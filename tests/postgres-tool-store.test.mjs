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
