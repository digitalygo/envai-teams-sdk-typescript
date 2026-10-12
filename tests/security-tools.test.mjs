import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { EnvaiClient, canonicalize, JwksCache, ToolRequestVerifier, SignatureError, ClientToolRegistry, ClientToolRunner, MemoryToolStateStore, ToolExecutionError, ConflictError, NotFoundError, parseEvent } from '../dist/index.js';
import { signatures,requestEvent,event,chatId,turnId,tick,json,sse } from './helpers.mjs';
const verification = () => new ToolRequestVerifier({get:async()=>signatures.jwks});
for(const [i,v]of signatures.vectors.entries())test('shared RFC8785/Ed25519 vector: '+v.name,async()=>{
 assert.equal(canonicalize(JSON.parse(v.args_json)),v.canonical);await verification().verify(requestEvent(i).data);const canonicalRequest=requestEvent(i);canonicalRequest.data.args=JSON.parse(v.canonical);await verification().verify(canonicalRequest.data);assert.equal(canonicalize(canonicalRequest.data.args),v.canonical);
});
test('canonical JSON rejects non-JSON, non-finite, sparse, accessors, symbols and unpaired Unicode',()=>{
 const cyclic={};cyclic.x=cyclic;const accessor={get x(){throw Error('must not run');}};
 const symbol={[Symbol('x')]:1};const array=[1];array.extra=2;
 for(const value of [undefined,1n,()=>{},NaN,Infinity,new Date(),cyclic,accessor,symbol,[,1],array,'\ud800','\udc00',{'\ud800':1}])assert.throws(()=>canonicalize(value),SignatureError);
 assert.equal(canonicalize({b:true,a:false,c:null,d:-0}),'\u007b"a":false,"b":true,"c":null,"d":0}');
 assert.equal(canonicalize(Object.create(null)), '{}');
});
test('key refresh once for missing kid or failed verification, reject algorithms and invalid keys',async()=>{
 for(const mode of ['missing','rotation']){
  const calls=[];const verifier=new ToolRequestVerifier({get:async force=>{calls.push(force);return force?signatures.jwks:mode==='missing'?{keys:[]}:{keys:signatures.jwks.keys.map(k=>({...k,x:Buffer.alloc(32).toString('base64url')}))};}});
  await verifier.verify(requestEvent().data);assert.deepEqual(calls,[false,true]);
 }
 for(const patch of [{alg:'RS256'},{sig:'bad='},{sig:'AA'},{sig:Buffer.alloc(64).toString('base64url')},{kid:'missing'}]){
  const e=requestEvent();e.data.signature={...e.data.signature,...patch};await assert.rejects(verification().verify(e.data),SignatureError);
 }
 for(const patch of [{kty:'RSA'},{crv:'Ed448'},{alg:'RS256'},{use:'enc'},{key_ops:['sign']},{d:'private'},{x:'bad='}]){
  const verifier=new ToolRequestVerifier({get:async()=>({keys:signatures.jwks.keys.map(k=>({...k,...patch}))})});await assert.rejects(verifier.verify(requestEvent().data),SignatureError);
 }
 const duplicate=new ToolRequestVerifier({get:async()=>({keys:[...signatures.jwks.keys,...signatures.jwks.keys]})});await assert.rejects(duplicate.verify(requestEvent().data));
});
test('JWKS TTL cache, coalescing, force refresh, errors, and explicit cancellation',async()=>{
 let count=0;let release;const cache=new JwksCache(async()=>{count++;return new Promise(r=>release=r);},100);
 const a=cache.get(),b=cache.get();release(signatures.jwks);assert.equal(await a,await b);assert.equal(count,1);await cache.get();assert.equal(count,1);
 const refreshed=cache.get(true);release(signatures.jwks);await refreshed;assert.equal(count,2);
 const empty=new JwksCache(async()=>({bad:1}));await assert.rejects(empty.get(),SignatureError);
 const zero=new JwksCache(async()=>{count++;return signatures.jwks;},0);await zero.get();await zero.get();assert.equal(count,4);
 const abort=new AbortController();abort.abort();await assert.rejects(cache.get(false,abort.signal));
});
const pair=generateKeyPairSync('ed25519');
const jwks={keys:[{...pair.publicKey.export({format:'jwk'}),kid:'test-key',alg:'EdDSA',use:'sig'}]};
let sequence=0;
function signed(args={},name='fixture_echo'){
 const e=requestEvent();const suffix=String(++sequence).padStart(6,'0');e.data.call_id='tc_'+'01ARZ3NDEKTSV4RRFFQ69G5FAV'.slice(0,20)+suffix;
 e.data.tool_name=name;e.data.args=args;e.data.signature={alg:'EdDSA',kid:'test-key',sig:sign(null,Buffer.from(e.data.call_id+'\n'+name+'\n'+canonicalize(args)),pair.privateKey).toString('base64url')};return e;
}
const verifier=()=>new ToolRequestVerifier({get:async()=>jwks});
const registry=(handler=async args=>args,schema={type:'object'},timeoutSeconds=120)=>new ClientToolRegistry().register({name:'fixture_echo',parameters:schema,handler,timeoutSeconds});
function runner(overrides={}){
 const submissions=[];const store=new MemoryToolStateStore();
 const instance=new ClientToolRunner({scope:'deployment:test/account:1',store,registry:registry(),verifier:verifier(),submit:async(chat,body)=>{submissions.push({chat,body});},...overrides});
 return {instance,store,submissions};
}
test('valid local tool is verified, durable claimed, serialized once, submitted once and resolved by stream',async()=>{
 let effects=0;const {instance,store,submissions}=runner({registry:registry(async(_,ctx)=>{effects++;assert.ok(ctx.idempotencyKey.includes('account:1'));return {sent:true};})});const e=signed();
 await instance.accept(e);await instance.accept(e);await instance.drain();assert.equal(effects,1);assert.equal(submissions.length,1);assert.equal(submissions[0].body.output,'{"sent":true}');
 const key=instance.key(chatId,e.data.call_id);assert.equal((await store.get(key)).state,'submitted');
 const result=event('agent.tool.result');result.data.call_id=e.data.call_id;await instance.accept(result);assert.equal((await store.get(key)).state,'resolved');await instance.accept(e);assert.equal(effects,1);
});
test('durable claims prevent handler replay across runner recreation and scopes isolate accounts',async()=>{
 const store=new MemoryToolStateStore();let effects=0;const reg=registry(()=>{effects++;return 'done';});const e=signed();
 const first=runner({store,registry:reg});await first.instance.accept(e);await first.instance.drain();
 const second=runner({store,registry:reg});await second.instance.accept(e);await second.instance.drain();assert.equal(effects,1);
 const other=runner({store,registry:reg,scope:'other-account'});await other.instance.accept(e);await other.instance.drain();assert.equal(effects,2);
});
test('failure to persist a claim blocks effects; concurrent atomic claims execute once',async()=>{
 let effects=0;const reg=registry(()=>{effects++;return 'ok';});const broken=runner({registry:reg,store:{get:async()=>undefined,transition:async()=>false,claim:async()=>{throw Error('database unavailable');}}});await assert.rejects(broken.instance.accept(signed()),/database/);assert.equal(effects,0);
 const store=new MemoryToolStateStore();const a=runner({registry:reg,store}),b=runner({registry:reg,store});const e=signed();await Promise.all([a.instance.accept(e),b.instance.accept(e)]);await Promise.all([a.instance.drain(),b.instance.drain()]);assert.equal(effects,1);
});
test('signature/schema/envelope validation precedes handler invocation; unknown local tool reports controlled error',async()=>{
 let effects=0;const {instance,submissions}=runner({registry:registry(()=>{effects++;return 'ok';},{type:'object',properties:{required:{type:'string'}},required:['required'],additionalProperties:false})});
 const bad=signed();bad.data.args.tampered=true;await assert.rejects(instance.accept(bad),SignatureError);assert.equal(effects,0);assert.equal(submissions.length,0);
 await assert.rejects(instance.accept({...signed(),v:3}));
 await instance.accept(signed({required:1}));await instance.accept(signed({},'not_registered'));await instance.drain();assert.equal(effects,0);
 assert.deepEqual(submissions.map(x=>JSON.parse(x.body.output).code).sort(),['invalid_arguments','unknown_tool']);assert.ok(submissions.every(x=>x.body.is_error));
});
test('caller cannot mutate verified args during JWKS await or while queued',async()=>{
 let release;const seen=[];const delayed=new ToolRequestVerifier({get:async()=>new Promise(r=>release=r)});
 const {instance}=runner({registry:registry(args=>{seen.push(args);return 'ok';}),verifier:delayed});
 const e=signed({signed:true});const admission=instance.accept(e);await tick();e.data.args.signed=false;e.data.args.evil=true;release(jwks);await admission;await instance.drain();assert.deepEqual(seen,[{signed:true}]);
 let unblock;const queued=runner({concurrency:1,registry:registry(async args=>{seen.push(args);if(args.block)await new Promise(r=>unblock=r);return 'ok';})});
 await queued.instance.accept(signed({block:true}));await tick();const second=signed({queued:true});await queued.instance.accept(second);second.data.args.queued=false;unblock();await queued.instance.drain();assert.deepEqual(seen.at(-1),{queued:true});
});
test('call id reuse with different signed arguments fails closed',async()=>{
 const {instance}=runner();const e=signed({a:1});await instance.accept(e);await instance.drain();const changed=structuredClone(e);changed.data.args={a:2};changed.data.signature.sig=sign(null,Buffer.from(e.data.call_id+'\nfixture_echo\n'+canonicalize(changed.data.args)),pair.privateKey).toString('base64url');await assert.rejects(instance.accept(changed),e=>e.code==='call_id_conflict');
});
test('bounded concurrency, queue overflow, and terminal/result cancellation',async()=>{
 let active=0,max=0;const resolvers=[];const {instance,store}=runner({concurrency:2,maxPending:3,registry:registry(async(_,ctx)=>{active++;max=Math.max(max,active);await new Promise(r=>{resolvers.push(r);ctx.signal.addEventListener('abort',r,{once:true});});active--;return 'done';})});
 const events=[signed(),signed(),signed()];for(const e of events)await instance.accept(e);await tick();assert.equal(max,2);await assert.rejects(instance.accept(signed()),e=>e.code==='queue_full');
 const result=event('agent.tool.result');result.data.call_id=events[0].data.call_id;await instance.accept(result);await tick();assert.equal((await store.get(instance.key(chatId,events[0].data.call_id))).state,'resolved');
 await instance.accept(event('turn.completed'));await instance.drain();assert.equal(active,0);assert.equal(max,2);
});
test('ambiguous network/409/404 delivery never resubmits or reexecutes',async()=>{
 for(const error of [Error('lost response'),new ConflictError('Already resolved',409,'conflict','tool_already_resolved'),new ConflictError('Timed out',409,'conflict','tool_timed_out'),new NotFoundError('Gone',404,'not_found')]){
  let effects=0,posts=0;const {instance,store}=runner({registry:registry(()=>{effects++;return 'done';}),submit:async()=>{posts++;throw error;}});const e=signed();await instance.accept(e);await assert.rejects(instance.drain(),AggregateError);
  assert.equal((await store.get(instance.key(chatId,e.data.call_id))).state,'ambiguous');await instance.accept(e);await instance.drain();assert.equal(posts,1);assert.equal(effects,1);
  const result=event('agent.tool.result');result.data.call_id=e.data.call_id;await instance.accept(result);assert.equal((await store.get(instance.key(chatId,e.data.call_id))).state,'resolved');
 }
});
test('handler failures and invalid/oversized UTF-8 outputs become bounded controlled results',async()=>{
 for(const [handler,code]of [[()=>{throw Error('sensitive details');},'handler_error'],[()=>undefined,'invalid_output'],[()=>'', 'empty_output'],[()=> 'é'.repeat(65537),'output_too_large'],[()=>{const x={};x.self=x;return x;},'handler_error']]){
  const {instance,submissions}=runner({registry:registry(handler)});await instance.accept(signed());await instance.drain();assert.equal(JSON.parse(submissions[0].body.output).code,code);assert.ok(!submissions[0].body.output.includes('sensitive details'));
 }
});
test('local timeout sends error, retains slot until ignored cancellation actually finishes',async()=>{
 let finish;let active=0,max=0;const {instance,submissions}=runner({concurrency:1,registry:registry(async()=>{active++;max=Math.max(max,active);await new Promise(r=>finish=r);active--;return 'late';},{type:'object'},1)});
 await instance.accept(signed());await tick();await new Promise(r=>setTimeout(r,940));assert.equal(JSON.parse(submissions[0].body.output).code,'tool_timeout');
 await instance.accept(signed());assert.equal(active,1);finish();await tick();assert.equal(max,1);finish();await instance.drain();assert.equal(max,1);
});
test('store transition races cannot downgrade a resolved state or submit after server result',async()=>{
 const base=new MemoryToolStateStore();let instance;let once=false;
 const store={claim:(...a)=>base.claim(...a),get:(...a)=>base.get(...a),transition:async(key,expected,patch)=>{
  if(patch.state==='completed'&&!once){once=true;const e=event('agent.tool.result');e.data.call_id=JSON.parse(key)[2];await instance.accept(e);}
  return base.transition(key,expected,patch);
 }};
 const value=runner({store});instance=value.instance;const e=signed();await instance.accept(e);await instance.drain();assert.equal(value.submissions.length,0);assert.equal((await store.get(instance.key(chatId,e.data.call_id))).state,'resolved');
});
test('registry validation, immutable registration schemas, store clone isolation and runner bounds',async()=>{
 const schema={type:'object'};const reg=registry(()=>{},schema);schema.type='string';assert.equal(reg.definitions()[0].parameters.type,'object');assert.equal(reg.definitions()[0].timeout_seconds,120);
 assert.throws(()=>reg.register({name:'fixture_echo',parameters:{type:'object'},handler(){}}));assert.throws(()=>registry(()=>{},{type:'array'}));assert.throws(()=>registry(()=>{},{type:'object'},601));
 assert.throws(()=>runner({scope:''}));assert.throws(()=>runner({concurrency:1.2}));assert.throws(()=>runner({maxPending:0}));
 const s=new MemoryToolStateStore();assert.equal(await s.transition('x',['claimed'],{state:'resolved'}),false);assert.equal(await s.get('x'),undefined);const callId=signed().data.call_id;const key=JSON.stringify(['scope',chatId,callId]);await s.claim(key,{state:'claimed',fingerprint:'a'.repeat(64),chatId,turnId,callId});const r=await s.get(key);r.state='resolved';assert.equal((await s.get(key)).state,'claimed');
});
test('runner close and drain cancellation propagate; run consumes control events',async()=>{
 const {instance}=runner();await instance.run((async function*(){yield event('ping',0);yield signed();})());await assert.rejects(instance.accept(signed()),e=>e.name==='AbortError');
 let finish;const pending=runner({registry:registry(()=>new Promise(r=>finish=r))});await pending.instance.accept(signed());await tick();const abort=new AbortController();const wait=pending.instance.drain(abort.signal);abort.abort();await assert.rejects(wait);pending.instance.close();finish('done');await pending.instance.drain();
});
test('EnvaiClient tool factory fetches unauthenticated JWKS, registers explicitly and submits through shared transport',async()=>{
 const calls=[];const c=new EnvaiClient({baseUrl:'https://example.test',apiKey:'secret',fetch:async(url,init)=>{calls.push({url,init});if(url.endsWith('jwks.json'))return json(jwks);return new Response(null,{status:204});}});
 const r=c.createToolRunner({scope:'example/account',store:new MemoryToolStateStore(),registry:registry(()=>({ok:true}))});await r.accept(signed());await r.drain();
 assert.equal(calls.length,2);assert.equal(calls[0].init.headers.get('authorization'),null);assert.equal(calls[1].init.headers.get('authorization'),'Bearer secret');assert.equal(calls[1].init.method,'POST');
});
test('terminal during signature verification blocks admission and persists across runner recreation',async()=>{
 let release;let effects=0;const store=new MemoryToolStateStore();const reg=registry(()=>{effects++;return 'bad';});
 const delayed=new ToolRequestVerifier({get:async()=>new Promise(r=>release=r)});const r=runner({store,registry:reg,verifier:delayed});
 const e=signed();const p=r.instance.accept(e);await tick();await r.instance.accept(event('turn.completed'));release(jwks);await p;await r.instance.drain();assert.equal(effects,0);
 const restarted=runner({store,registry:reg});await restarted.instance.accept(e);await restarted.instance.drain();assert.equal(effects,0);
});
test('authoritative result before request creates durable tombstone; delayed admission remains blocked',async()=>{
 for(const during of [false,true]){
  let release;let effects=0;const store=new MemoryToolStateStore();const reg=registry(()=>{effects++;return 'bad';});const r=runner({store,registry:reg,verifier:during?new ToolRequestVerifier({get:async()=>new Promise(res=>release=res)}):verifier()});
  const e=signed();const result=event('agent.tool.result');result.data.call_id=e.data.call_id;
  let p;if(during){p=r.instance.accept(e);await tick();}
  await r.instance.accept(result);if(during){release(jwks);await p;}else await r.instance.accept(e);
  await r.instance.drain();assert.equal(effects,0);assert.equal((await store.get(r.instance.key(chatId,e.data.call_id))).state,'resolved');
  const restarted=runner({store,registry:reg});await restarted.instance.accept(e);await restarted.instance.drain();assert.equal(effects,0);
 }
});
test('terminal arriving while durable claim commits prevents execution',async()=>{
 const memory=new MemoryToolStateStore();let release;let effects=0;
 const store={get:(...a)=>memory.get(...a),transition:(...a)=>memory.transition(...a),claim:async(key,record)=>{const value=await memory.claim(key,record);if(record.state==='claimed')await new Promise(r=>release=r);return value;}};
 const r=runner({store,registry:registry(()=>{effects++;return 'bad';})});const e=signed();const p=r.instance.accept(e);await tick();await r.instance.accept(event('turn.completed'));release();await p;await r.instance.drain();assert.equal(effects,0);assert.equal((await store.get(r.instance.key(chatId,e.data.call_id))).state,'abandoned');
});

// These are SDK-authored conformance cases, not fixtures emitted by the pinned server.
for (const item of JSON.parse((await import('node:fs')).readFileSync(new URL('../testdata/tool-schema-matrix.json', import.meta.url), 'utf8'))) {
 for (const kind of ['good', 'bad']) test(`signed tool schema matrix: ${item.name} / ${kind}`, async () => {
  let effects = 0;
  const r = runner({registry: registry(args => { effects++; assert.deepEqual(args, item.good); return 'ok'; }, item.schema)});
  await r.instance.accept(signed(item[kind])); await r.instance.drain();
  assert.equal(effects, kind === 'good' ? 1 : 0);
  assert.equal(r.submissions.length, 1);
  assert.equal(r.submissions[0].body.is_error, kind === 'bad');
  if (kind === 'bad') assert.equal(JSON.parse(r.submissions[0].body.output).code, 'invalid_arguments');
 });
}
test('schema dialect defaults to 2020-12; explicit unsupported dialects fail registration', async () => {
 for (const dialect of ['https://json-schema.org/draft/2020-12/schema', 'https://json-schema.org/draft/2019-09/schema','https://json-schema.org/draft/2019-09/schema#']) {
  const r = runner({registry: registry(() => 'ok', {$schema:dialect,type:'object',dependentRequired:{a:['b']}})});
  await r.instance.accept(signed({a:1})); await r.instance.drain();
  assert.equal(JSON.parse(r.submissions[0].body.output).code,'invalid_arguments');
 }
 for (const dialect of ['http://json-schema.org/draft-04/schema#', 'https://example.test/unknown-schema', 7]) {
  assert.throws(() => registry(() => 'never', {$schema:dialect,type:'object'}));
 }
});

const corruptRecords = good => [null, false, 0, '', [], {}, {...good,state:'unknown'}, {...good,state:3},
 {...good,chatId:'wrong-chat'}, {...good,turnId:'wrong-turn'}, {...good,callId:'wrong-call'},
 {...good,fingerprint:'invalid'}, {...good,fingerprint:''}, {...good,output:'x'}, {...good,isError:false},
 {...good,state:'completed'}, {...good,state:'submitted',output:'',isError:false},
 {...good,state:'ambiguous',output:'x',isError:'false'}, {...good,state:'resolved',output:[],isError:false},
 {...good,state:'completed',output:'x'.repeat(131073),isError:false}];
const validRecord = e => ({state:'claimed',fingerprint:'a'.repeat(64),chatId:e.chat_id,turnId:e.turn_id,callId:e.data.call_id});
test('corrupt call or turn records fail closed before claim, mutation, handler, or submission',async()=>{
 for (const barrier of [false,true]) { const e=signed(); for (const value of corruptRecords(validRecord(e))) {
  let effects=0,claims=0,mutations=0;
  const target=JSON.stringify(barrier?['deployment:test/account:1',e.chat_id,'turn',e.turn_id]:['deployment:test/account:1',e.chat_id,e.data.call_id]);
  const store={get:async key=>key===target?structuredClone(value):undefined,claim:async()=>{claims++;return true;},transition:async()=>{mutations++;return true;}};
  const r=runner({store,registry:registry(()=>{effects++;return 'bad';})});
  await assert.rejects(r.instance.accept(e),error=>error.code==='invalid_tool_state');await r.instance.drain();
  assert.equal(effects,0);assert.equal(claims,0);assert.equal(mutations,0);assert.equal(r.submissions.length,0);
 }}
});
test('corruption after an atomic claim is detected without execution or overwrite',async()=>{
 const e=signed();let reads=0,effects=0,mutations=0;
 const store={get:async key=>key.includes('"turn"')?undefined:(++reads===1?undefined:null),claim:async()=>true,transition:async()=>{mutations++;return true;}};
 const r=runner({store,registry:registry(()=>{effects++;return 'bad';})});
 await assert.rejects(r.instance.accept(e),error=>error.code==='invalid_tool_state');
 assert.equal(effects,0);assert.equal(mutations,0);assert.equal(r.submissions.length,0);
});
test('server resolution and terminal barriers do not overwrite corrupt existing records',async()=>{
 for(const type of ['agent.tool.result','turn.completed']){
  let writes=0;const r=runner({store:{get:async()=>null,claim:async()=>{writes++;return true;},transition:async()=>{writes++;return true;}}});
  await assert.rejects(r.instance.accept(event(type)),error=>error.code==='invalid_tool_state');assert.equal(writes,0);
 }
});
test('memory store validates runtime values, immutable identities, and valid tombstones',async()=>{
 const {assertToolRecord}=await import('../dist/index.js');const e=signed();const good=validRecord(e);const key=JSON.stringify(['scope',e.chat_id,e.data.call_id]);
 for(const value of corruptRecords(good)){
  const store=new MemoryToolStateStore();await assert.rejects(store.claim(key,value),error=>error.code==='invalid_tool_state');assert.equal(await store.get(key),undefined);
 }
 for(const key of [JSON.stringify(['scope','bad',e.data.call_id]),JSON.stringify(['scope',e.chat_id,'bad']),'invalid','{}','[]','["s","c"]','["","c","k"]','["s","c","bad","t"]'])assert.throws(()=>assertToolRecord(key,good),error=>error.code==='invalid_tool_state');
 const store=new MemoryToolStateStore();await store.claim(key,good);assert.equal(await store.claim(key,good),false);
 for(const patch of [{turnId:'other'},{fingerprint:'b'.repeat(64)},{callId:'other'},{state:'unknown'}])await assert.rejects(store.transition(key,['claimed'],patch),error=>error.code==='invalid_tool_state');
 assert.deepEqual(await store.get(key),good);assert.equal(await store.transition(key,['submitted'],{state:'resolved'}),false);
 assert.equal(await store.transition(key,['claimed'],{state:'resolved'}),true);
 const barrier=JSON.stringify(['scope',e.chat_id,'turn',e.turn_id]);
 await store.claim(barrier,{state:'abandoned',fingerprint:'',chatId:e.chat_id,turnId:e.turn_id,callId:''});
 await assert.rejects(store.transition(barrier,['abandoned'],{state:'resolved'}),error=>error.code==='invalid_tool_state');
});

test('a changed fingerprint after claim is corruption, never permission to execute',async()=>{
 const e=signed();let reads=0,effects=0,mutations=0;
 const store={get:async key=>JSON.parse(key).length===4?undefined:(++reads===1?undefined:validRecord(e)),claim:async()=>true,transition:async()=>{mutations++;return true;}};
 const r=runner({store,registry:registry(()=>{effects++;return 'bad';})});
 await assert.rejects(r.instance.accept(e),error=>error.code==='invalid_tool_state');
 assert.equal(effects,0);assert.equal(mutations,0);assert.equal(r.submissions.length,0);
});
