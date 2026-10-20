import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvaiClient, CompatibilityError, ConflictError, ProtocolError, uploadAttachmentFile, waitForAttachment, parseEvent, validateContractValue } from '../dist/index.js';
import { json, capabilities, sse, event, chatId } from './helpers.mjs';
const ready=JSON.parse(readFileSync(new URL('../testdata/chat-attachments/ready.json',import.meta.url))).data;
const pending=JSON.parse(readFileSync(new URL('../testdata/chat-attachments/pending.json',import.meta.url))).data;
const failed=JSON.parse(readFileSync(new URL('../testdata/chat-attachments/failed.json',import.meta.url))).data;
const originalReady=JSON.parse(readFileSync(new URL('../testdata/chat-attachments/original-ready.json',import.meta.url))).data;
const caps={...capabilities,features:['chat_attachments','chat_attachment_originals']};
const params={workspace_id:'w/a',chat_id:'c/b',attachment_id:ready.attachment_id};
const client=fetch=>new EnvaiClient({baseUrl:'https://api.example',fetch:async(u,i)=>u.endsWith('/capabilities')?json(caps):fetch(u,i)});
for(const [method,extra,http] of [['upload',{idempotencyKey:'upload',body:{file:new File(['data'],'notes.txt')}},'POST'],['get',{},'GET'],['retry',{idempotencyKey:'retry'},'POST'],['delete',{},'DELETE']])test('attachments '+method+' preserves scope, headers and resource',async()=>{
 let request;const c=client(async(u,i)=>{request={u,i};return json({data:ready},202);});
 assert.deepEqual(await c.attachments[method]({...params,...extra}),ready);
 assert.equal(request.i.method,http);assert.ok(request.u.startsWith('https://api.example/api/v1/workspaces/w%2Fa/chats/c%2Fb/attachments'));
 assert.equal(request.i.headers.get('X-Envai-Contract-Version'),'3');
 if(extra.idempotencyKey)assert.equal(request.i.headers.get('Idempotency-Key'),extra.idempotencyKey);
});
test('attachment list and private binary downloads acknowledge contract',async()=>{
 const c=client(async u=>u.includes('/download')?new Response('original',{headers:{'X-Envai-Contract-Version':'3'}}):json({data:{attachments:[ready]}}));
 assert.deepEqual((await c.attachments.list(params)).attachments,[ready]);
 assert.equal(await (await c.attachments.download({...params,kind:'original'})).text(),'original');
 await assert.rejects(client(async()=>json({data:{attachments:[{...ready,revision:'bad'}]}})).attachments.list(params),ProtocolError);
 await assert.rejects(new EnvaiClient({baseUrl:'https://api.example',contractVersion:2}).attachments.get(params),CompatibilityError);
});
test('feature guard rejects old servers and incomplete acknowledgments without resubmission',async()=>{
 for(const features of [[],undefined]){
  let posts=0;const c=new EnvaiClient({baseUrl:'https://api.example',fetch:async(u,i)=>{if(i.method==='POST')posts++;return json({...caps,features});}});
  await assert.rejects(c.attachments.retry({...params,idempotencyKey:'retry'}),CompatibilityError);
  await assert.rejects(c.chats.sendMessage({chat_id:'c',idempotencyKey:'send',body:{message:'hello',attachment_ids:['a']}}),CompatibilityError);assert.equal(posts,0);
 }
 for(const attachment_ids of [undefined,[],['b']]){
  let posts=0;const c=client(async()=>{posts++;return json({status:'accepted',turn_id:'turn',attachment_ids},202);});
  await assert.rejects(c.sendChatMessage({chat_id:'c',idempotencyKey:'send',body:{message:'hello',attachment_ids:['a']}}),ProtocolError);assert.equal(posts,1);
 }
 await assert.rejects(client(async()=>{throw Error('must not send');}).sendChatMessage({chat_id:'c',body:{message:'hello',attachment_ids:['a']}}),/Idempotency-Key/);
 await assert.rejects(client(async()=>{throw Error('must not send');}).attachments.upload({...params,idempotencyKey:'up',body:{file:'bad'}}),TypeError);
});
test('stream helpers retain attachments and idempotency key',async()=>{
 let body;const c=client(async(u,i)=>{
  if(u.includes('/events'))return sse([event('ping',0),event('turn.completed',1)]);
  body=JSON.parse(i.body);assert.equal(i.headers.get('Idempotency-Key'),'stable-key');return json({status:'accepted',turn_id:event('turn.completed').turn_id,attachment_ids:['a']},202);
 });
 const result=await c.sendAndWait(chatId,{message:'hello',attachment_ids:['a']},{idempotencyKey:'stable-key'});
 assert.deepEqual(body,{message:'hello',attachment_ids:['a']});assert.equal(result.terminal.type,'turn.completed');
 const start={...event('turn.started'),v:3};start.data.attachments=[{attachment_id:ready.attachment_id,original_name:ready.original_name,revision:ready.revision,...ready.derived}];assert.equal(parseEvent(start).data.attachments[0].attachment_id,ready.attachment_id);
});
test('idempotent completed turns replay before subscription ping without running resolved tools',async()=>{
 let posts=0;const observed=[];
 const done=event('agent.text.done',2);const terminal=event('turn.completed',3);
 const c=client(async(u)=>{
  if(u.includes('/events'))return sse([event('agent.tool.request',1),done,terminal,event('ping',0)]);
  posts++;return json({status:'accepted',turn_id:terminal.turn_id,attachment_ids:['a']},202);
 });
 const result=await c.sendAndWait(chatId,{message:'Read',attachment_ids:['a']},{idempotencyKey:'existing',toolRunner:{accept:async e=>observed.push(e.type)}});
 assert.equal(posts,1);assert.equal(result.text,done.data.text);assert.equal(result.terminal.type,'turn.completed');assert.ok(!observed.includes('agent.tool.request'));
});
test('idempotent send rejects excessive replay before submitting a message',async()=>{
 let posts=0;const c=client(async()=>{posts++;throw Error('must not send');});
 c.events=()=>({close(){},async *[Symbol.asyncIterator](){yield event('agent.text.delta',1,{data:{delta:'x'.repeat(17*1024*1024)}});}});
 await assert.rejects(c.sendAndWait(chatId,{message:'Read',attachment_ids:['a']},{idempotencyKey:'existing'}),/exceeds 16 MiB/);assert.equal(posts,0);
});
test('filesystem upload and bounded cancellable polling do not submit messages',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'envai-chat-'));const file=join(dir,'input.txt');writeFileSync(file,'data');
 try{
  const c=client(async(_u,i)=>{assert.ok(i.body instanceof FormData);assert.equal(i.body.get('file').name,'override.md');return json({data:pending},202);});
  assert.equal((await uploadAttachmentFile(c,'w','c',file,'upload',{filename:'override.md',mimeType:'text/markdown'})).conversion.status,'queued');
  const controller=new AbortController();controller.abort();await assert.rejects(uploadAttachmentFile(c,'w','c',file,'up',{signal:controller.signal}));
  for(const value of [ready,failed,{...pending,lifecycle:'deleted'}])assert.deepEqual(await waitForAttachment(client(async()=>json({data:value})),'w','c','a'),value);
  let reads=0;assert.deepEqual(await waitForAttachment(client(async()=>json({data:++reads===1?pending:ready})),'w','c','a',{intervalMs:1,timeoutMs:100}),ready);
  await assert.rejects(waitForAttachment(client(async()=>json({data:pending})),'w','c','a',{intervalMs:1,timeoutMs:5}),/timed out/);
  await assert.rejects(waitForAttachment(c,'w','c','a',{signal:controller.signal}));
  await assert.rejects(waitForAttachment(c,'w','c','a',{intervalMs:0}),RangeError);
  await assert.rejects(waitForAttachment(c,'w','c','a',{timeoutMs:0}),RangeError);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

for (const accepted of [{status:'not-accepted',turn_id:'cmpl_01j5abcdefghjkmnpqrstvwxyz'},{status:'accepted',turn_id:'invalid'},{status:'accepted'}]) test('message acknowledgment validates status and turn '+JSON.stringify(accepted),async()=>{
 let posts=0;
 const c=client(async()=>{posts++;return json({...accepted,attachment_ids:['a']},202);});
 await assert.rejects(c.sendChatMessage({chat_id:'c',idempotencyKey:'stable',body:{message:'read',attachment_ids:['a']}}),ProtocolError);
 assert.equal(posts,1);
});
for (const features of ['chat_attachments','prefix_chat_attachments_suffix',[1],null]) test('malformed capabilities fail before mutation '+JSON.stringify(features),async()=>{
 let posts=0;
 const c=new EnvaiClient({baseUrl:'https://api.example',fetch:async(u,i)=>{if(i.method==='POST')posts++;return json({...caps,features});}});
 await assert.rejects(c.attachments.retry({...params,idempotencyKey:'retry'}),CompatibilityError);
 assert.equal(posts,0);
});
test('JSON resources reject empty 204 responses',async()=>{
 await assert.rejects(client(async()=>new Response(null,{status:204,headers:{'X-Envai-Contract-Version':'3'}})).attachments.delete(params),ProtocolError);
});
test('polling waits for scheduled recovery without requesting retry',async()=>{
 const recoverable=JSON.parse(readFileSync(new URL('../testdata/chat-attachments/recoverable.json',import.meta.url))).data;
 let reads=0;
 const c=client(async(u,i)=>{assert.equal(i.method,'GET');return json({data:++reads===1?recoverable:ready});});
 assert.equal((await waitForAttachment(c,'w','c','a',{intervalMs:1,timeoutMs:1000})).lifecycle,'ready');
 assert.equal(reads,2);
});
test('native original readiness is ready-only and preserves existing terminal states',async()=>{
 const uploaded={...originalReady,lifecycle:'uploaded'};
 let reads=0;
 const c=client(async(u,i)=>{assert.equal(i.method,'GET');return json({data:++reads===1?uploaded:originalReady});});
 const result=await waitForAttachment(c,'w','c','a',{intervalMs:1,timeoutMs:1000});
 assert.equal(result.lifecycle,'ready');assert.equal(result.conversion.status,'not_required');assert.equal(result.derived,null);assert.equal(reads,2);
 for(const value of [originalReady,ready,failed,{...pending,lifecycle:'deleted'}])assert.deepEqual(await waitForAttachment(client(async()=>json({data:value})),'w','c','a'),value);
});
test('native upload requires both canonical features before any multipart POST',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'envai-native-'));const path=join(dir,'native.txt');writeFileSync(path,'native bytes');
 try{
  for(const features of [
   ['chat_attachments'],
   ['chat_attachment_originals'],
   ['chat_attachments','chat_attachment_originals_beta'],
   {chat_attachments:true},
   {chat_attachments:true,chat_attachment_originals:false},
   {chat_attachments:true,chat_attachment_originals:'true'},
   ['chat_attachments','chat_attachment_originals',42],
   ['chat_attachments',null],
  ])for(const method of ['helper','low']){
   const requests=[];const c=new EnvaiClient({baseUrl:'https://api.example',fetch:async(u,i)=>{requests.push([new URL(u).pathname,i.method]);return json({...caps,features});}});
   const upload=method==='helper'?uploadAttachmentFile(c,'w','c',path,'stable-upload'):c.attachments.upload({...params,idempotencyKey:'stable-upload',body:{file:new File(['native bytes'],'native.txt')}});
   await assert.rejects(upload,CompatibilityError);
   assert.deepEqual(requests,[['/api/v1/atp/v3/capabilities','GET']]);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('native upload accepts a positive feature list or exact true map with one preflight',async()=>{
 for(const features of [['chat_attachments','chat_attachment_originals'],{chat_attachments:true,chat_attachment_originals:true}]){
  let body;const requests=[];const c=new EnvaiClient({baseUrl:'https://api.example',fetch:async(u,i)=>{requests.push([new URL(u).pathname,i.method]);if(i.method==='POST')body=i.body;return u.endsWith('/capabilities')?json({...caps,features}):json({data:originalReady},202);}});
  assert.deepEqual(await c.attachments.upload({...params,idempotencyKey:'listed-upload',body:{file:new File(['native bytes'],'native.txt')}}),originalReady);
  assert.deepEqual(requests,[['/api/v1/atp/v3/capabilities','GET'],['/api/v1/workspaces/w%2Fa/chats/c%2Fb/attachments','POST']]);
  assert.ok(body instanceof FormData);assert.equal(await body.get('file').text(),'native bytes');assert.equal(body.get('file').name,'native.txt');
 }
});
test('attachment operations other than native upload require only chat_attachments',async()=>{
 let posts=0;const c=new EnvaiClient({baseUrl:'https://api.example',fetch:async(u,i)=>{if(i.method==='POST')posts++;if(u.endsWith('/capabilities'))return json({...caps,features:['chat_attachments']});if(u.endsWith('/messages'))return json({status:'accepted',turn_id:'cmpl_01ARZ3NDEKTSV4RRFFQ69G5FAV',attachment_ids:['a']},202);return json({data:ready},202);}});
 assert.equal((await c.attachments.get(params)).lifecycle,'ready');
 assert.equal((await c.attachments.retry({...params,idempotencyKey:'retry'})).lifecycle,'ready');
 assert.equal((await c.attachments.delete(params)).lifecycle,'ready');
 assert.equal((await c.sendChatMessage({chat_id:'c',idempotencyKey:'send',body:{message:'read',attachment_ids:['a']}})).status,'accepted');
 assert.equal(posts,2);
});
test('native retry conflict is returned without resubmission',async()=>{
 let gets=0,posts=0;
 const c=new EnvaiClient({baseUrl:'https://api.example',fetch:async(u,i)=>{if(u.endsWith('/capabilities')){gets++;return json(caps);}posts++;return json({error:{type:'conflict',code:'attachment_retry_not_permitted',message:'Native originals cannot be retried'}},409);}});
 await assert.rejects(c.attachments.retry({...params,idempotencyKey:'retry'}),e=>e instanceof ConflictError&&e.code==='attachment_retry_not_permitted');
 assert.equal(gets,1);assert.equal(posts,1);
});
test('native manifest and conversion enums hydrate',()=>{
 const manifest={attachment_id:originalReady.attachment_id,original_name:originalReady.original_name,mime_type:originalReady.mime_type,mode:'native',revision:1,sha256:'a'.repeat(64),bytes:17,conversion:{status:'not_required'}};
 assert.deepEqual(validateContractValue('AttachmentManifest',manifest),manifest);
 assert.throws(()=>validateContractValue('AttachmentManifest',{...manifest,mode:'converted'}),ProtocolError);
 assert.equal(validateContractValue('ChatAttachment',originalReady).conversion.status,'not_required');
});
