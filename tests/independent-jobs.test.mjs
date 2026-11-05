import test from 'node:test';
import assert from 'node:assert/strict';
import {EnvaiClient,CompatibilityError,ProtocolError} from '../dist/index.js';
import {capabilities,json,chatId} from './helpers.mjs';
const features=['detached_background','independent_jobs','finite_choice_classification','native_deliveries','originless_deliveries','strict_model'];
const body={request_id:'choice',context:{full:'output'},question:'Next?',choices:[{label:'Continue',description:'Ready'},{label:'Ask',description:'Missing input'}]};
const choice={choice:'Continue',request_id:'choice',model:'configured',invocation_id:'inv'};
const job={workspace_id:'w',request_id:'job',prompt:'Work',strict_model:true};
const delivery={workspace_id:'w',event_id:'notice',task_id:'task',status:'completed',output:'full',strict_model:true};
const final={task_id:'task',origin_turn_id:'',target_chat_id:chatId,status:'completed',output:'FINAL',result_turn_id:'final-turn'};
function client(handler, available=features,ack=true) {
 return new EnvaiClient({baseUrl:'https://example.test',nativeTasks:true,fetch:async(url,init)=>{
  const discovery=new URL(url).pathname.endsWith('/capabilities');
  const response=await(discovery?json({...capabilities,features:available}):handler(url,init));
  if(ack||discovery)response.headers.set('X-Envai-Extensions','native-tasks-v1');return response;
 }});
}
test('job and finite choice generated routes and ergonomic bindings preserve contracts',async()=>{
 const seen=[];let reads=0;
 const c=client((url,init)=>{seen.push({url,init});const path=new URL(url).pathname;assert.equal(init.headers.get('X-Envai-Extensions'),'native-tasks-v1');
  if(path.endsWith('/jobs'))return json({task_id:'task',turn_id:'initial-turn'},202);
  if(path.endsWith('/classify-choice'))return json(choice);
  if(path.endsWith('/deliveries'))return json({event_id:'notice',status:'queued',duplicate:false},202);
  reads++;return json({...final,status:reads===1?'running':'completed'});
 });
 const receipt=await c.chats.startJob({chat_id:chatId,body:job});assert.equal(receipt.turn_id,'initial-turn');
 assert.deepEqual(await c.chats.classifyChoice({chat_id:chatId,body}),choice);
 await c.chats.deliver({chat_id:chatId,body:delivery});await c.chats.deliver({chat_id:chatId,body:{...delivery,origin_turn_id:''}});
 const result=await c.waitForIndependentJob(chatId,'task',{pollIntervalMs:1,timeoutMs:500});assert.equal(result.output,'FINAL');assert.notEqual(result.result_turn_id,receipt.turn_id);
 assert.equal(seen.filter(value=>value.init.method==='POST').length,4);
});
test('new capabilities and strict policy gate admission without mutations',async()=>{
 for(const [method,request,required]of [['startIndependentJob',job,'independent_jobs'],['startIndependentJob',job,'strict_model'],['classifyChoice',body,'finite_choice_classification'],['deliverWorkflowResult',delivery,'originless_deliveries'],['deliverWorkflowResult',delivery,'strict_model']]) {
  let effects=0;await assert.rejects(client(()=>{effects++;throw Error('mutation');},features.filter(value=>value!==required))[method]({chat_id:chatId,body:request}),CompatibilityError);assert.equal(effects,0);
 }
 const legacy=new EnvaiClient({baseUrl:'https://example.test',fetch:()=>{throw Error('network');}});
 await assert.rejects(legacy.startIndependentJob({chat_id:chatId,body:job}),CompatibilityError);
 await assert.rejects(legacy.waitForIndependentJob(chatId,'task'),CompatibilityError);
 await assert.rejects(client(()=>{},[]).waitForIndependentJob(chatId,'task'),CompatibilityError);
});
test('finite choice requests reject malformed labels and enforce byte and full-context bounds',async()=>{
 const patches=[{context:null},{question:' '},{question:'é'.repeat(5000)},{request_id:' '},{request_id:'é'.repeat(100)},{context:'x'.repeat(1024*1024)},
  ...[' Continue','Continue ','bad\nlabel','é'.repeat(100)].map(label=>({choices:[{label,description:'x'},body.choices[1]]})),
  {choices:[body.choices[0],body.choices[0]]},...[' ','é'.repeat(3000)].map(description=>({choices:[{label:'First',description},body.choices[1]]}))];
 for(const patch of patches)await assert.rejects(client(()=>{throw Error('mutation');}).classifyChoice({chat_id:chatId,body:{...body,...patch}}),ProtocolError);
});
test('finite choice response belongs to exact request and caller-supplied labels',async()=>{
 for(const patch of [{choice:'Other'},{request_id:'other'},{model:''},{invocation_id:''}])await assert.rejects(client(()=>json({...choice,...patch})).classifyChoice({chat_id:chatId,body}),ProtocolError);
 for(const receipt of [{task_id:'',turn_id:'t'},{task_id:'task',turn_id:''}])await assert.rejects(client(()=>json(receipt,202)).startIndependentJob({chat_id:chatId,body:job}),ProtocolError);
});
test('empty origin is explicit identity and needs independent-job capability',async()=>{
 for(const patch of [{task_id:'wrong'},{origin_turn_id:'origin'},{target_chat_id:'other'}])await assert.rejects(client(()=>json({...final,...patch})).waitForIndependentJob(chatId,'task',{timeoutMs:100}),ProtocolError);
 await assert.rejects(client(()=>json(final),features.filter(value=>value!=='independent_jobs')).chats.task({chat_id:chatId,task_id:'task'}),CompatibilityError);
 const missing={...final};delete missing.origin_turn_id;await assert.rejects(client(()=>json(missing)).chats.task({chat_id:chatId,task_id:'task'}),ProtocolError);
 const abort=new AbortController();abort.abort();await assert.rejects(client(()=>json(final)).waitForIndependentJob(chatId,'task',{signal:abort.signal}));
 await assert.rejects(client(()=>json({...final,status:'running'})).waitForIndependentJob(chatId,'task',{timeoutMs:10,pollIntervalMs:1}));
});
test('unknown outcomes and acknowledgments never cause automatic paid retries',async()=>{
 for(const [method,request]of [['classifyChoice',body],['startIndependentJob',job],['deliverWorkflowResult',delivery]])for(const failure of [503,502,'lost']){
  let effects=0;const c=client(()=>{effects++;if(failure==='lost')throw Error('connection lost');return json({error:{type:'server_error',message:'unknown'}},failure);});
  await assert.rejects(c[method]({chat_id:chatId,body:request}));assert.equal(effects,1);
 }
 let effects=0;await assert.rejects(client(()=>{effects++;return json(choice);},features,false).classifyChoice({chat_id:chatId,body}),CompatibilityError);assert.equal(effects,1);
});
