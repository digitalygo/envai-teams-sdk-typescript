import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
// Compile the documented adapter and exercise its SQL contract with an in-memory database double.
// No PostgreSQL service, credentials, or network access is used.
const source=readFileSync(new URL('../examples/postgres-tool-store.ts',import.meta.url),'utf8')
 .replace("'../src/index.js'",JSON.stringify(new URL('../dist/index.js',import.meta.url).href));
const javascript=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {PostgresToolStateStore}=await import('data:text/javascript;base64,'+Buffer.from(javascript).toString('base64'));
const suffix='01ARZ3NDEKTSV4RRFFQ69G5FAV';
const good={state:'claimed',fingerprint:'a'.repeat(64),chatId:'cht_'+suffix,turnId:'cmpl_'+suffix,callId:'tc_'+suffix};
const key=JSON.stringify(['scope',good.chatId,good.callId]);
function database(initial, present=initial!==undefined){
 const rows=new Map(present?[[key,structuredClone(initial)]]:[]);const writes=[];
 return {rows,writes,beforeWrite:undefined,async query(sql,values){
  const [id]=values;
  if(sql.startsWith('SELECT'))return{rows:rows.has(id)?[{record:structuredClone(rows.get(id))}]:[],rowCount:rows.has(id)?1:0};
  this.beforeWrite?.();writes.push({sql,values});
  if(sql.startsWith('INSERT')){if(rows.has(id))return{rows:[],rowCount:0};rows.set(id,JSON.parse(values[1]));return{rows:[{key:id}],rowCount:1};}
  assert.match(sql,/AND record = \$3::jsonb/);
  if(!rows.has(id)||JSON.stringify(rows.get(id))!==values[2])return{rows:[],rowCount:0};
  rows.set(id,JSON.parse(values[1]));return{rows:[{key:id}],rowCount:1};
 }};
}
test('Postgres adapter preserves corrupt JSON rows and rejects every operation before writes',async()=>{
 for(const value of [null,false,0,[],{}, {...good,state:'bad'}, {...good,chatId:'other'}, {...good,callId:'other'}, {...good,turnId:null}, {...good,fingerprint:''}, {...good,state:'completed'}, {...good,output:'partial'}]){
  const db=database(value);const store=new PostgresToolStateStore(db);
  for(const action of [()=>store.get(key),()=>store.claim(key,good),()=>store.transition(key,['claimed'],{state:'resolved'})])await assert.rejects(action,error=>error.code==='invalid_tool_state');
  assert.deepEqual(db.rows.get(key),value);assert.equal(db.writes.length,0);
 }
});
test('Postgres adapter distinguishes absent rows from undefined/null data and validates transitions',async()=>{
 const db=database();const store=new PostgresToolStateStore(db);assert.equal(await store.get(key),undefined);
 assert.equal(await store.transition(key,['claimed'],{state:'resolved'}),false);
 assert.equal(await store.claim(key,good),true);assert.equal(await store.claim(key,good),false);
 assert.equal(await store.transition(key,['submitted'],{state:'resolved'}),false);
 for(const patch of [{turnId:'other'},{fingerprint:'b'.repeat(64)},{state:'bad'}])await assert.rejects(store.transition(key,['claimed'],patch),error=>error.code==='invalid_tool_state');
 assert.equal(await store.transition(key,['claimed'],{state:'completed',output:'ok',isError:false}),true);
 assert.equal(await store.transition(key,['completed'],{state:'submitted'}),true);
 assert.equal(await store.transition(key,['submitted'],{state:'resolved'}),true);
 assert.equal((await store.get(key)).state,'resolved');
 const invalid=database(undefined,true);await assert.rejects(new PostgresToolStateStore(invalid).get(key),error=>error.code==='invalid_tool_state');
});
test('Postgres adapter handles concurrent claim and compare-and-swap races without overwrite',async()=>{
 const db=database();const store=new PostgresToolStateStore(db);
 db.beforeWrite=()=>{db.rows.set(key,structuredClone(good));db.beforeWrite=undefined;};
 assert.equal(await store.claim(key,good),false);assert.deepEqual(db.rows.get(key),good);
 db.beforeWrite=()=>{db.rows.set(key,{...good,state:'resolved'});db.beforeWrite=undefined;};
 assert.equal(await store.transition(key,['claimed'],{state:'completed',output:'ok',isError:false}),false);
 assert.equal(db.rows.get(key).state,'resolved');
 const corrupt=database();corrupt.beforeWrite=()=>{corrupt.rows.set(key,null);corrupt.beforeWrite=undefined;};
 await assert.rejects(new PostgresToolStateStore(corrupt).claim(key,good),error=>error.code==='invalid_tool_state');assert.equal(corrupt.rows.get(key),null);
});

test('Postgres adapter rejects duplicate rows before any mutation if a restored table lost its constraint',async()=>{
 let writes=0;const copies=[structuredClone(good),structuredClone(good)];
 const db={async query(sql){if(sql.startsWith('SELECT'))return {rows:copies.map(record=>({record})),rowCount:2};writes++;return {rows:[],rowCount:2};}};
 const store=new PostgresToolStateStore(db);
 for(const action of [()=>store.get(key),()=>store.claim(key,good),()=>store.transition(key,['claimed'],{state:'resolved'})])await assert.rejects(action,error=>error.code==='invalid_tool_state');
 assert.equal(writes,0);assert.deepEqual(copies,[good,good]);
});

test('supported PostgreSQL tool store: concurrent claims, restart task barriers, corruption and scope isolation', {skip:!process.env.ENVAI_TEST_PG_URL}, async()=>{
 const {default:pg}=await import('pg');const {randomUUID}=await import('node:crypto');
 const {PostgresToolStateStore,ClientToolRunner,ClientToolRegistry,ToolRequestVerifier}=await import('../dist/index.js');
 const fixture=JSON.parse(readFileSync(new URL('../testdata/parity/fixtures.json',import.meta.url),'utf8'));
 const schema='envai_tools_'+randomUUID().replaceAll('-','');const admin=new pg.Pool({connectionString:process.env.ENVAI_TEST_PG_URL});
 await admin.query('CREATE SCHEMA '+schema);const pool=new pg.Pool({connectionString:process.env.ENVAI_TEST_PG_URL,options:'-c search_path='+schema,max:8});
 try {
  await pool.query('CREATE TABLE envai_tool_state (key text PRIMARY KEY, record jsonb NOT NULL)');
  const stores=Array.from({length:8},()=>new PostgresToolStateStore(pool));
  assert.equal((await Promise.all(stores.map(s=>s.claim(key,good)))).filter(Boolean).length,1);
  assert.deepEqual(await new PostgresToolStateStore(pool).get(key),good);
  const second=JSON.stringify(['other-scope',good.chatId,good.callId]);assert.equal(await stores[0].claim(second,good),true);
  assert.equal(await stores[0].transition(key,['claimed'],{state:'completed',output:'saved',isError:false}),true);
  const transitions=await Promise.all(stores.map(s=>s.transition(key,['completed'],{state:'submitted'})));assert.equal(transitions.filter(Boolean).length,1);
  let effects=0;const registry=new ClientToolRegistry().register({name:fixture.request.data.tool_name,parameters:{type:'object'},handler:()=>{effects++;return 'must not execute';}});
  const options={scope:'persistent-task',registry,verifier:new ToolRequestVerifier({get:async()=>fixture.jwks}),submit:async()=>{throw Error('must not submit');}};
  const first=new ClientToolRunner({...options,store:stores[0]});await first.accept(fixture.task_cancelled);first.close();
  const restarted=new ClientToolRunner({...options,store:new PostgresToolStateStore(pool)});await restarted.accept(fixture.task_request);await restarted.drain();restarted.close();assert.equal(effects,0);
  await pool.query('UPDATE envai_tool_state SET record=$2::jsonb WHERE key=$1',[key,'null']);
  await assert.rejects(stores[0].claim(key,good),e=>e.code==='invalid_tool_state');assert.equal((await pool.query('SELECT record FROM envai_tool_state WHERE key=$1',[key])).rows[0].record,null);
 } finally {await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();}
});
