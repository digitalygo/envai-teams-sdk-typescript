import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WikiWebhookVerifier, PostgresWikiWebhookInbox, SignatureError, ProtocolError, JwksCache } from '../dist/index.js';
const fixture=name=>JSON.parse(readFileSync(new URL('../testdata/wiki/'+name+'.json',import.meta.url),'utf8'));
const vector=fixture('webhook-signature');
const seed='9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const privateKey=createPrivateKey({key:Buffer.from('302e020100300506032b657004220420'+seed,'hex'),format:'der',type:'pkcs8'});
const original=JSON.parse(vector.raw_body);
const request=()=>({method:'POST',headers:{'Content-Type':'application/json',...vector.headers},rawBody:Buffer.from(vector.raw_body)});
const verifier=(options={})=>new WikiWebhookVerifier(new JwksCache(async()=>vector.jwks),original.workspace_id,{now:()=>vector.now,...options});
function signed(payload, {timestamp=String(vector.now),rawBody=Buffer.from(JSON.stringify(payload)),eventId=payload.event_id,kid=vector.headers['Envai-Webhook-Key-Id']}={}){
 const hash=createHash('sha256').update(rawBody).digest('hex');
 const input=`envai-webhook-v1\n${kid}\n${eventId}\n${timestamp}\n${hash}`;
 return {method:'POST',rawBody,headers:{'Content-Type':'application/json','Envai-Webhook-Id':eventId,'Envai-Webhook-Timestamp':timestamp,'Envai-Webhook-Key-Id':kid,'Envai-Webhook-Signature':sign(null,Buffer.from(input),privateKey).toString('base64url')}};
}
test('shared exact-byte signature vector and typed event discriminators',async()=>{
 const verified=await verifier().verify(request());assert.deepEqual(verified.event,original);assert.equal(Buffer.from(verified.rawBody).toString(),vector.raw_body);
 assert.equal(verified.payloadHash,vector.signing_input.split('\n').at(-1));
 for(const name of ['file-processed','file-deleted','operation-event']){const payload=fixture(name).data;const result=await verifier().verify(signed(payload));assert.deepEqual(result.event,payload);}
 for(const kind of ['inbox','outbox','sync'])for(const status of ['completed','failed']){const payload={...fixture('operation-event').data,event_type:`wiki.${kind}.${status}`,status};assert.equal((await verifier().verify(signed(payload))).event.event_type,payload.event_type);}
});
test('headers preserve duplicate detection across native request representations',async()=>{
 for(const headers of [Object.entries(request().headers),Object.entries(request().headers).flat(),new Headers(request().headers),{...request().headers,ignored:['okay','twice']}])assert.equal((await verifier().verify({...request(),headers})).event.event_id,original.event_id);
 const variants=[[],['x'],[['bad']],{...vector.headers,'envai-webhook-id':original.event_id},{...vector.headers,'Envai-Webhook-Id':[original.event_id]}, {...vector.headers,'Envai-Webhook-Id':undefined},{...vector.headers,'Envai-Webhook-Id':'bad, bad'}, {...vector.headers,'Envai-Webhook-Id':'bad\nvalue'}];
 const duplicated=new Headers(vector.headers);duplicated.append('Envai-Webhook-Id',original.event_id);variants.push(duplicated);
 for(const headers of variants)await assert.rejects(verifier().verify({...request(),headers}),SignatureError);
});
test('timestamp grammar, replay window and legitimate fresh retry of an old logical event',async()=>{
 for(const delta of [-300,0,300])await verifier({now:()=>vector.now+delta}).verify(request());
 for(const delta of [-301,301])await assert.rejects(verifier({now:()=>vector.now+delta}).verify(request()),SignatureError);
 for(const timestamp of ['0','01','-1','1.0','1e2','9007199254740992'])await assert.rejects(verifier().verify(signed(original,{timestamp})),SignatureError);
 const old={...original,occurred_at:'2020-01-01T00:00:00Z'};assert.equal((await verifier().verify(signed(old))).event.occurred_at,old.occurred_at);
 await assert.rejects(verifier({toleranceSeconds:0,now:()=>vector.now+1}).verify(request()),SignatureError);
});
test('body bound, exact bytes, immutable input snapshot and workspace/identity scope',async()=>{
 assert.throws(()=>new WikiWebhookVerifier({},''),TypeError);assert.throws(()=>new WikiWebhookVerifier({},'bad space'),TypeError);
 assert.throws(()=>verifier({maxBodyBytes:0}));
 await assert.rejects(verifier({maxBodyBytes:1}).verify(request()),SignatureError);
 await assert.rejects(verifier().verify({...request(),rawBody:vector.raw_body}),SignatureError);
 await assert.rejects(verifier().verify({...request(),rawBody:Buffer.from(vector.raw_body+' ')}),SignatureError);
 await assert.rejects(verifier().verify(signed({...original,workspace_id:'wsp_another'})),SignatureError);
 await assert.rejects(verifier().verify(signed(original,{eventId:'evt_other'})),SignatureError);
 let release;const v=new WikiWebhookVerifier({get:()=>new Promise(r=>release=r)},original.workspace_id,{now:()=>vector.now});const mutable=request();const pending=v.verify(mutable);mutable.rawBody.fill(32);release(vector.jwks);assert.deepEqual((await pending).event,original);
});
test('strict key metadata, canonical signature/key bytes and unknown-key rotation only',async()=>{
 for(const patch of [{kty:'RSA'},{crv:'P-256'},{alg:'HS256'},{use:'enc'},{key_ops:['sign']},{d:'private'},{x:'bad'},{x:vector.jwks.keys[0].x+'='}]){
  const v=new WikiWebhookVerifier({get:async()=>({keys:[{...vector.jwks.keys[0],...patch}]})},original.workspace_id,{now:()=>vector.now});await assert.rejects(v.verify(request()),SignatureError);
 }
 for(const signature of ['bad',vector.headers['Envai-Webhook-Signature']+'=', '_'.repeat(86)])await assert.rejects(verifier().verify({...request(),headers:{'Content-Type':'application/json',...vector.headers,'Envai-Webhook-Signature':signature}}),SignatureError);
 for(const keys of [[],[...vector.jwks.keys,...vector.jwks.keys]]){let count=0;const v=new WikiWebhookVerifier({get:async()=>{count++;return {keys};}},original.workspace_id,{now:()=>vector.now});await assert.rejects(v.verify(request()),SignatureError);assert.equal(count,keys.length?1:2);}
 const force=[];const rotating=new WikiWebhookVerifier({get:async refresh=>{force.push(refresh);return refresh?vector.jwks:{keys:[]};}},original.workspace_id,{now:()=>vector.now});await rotating.verify(request());assert.deepEqual(force,[false,true]);
 const badSignature=request();badSignature.rawBody[0]=91;let count=0;const v=new WikiWebhookVerifier({get:async()=>{count++;return vector.jwks;}},original.workspace_id,{now:()=>vector.now});await assert.rejects(v.verify(badSignature),SignatureError);assert.equal(count,1);
});
test('verified bytes still must be UTF-8 JSON and satisfy state/discriminator schema',async()=>{
 for(const rawBody of [Buffer.from([255]),Buffer.from('{')])await assert.rejects(verifier().verify(signed(original,{rawBody})),SignatureError);
 const invalids=[{...original,schema_version:'2'},{...original,source_revision:0},{...original,event_type:'provider.transcript.ready'},{...fixture('operation-event').data,status:'failed'},{...original,availability:'withdrawn'}];
 for(const payload of invalids)await assert.rejects(verifier().verify(signed(payload)),ProtocolError);
 const abort=new AbortController();abort.abort();await assert.rejects(verifier().verify(request(),abort.signal),e=>e.name==='AbortError');
 const during=new AbortController();const v=new WikiWebhookVerifier({get:async()=>{during.abort();return vector.jwks;}},original.workspace_id,{now:()=>vector.now});await assert.rejects(v.verify(request(),during.signal),e=>e.name==='AbortError');
});
function database({inserted=1,storedHash,failAt,rollbackFails=false,workRows=1,rows}={}){
 const calls=[];let released;const hash=createHash('sha256').update(vector.raw_body).digest('hex');
 const pool={connect:async()=>({query:async(sql,args)=>{calls.push([sql,args]);if(failAt&&sql.startsWith(failAt))throw Error('store failure');if(rollbackFails&&sql==='ROLLBACK')throw Error('rollback failure');if(sql.startsWith('INSERT INTO envai_wiki_webhook_receipts'))return {rows:[],rowCount:inserted};if(sql.startsWith('SELECT'))return {rows:rows??[{payload_hash:storedHash??hash}],rowCount:1};if(sql.startsWith('INSERT INTO envai_wiki_application_outbox'))return {rows:[],rowCount:workRows};return {rows:[],rowCount:null};},release:broken=>released=broken})};
 return {pool,calls,get released(){return released;}};
}
test('durable inbox verifies before SQL, commits receipt plus work and scopes identities',async()=>{
 const db=database();const inbox=new PostgresWikiWebhookInbox(db.pool,verifier());assert.equal(await inbox.receive(request(),'production'),'accepted');
 assert.equal(db.calls[0][0],'BEGIN');assert.equal(db.calls.at(-1)[0],'COMMIT');assert.equal(db.released,false);
 const work=db.calls.find(([sql])=>sql.startsWith('INSERT INTO envai_wiki_application_outbox'));assert.deepEqual(JSON.parse(work[1][2]),original);assert.equal(work[1][3].toString(),vector.raw_body);
 const db2=database();await new PostgresWikiWebhookInbox(db2.pool,verifier()).receive(request(),'staging');assert.notEqual(db.calls[1][1][0],db2.calls[1][1][0]);
 for(const scope of ['', 'bad\0scope'])await assert.rejects(inbox.receive(request(),scope),TypeError);
 let connected=false;const blocked=new PostgresWikiWebhookInbox({connect:async()=>{connected=true;}},verifier());await assert.rejects(blocked.receive({...request(),rawBody:Buffer.from('bad')},'scope'),SignatureError);assert.equal(connected,false);
});
test('duplicates enqueue no new work, collisions roll back, and failed transactions remain retryable',async()=>{
 for(const [setup,expected]of [[{inserted:0},'duplicate'],[{inserted:0,storedHash:'different'},'collision']]){
  const db=database(setup);assert.equal(await new PostgresWikiWebhookInbox(db.pool,verifier()).receive(request(),'scope'),expected);assert.ok(!db.calls.some(([sql])=>sql.startsWith('INSERT INTO envai_wiki_application_outbox')));assert.equal(db.calls.at(-1)[0],expected==='collision'?'ROLLBACK':'COMMIT');
 }
 for(const setup of [{inserted:2},{rows:[]},{rows:[{payload_hash:null}]},{workRows:0},{failAt:'BEGIN'},{failAt:'INSERT INTO envai_wiki_application_outbox'},{failAt:'COMMIT'},{failAt:'SELECT',rollbackFails:true}]){
  const db=database(setup);await assert.rejects(new PostgresWikiWebhookInbox(db.pool,verifier()).receive(request(),'scope'));assert.equal(db.calls.at(-1)[0],'ROLLBACK');assert.equal(db.released,!!setup.rollbackFails);
 }
});
test('cancellation rolls back uncommitted work and never acknowledges an aborted commit',async()=>{
 const abort=new AbortController(),db=database();const base=db.pool.connect;db.pool.connect=async()=>{const connection=await base();const query=connection.query;connection.query=async(sql,args)=>{const result=await query(sql,args);if(sql.startsWith('INSERT INTO envai_wiki_application_outbox'))abort.abort();return result;};return connection;};
 await assert.rejects(new PostgresWikiWebhookInbox(db.pool,verifier()).receive(request(),'scope',abort.signal),e=>e.name==='AbortError');assert.equal(db.calls.at(-1)[0],'ROLLBACK');
});
test('HTTP method and exact signing-header grammar cannot bypass verification',async()=>{
 for(const method of ['GET','HEAD',undefined])await assert.rejects(verifier().verify({...request(),method}),SignatureError);
 await verifier().verify({...request(),method:'post'});
 for(const [field,value]of [['Envai-Webhook-Id','a'.repeat(256)],['Envai-Webhook-Key-Id','bad.kid'],['Envai-Webhook-Timestamp','999999999999']])await assert.rejects(verifier().verify({...request(),headers:{...vector.headers,[field]:value}}),SignatureError);
 await assert.rejects(verifier({now:()=>NaN}).verify(request()),SignatureError);assert.throws(()=>verifier({toleranceSeconds:301}),RangeError);
 await assert.rejects(verifier().verify({...request(),headers:[[1,'a']]}),SignatureError);
 for(const patch of [{alg:undefined},{use:undefined},{x:undefined},{key_ops:'verify'}]){const v=new WikiWebhookVerifier({get:async()=>({keys:[{...vector.jwks.keys[0],...patch}]})},original.workspace_id,{now:()=>vector.now});await assert.rejects(v.verify(request()),SignatureError);}
});
test('tool/provider signature preimages cannot substitute for domain-separated wiki signatures',async()=>{
 for(const body of ['call-id\ntool-name\n{}','provider-callback\n'+vector.raw_body]){
  const bad={...request(),headers:{'Content-Type':'application/json',...vector.headers,'Envai-Webhook-Signature':sign(null,Buffer.from(body),privateKey).toString('base64url')}};await assert.rejects(verifier().verify(bad),SignatureError);
 }
});
test('only a single JSON HTTP content type is accepted',async()=>{
 for(const type of ['application/json; charset=utf-8','APPLICATION/JSON','application/vnd.envai+json'])await verifier().verify({...request(),headers:{...request().headers,'Content-Type':type}});
 for(const headers of [{...vector.headers},{...request().headers,'content-type':'application/json'},{...request().headers,'Content-Type':['application/json']},{...request().headers,'Content-Type':'text/plain'},{...request().headers,'Content-Type':'application/json, application/json'}])await assert.rejects(verifier().verify({...request(),headers}),SignatureError);
});
test('default delivery clock accepts a freshly signed retry',async()=>{
 const v=new WikiWebhookVerifier(new JwksCache(async()=>vector.jwks),original.workspace_id);const fresh=signed(original,{timestamp:String(Math.floor(Date.now()/1000))});assert.equal((await v.verify(fresh)).event.event_id,original.event_id);
});
