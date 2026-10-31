import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ClientDefinitionRemote} from '../dist/definition-client.js';
import {runDefinitionsCli} from '../dist/definition-cli.js';
import {EnvaiClient} from '../dist/client.js';
import {EnvaiError} from '../dist/errors.js';
import {negotiatedFetch,json} from './helpers.mjs';

test('definition adapter routes all identities, strips immutable tool fields, preserves failures',async()=>{
 const calls=[];const client={listModels:async()=>({data:[{id:'llm',type:'llm'},{id:'team',type:'team'}]})};
 for(const noun of ['UserTool','Agent','Team'])for(const verb of ['list','get','create','update','delete'])client[verb+noun+(verb==='list'?'s':'')]=async p=>{calls.push([verb+noun,p]);return verb==='list'?[]:verb==='delete'?undefined:{id:'id',name:'name'};};
 const remote=new ClientDefinitionRemote(client);assert.deepEqual(await remote.models(),['llm']);
 for(const type of ['tool','agent','team']){await remote.list(type);await remote.get(type,'id','name');await remote.create(type,{name:'name'});await remote.update(type,'id','name',{name:'name',kind:'client',description:'new'});await remote.delete(type,'id','name');}
 assert.deepEqual(calls.find(c=>c[0]==='updateUserTool')[1],{name:'name',body:{description:'new'}});
 assert.deepEqual(calls.find(c=>c[0]==='getAgent')[1],{agent_id:'id'});
 assert.deepEqual(calls.find(c=>c[0]==='getTeam')[1],{team_id:'id'});
 client.getUserTool=async()=>{throw new EnvaiError('missing',404,'missing',null,null,null);};assert.equal(await remote.get('tool','id','name'),undefined);
 client.getUserTool=async()=>{throw new EnvaiError('denied',403,'denied',null,null,null);};await assert.rejects(remote.get('tool','id','name'),/denied/);
});

test('definition adapter uses authenticated ordinary SDK transport',async()=>{
 const seen=[];const c=new EnvaiClient({baseUrl:'https://example.test/api/v1',apiKey:'test-secret',fetch:negotiatedFetch(async(url,init)=>{seen.push([url,init]);return json({data:{id:'id',name:'echo'}});})});
 await new ClientDefinitionRemote(c).create('tool',{name:'echo',kind:'client',parameters:{type:'object'}});
 assert.equal(seen.length,1);assert.equal(seen[0][1].headers.get('authorization'),'Bearer test-secret');assert.equal(JSON.parse(seen[0][1].body).name,'echo');
});

test('CLI validates locally, selects environments, inspects absent state without writes and redacts failures',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'envai-cli-'));const manifest=join(dir,'manifest.json'),state=join(dir,'state.json');await writeFile(manifest,JSON.stringify({format_version:'1',tools:{},agents:{},teams:{}}));
 const output=[],errors=[],io={out:t=>output.push(t),err:t=>errors.push(t)};
 try {
  assert.equal(await runDefinitionsCli(['validate','--manifest',manifest,'--json'],{},io),0);assert.equal(JSON.parse(output.pop()).status,'valid');
  const env={ENVAI_DEV_DEFINITIONS:manifest,ENVAI_DEV_DEFINITION_SCOPE:'account',ENVAI_DEV_DEFINITION_STATE:state};
  assert.equal(await runDefinitionsCli(['state','--env','dev'],env,io),0);assert.deepEqual(JSON.parse(output.pop()),{format_version:'1',records:{}});await assert.rejects(access(state));
  for(const args of [[],['wrong'],['validate','--what'],['validate','--manifest'],['validate','--env','bad/selector'],['state','--manifest',manifest],['plan','--manifest',manifest,'--scope','account'],['validate','--manifest',manifest,'--manifest',manifest]])assert.equal(await runDefinitionsCli(args,{ENVAI_API_KEY:'super-secret'},io),1);
  assert.ok(errors.every(s=>!s.includes('super-secret')));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('CLI plan/dry-run are read-only; explicit sync persists state and readiness',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'envai-cli-wire-')),manifest=join(dir,'manifest.json'),state=join(dir,'state.json');await writeFile(manifest,JSON.stringify({format_version:'1',tools:{},agents:{},teams:{}}));
 const old=globalThis.fetch,calls=[],out=[];globalThis.fetch=negotiatedFetch(async(url,init)=>{calls.push(init.method);return json(url.endsWith('/models')?{object:'list',data:[],defaults:{orchestrator:'x',subagent:'x'}}:{data:[]});});
 const env={ENVAI_DEFINITIONS:manifest,ENVAI_DEFINITION_STATE:state,ENVAI_DEFINITION_SCOPE:'test-account',ENVAI_BASE_URL:'https://example.test/api/v1',ENVAI_API_KEY:'test-secret'},io={out:t=>out.push(JSON.parse(t)),err:t=>out.push(t)};
 try{
  for(const command of [['plan'],['plan','--strict-validation'],['status','--fail-on-drift'],['sync','--dry-run','--only','tools','--adopt','--overwrite-drift','--recreate-missing','--prune']])assert.equal(await runDefinitionsCli(command,env,io),0);
  await assert.rejects(access(state));assert.ok(calls.every(m=>m==='GET'));
  assert.equal(await runDefinitionsCli(['plan','--only','invalid'],env,io),1);
  assert.equal(await runDefinitionsCli(['plan'],{...env,ENVAI_STRICT_VALIDATION:'true'},io),0);
  assert.equal(await runDefinitionsCli(['plan'],{...env,ENVAI_STRICT_VALIDATION:'invalid'},io),1);
  assert.equal(await runDefinitionsCli(['sync'],env,io),0);assert.equal(out.at(-1).manifest_ready,true);
  assert.equal(await runDefinitionsCli(['state'],env,io),0);assert.ok(out.at(-1).ready);
 }finally{globalThis.fetch=old;await rm(dir,{recursive:true,force:true});}
});

test('CLI new create is not drift, managed remote drift and blocked sync exit 2',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'envai-cli-drift-')),manifest=join(dir,'manifest.json'),state=join(dir,'state.json');
 const tool={name:'echo',kind:'client',parameters:{type:'object'},description:'wanted',timeout_seconds:120};
 await writeFile(manifest,JSON.stringify({format_version:'1',tools:{echo:tool},agents:{},teams:{}}));
 let remote=[];const old=globalThis.fetch;globalThis.fetch=negotiatedFetch(async(url,init)=>json(url.endsWith('/models')?{object:'list',data:[],defaults:{orchestrator:'x',subagent:'x'}}:{data:url.endsWith('/tools/echo')?remote[0]:url.endsWith('/tools')?remote:[]}));
 const env={ENVAI_DEFINITIONS:manifest,ENVAI_DEFINITION_STATE:state,ENVAI_DEFINITION_SCOPE:'account',ENVAI_BASE_URL:'https://example.test/api/v1',ENVAI_API_KEY:'test-secret'},output=[],io={out:t=>output.push(JSON.parse(t)),err:t=>output.push(t)};
 try{
  assert.equal(await runDefinitionsCli(['plan','--fail-on-drift'],env,io),0);
  const {FileDefinitionStateStore}=await import('../dist/definition-state.js');const store=new FileDefinitionStateStore(state);await store.initialize();
  await store.withScope('account',session=>session.save({type:'tool',local_key:'echo',remote_id:'id',remote_name:'echo',last_applied:tool,desired_hash:'hash',remote_marker:null,status:'applied',updated_at:'now'}));
  remote=[{...tool,id:'id',description:'remote drift'}];
  assert.equal(await runDefinitionsCli(['plan','--fail-on-drift'],env,io),2);
  assert.equal(await runDefinitionsCli(['sync'],env,io),2);
 }finally{globalThis.fetch=old;await rm(dir,{recursive:true,force:true});}
});

test('CLI explicitly loads caller database store factory without provisioning file state',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'envai-cli-store-')),manifest=join(dir,'manifest.json'),module=join(dir,'store.mjs');await writeFile(manifest,JSON.stringify({format_version:'1',tools:{},agents:{},teams:{}}));
 const output=[],io={out:t=>output.push(JSON.parse(t)),err:t=>output.push(t)};
 try{
  await writeFile(module,'export function createDefinitionStateStore(env) { return {withScope: async (scope, fn) => fn({read:async()=>({records:{},testScope:scope})})}; }');
  assert.equal(await runDefinitionsCli(['state','--manifest',manifest,'--scope','database-account','--store',module],{},io),0);assert.equal(output.at(-1).testScope,'database-account');
  const invalid=join(dir,'invalid.mjs');await writeFile(invalid,'export const nope=true;');assert.equal(await runDefinitionsCli(['state','--manifest',manifest,'--scope','a','--store',invalid],{},io),1);
  const bad=join(dir,'bad.mjs');await writeFile(bad,'export function createDefinitionStateStore(){return null;}');assert.equal(await runDefinitionsCli(['state','--manifest',manifest,'--scope','a','--store',bad],{},io),1);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('CLI portable selectors and format version support explicit memory state',async()=>{const dir=await mkdtemp(join(tmpdir(),'envai-cli-alias-'));try{const manifest=join(dir,'manifest.json');await writeFile(manifest,JSON.stringify({format_version:'1',tools:{},agents:{},teams:{}}));const out=[],io={out:s=>out.push(JSON.parse(s)),err:()=>{}};assert.equal(await runDefinitionsCli(['validate','--path',manifest],{},io),0);assert.equal(out.at(-1).format_version,'1');assert.equal(await runDefinitionsCli(['state','--connection','a'],{ENVAI_DEFINITIONS_PATH:manifest,ENVAI_STATE_PATH:join(dir,'absent'),ENVAI_STATE_DRIVER:'memory'},io),0);assert.deepEqual(out.at(-1),{format_version:'1',records:{}});assert.equal(await runDefinitionsCli(['state'],{ENVAI_DEFINITIONS_PATH:manifest,ENVAI_CONNECTION:'a',ENVAI_STATE_DRIVER:'memory'},io),0);}finally{await rm(dir,{recursive:true,force:true});}});
