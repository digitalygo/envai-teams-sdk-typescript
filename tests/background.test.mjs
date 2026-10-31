import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvaiClient, parseEvent, ClientToolRunner, ClientToolRegistry, MemoryToolStateStore, ToolRequestVerifier, SignatureError, ProtocolError, CompatibilityError, NotFoundError, assertToolRecord } from '../dist/index.js';
import { event, requestEvent, signatures, chatId, turnId, json, capabilities, tick } from './helpers.mjs';
const features=['detached_background','native_deliveries','cross_team_delegation','delegated_job_lifecycle','delegation_notify_origin','strict_model','phase_classification'];
const body={workspace_id:'wsp_example',event_id:'job-1',origin_turn_id:turnId,target_chat_id:chatId,prompt:'Work',notify_origin:false,strict_model:true};
const receipt={task_id:'task-1',target_chat_id:chatId,turn_id:turnId};
const terminal={task_id:receipt.task_id,origin_turn_id:turnId,target_chat_id:chatId,status:'completed',output:'FINAL',result_turn_id:'cmpl_01ARZ3NDEKTSV4RRFFQ69G5FAW'};
const wrapper=(inner=requestEvent(), taskId='task-1')=>({...inner,v:3,turn_id:null,type:'task.event',data:{task_id:taskId,origin_turn_id:turnId,event_type:inner.type,event_payload:inner.data}});
const taskEnd=(status='completed')=>({...event('turn.completed'),v:3,turn_id:null,agent:null,type:`task.${status}`,data:{task_id:'task-1',origin_turn_id:turnId,status,output:'done',error:''}});
function runner(handler=()=> 'ok',store=new MemoryToolStateStore(),signal) {
 const posts=[];
 const registry=new ClientToolRegistry().register({name:requestEvent().data.tool_name,parameters:{type:'object'},handler});
 const instance=new ClientToolRunner({scope:'test',store,registry,signal,verifier:new ToolRequestVerifier({get:async()=>signatures.jwks}),submit:async(chat,body)=>{posts.push({chat,body});}});
 return {instance,posts,store};
}
test('root completion diagnostics validate without loosening legacy payloads',()=>{
 const original={...requestEvent(),type:'agent.done',data:{status:'completed',summary:'done',usage:event('turn.completed').data.usage,duration_ms:1}};original.v=3;original.data.requested_model='selected';original.data.model='provider/alias';assert.equal(parseEvent(original).data.model,'provider/alias');
 const control=structuredClone(original);delete control.data.model;delete control.data.requested_model;parseEvent(control);
 original.v=2;assert.throws(()=>parseEvent(original),ProtocolError);
});
test('wrapped signed tools survive origin terminal, deduplicate calls and submit to execution chat',async()=>{
 let effects=0;const r=runner((_,context)=>{effects++;assert.equal(context.taskId,'task-1');assert.equal(context.turnId,turnId);return 'done';});
 await r.instance.accept(event('turn.completed'));
 await r.instance.accept(wrapper());await r.instance.accept(wrapper());await r.instance.drain();assert.equal(effects,1);assert.equal(r.posts[0].chat,chatId);
 const result=event('agent.tool.result');result.data.call_id=requestEvent().data.call_id;await r.instance.accept(wrapper(result));
 assert.equal((await r.store.get(r.instance.key(chatId,result.data.call_id))).state,'resolved');
 const bad=wrapper();bad.data.event_payload.args.tampered=true;await assert.rejects(r.instance.accept(bad),SignatureError);
 await r.instance.accept(wrapper(event('agent.text.delta')));
});
test('task terminal is durable admission barrier and cancels only task-owned work',async()=>{
 for(const status of ['completed','failed','cancelled']) {
  let started=0;const r=runner(async(_,ctx)=>{started++;await new Promise(resolve=>ctx.signal.addEventListener('abort',resolve,{once:true}));return 'late';});
  await r.instance.accept(wrapper());await tick();await r.instance.accept(taskEnd(status));await r.instance.drain();assert.equal(started,1);assert.equal(r.posts.length,0);
  const resumed=runner(()=>{throw Error('must never run');},r.store);await resumed.instance.accept(wrapper());await resumed.instance.drain();assert.equal(resumed.posts.length,0);
 }
 const r=runner();await r.instance.accept(taskEnd());await r.instance.accept(wrapper());await r.instance.drain();assert.equal(r.posts.length,0);
});
test('task ownership cannot change under an existing call ID; task records reject malformed identity',async()=>{
 const r=runner();await r.instance.accept(wrapper());await r.instance.drain();await assert.rejects(r.instance.accept(wrapper(requestEvent(),'other-task')),/ownership/);
 const result=event('agent.tool.result');result.data.call_id=requestEvent().data.call_id;await assert.rejects(r.instance.accept(wrapper(result,'other-task')),/ownership/);
 const record=await r.store.get(r.instance.key(chatId,result.data.call_id));assert.throws(()=>assertToolRecord(r.instance.key(chatId,result.data.call_id),{...record,taskId:''}));
});
function clientWith(fetch, advertised=features) {return new EnvaiClient({baseUrl:'https://example.test',nativeTasks:true,retry:{maxRetries:0},fetch:async(url,init)=>{const response=await (new URL(url).pathname.endsWith('/capabilities')?json({...capabilities,families:['turn','agent','chat','task'],features:advertised}):fetch(url,init));response.headers.set('X-Envai-Extensions','native-tasks-v1');return response;}});}
test('native primitives route exactly, retain typed states, and gate negotiated features',async()=>{
 const cases=[['deliverWorkflowResult',{chat_id:chatId,body:{workspace_id:'w',event_id:'e',origin_turn_id:turnId,task_id:'task',status:'blocked',output:'result'}},{event_id:'e',status:'failed',duplicate:false,error:'admission'},'deliveries'],['delegateToTeam',{chat_id:chatId,body},receipt,'delegations'],['getDetachedTask',{chat_id:chatId,task_id:'task'},terminal,'tasks/task'],['cancelDetachedTask',{chat_id:chatId,task_id:'task',body:{subtree:true}},{task_id:'task',status:'cancelled',subtree:true},'tasks/task/cancel'],['classifyPhase',{chat_id:chatId,body:{request_id:'once',task_context:{goal:'x'},phase_id:'review',attempt:1,final_output:'done'}},{request_id:'once',invocation_id:'inv',model:'fixed',decision:'NOT BLOCKED'},'classify-phase']];
 for(const [method,args,response,path] of cases) {
  let calls=0;const c=clientWith(async(url,init)=>{calls++;assert.equal(new URL(url).pathname,`/api/v1/atp/v3/chats/${chatId}/${path}`);assert.equal(init.headers.get('X-Envai-Contract-Version'),'3');assert.equal(init.headers.get('X-Envai-Extensions'),'native-tasks-v1');return json(response);});
  assert.deepEqual(await c[method](args),response);assert.equal(calls,1);
  await assert.rejects(clientWith(()=>{throw Error('unexpected mutation');},[])[method](args),CompatibilityError);
 }
 for(const missing of ['strict_model','delegation_notify_origin'])await assert.rejects(clientWith(()=>{throw Error('unexpected');},features.filter(x=>x!==missing)).delegateToTeam({chat_id:chatId,body}),CompatibilityError);
 await assert.rejects(clientWith(()=>{throw Error('unexpected');},[]).sendChatMessage({chat_id:chatId,body:{message:'hello',strict_model:true}}),CompatibilityError);
});
test('classification validates context, never retries uncertain admission; missing tasks remain unknown',async()=>{
 const args={chat_id:chatId,body:{request_id:'once',task_context:'goal',phase_id:'review',attempt:1,final_output:'done'}};
 for(const status of [502,503]){let calls=0;await assert.rejects(clientWith(async()=>{calls++;return json({error:{type:'server_error',message:'unknown'}},status);}).classifyPhase(args));assert.equal(calls,1);}
 let calls=0;await assert.rejects(clientWith(async()=>{calls++;throw Error('lost');}).classifyPhase(args));assert.equal(calls,1);
 for(const patch of [{task_context:null},{attempt:0},{final_output:''}])await assert.rejects(clientWith(()=>{throw Error('unexpected');}).classifyPhase({...args,body:{...args.body,...patch}}),ProtocolError);
 await assert.rejects(clientWith(()=>json({error:{type:'not_found',code:'task_unknown',message:'Unknown'}},404)).getDetachedTask({chat_id:chatId,task_id:'missing'}),e=>e instanceof NotFoundError&&e.code==='task_unknown');
 for(const body of [undefined,[],{subtree:'yes'},{extra:true}])await assert.rejects(clientWith(()=>{}).cancelDetachedTask({chat_id:chatId,task_id:'task',body}),ProtocolError);
});
function streamClient({status='completed',resume=false, badTarget=false, never=false, noPing=false, replay=false, missing=false}={}) {
 let controller,closed=false,posted=false,reads=0;const accepted=[];
 const emit=e=>controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));
 const client=clientWith(async(url,init)=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/events')) return new Response(new ReadableStream({start(c){controller=c;if(replay)emit({...requestEvent(),v:3});if(!noPing)emit(event('ping',0));},cancel(){closed=true;}}),{headers:{'content-type':'text/event-stream','X-Envai-Contract-Version':'3'}});
  if(path.endsWith('/delegations')) {posted=true;emit(event('turn.completed',1));emit(wrapper({...requestEvent(),seq:2}));return json({...receipt,target_chat_id:badTarget?'wrong':chatId});}
  if(path.includes('/tasks/')) {reads++;if(missing)return json({error:{type:'not_found',code:'task_unknown'}},404);await tick();return json({...terminal,status:never||reads===1?'running':status});}
  throw Error(path);
 });
 return {client,accepted,options:{pollIntervalMs:1,timeoutMs:500,readyTimeoutMs:100,maxReconnects:0,toolRunner:{accept:async e=>accepted.push(e)}},get closed(){return closed;},get posted(){return posted;},emit};
}
test('delegated waiter keeps target stream after ack and returns final origin job output/result turn',async()=>{
 for(const status of ['completed','failed','cancelled']) {
  const s=streamClient({status});const result=await s.client.delegateAndWait(chatId,body,s.options);
  assert.equal(result.task.status,status);assert.equal(result.task.output,'FINAL');assert.notEqual(result.task.result_turn_id,result.receipt.turn_id);assert.ok(s.accepted.some(e=>e.type==='task.event'));assert.ok(s.closed);
 }
 const s=streamClient({resume:true,replay:true});const result=await s.client.waitForDelegatedJob(chatId,receipt,s.options);assert.equal(result.output,'FINAL');assert.ok(!s.posted);assert.ok(s.accepted.some(e=>e.type==='agent.tool.request'));
});
test('background waits fail closed on capability, identity, stream readiness, unknown task and cancellation',async()=>{
 await assert.rejects(clientWith(()=>{},[]).delegateAndWait(chatId,body),CompatibilityError);
 for(const config of [{badTarget:true},{missing:true},{noPing:true},{never:true}]){const s=streamClient(config);await assert.rejects(s.client.delegateAndWait(chatId,body,{...s.options,timeoutMs:20,readyTimeoutMs:10}));assert.ok(s.closed);if(config.noPing)assert.ok(!s.posted);}
 const s=streamClient({never:true});const abort=new AbortController();const waiting=s.client.delegateAndWait(chatId,body,{...s.options,signal:abort.signal});setTimeout(()=>abort.abort(),10);await assert.rejects(waiting);assert.ok(s.closed);
});
test('explicit task subscription continues past foreground terminal and closes on caller break',async()=>{
 await assert.rejects(async()=>{for await(const e of clientWith(()=>{},[]).taskEvents(chatId)){}},CompatibilityError);
 let closed=false;const c=clientWith(async()=>new Response(new ReadableStream({start(controller){for(const e of [event('ping',0),event('turn.completed',1),wrapper({...requestEvent(),seq:2})])controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));},cancel(){closed=true;}}),{headers:{'content-type':'text/event-stream','X-Envai-Contract-Version':'3'}}));
 const seen=[];for await(const e of c.taskEvents(chatId)){if(e.type!=='ping')seen.push(e.type);if(seen.length===2)break;}assert.deepEqual(seen,['turn.completed','task.event']);assert.ok(closed);
});

test('replayed resolved or terminal task requests never execute handlers before readiness',async()=>{
 for(const resolution of ['task','result','turn']) {
  let effects=0;const r=runner(()=>{effects++;return 'unsafe';});
  const request=resolution==='turn'?{...requestEvent(),v:3}:wrapper();request.seq=1;
  let end=resolution==='task'?taskEnd():resolution==='turn'?event('turn.completed'):wrapper(event('agent.tool.result'));
  if(resolution==='result')end.data.event_payload.call_id=requestEvent().data.call_id;
  end.seq=2;
  const c=clientWith(async()=>new Response(new ReadableStream({start(controller){for(const e of [request,end,event('ping',0)])controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));}}),{headers:{'content-type':'text/event-stream','X-Envai-Contract-Version':'3'}}));
  for await(const e of c.taskEvents(chatId,{toolRunner:r.instance})) {if(e.type==='ping')break;}
  await r.instance.drain();assert.equal(effects,0);
 }
});

test('native extension is explicit and consistently selected for capabilities, streams and tools',async()=>{
 assert.throws(()=>new EnvaiClient({baseUrl:'https://example.test',contractVersion:2,nativeTasks:true}),CompatibilityError);
 const ordinary=new EnvaiClient({baseUrl:'https://example.test',fetch:()=>{throw Error('must not request');}});
 await assert.rejects(ordinary.delegateToTeam({chat_id:chatId,body}),/nativeTasks/);
 await assert.rejects(ordinary.sendChatMessage({chat_id:chatId,body:{message:'hello',strict_model:true}}),/nativeTasks/);
 await assert.rejects(ordinary.delegateAndWait(chatId,body),/nativeTasks/);
 await assert.rejects(async()=>{for await(const e of ordinary.taskEvents(chatId)){}},/nativeTasks/);
 const seen=[];const c=new EnvaiClient({baseUrl:'https://example.test',nativeTasks:true,fetch:async(url,init)=>{seen.push({url,headers:init.headers});return url.endsWith('/capabilities')?json({...capabilities,features},200,{'X-Envai-Extensions':'native-tasks-v1'}):new Response(null,{status:204,headers:{'X-Envai-Contract-Version':'3','X-Envai-Extensions':'native-tasks-v1'}});}});
 await c.resolveChatTool({chat_id:chatId,body:{call_id:requestEvent().data.call_id,output:'done',is_error:false}});
 assert.equal(seen.length,2);assert.ok(seen.every(r=>r.headers.get('X-Envai-Extensions')==='native-tasks-v1'));
 await assert.rejects(c.getCapabilities({}, {headers:{'X-Envai-Extensions':'other'}}),TypeError);
});

test('shared caller signal cancels admitted task handler when delegated waiting is aborted',async()=>{
 const abort=new AbortController();let startedResolve;const started=new Promise(resolve=>startedResolve=resolve);
 const r=runner(async(_args,ctx)=>{startedResolve();await new Promise(resolve=>ctx.signal.addEventListener('abort',resolve,{once:true}));return 'late';},new MemoryToolStateStore(),abort.signal);
 const s=streamClient({never:true});
 const waiting=s.client.delegateAndWait(chatId,body,{...s.options,toolRunner:r.instance,signal:abort.signal});
 await started;abort.abort();await assert.rejects(waiting);await r.instance.drain();assert.equal(r.posts.length,0);assert.ok(s.closed);r.instance.close();
});

test('cancellation responses preserve explicit cancelled state and reject malformed receipts',async()=>{
 for(const response of [null,[],{}, {task_id:'task',status:'completed',subtree:false},{task_id:'',status:'cancelled',subtree:false},{task_id:'task',status:'cancelled',subtree:'false'},{task_id:'task',status:'cancelled',subtree:false,extra:true}])await assert.rejects(clientWith(()=>json(response)).cancelDetachedTask({chat_id:chatId,task_id:'task',body:{}}),ProtocolError);
});

test('native message admission requires the negotiated detached capability before POST',async()=>{
 await assert.rejects(clientWith(()=>{throw Error('must not post');},[]).sendChatMessage({chat_id:chatId,body:{message:'background work'}}),CompatibilityError);
});

test('foreground send helper never dispatches replayed detached requests before readiness',async()=>{
 const r=runner(()=>{throw Error('replayed task must not execute');});
 let controller;const emit=e=>controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));
 const c=clientWith(async(url)=>{
  if(url.includes('/events'))return new Response(new ReadableStream({start(c){controller=c;emit(wrapper());emit(event('ping',0));}}),{headers:{'content-type':'text/event-stream','X-Envai-Contract-Version':'3'}});
  emit(event('turn.completed',2));return json({status:'accepted',turn_id:turnId});
 });
 await c.sendAndWait(chatId,{message:'hello'},{toolRunner:r.instance});await r.instance.drain();assert.equal(r.posts.length,0);
});

test('native response acknowledgment is mandatory before hydration or stream dispatch',async()=>{
 for(const extension of [undefined,'other']) {
  const c=new EnvaiClient({baseUrl:'https://example.test',nativeTasks:true,fetch:async()=>json({...capabilities,features},200,extension?{'X-Envai-Extensions':extension}:{})});
  await assert.rejects(c.getCapabilities(),/extension acknowledgment/);
 }
 let posts=0;
 const c=new EnvaiClient({baseUrl:'https://example.test',nativeTasks:true,fetch:async(url)=>url.endsWith('/capabilities')?json({...capabilities,features},200,{'X-Envai-Extensions':'native-tasks-v1'}):(posts++,json(receipt))});
 await assert.rejects(c.delegateToTeam({chat_id:chatId,body}),/outcome may be unknown/);assert.equal(posts,1);
});
test('legacy projected neutral events preserve sequence and remain ignorable',()=>{
 const neutral={...event('turn.completed'),v:3,type:'chat.extension',turn_id:null,agent:null,data:{}};
 const parsed=parseEvent(neutral);assert.equal(parsed.known,false);assert.equal(parsed.seq,neutral.seq);
});

test('exact delegation receipt retry services a signed pending replay before waiting for final job',async()=>{
 const r=runner();let controller,submitted=false;
 const c=clientWith(async(url)=>{
  if(url.includes('/events'))return new Response(new ReadableStream({start(c){controller=c;for(const e of [wrapper(),event('ping',0)])c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));}}),{headers:{'content-type':'text/event-stream','X-Envai-Contract-Version':'3'}});
  if(url.endsWith('/delegations')){assert.equal(r.posts.length,0);submitted=true;return json(receipt);}
  if(url.includes('/tasks/')){await tick();return json({...terminal,status:r.posts.length?'completed':'running'});}
  throw Error(url);
 });
 const result=await c.delegateAndWait(chatId,body,{toolRunner:r.instance,pollIntervalMs:1,timeoutMs:500});await r.instance.drain();assert.ok(submitted);assert.equal(r.posts.length,1);assert.equal(result.task.output,'FINAL');
});
