import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createPrivateKey, sign, randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresWikiWebhookInbox, WikiWebhookVerifier, JwksCache } from '../dist/index.js';
const url=process.env.ENVAI_TEST_PG_URL ?? process.env.TEST_DATABASE_URL;
const vector=JSON.parse(readFileSync(new URL('../testdata/wiki/webhook-signature.json',import.meta.url),'utf8'));
const payload=JSON.parse(vector.raw_body);
const request=()=>({method:'POST',headers:{'Content-Type':'application/json',...vector.headers},rawBody:Buffer.from(vector.raw_body)});
const verifier=()=>new WikiWebhookVerifier(new JwksCache(async()=>vector.jwks),payload.workspace_id,{now:()=>vector.now});
test('real PostgreSQL: concurrent delivery, rollback, restart, collisions and independent connection scopes',{skip:!url},async()=>{
 const schema='envai_wiki_test_'+randomUUID().replaceAll('-','');
 const pool=new pg.Pool({connectionString:url,max:8,options:'-c search_path='+schema});
 try{
  await pool.query('CREATE SCHEMA '+schema);
  await pool.query(readFileSync(new URL('../migrations/wiki-webhook-inbox.sql',import.meta.url),'utf8'));
  const outcomes=await Promise.all(Array.from({length:8},()=>new PostgresWikiWebhookInbox(pool,verifier()).receive(request(),'production')));
  assert.equal(outcomes.filter(x=>x==='accepted').length,1);assert.equal(outcomes.filter(x=>x==='duplicate').length,7);
  assert.equal(Number((await pool.query('SELECT count(*) FROM envai_wiki_webhook_receipts')).rows[0].count),1);
  const work=(await pool.query('SELECT * FROM envai_wiki_application_outbox')).rows;assert.equal(work.length,1);assert.deepEqual(work[0].payload,payload);assert.equal(work[0].raw_body.toString(),vector.raw_body);
  assert.equal(await new PostgresWikiWebhookInbox(pool,verifier()).receive(request(),'production'),'duplicate');
  assert.equal(await new PostgresWikiWebhookInbox(pool,verifier()).receive(request(),'staging'),'accepted');
  // A schema failure after receipt insertion must roll back both records. Replay after repair is safe.
  await pool.query("ALTER TABLE envai_wiki_application_outbox ADD CONSTRAINT reject_test CHECK (event_type = 'cannot-match') NOT VALID");
  await assert.rejects(new PostgresWikiWebhookInbox(pool,verifier()).receive(request(),'rollback-scope'));
  assert.equal(Number((await pool.query("SELECT count(*) FROM envai_wiki_webhook_receipts WHERE connection_scope='rollback-scope'")).rows[0].count),0);
  await pool.query('ALTER TABLE envai_wiki_application_outbox DROP CONSTRAINT reject_test');
  assert.equal(await new PostgresWikiWebhookInbox(pool,verifier()).receive(request(),'rollback-scope'),'accepted');
  const body=Buffer.from(JSON.stringify({...payload,source_revision:4}));
  const key=createPrivateKey({key:Buffer.from('302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60','hex'),format:'der',type:'pkcs8'});
  const input=vector.signing_input.split('\n').slice(0,-1).join('\n')+'\n'+createHash('sha256').update(body).digest('hex');
  const collision={method:'POST',rawBody:body,headers:{'Content-Type':'application/json',...vector.headers,'Envai-Webhook-Signature':sign(null,Buffer.from(input),key).toString('base64url')}};
  assert.equal(await new PostgresWikiWebhookInbox(pool,verifier()).receive(collision,'production'),'collision');
  assert.equal(Number((await pool.query('SELECT count(*) FROM envai_wiki_application_outbox')).rows[0].count),3);
  assert.equal((await pool.query('SELECT payload FROM envai_wiki_application_outbox WHERE deduplication_key=$1',[work[0].deduplication_key])).rows[0].payload.source_revision,payload.source_revision);
  // Simulate connection loss after a successful commit: no 2xx is returned, but a later retry cannot enqueue twice.
  const ambiguous={connect:async()=>{const client=await pool.connect();return {release:e=>client.release(e),query:async(sql,args)=>{const result=await client.query(sql,args);if(sql==='COMMIT')throw Error('connection lost after commit');return result;}};}};
  await assert.rejects(new PostgresWikiWebhookInbox(ambiguous,verifier()).receive(request(),'ambiguous'),/connection lost/);
  assert.equal(await new PostgresWikiWebhookInbox(pool,verifier()).receive(request(),'ambiguous'),'duplicate');
  assert.equal(Number((await pool.query('SELECT count(*) FROM envai_wiki_application_outbox')).rows[0].count),4);
  // Exercise both uniqueness indexes repeatedly; conflict handling must cover either arbiter.
  for(let run=0;run<20;run++){
   const result=await Promise.all(Array.from({length:8},()=>new PostgresWikiWebhookInbox(pool,verifier()).receive(request(),'contention-'+run)));
   assert.equal(result.filter(x=>x==='accepted').length,1);assert.equal(result.filter(x=>x==='duplicate').length,7);
  }
  assert.equal(Number((await pool.query('SELECT count(*) FROM envai_wiki_application_outbox')).rows[0].count),24);
 }finally{try{await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}finally{await pool.end();}}
});
