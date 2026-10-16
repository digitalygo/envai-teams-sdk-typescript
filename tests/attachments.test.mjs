import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvaiClient, CompatibilityError, ProtocolError, uploadAttachmentFile, waitForAttachment, parseEvent } from '../dist/index.js';
import { json, capabilities, sse, event, chatId } from './helpers.mjs';
const ready=JSON.parse(readFileSync(new URL('../testdata/chat-attachments/ready.json',import.meta.url))).data;
const pending=JSON.parse(readFileSync(new URL('../testdata/chat-attachments/pending.json',import.meta.url))).data;
const failed=JSON.parse(readFileSync(new URL('../testdata/chat-attachments/failed.json',import.meta.url))).data;
const caps={...capabilities,features:['chat_attachments']};
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
