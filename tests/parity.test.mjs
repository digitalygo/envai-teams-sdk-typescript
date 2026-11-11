import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EnvaiClient, ToolRequestVerifier, ClientToolRegistry, assertToolRecord, ProtocolError, CompatibilityError, SignatureError } from '../dist/index.js';
import { json, capabilities, tick } from './helpers.mjs';
const fixtures=JSON.parse(readFileSync(new URL('../testdata/parity/fixtures.json',import.meta.url),'utf8'));
const manifest=JSON.parse(readFileSync(new URL('../testdata/parity/manifest.json',import.meta.url),'utf8'));
const scenarios=JSON.parse(readFileSync(new URL('../testdata/parity/scenarios.json',import.meta.url),'utf8'));
const chatId=fixtures.request.chat_id,turnId=fixtures.request.turn_id;
const features=['detached_background','native_deliveries','cross_team_delegation','delegated_job_lifecycle','delegation_notify_origin','strict_model','phase_classification'];
const wire=e=>new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`);
const event=(name,seq)=>({...structuredClone(fixtures[name]),seq});
// Test-only persistent adapter: exclusive file claims and validated atomic replacement.
// Production callers must choose a transactional store suitable for their deployment.
class FileStore {
 constructor(root){this.root=root;}
 path(key){return join(this.root,createHash('sha256').update(key).digest('hex'));}
 async get(key){let raw;try{raw=readFileSync(this.path(key),'utf8');}catch(e){if(e.code==='ENOENT')return;throw e;}const record=JSON.parse(raw);assertToolRecord(key,record);return record;}
 async claim(key,value){assertToolRecord(key,value);try{writeFileSync(this.path(key),JSON.stringify(value),{flag:'wx'});return true;}catch(e){if(e.code!=='EEXIST')throw e;await this.get(key);return false;}}
 async transition(key,expected,patch){const old=await this.get(key);if(!old||!expected.includes(old.state))return false;const next={...old,...patch};assertToolRecord(key,next,old.turnId);assert.equal(next.fingerprint,old.fingerprint);assert.equal(next.taskId,old.taskId);writeFileSync(this.path(key)+'.next',JSON.stringify(next));renameSync(this.path(key)+'.next',this.path(key));return true;}
}
function harness(t,{native=false,pre=[],after=[],handler,fetch:custom,verifier}={}) {
 const dir=mkdtempSync(join(tmpdir(),'envai-parity-'));const store=new FileStore(dir);
 const state={effects:0,submissions:0,requests:[],controllers:[],closed:0};
 const response=value=>json(value,200,native?{'X-Envai-Extensions':'native-tasks-v1'}:{});
 const client=new EnvaiClient({baseUrl:'https://offline.test/api/v1',apiKey:'fixture',nativeTasks:native,jwksCache:{get:async()=>fixtures.jwks},retry:{maxRetries:0},fetch:async(url,init)=>{
  state.requests.push({url,init});
  if(url.endsWith('/capabilities'))return response({...capabilities,features});
  if(url.includes('/events'))return new Response(new ReadableStream({start(c){state.controllers.push(c);for(const e of [...pre,event('ping',0)])c.enqueue(wire(e));},cancel(){state.closed++;}}),{headers:{'content-type':'text/event-stream','X-Envai-Contract-Version':'3',...(native?{'X-Envai-Extensions':'native-tasks-v1'}:{})}});
  if(url.endsWith('/tool-output')){state.submissions++;const result=custom?await custom(url,init,state,response):null;return result??new Response(null,{status:204,headers:{'X-Envai-Contract-Version':'3',...(native?{'X-Envai-Extensions':'native-tasks-v1'}:{})}});}
  if(url.endsWith('/messages')){for(const e of after)state.controllers.at(-1).enqueue(wire(e));return response(scenarios.message_receipt);}
  if(custom)return custom(url,init,state,response);
  throw Error('Unexpected route '+url);
 }});
 const registry=new ClientToolRegistry().register({name:fixtures.request.data.tool_name,parameters:{type:'object'},handler:async(a,c)=>{state.effects++;return handler?handler(a,c):'local output';}});
 const runner=client.createToolRunner({scope:'parity/account',store,registry,...(verifier?{verifier}:{})});
 t.after(()=>{runner.close();rmSync(dir,{recursive:true,force:true});});
 return {client,runner,state,store,registry};
}
test('parity fixture provenance is synthetic and matches shared checksum',()=>{assert.equal(manifest.synthetic,true);assert.equal(createHash('sha256').update(readFileSync(new URL('../testdata/parity/fixtures.json',import.meta.url))).digest('hex'),manifest.fixtures_sha256);});
for(const [id,pre,expected]of [
 ['REPLAY-01',[event('request',1),event('result',2)],0],
 ['REPLAY-02',[event('request',1),event('turn_terminal',2)],0],
 ['REPLAY-03',[event('request',1)],1],
])test(id+' actual foreground helper resolves replay before effects',async t=>{
 const h=harness(t,{pre,after:expected?[]:[event('turn_terminal',pre.length+1)],fetch:async(url,init,state)=>{if(url.endsWith('/tool-output')){state.controllers[0].enqueue(wire(event('result',2)));state.controllers[0].enqueue(wire(event('turn_terminal',3)));}}});
 for await(const e of h.client.sendAndStream(chatId,{message:'existing'},{idempotencyKey:'stable',toolRunner:h.runner,maxReconnects:0})){if(e.type==='agent.tool.request')await h.runner.drain();}
 await h.runner.drain();assert.equal(h.state.effects,expected);assert.equal(h.state.submissions,expected);assert.equal(h.state.requests.filter(r=>r.url.endsWith('/messages')).length,1);
});
test('TASK-01 native task tools execute after origin terminal on owning chat',async t=>{
 const h=harness(t,{native:true,pre:[],after:[]});
 await h.runner.accept(event('turn_terminal',1));await h.runner.accept(event('task_request',2));await h.runner.drain();assert.equal(h.state.effects,1);assert.equal(h.state.submissions,1);assert.ok(h.state.requests.find(r=>r.url.endsWith('/tool-output')).url.includes(chatId));
});
test('SIGN-01 invalid actual inner signature rejects before effects',async t=>{const h=harness(t,{native:true});await assert.rejects(h.runner.accept(fixtures.task_bad_signature),SignatureError);assert.equal(h.state.effects,0);assert.equal(h.state.submissions,0);});
test('DEDUP-01 repeated signed call is durable across runner recreation',async t=>{
 const h=harness(t,{native:true});await h.runner.accept(fixtures.task_request);await h.runner.accept(fixtures.task_request);await h.runner.drain();
 const restarted=h.client.createToolRunner({scope:'parity/account',store:h.store,registry:h.registry});await restarted.accept(fixtures.task_request);await restarted.drain();restarted.close();assert.equal(h.state.effects,1);assert.equal(h.state.submissions,1);
});
test('DEDUP-02 direct/wrapped/task ownership changes fail closed',async t=>{
 for(const [first,second]of [[fixtures.request,fixtures.task_request],[fixtures.task_request,fixtures.request],[fixtures.task_request,{...fixtures.task_request,data:{...fixtures.task_request.data,task_id:'other-task'}}]]){
  const h=harness(t,{native:true});await h.runner.accept(first);await h.runner.drain();await assert.rejects(h.runner.accept(second),/ownership/);assert.equal(h.state.effects,1);assert.equal(h.state.submissions,1);
 }
});
test('CANCEL-01 cancellation during real key verification bars admission',async t=>{
 let release,started;const entered=new Promise(r=>started=r);const verifier=new ToolRequestVerifier({get:async()=>{started();return new Promise(r=>release=r);}});
 const h=harness(t,{native:true,verifier});const admission=h.runner.accept(fixtures.task_request);await entered;await h.runner.accept(fixtures.task_cancelled);release(fixtures.jwks);await admission;await h.runner.drain();assert.equal(h.state.effects,0);assert.equal(h.state.submissions,0);
});
test('CANCEL-02 task terminal cancels active handler while origin terminal preserves it',async t=>{
 let entered;const started=new Promise(r=>entered=r);let signal;
 const h=harness(t,{native:true,handler:async(a,c)=>{signal=c.signal;entered();await new Promise(r=>c.signal.addEventListener('abort',r,{once:true}));return 'late';}});
 await h.runner.accept(fixtures.task_request);await started;await h.runner.accept(fixtures.turn_terminal);assert.equal(signal.aborted,false);await h.runner.accept(fixtures.task_cancelled);await h.runner.drain();assert.equal(signal.aborted,true);assert.equal(h.state.submissions,0);
});
test('MULTIPART-01 diagnostic images are repeated real files with bytes and filenames',async()=>{
 let calls=0;const client=new EnvaiClient({baseUrl:'https://offline.test',fetch:async(url,init)=>{calls++;assert.equal(init.headers.has('authorization'),false);assert.equal(init.headers.has('content-type'),false);assert.equal(init.body.get('files'),null);const parts=init.body.getAll('files[]');assert.equal(parts.length,calls);assert.equal(parts[0].name,'first.png');assert.equal(parts[0].type,'image/png');assert.deepEqual(new Uint8Array(await parts[0].arrayBuffer()),new Uint8Array([0,255,1]));if(parts.length===2){assert.equal(parts[1].name,'second.jpg');assert.equal(await parts[1].text(),'second');}assert.equal(init.body.get('prompt'),'diagnostic');return json({data:{ok:true}});}});
 const first=new File([new Uint8Array([0,255,1])],'first.png',{type:'image/png'}),second=new File(['second'],'second.jpg',{type:'image/jpeg'});
 for(const files of [[first],[first,second]])await client.testGenerateImage({body:{files,prompt:'diagnostic',model_code:'fixture'}});
 for(const files of [[],[{}],Array(5).fill(first),[new Blob([new Uint8Array(10_240*1024+1)])]])await assert.rejects(client.testGenerateImage({body:{files,prompt:'diagnostic',model_code:'fixture'}}),TypeError);assert.equal(calls,2);
});
const page=(current,last,next)=>({data:[],links:{next},meta:{current_page:current,last_page:last}});
test('PAGE-01 numeric pagination preserves filters/auth/base and validates absolute/relative links',async()=>{
 for(const next of ['https://offline.test/custom/api/v1/workspaces/w/chats/c/completions?page=2','?page=2','completions?page=2']){
  const requests=[];const client=new EnvaiClient({baseUrl:'https://offline.test/custom/api/v1',apiKey:'key',fetch:async(url,init)=>{requests.push(url);assert.equal(init.headers.get('authorization'),'Bearer key');assert.equal(init.headers.get('X-Envai-Contract-Version'),'3');const p=new URL(url);assert.equal(p.pathname,'/custom/api/v1/workspaces/w/chats/c/completions');assert.equal(p.searchParams.get('status'),'succeeded');return json(page(requests.length,2,requests.length===1?next:null));}});
  assert.deepEqual(await Array.fromAsync(client.completions.iterate({workspace_id:'w',chat_id:'c',status:'succeeded'})),[]);assert.deepEqual(requests.map(u=>new URL(u).searchParams.get('page')),['1','2']);
 }
 for(const next of ['https://evil.test/leak?page=2','/other?page=2','?page=3','?page=2&page=2','?page=2#fragment']){
  let calls=0;const client=new EnvaiClient({baseUrl:'https://offline.test',apiKey:'key',fetch:async()=>{calls++;return json(page(1,2,next));}});
  await assert.rejects(Array.fromAsync(client.iterateCompletions({workspace_id:'w',chat_id:'c'})),ProtocolError);assert.equal(calls,1);
 }
});
test('pagination bounds, metadata, cancellation and GET retry use the shared transport',async()=>{
 let calls=0;const client=new EnvaiClient({baseUrl:'https://offline.test',retry:{baseDelayMs:0},fetch:async()=>++calls===1?json({error:{type:'server_error'}},503):json(page(1,1,null))});
 await client.listCompletionPage({workspace_id:'w',chat_id:'c'});assert.equal(calls,2);
 for(const invalid of [0,-1,1.5,NaN,Infinity])assert.throws(()=>client.listCompletionPage({workspace_id:'w',chat_id:'c',page:invalid}),RangeError);
 await assert.rejects(Array.fromAsync(client.iterateCompletions({workspace_id:'w',chat_id:'c'},{maxPages:0})),RangeError);
 const abort=new AbortController();abort.abort();await assert.rejects(Array.fromAsync(client.iterateCompletions({workspace_id:'w',chat_id:'c'},{signal:abort.signal})),e=>e.name==='AbortError');
 for(const result of [page(2,2,null),page(1,0,null),page(1,2,null),page(1,1,'?page=2')]){const c=new EnvaiClient({baseUrl:'https://offline.test',fetch:async()=>json(result)});await assert.rejects(Array.fromAsync(c.iterateCompletions({workspace_id:'w',chat_id:'c'})),ProtocolError);}
 const bounded=new EnvaiClient({baseUrl:'https://offline.test',fetch:async()=>json(page(1,2,'?page=2'))});await assert.rejects(Array.fromAsync(bounded.iterateCompletions({workspace_id:'w',chat_id:'c'},{maxPages:1})),/maxPages/);
});
test('HTTP-01 job timeout includes initial capabilities negotiation and caller abort',async()=>{
 for(const callerCancel of [false,true]){
  let requests=0;const abort=new AbortController();const client=new EnvaiClient({baseUrl:'https://offline.test',nativeTasks:true,fetch:async(url,init)=>{requests++;return new Promise((r,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));}});
  const started=Date.now();const pending=client.waitForDelegatedJob('origin',scenarios.delegation_receipt,{timeoutMs:20,signal:abort.signal});if(callerCancel)abort.abort();await assert.rejects(pending,e=>['TimeoutError','AbortError'].includes(e.name));assert.ok(Date.now()-started<1_000);assert.equal(requests,1);
 }
});
test('MODE-01/MODE-02 legacy defaults and native acknowledgment are explicit',async()=>{
 for(const native of [false,true]){const requests=[];const client=new EnvaiClient({baseUrl:'https://offline.test',apiKey:'key',nativeTasks:native,fetch:async(url,init)=>{requests.push({url,init});return json({...capabilities,features},200,native?{'X-Envai-Extensions':'native-tasks-v1'}:{});}});await client.getCapabilities();assert.equal(requests[0].init.headers.get('X-Envai-Extensions'),native?'native-tasks-v1':null);assert.equal(requests[0].init.headers.get('authorization'),'Bearer key');}
 for(const ack of [undefined,'unknown','NATIVE-TASKS-V1']){let calls=0;const client=new EnvaiClient({baseUrl:'https://offline.test',nativeTasks:true,fetch:async()=>{calls++;return json({...capabilities,features},200,ack?{'X-Envai-Extensions':ack}:{});}});await assert.rejects(client.delegateToTeam({chat_id:scenarios.origin_chat_id,body:{workspace_id:'w',event_id:'once',origin_turn_id:turnId,target_chat_id:chatId,prompt:'work'}}),CompatibilityError);assert.equal(calls,1);}
});
test('MODE-03 missing capability prevents mutation; HTTP-02 uncertain classification stays one attempt',async()=>{
 let mutations=0;const client=new EnvaiClient({baseUrl:'https://offline.test',nativeTasks:true,fetch:async url=>{if(!url.endsWith('/capabilities'))mutations++;return json({...capabilities,features:[]},200,{'X-Envai-Extensions':'native-tasks-v1'});}});await assert.rejects(client.delegateToTeam({chat_id:scenarios.origin_chat_id,body:{workspace_id:'w',event_id:'once',origin_turn_id:turnId,target_chat_id:chatId,prompt:'work'}}),CompatibilityError);assert.equal(mutations,0);
 for(const status of [502,503,'lost']){let attempts=0;const c=new EnvaiClient({baseUrl:'https://offline.test',nativeTasks:true,retry:{maxRetries:5,baseDelayMs:0},fetch:async url=>{if(url.endsWith('/capabilities'))return json({...capabilities,features},200,{'X-Envai-Extensions':'native-tasks-v1'});attempts++;if(status==='lost')throw Error('offline');return json({error:{type:'server_error'}},status);}});await assert.rejects(c.classifyPhase({chat_id:chatId,body:{request_id:'durable',task_context:['json'],phase_id:'review',attempt:1,final_output:'done'}}));assert.equal(attempts,1);}
});
for(const status of ['completed','failed','cancelled'])test(`JOB-01/JOB-02 real signed target tool and final origin task ${status}`,async t=>{
 let reads=0,admissions=0;const receipt=scenarios.delegation_receipt;
 const h=harness(t,{native:true,fetch:async(url,init,state,response)=>{
  if(url.endsWith('/delegations')){admissions++;state.controllers[0].enqueue(wire(event('turn_terminal',1)));state.controllers[0].enqueue(wire(event('task_request',2)));return response(receipt);}
  if(url.includes('/tasks/')){reads++;assert.ok(url.includes(scenarios.origin_chat_id));await tick();return response({task_id:receipt.task_id,origin_turn_id:turnId,target_chat_id:chatId,status:state.submissions?status:'running',output:state.submissions?'FINAL JOB OUTPUT':'',result_turn_id:state.submissions?'cmpl_01ARZ3NDEKTSV4RRFFQ69G5FAW':undefined});}
 }});
 const result=await h.client.delegateAndWait(scenarios.origin_chat_id,{workspace_id:'w',event_id:'durable',origin_turn_id:turnId,target_chat_id:chatId,prompt:'work',notify_origin:false,strict_model:true},{toolRunner:h.runner,pollIntervalMs:1,timeoutMs:1000,maxReconnects:0});await h.runner.drain();assert.equal(result.task.status,status);assert.equal(result.task.output,'FINAL JOB OUTPUT');assert.notEqual(result.task.result_turn_id,result.receipt.turn_id);assert.equal(h.state.effects,1);assert.equal(h.state.submissions,1);assert.equal(admissions,1);assert.ok(reads>=1);assert.equal(h.state.closed,1);for(const req of h.state.requests)assert.equal(req.init.headers.get('X-Envai-Extensions'),'native-tasks-v1');
});
test('JOB-03 resume receipt replays pending tools with no new delegation; UNKNOWN-01 task_unknown errors',async t=>{
 for(const unknown of [false,true]){
 const receipt=scenarios.delegation_receipt;const h=harness(t,{native:true,pre:[event('task_request',1)],fetch:async(url,init,state,response)=>{if(url.includes('/tasks/')){await tick();return unknown?json({error:{type:'not_found',code:'task_unknown',message:'unknown'}},404):response({task_id:receipt.task_id,origin_turn_id:turnId,target_chat_id:chatId,status:state.submissions?'completed':'running',output:'FINAL',result_turn_id:'cmpl_01ARZ3NDEKTSV4RRFFQ69G5FAW'});}}});
 const waiting=h.client.waitForDelegatedJob(scenarios.origin_chat_id,receipt,{toolRunner:h.runner,pollIntervalMs:1,timeoutMs:1000,maxReconnects:0});if(unknown)await assert.rejects(waiting,e=>e.code==='task_unknown');else assert.equal((await waiting).output,'FINAL');await h.runner.drain();assert.equal(h.state.requests.some(r=>r.url.endsWith('/delegations')),false);assert.equal(h.state.closed,1);
 }
});
test('STATE-01 corrupt persisted tool claim fails closed without overwrite',async t=>{
 const h=harness(t,{native:true});const key=h.runner.key(chatId,fixtures.request.data.call_id);writeFileSync(h.store.path(key),'null');await assert.rejects(h.runner.accept(fixtures.task_request),e=>e.code==='invalid_tool_state');assert.equal(readFileSync(h.store.path(key),'utf8'),'null');assert.equal(h.state.effects,0);assert.equal(h.state.submissions,0);
});
test('ERROR-01 integrated job waiter surfaces tool-output uncertainty before timeout',async t=>{
 const receipt=scenarios.delegation_receipt;const h=harness(t,{native:true,pre:[event('task_request',1)],fetch:async(url,init,state,response)=>{if(url.endsWith('/tool-output'))throw Error('uncertain delivery');if(url.includes('/tasks/'))return response({task_id:receipt.task_id,origin_turn_id:turnId,target_chat_id:chatId,status:'running'});}});
 const start=Date.now();await assert.rejects(h.client.waitForDelegatedJob(scenarios.origin_chat_id,receipt,{toolRunner:h.runner,pollIntervalMs:100,timeoutMs:1000,maxReconnects:0}),e=>e.name==='TransportError');assert.ok(Date.now()-start<500);assert.equal(h.state.effects,1);assert.equal(h.state.submissions,1);assert.equal(h.state.closed,1);await assert.rejects(h.runner.drain(),AggregateError);
});
test('JOB-02 exact delegated receipt retry executes pending signed replay once',async t=>{
 const receipt=scenarios.delegation_receipt;let admissions=0;const h=harness(t,{native:true,pre:[event('task_request',1)],fetch:async(url,init,state,response)=>{if(url.endsWith('/delegations')){admissions++;assert.equal(JSON.parse(init.body).event_id,'existing-event');return response(receipt);}if(url.includes('/tasks/')){await tick();return response({task_id:receipt.task_id,origin_turn_id:turnId,target_chat_id:chatId,status:state.submissions?'completed':'running',output:'FINAL',result_turn_id:'cmpl_01ARZ3NDEKTSV4RRFFQ69G5FAW'});}}});
 const result=await h.client.delegateAndWait(scenarios.origin_chat_id,{workspace_id:'w',event_id:'existing-event',origin_turn_id:turnId,target_chat_id:chatId,prompt:'work'},{toolRunner:h.runner,pollIntervalMs:1,timeoutMs:1000,maxReconnects:0});assert.equal(result.task.output,'FINAL');assert.equal(admissions,1);assert.equal(h.state.effects,1);assert.equal(h.state.submissions,1);
});
test('JOB-03 exact terminal receipt replay bars signed historical tool effects',async t=>{
 for(const status of ['completed','failed','cancelled']){
  const receipt=scenarios.delegation_receipt;const terminal=event('task_cancelled',2);terminal.type=`task.${status}`;terminal.data.status=status;
  const h=harness(t,{native:true,pre:[event('task_request',1),terminal],fetch:async(url,init,state,response)=>{if(url.endsWith('/delegations'))return response(receipt);if(url.includes('/tasks/'))return response({task_id:receipt.task_id,origin_turn_id:turnId,target_chat_id:chatId,status,output:'FINAL',error:status==='failed'?'job error':undefined,result_turn_id:'cmpl_01ARZ3NDEKTSV4RRFFQ69G5FAW'});}});
  const result=await h.client.delegateAndWait(scenarios.origin_chat_id,{workspace_id:'w',event_id:'existing',origin_turn_id:turnId,target_chat_id:chatId,prompt:'work'},{toolRunner:h.runner,timeoutMs:1000,maxReconnects:0});assert.equal(result.task.status,status);assert.equal(result.task.output,'FINAL');assert.equal(result.task.error,status==='failed'?'job error':undefined);await h.runner.drain();assert.equal(h.state.effects,0);assert.equal(h.state.submissions,0);
 }
});
test('HTTP-03/HTTP-04 request identity and typed safe errors retain caller correlation',async()=>{
 for(const status of [200,401,403,404,409,422,429,502,503]){
  const observed=[];const client=new EnvaiClient({baseUrl:'https://offline.test',apiKey:'never-print-secret',retry:{maxRetries:0},onObservation:e=>observed.push(e),fetch:async(url,init)=>{assert.equal(init.headers.get('X-Request-ID'),'caller-id');return json(status===200?{data:{id:'workspace'}}:{error:{type:'typed_error',code:'exact_code',details:{safe:'value'}}},status,{'X-Request-ID':'server-id'});}});
  const call=client.getWorkspace({workspace_id:'w'},{headers:{'X-Request-ID':'caller-id'}});if(status===200)await call;else await assert.rejects(call,e=>e.httpStatus===status&&e.code==='exact_code'&&e.requestId==='server-id'&&e.details.safe==='value'&&!String(e).includes('never-print-secret'));
  assert.equal(observed.find(e=>e.kind==='request.end').requestId,'server-id');assert.equal(JSON.stringify(observed).includes('never-print-secret'),false);
  for(const header of ['Authorization','Host','X-Envai-Contract-Version','X-Envai-Extensions'])await assert.rejects(client.getWorkspace({workspace_id:'w'},{headers:{[header]:'override'}}),TypeError);
 }
});
test('STREAM-01/ERROR-01 foreign-chat and bad signed replay fail before tool effects',async t=>{
 for(const request of [{...event('task_request',1),chat_id:scenarios.origin_chat_id},{...fixtures.task_bad_signature,seq:1}]){const h=harness(t,{native:true,pre:[request]});await assert.rejects(h.client.waitForDelegatedJob(scenarios.origin_chat_id,scenarios.delegation_receipt,{toolRunner:h.runner,timeoutMs:500,maxReconnects:0}),e=>e instanceof ProtocolError||e instanceof SignatureError);assert.equal(h.state.effects,0);assert.equal(h.state.submissions,0);assert.equal(h.state.closed,1);}
});
test('STREAM-02 EOF while final task is running rejects promptly',async t=>{
 const receipt=scenarios.delegation_receipt;let closed=false;const h=harness(t,{native:true,fetch:async(url,init,state,response)=>{if(url.includes('/tasks/')){if(!closed){closed=true;state.controllers[0].close();}return response({task_id:receipt.task_id,origin_turn_id:turnId,target_chat_id:chatId,status:'running'});}}});
 const start=Date.now();await assert.rejects(h.client.waitForDelegatedJob(scenarios.origin_chat_id,receipt,{toolRunner:h.runner,pollIntervalMs:1,timeoutMs:1000,maxReconnects:0}),e=>e.name==='TransportError');assert.ok(Date.now()-start<500);assert.equal(h.state.effects,0);
});
test('STATE-01 explicit failed delivery and subtree cancellation remain distinct from final task',async t=>{
 const h=harness(t,{native:true,fetch:async(url,init,state,response)=>{if(url.endsWith('/deliveries'))return response({event_id:'event',status:'failed',duplicate:false,error:'delivery admission failed'});if(url.endsWith('/cancel')){assert.equal(JSON.parse(init.body).subtree,true);return response({task_id:'job',status:'cancelled',subtree:true});}}});
 const delivered=await h.client.deliverWorkflowResult({chat_id:chatId,body:{workspace_id:'w',event_id:'event',origin_turn_id:turnId,task_id:'job',status:'cancelled',output:'cancelled result'}});assert.equal(delivered.status,'failed');assert.equal(delivered.error,'delivery admission failed');const cancelled=await h.client.cancelDetachedTask({chat_id:chatId,task_id:'job',body:{subtree:true}});assert.equal(cancelled.subtree,true);assert.equal(cancelled.status,'cancelled');
});
