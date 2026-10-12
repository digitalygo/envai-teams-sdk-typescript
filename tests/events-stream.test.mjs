import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { EnvaiClient, parseEvent, parseSSE, isEvent, isTerminal, knownEventTypes, ProtocolError, ReplayGapError, TransportError, AuthenticationError } from '../dist/index.js';
import {fixture,valid,event,chatId,turnId,bytes,sse,json,tick} from './helpers.mjs';
const collect = async iterable => { const a=[];for await(const x of iterable)a.push(x);return a; };
for(const e of valid)test('shared valid event: '+e.type,()=>{const parsed=parseEvent(JSON.stringify(e));assert.equal(parsed.type,e.type);assert.equal(parsed.known,knownEventTypes.includes(e.type));});
for(const c of fixture('events-invalid.json'))test('shared invalid event: '+c.name,()=>assert.throws(()=>parseEvent(c.event),ProtocolError));
test('unknown fields preserved without caller aliases; inconsistent turn and malformed JSON rejected',()=>{
 const source={...event('turn.started'),extra:{future:true}};const parsed=parseEvent(source);source.extra.future=false;assert.equal(parsed.extra.future,true);
 assert.throws(()=>parseEvent('{bad'),/Invalid SSE JSON/);assert.throws(()=>parseEvent(null),/Invalid ATP envelope/);assert.throws(()=>parseEvent(()=>{}),/not structured JSON/);
 assert.throws(()=>parseEvent({...event('turn.started'),seq:Number.MAX_SAFE_INTEGER+1}),/Unsafe/);
 const e=event('turn.completed');e.data.turn_id='cmpl_01ARZ3NDEKTSV4RRFFQ69G5FAX';assert.throws(()=>parseEvent(e),/disagrees/);
 assert.equal(isTerminal(parseEvent(event('turn.completed'))),true);assert.equal(isEvent(parseEvent(event('agent.text.delta')),'agent.text.delta'),true);
});
test('all 28 declared event types validate through full external-def schema',()=>{
 const schema=JSON.parse(readFileSync(new URL('../contracts/events.json',import.meta.url),'utf8'));
 const make=s=>{
  if(s.$ref)return make(schema.$defs[s.$ref.split('/').at(-1)]);
  if('const'in s)return s.const;if(s.enum)return s.enum[0];
  if(s.anyOf||s.oneOf)return make((s.anyOf||s.oneOf)[0]);
  const t=Array.isArray(s.type)?s.type[0]:s.type;
  if(t==='null')return null;if(t==='boolean')return false;if(t==='number'||t==='integer')return s.minimum??0;
  if(t==='array')return Array.from({length:s.minItems??0},()=>make(s.items));
  if(t==='object'||s.properties)return Object.fromEntries((s.required??[]).map(k=>[k,make(s.properties[k])]));
  if(t==='string'){
    if(s.format==='date-time')return '2026-10-12T22:00:00Z';
    if(s.pattern?.startsWith('^')){const prefix=s.pattern.match(/^\^([a-z]+_)/)?.[1];if(prefix)return prefix+'01ARZ3NDEKTSV4RRFFQ69G5FAV';}
    return 'x'.repeat(s.minLength??1);
  }
  return {};
 };
 for(const type of knownEventTypes){
  const variant=schema.$defs.Event.oneOf.find(v=>v.allOf?.[1]?.properties?.type?.const===type).allOf[1];
  const e={...event('turn.started'),type,data:make(schema.$defs[type]),agent:make(variant.properties.agent)};
  if(type==='ping'){e.seq=0;e.turn_id=null;}
  if('turn_id'in e.data)e.data.turn_id=e.turn_id;
  assert.equal(parseEvent(e).type,type);
 }
});
for(const c of fixture('sse-cases.json'))for(const chunkSize of [1,2,7,99999])test(`SSE shared ${c.name}, chunks ${chunkSize}`,async()=>assert.deepEqual(await collect(parseSSE(bytes(c.wire,chunkSize))),c.data));
test('SSE splits multibyte UTF-8, allows empty data and rejects invalid encoding/size',async()=>{
 assert.deepEqual(await collect(parseSSE(bytes('data: 😀 café\r\rdata\n\n',1))),['😀 café','']);
 await assert.rejects(collect(parseSSE(bytes(new Uint8Array([0xff])))),/UTF-8/);
 await assert.rejects(collect(parseSSE(bytes('data: too large\n\n'),{maxFrameBytes:5})),/maxFrameBytes/);
});
test('SSE idle timeout, cancellation and reader cleanup',async()=>{
 let cancelled=0;const body=()=>new ReadableStream({cancel(){cancelled++;}});
 await assert.rejects(collect(parseSSE(body(),{idleTimeoutMs:5})),/idle timeout/);
 const abort=new AbortController();const pending=collect(parseSSE(body(),{signal:abort.signal}));abort.abort();await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(cancelled,2);
});
test('reconnect after cursor, dedupe, ping exclusion, and observations',async()=>{
 const urls=[],observed=[];let count=0;
 const c=new EnvaiClient({baseUrl:'https://test.invalid',retry:{maxRetries:0},onObservation:e=>observed.push(e),fetch:async u=>{urls.push(u);return ++count===1?sse([event('ping',0),event('turn.started',1)]):sse([event('turn.started',1),event('agent.text.delta',2),event('turn.completed',3)]);}});
 const stream=c.events(chatId,{reconnectDelayMs:0,maxReconnects:1});const got=[];
 for await(const e of stream){got.push(e.seq);if(isTerminal(e))break;}
 assert.deepEqual(got,[0,1,2,3]);assert.equal(new URL(urls[1]).searchParams.get('after'),'1');assert.ok(observed.some(e=>e.kind==='stream.reconnect'));assert.equal(stream.lastSeq,2);
 assert.throws(()=>stream[Symbol.asyncIterator](),/one consumer/);
});
test('observable live gap heals through one replay and unrecoverable gap fails',async()=>{
 for(const recover of [true,false]){
  let calls=0;const c=new EnvaiClient({baseUrl:'https://test.invalid',fetch:async()=>++calls===1?sse([event('turn.started',1),event('turn.completed',3)]):sse(recover?[event('agent.text.delta',2),event('turn.completed',3)]:[event('turn.completed',3)])});
  const got=[];const work=(async()=>{for await(const e of c.events(chatId,{reconnectDelayMs:0,maxReconnects:2})){got.push(e.seq);if(isTerminal(e))break;}})();
  if(recover){await work;assert.deepEqual(got,[1,2,3]);}else{await assert.rejects(work,e=>e instanceof ReplayGapError&&e.lastSeq===1&&e.receivedSeq===3);assert.deepEqual(got,[1]);}
 }
});
test('stream HTTP auth failure is terminal; protocol errors are not retried',async()=>{
 for(const response of [()=>json({error:{type:'unauthenticated'}},401),()=>new Response('bad',{headers:{'content-type':'text/plain'}}),()=>sse([{...event('turn.started'),chat_id:'cht_01ARZ3NDEKTSV4RRFFQ69G5FAX'}]),()=>sse([{...event('turn.started'),v:3}]),()=>new Response(null,{headers:{'content-type':'text/event-stream'}})]){
  let calls=0;const c=new EnvaiClient({baseUrl:'https://test.invalid',fetch:async()=>{calls++;return response();}});
  await assert.rejects(collect(c.events(chatId,{reconnectDelayMs:0})));assert.equal(calls,1);
 }
});
test('EOF and transport failures have bounded reconnect limits',async()=>{
 for(const mode of ['eof','network','gap']){
  let calls=0;const c=new EnvaiClient({baseUrl:'https://test.invalid',retry:{maxRetries:0},fetch:async()=>{calls++;if(mode==='network')throw Error('lost');return sse(mode==='gap'?[event('turn.started',3)]:[]);}});
  await assert.rejects(collect(c.events(chatId,{maxReconnects:mode==='gap'?0:1,reconnectDelayMs:0})));assert.equal(calls,mode==='gap'?1:2);
 }
});
test('explicit nonzero checkpoint policy, local stream close and duration deadline',async()=>{
 const c=new EnvaiClient({baseUrl:'https://test.invalid',fetch:async()=>new Response(new ReadableStream({}),{headers:{'content-type':'text/event-stream'}})});
 assert.throws(()=>c.events(chatId,{after:3}),/same-runtime/);assert.throws(()=>c.events(chatId,{after:-1}));assert.throws(()=>c.events(chatId,{maxReconnects:1.2}));
 const stream=c.events(chatId,{after:3,resume:'same-runtime'});const p=collect(stream);await tick();stream.close();await assert.rejects(p,e=>e.name==='AbortError');
 await assert.rejects(collect(c.events(chatId,{maxDurationMs:5})),e=>e.name==='TimeoutError');
});
test('sendAndWait waits for readiness ping, ignores subagent/reasoning and final text is authoritative',async()=>{
 let server;let posted=false;const calls=[];
 const c=new EnvaiClient({baseUrl:'https://test.invalid',fetch:async(url,init)=>{
  calls.push(init.method);
  if(init.method==='GET')return new Response(new ReadableStream({start(ctrl){server=ctrl;setTimeout(()=>ctrl.enqueue(new TextEncoder().encode('data: '+JSON.stringify(event('ping',0))+'\n\n')),5);}}),{headers:{'content-type':'text/event-stream'}});
  posted=true;const delta=event('agent.text.delta',2);const child=structuredClone(delta);child.seq=3;child.agent.role='member';child.data.delta='unwanted';
  const done=event('agent.text.done',4);done.data.text='Final text';
  for(const e of [event('turn.started',1),delta,child,done,event('turn.completed',5)])server.enqueue(new TextEncoder().encode('data: '+JSON.stringify(e)+'\n\n'));
  return json({status:'accepted',turn_id:turnId},202);
 }});
 const promise=c.sendAndWait(chatId,{message:'Hello'});await tick();assert.equal(posted,false);
 const result=await promise;assert.equal(result.text,'Final text');assert.equal(result.lastSeq,5);assert.equal(result.turnId,turnId);assert.equal(result.terminal.type,'turn.completed');assert.deepEqual(calls,['GET','POST']);
});
test('sendAndStream readiness timeout never submits a mutation',async()=>{
 let posts=0;const c=new EnvaiClient({baseUrl:'https://test.invalid',fetch:async(_,init)=>{if(init.method==='POST')posts++;return new Response(new ReadableStream({}),{headers:{'content-type':'text/event-stream'}});}});
 await assert.rejects(c.sendAndWait(chatId,{message:'Hi'},{readyTimeoutMs:5}),e=>e.name==='TimeoutError');assert.equal(posts,0);
});
test('send helper propagates failed/cancelled terminal; no message replay; acceptance requires id',async()=>{
 for(const kind of ['turn.failed','turn.cancelled','missing-id']){
  let controller;let posts=0;const c=new EnvaiClient({baseUrl:'https://test.invalid',fetch:async(_,init)=>{
   if(init.method==='GET')return new Response(new ReadableStream({start(c){controller=c;c.enqueue(new TextEncoder().encode('data: '+JSON.stringify(event('ping',0))+'\n\n'));}}),{headers:{'content-type':'text/event-stream'}});
   posts++;if(kind==='missing-id')return json({status:'accepted'},202);
   controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(event(kind,1))+'\n\n'));return json({status:'accepted',turn_id:turnId},202);
  }});
  if(kind==='missing-id')await assert.rejects(c.sendAndWait(chatId,{message:'hi'}),/omitted turn_id/);else assert.equal((await c.sendAndWait(chatId,{message:'hi'})).terminal.type,kind);
  assert.equal(posts,1);
 }
});
test('generateAndWait polls only GET, terminates correctly and honors cancellation',async()=>{
 const methods=[];let reads=0;const c=new EnvaiClient({baseUrl:'https://test.invalid',fetch:async(_,init)=>{methods.push(init.method);return json({data:init.method==='POST'?{id:'igr_x',status:'accepted'}:{id:'igr_x',status:++reads===1?'processing':'succeeded'}});}});
 assert.equal((await c.generateAndWait({model:'test',prompt:'test'},{pollIntervalMs:1,timeoutMs:100})).status,'succeeded');assert.deepEqual(methods,['POST','GET','GET']);
 const absent=new EnvaiClient({baseUrl:'https://test.invalid',fetch:async()=>json({data:{}})});await assert.rejects(absent.generateAndWait({}),/omitted id/);
 const never=new EnvaiClient({baseUrl:'https://test.invalid',fetch:async()=>json({data:{id:'x',status:'processing'}})});await assert.rejects(never.generateAndWait({},{timeoutMs:5,pollIntervalMs:10}),e=>e.name==='TimeoutError');
});
test('consumer mutation cannot change the resume cursor',async()=>{
 const urls=[];let calls=0;const c=new EnvaiClient({baseUrl:'https://example.test',fetch:async url=>{urls.push(url);return ++calls===1?sse([event('turn.started',1)]):sse([event('turn.completed',2)]);}});
 for await(const e of c.events(chatId,{reconnectDelayMs:0})){if(e.type==='turn.started'){e.seq=999;e.type='ping';}else break;}
 assert.equal(new URL(urls[1]).searchParams.get('after'),'1');
});
test('sendAndStream feeds prior controls and current-turn events to optional runner',async()=>{
 const newTurn='cmpl_01ARZ3NDEKTSV4RRFFQ69G5FAX';let controller;const observed=[];
 const c=new EnvaiClient({baseUrl:'https://test.invalid',fetch:async(_,init)=>{
  if(init.method==='GET')return new Response(new ReadableStream({start(c){controller=c;for(const e of [event('agent.tool.request',1),event('turn.completed',2),event('ping',0)])c.enqueue(new TextEncoder().encode('data: '+JSON.stringify(e)+'\n\n'));}}),{headers:{'content-type':'text/event-stream'}});
  const completed=event('turn.completed',4,{turn_id:newTurn});completed.data.turn_id=newTurn;
  for(const e of [event('agent.text.delta',3),completed])controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(e)+'\n\n'));
  return json({status:'accepted',turn_id:newTurn},202);
 }});
 const abort=new AbortController();const result=await c.sendAndWait(chatId,{message:'new'},{signal:abort.signal,toolRunner:{accept:async e=>observed.push(e.type)}});
 assert.equal(result.turnId,newTurn);assert.deepEqual(observed,['turn.completed','turn.completed']);
});
