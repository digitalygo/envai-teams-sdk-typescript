import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvaiClient, HttpTransport, CompatibilityError, ProtocolError, TransportError, hasCapabilityFeature, isCapabilityFeatures, parseEvent, validateContractValue, uploadAttachmentFile, uploadSourceFile, waitForSource, waitForWikiOperation, operations } from '../dist/index.js';
import { json, sse, event, chatId, capabilities, negotiatedFetch } from './helpers.mjs';
export const wikiFixture = name => JSON.parse(readFileSync(new URL('../testdata/wiki/'+name+'.json',import.meta.url),'utf8'));
const source=wikiFixture('source-accepted').data, operation=wikiFixture('operation-completed').data;
const baseUrl='https://envai.example/api/v1';
const clone=structuredClone;
const completion={id:'cmpl_01ARZ3NDEKTSV4RRFFQ69G5FAV',workspace_id:'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',chat_id:chatId,team_id:'team_01ARZ3NDEKTSV4RRFFQ69G5FAV',user_id:'usr_01ARZ3NDEKTSV4RRFFQ69G5FAV',models_subagents:[],started_at:'2026-10-13T00:00:00Z',usage:{},cost_usd:null,status:'running',created_at:'2026-10-13T00:00:00Z',updated_at:'2026-10-13T00:00:00Z'};

test('default contract 3 preflight precedes versioned mutation and preserves exact body',async()=>{
 const seen=[];const c=new EnvaiClient({baseUrl,apiKey:'key',fetch:async(u,i)=>{seen.push([u,i]);return json(u.endsWith('/capabilities')?capabilities:{status:'accepted',turn_id:'cmpl_01ARZ3NDEKTSV4RRFFQ69G5FAV'},202);}});
 await c.sendChatMessage({chat_id:'a/b',body:{message:'hi'}});
 assert.deepEqual(seen.map(([u,i])=>[new URL(u).pathname,i.method,i.headers.get('X-Envai-Contract-Version')]),[['/api/v1/atp/v3/capabilities','GET','3'],['/api/v1/atp/v3/chats/a%2Fb/messages','POST','3']]);
 assert.equal(seen[1][1].body,'{"message":"hi"}');
});
for(const [name,response] of Object.entries({old404:()=>new Response('{}',{status:404}),noAck:()=>new Response(JSON.stringify(capabilities)),wrongAck:()=>json(capabilities,200,{'X-Envai-Contract-Version':'2'}),wrongProtocol:()=>json({...capabilities,protocol_version:2}),unsupported:()=>json({error:{code:'unsupported_contract_version'}},400),incomplete:()=>json({protocol_version:3}),duplicateAck:()=>json(capabilities,200,{'X-Envai-Contract-Version':'3, 3'})}))test('fail closed before mutations: '+name,async()=>{
 let posts=0;const c=new EnvaiClient({baseUrl,retry:{maxRetries:0},fetch:async(_u,i)=>{if(i.method==='POST')posts++;return response();}});
 await assert.rejects(c.sendChatMessage({chat_id:'x',body:{message:'hi'}}),CompatibilityError);assert.equal(posts,0);
 await assert.rejects(c.wiki.inbox({workspace_id:'w',idempotencyKey:'same-key',body:{webhook_url:'https://app.example/hook'}}),CompatibilityError);assert.equal(posts,0);
});
test('old-server race and ambiguous mutation never downgrade or resubmit',async()=>{
 for(const failure of ['404','missing-ack','network','429']){
  const seen=[];const c=new EnvaiClient({baseUrl,retry:{maxRetries:5,baseDelayMs:0},fetch:async(u,i)=>{seen.push([u,i.method]);if(u.endsWith('/capabilities'))return json(capabilities);if(failure==='network')throw Error('lost');if(failure==='missing-ack')return new Response('{}',{status:202});return json({},Number(failure));}});
  await assert.rejects(c.sendChatMessage({chat_id:'x',body:{message:'hi'}}));assert.equal(seen.filter(x=>x[1]==='POST').length,1);assert.ok(seen.every(x=>x[0].includes('/atp/v3/')));
 }
});
test('selector cannot be overridden, supported configuration is explicit and v2 is read-only',async()=>{
 assert.throws(()=>new EnvaiClient({baseUrl,contractVersion:4}),TypeError);
 const c=new EnvaiClient({baseUrl,fetch:async()=>{throw Error('should not fetch');}});
 await assert.rejects(c.getCapabilities({}, {headers:{'X-Envai-Contract-Version':'2'}}),/Reserved/);
 await assert.rejects(c.getCapabilitiesLegacy(),CompatibilityError);
 const legacy=new EnvaiClient({baseUrl,contractVersion:2,fetch:async()=>{throw Error('should not fetch');}});
 await assert.rejects(legacy.sendChatMessage({chat_id:'x',body:{message:'hi'}}),CompatibilityError);
 await assert.rejects(legacy.wiki.categories({workspace_id:'w'}),CompatibilityError);
 await assert.rejects(legacy.createWorkspace({body:{name:'x'}}),CompatibilityError);
 await assert.rejects(new HttpTransport({baseUrl,contractVersion:2}).negotiate(),CompatibilityError);
});
test('strict numeric v2 and nullable v3 apply to every usage and terminal field',()=>{
 for(const type of ['turn.completed','turn.cancelled','turn.failed','agent.done','agent.tool.complete']){
  const original=type==='agent.done'?{...event('agent.text.delta'),type,data:{status:'completed',summary:'done',usage:event('turn.completed').data.usage,duration_ms:1}}:type==='agent.tool.complete'?{...event('agent.tool.request'),type,data:{call_id:event('agent.tool.request').data.call_id,result:'done',is_error:false,usage:event('turn.completed').data.usage}}:event(type);assert.equal(parseEvent(original).v,2);
  const nullable=clone(original);nullable.data.usage.cost_usd=null;
  if(type.startsWith('turn.')){nullable.data.cost=null;nullable.data.chat_cost=null;nullable.data.chat_usage.cost_usd=null;}
  assert.throws(()=>parseEvent(nullable),ProtocolError);
  nullable.v=3;assert.equal(parseEvent(nullable).data.usage.cost_usd,null);assert.throws(()=>parseEvent(nullable,2),ProtocolError);
  const numeric={...clone(original),v:3};assert.equal(parseEvent(numeric).v,3);
 }
 assert.throws(()=>parseEvent({...event('ping'),v:4}),/Unsupported/);
});
test('mixed replay preserves bytes and version on reconnect; legacy is finite and strict',async()=>{
 const seen=[];let n=0;const old=event('turn.started',1),fresh={...event('turn.completed',2),v:3};fresh.data.cost=null;fresh.data.usage.cost_usd=null;
 const c=new EnvaiClient({baseUrl,fetch:async(u,i)=>{seen.push([u,i.headers.get('X-Envai-Contract-Version')]);return sse(++n===1?[old]:[old,fresh]);}});
 const got=[];for await(const e of c.events(chatId,{reconnectDelayMs:0,maxReconnects:1})){got.push(e);if(e.type==='turn.completed')break;}
 assert.equal(got[0].v,2);assert.equal(got[1].v,3);assert.equal(got[1].data.cost,null);assert.equal(new URL(seen[1][0]).searchParams.get('after'),'1');assert.ok(seen.every(x=>x[0].includes('/atp/v3/')&&x[1]==='3'));
 let calls=0;const legacy=new EnvaiClient({baseUrl,contractVersion:2,fetch:async(u,i)=>{calls++;assert.ok(!u.includes('/atp/v3/'));assert.equal(i.headers.get('X-Envai-Contract-Version'),'2');const r=sse([old]);r.headers.set('X-Envai-Contract-Version','2');return r;}});
 const replay=[];for await(const e of legacy.events(chatId))replay.push(e);assert.equal(calls,1);assert.equal(replay.length,1);
 for(const failure of ['network','null','gap']){let calls=0;const bad=new EnvaiClient({baseUrl,contractVersion:2,retry:{maxRetries:0},fetch:async()=>{calls++;if(failure==='network')throw Error('network');const r=sse([failure==='null'?fresh:event('turn.started',4)]);r.headers.set('X-Envai-Contract-Version','2');return r;}});await assert.rejects(async()=>{for await(const _ of bad.events(chatId)){};});assert.equal(calls,1);}
});
test('completion reads acknowledge before validation, strict legacy null rejection, snapshot turn binding and atomic list validation',async()=>{
 for(const version of [2,3]){
  const c=new EnvaiClient({baseUrl,contractVersion:version,fetch:async()=>json({data:completion},200,{'X-Envai-Contract-Version':String(version)})});
  const read=c.getCompletion({workspace_id:'w',chat_id:'c',completion_id:'d'});
  if(version===2)await assert.rejects(read,ProtocolError);else assert.equal((await read).cost_usd,null);
 }
 const numeric={...completion,cost_usd:0};assert.equal(validateContractValue('Completion',numeric,2).cost_usd,0);
 const bad=new EnvaiClient({baseUrl,fetch:async()=>new Response('{"data":null}')});await assert.rejects(bad.getCompletion({workspace_id:'w',chat_id:'c',completion_id:'d'}),CompatibilityError);
 const data={...completion,terminal_snapshot:{event_id:'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',event_type:'turn.completed',occurred_at:'2026-10-13T00:00:00Z',data:{turn_id:'cmpl_01ARZ3NDEKTSV4RRFFQ69G5FAW'}}};
 assert.throws(()=>validateContractValue('Completion',data),/another turn/);
 assert.throws(()=>validateContractValue('CompletionCollection',{data:[numeric,completion],links:{},meta:{}},2),ProtocolError);
 assert.equal(validateContractValue('CompletionCollection',{data:[numeric,completion],links:{},meta:{}}).data.length,2);
});
test('all wiki metadata fixtures validate without decimal or currency coercion',()=>{
 for(const name of ['source-accepted','source-conversion-exhausted','source-conversion-no-audio','source-conversion-retry','operation-completed','categories','category-index','usage-empty','usage-pending','file-processed','file-deleted','operation-event']){
  const f=wikiFixture(name);assert.deepEqual(validateContractValue(f.schema,f.data),f.data);
 }
 const pending=wikiFixture('usage-pending').data;assert.equal(pending.totals,null);assert.equal(typeof pending.priced_subtotals[0].amount,'string');
 assert.throws(()=>validateContractValue('UsageCost',{...pending,totals:[]}),ProtocolError);
 assert.throws(()=>validateContractValue('UsageCost',{...pending,status:'complete'}),ProtocolError);
});
const wireCases=[
 ['uploadWikiSource',{workspace_id:'w/a',idempotencyKey:'upload-1',body:{file:new File(['original'],'sample.txt')}},source,'POST','/workspaces/w%2Fa/files/sources'],
 ['getWikiSource',{workspace_id:'w/a',file_id:'f/b'},source,'GET','/workspaces/w%2Fa/files/sources/f%2Fb'],
 ['withdrawWikiSource',{workspace_id:'w/a',body:{file_id:'f/b'}},source,'POST','/workspaces/w%2Fa/wiki/outbox/files'],
 ...['Inbox','Outbox','Sync'].map((kind)=>['createWiki'+kind+'Run',{workspace_id:'w/a',idempotencyKey:'run-'+kind,body:{webhook_url:'https://app.example/hook'}},operation,'POST','/workspaces/w%2Fa/wiki/'+({Inbox:'inbox/runs',Outbox:'outbox/runs',Sync:'syncs'}[kind])]),
 ['getWikiOperation',{workspace_id:'w/a',operation_id:'o/b'},operation,'GET','/workspaces/w%2Fa/wiki/operations/o%2Fb'],
 ['listWikiCategories',{workspace_id:'w/a'},wikiFixture('categories').data,'GET','/workspaces/w%2Fa/wiki/categories'],
 ['getWikiCategoryIndex',{workspace_id:'w/a',category_id:'c/b',from:1,to:20,type:'artifact',catalog_revision:4},wikiFixture('category-index').data,'GET','/workspaces/w%2Fa/wiki/categories/c%2Fb/index'],
];
for(const [method,params,result,http,path]of wireCases)test('wiki HTTP '+method,async()=>{
 let request;const c=new EnvaiClient({baseUrl,apiKey:'key',fetch:negotiatedFetch(async(u,i)=>{request={u,i};return json({data:result},http==='POST'?202:200);})});
 assert.deepEqual(await c[method](params),result);assert.equal(new URL(request.u).pathname,'/api/v1'+path);assert.equal(request.i.method,http);assert.equal(request.i.headers.get('X-Envai-Contract-Version'),'3');assert.equal(request.i.headers.get('authorization'),'Bearer key');
 if(params.idempotencyKey)assert.equal(request.i.headers.get('Idempotency-Key'),params.idempotencyKey);
 if(method==='getWikiCategoryIndex')assert.equal(new URL(request.u).search,'?from=1&to=20&type=artifact&catalog_revision=4');
});
test('scoped download is streamed and public webhook JWKS never sends credentials or negotiation',async()=>{
 const seen=[];const c=new EnvaiClient({baseUrl,apiKey:'key',fetch:async(u,i)=>{seen.push([u,i]);return u.endsWith('jwks.json')?json({keys:[]}):new Response('exact original',{headers:{'X-Envai-Contract-Version':'3'}});}});
 assert.equal(await (await c.workspaceFiles.downloadSource({workspace_id:'w',file_id:'f'})).text(),'exact original');
 await c.getWikiWebhookJwks();assert.equal(seen[1][0],'https://envai.example/.well-known/wiki-webhook-jwks.json');assert.equal(seen[1][1].headers.get('authorization'),null);assert.equal(seen[1][1].headers.get('X-Envai-Contract-Version'),null);
 const verifier=c.createWikiWebhookVerifier('workspace');await verifier.jwks.get(false);await verifier.jwks.get(false);assert.equal(seen.length,3);
});
test('idempotency and category input validation happen before network; accepted mutations are never retried',async()=>{
 let calls=0;const c=new EnvaiClient({baseUrl,fetch:async()=>{calls++;throw Error('unexpected');}});
 for(const key of ['',undefined,'bad key','a'.repeat(256)])await assert.rejects(c.wiki.inbox({workspace_id:'w',idempotencyKey:key,body:{webhook_url:'https://app.example/hook'}}),TypeError);
 for(const params of [{},{from:0,to:1},{from:2,to:1},{all:true,from:1},{all:false},{all:true,type:'bad'},{all:true,catalog_revision:-1}])await assert.rejects(c.wiki.categoryIndex({workspace_id:'w',category_id:'c',...params}),TypeError);
 for(const file of [null,'bytes',Object.defineProperty(new Blob([]),'size',{value:1_000_000_001})])await assert.rejects(c.uploadWikiSource({workspace_id:'w',idempotencyKey:'key',body:{file}}),TypeError);
 assert.equal(calls,0);
 let posts=0;const bad=new EnvaiClient({baseUrl,fetch:negotiatedFetch(async()=>{posts++;throw Error('lost');})});await assert.rejects(bad.wiki.inbox({workspace_id:'w',idempotencyKey:'key',body:{webhook_url:'https://app.example/hook'}}),TransportError);assert.equal(posts,1);
});
test('filesystem-backed upload, conversion polling, terminal failure and abort/timeout',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'envai-wiki-'));const path=join(dir,'source.txt');writeFileSync(path,'original');
 try{
  let multipart;const c=new EnvaiClient({baseUrl,fetch:negotiatedFetch(async(_u,i)=>{multipart=i.body;return json({data:source},202);})});
  await uploadSourceFile(c,'w',path,'upload');assert.equal(await multipart.get('file').text(),'original');assert.equal(multipart.get('file').name,'source.txt');
  await uploadSourceFile(c,'w',path,'upload',{filename:'override.txt',mimeType:'text/plain'});assert.equal(multipart.get('file').name,'override.txt');
  const abort=new AbortController();abort.abort();await assert.rejects(uploadSourceFile(c,'w',path,'key',{signal:abort.signal}),e=>e.name==='AbortError');
 }finally{rmSync(dir,{recursive:true});}
 const cases=[{...source,lifecycle:'inbox',conversion:{status:'completed'}},{...source,conversion:{status:'failed',recoverable:false}},{...source,lifecycle:'outbox'},{...source,lifecycle:'deleting'},{...source,lifecycle:'deleted'}];
 for(const final of cases){let count=0;const c=new EnvaiClient({baseUrl,fetch:async()=>json({data:count++?final:source})});assert.deepEqual(await waitForSource(c,'w','f',{intervalMs:1}),final);assert.equal(count,2);}
 for(const status of ['completed','failed']){let count=0;const final={...operation,status};const c=new EnvaiClient({baseUrl,fetch:async()=>json({data:count++?final:{...operation,status:'running'}})});assert.equal((await waitForWikiOperation(c,'w','o',{intervalMs:1})).status,status);}
 const hanging=new EnvaiClient({baseUrl,fetch:async(_u,i)=>new Promise((_,reject)=>i.signal.addEventListener('abort',()=>reject(i.signal.reason),{once:true}))});await assert.rejects(waitForSource(hanging,'w','f',{timeoutMs:5}),e=>e.name==='TimeoutError');
 const controller=new AbortController();controller.abort();await assert.rejects(waitForWikiOperation(hanging,'w','o',{signal:controller.signal}),e=>e.name==='AbortError');
});
test('explicit legacy capabilities and raw historical streams bind to version 2',async()=>{
 const seen=[];const c=new EnvaiClient({baseUrl,contractVersion:2,fetch:async(u,i)=>{seen.push([u,i]);return u.endsWith('/capabilities')?json({protocol_version:2},200,{'X-Envai-Contract-Version':'2'}):new Response('',{headers:{'X-Envai-Contract-Version':'2','content-type':'text/event-stream'}});}});
 assert.equal((await c.getCapabilitiesLegacy()).protocol_version,2);
 assert.equal((await c.getCapabilities()).protocol_version,2);
 const response=await c.streamChatEventsLegacy({chat_id:'x'});await response.body.cancel();assert.equal(seen.length,3);assert.ok(seen.every(([u,i])=>!u.includes('/atp/v3/')&&i.headers.get('X-Envai-Contract-Version')==='2'));
 await assert.rejects(new EnvaiClient({baseUrl}).streamChatEventsLegacy({chat_id:'x'}),CompatibilityError);
 const liar=new EnvaiClient({baseUrl,contractVersion:2,fetch:async()=>json(capabilities,200,{'X-Envai-Contract-Version':'2'})});await assert.rejects(liar.getCapabilitiesLegacy(),CompatibilityError);
});
test('capability fields and required upgrade are checked for direct reads as well as preflight',async()=>{
 for(const value of [null,{...capabilities,contract_version:2},{...capabilities,supported_contract_versions:[3]},{...capabilities,supported_contract_versions:[2]},{...capabilities,legacy_v2_mode:'live'}]){
  const c=new EnvaiClient({baseUrl,fetch:async()=>json(value)});await assert.rejects(c.getCapabilities(),CompatibilityError);
 }
 const upgrade=new EnvaiClient({baseUrl,contractVersion:2,fetch:async()=>json({error:{code:'contract_upgrade_required'}},426)});await assert.rejects(upgrade.getCompletion({workspace_id:'w',chat_id:'c',completion_id:'x'}),CompatibilityError);
});
test('all catalog range, header key fallback and empty decoded metadata are tested',async()=>{
 let seen;const c=new EnvaiClient({baseUrl,fetch:negotiatedFetch(async(u,i)=>{seen=[u,i];return json({data:u.includes('categories')?{...wikiFixture('category-index').data,entries:[],returned_count:0}:operation});})});
 await c.wiki.categoryIndex({workspace_id:'w',category_id:'c',all:true});assert.equal(new URL(seen[0]).search,'?all=true');
 await c.wiki.inbox({workspace_id:'w',body:{webhook_url:'https://app.example/hook'}},{headers:{'Idempotency-Key':'provided-key'}});assert.equal(seen[1].headers.get('Idempotency-Key'),'provided-key');
 const empty=new EnvaiClient({baseUrl,fetch:negotiatedFetch(async()=>new Response(null,{status:204}))});await assert.rejects(empty.cancelChatTurn({chat_id:'x'}),ProtocolError);assert.equal(await empty.deleteUserTool({name:'x'}),undefined);
});
test('parser and generic schema validation reject unsupported selected profiles',()=>{
 assert.throws(()=>parseEvent(event('ping'),4),ProtocolError);assert.throws(()=>validateContractValue('UsageCost',{},4),CompatibilityError);
});
test('inclusive billion-byte originals remain file-backed and oversized sources fail before requests',async()=>{
 const {truncateSync}=await import('node:fs');const dir=mkdtempSync(join(tmpdir(),'envai-sparse-')),path=join(dir,'large.txt');writeFileSync(path,'');let calls=0;
 try{
  const client=new EnvaiClient({baseUrl,fetch:negotiatedFetch(async(_u,i)=>{calls++;assert.equal(i.body.get('file').size,1_000_000_000);return json({data:source},202);})});
  truncateSync(path,1_000_000_000);await uploadSourceFile(client,'w',path,'key');assert.equal(calls,1);
  truncateSync(path,1_000_000_001);await assert.rejects(uploadSourceFile(client,'w',path,'key'),TypeError);assert.equal(calls,1);
 }finally{rmSync(dir,{recursive:true});}
});
test('unsafe revisions and non-finite monetary projections fail rather than round or coerce',()=>{
 assert.throws(()=>validateContractValue('WikiSource',{...source,source_revision:Number.MAX_SAFE_INTEGER+1}),ProtocolError);
 const usage=wikiFixture('usage-pending').data;assert.throws(()=>validateContractValue('UsageCost',{...usage,revision:Number.MAX_SAFE_INTEGER+1}),ProtocolError);
 assert.throws(()=>validateContractValue('Completion',{...completion,cost_usd:Infinity}),ProtocolError);
 const bad={...event('turn.completed'),v:3};bad.data.cost=Infinity;assert.throws(()=>parseEvent(bad),ProtocolError);
});
test('current cost reconciliation leaves immutable terminal identity, timing and bytes unchanged',async()=>{
 const pending=wikiFixture('usage-pending').data;
 for(const name of ['actual-completed','actual-recovered','completed','recovered']){
  const fixture=JSON.parse(readFileSync(new URL('../testdata/completion-terminal/'+name+'.json',import.meta.url),'utf8'));const terminal=fixture.data?.turn_id?fixture:fixture.data;
  const snapshot=clone(terminal),id=snapshot.data.turn_id;
  const initial={...completion,id,usage_cost:pending,terminal_snapshot:snapshot};
  const before=JSON.stringify(snapshot);const closed={...pending,status:'complete',scope_status:'closed',revision:pending.revision+1,pending_invocation_count:0,totals:[{currency:'EUR',amount:'0.12000000000000000001'}]};
  const final={...initial,usage_cost:closed};let count=0;
  const client=new EnvaiClient({baseUrl,fetch:async()=>json({data:count++?final:initial})});
  const first=await client.completions.get({workspace_id:'w',chat_id:'c',completion_id:id});const last=await client.completions.get({workspace_id:'w',chat_id:'c',completion_id:id});
  assert.equal(first.cost_usd,null);assert.equal(last.cost_usd,null);assert.equal(last.usage_cost.totals[0].amount,'0.12000000000000000001');assert.equal(JSON.stringify(first.terminal_snapshot),before);assert.equal(JSON.stringify(last.terminal_snapshot),before);assert.equal(last.usage_cost.revision,first.usage_cost.revision+1);
 }
 const provenance=JSON.parse(readFileSync(new URL('../testdata/completion-terminal/provenance.json',import.meta.url),'utf8'));
 const {createHash}=await import('node:crypto');for(const [file,meta]of Object.entries(provenance.files)){const bytes=readFileSync(new URL('../testdata/completion-terminal/'+file,import.meta.url));assert.equal(bytes.length,meta.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),meta.sha256);}
});
test('negotiated selection cannot be mutated between a stream and its reconnect',async()=>{
 const selected={baseUrl,contractVersion:3};const transport=new HttpTransport(selected);selected.contractVersion=2;assert.equal(transport.contractVersion,3);assert.throws(()=>{transport.contractVersion=2;},TypeError);assert.equal(transport.contractVersion,3);
});
test('legacy replay validates an entire finite snapshot before exposing any prefix',async()=>{
 for(const tail of [{...event('turn.completed',2),v:3},{...event('turn.completed',2),data:{}},{...event('turn.started',2),chat_id:'other'},event('turn.completed',4)]){
  let calls=0;const c=new EnvaiClient({baseUrl,contractVersion:2,fetch:async()=>{calls++;const r=sse([event('turn.started',1),tail]);r.headers.set('X-Envai-Contract-Version','2');return r;}});const got=[];
  await assert.rejects(async()=>{for await(const e of c.events(chatId))got.push(e);},ProtocolError);assert.equal(got.length,0);assert.equal(calls,1);
 }
 let calls=0;const data=[event('ping',0),event('turn.started',1),event('turn.completed',2)];
 const c=new EnvaiClient({baseUrl,contractVersion:2,fetch:async()=>{calls++;const r=sse(data,1);r.headers.set('X-Envai-Contract-Version','2');return r;}});const stream=c.events(chatId);const got=[];for await(const e of stream)got.push(e);assert.deepEqual(got.map(e=>[e.v,e.seq]),[[2,0],[2,1],[2,2]]);assert.equal(stream.lastSeq,2);assert.equal(calls,1);
});
test('legacy buffer limit is explicit, applies to exact wire bytes and never truncates',async()=>{
 const data=[event('turn.started',1),event('turn.completed',2)];const wire=data.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('');const size=Buffer.byteLength(wire);
 const c=new EnvaiClient({baseUrl,contractVersion:2,fetch:async()=>{const r=sse(data,7);r.headers.set('X-Envai-Contract-Version','2');return r;}});
 for(const invalid of [0,-1,1.5,Infinity])assert.throws(()=>c.events(chatId,{maxLegacySnapshotBytes:invalid}),RangeError);
 const accepted=[];for await(const e of c.events(chatId,{maxLegacySnapshotBytes:size}))accepted.push(e);assert.equal(accepted.length,2);
 const got=[];await assert.rejects(async()=>{for await(const e of c.events(chatId,{maxLegacySnapshotBytes:size-1}))got.push(e);},/maxLegacySnapshotBytes/);assert.equal(got.length,0);
});
test('legacy cancellation while buffering emits no prefix and closes the response',async()=>{
 let controller,cancelled=false,requests=0;const abort=new AbortController();const c=new EnvaiClient({baseUrl,contractVersion:2,fetch:async()=>{requests++;return new Response(new ReadableStream({start(c){controller=c;c.enqueue(new TextEncoder().encode('data: '+JSON.stringify(event('turn.started',1))+'\n\n'));},cancel(){cancelled=true;}}),{headers:{'X-Envai-Contract-Version':'2','content-type':'text/event-stream'}});}});
 const got=[];const work=(async()=>{for await(const e of c.events(chatId,{signal:abort.signal}))got.push(e);})();await new Promise(resolve=>setTimeout(resolve,5));abort.abort();await assert.rejects(work,e=>e.name==='AbortError');assert.equal(got.length,0);assert.equal(cancelled,true);assert.equal(requests,1);
 await assert.rejects(c.sendAndWait(chatId,{message:'no paid work'}),CompatibilityError);assert.equal(requests,1);
});
test('truncated finite legacy SSE tail is an atomic protocol error',async()=>{
 const wire='data: '+JSON.stringify(event('turn.started',1))+'\n\ndata: '+JSON.stringify(event('turn.completed',2));
 const c=new EnvaiClient({baseUrl,contractVersion:2,fetch:async()=>new Response(wire,{headers:{'X-Envai-Contract-Version':'2','content-type':'text/event-stream'}})});const got=[];
 await assert.rejects(async()=>{for await(const e of c.events(chatId))got.push(e);},/Truncated legacy/);assert.equal(got.length,0);
});
test('shared schemas match the verified backend Git tree byte-for-byte',async()=>{
 const {createHash}=await import('node:crypto');const manifest=JSON.parse(readFileSync(new URL('../contracts/manifest.json',import.meta.url),'utf8'));
 assert.equal(manifest.commit,'3a9ecf3a4ccd3291474848d3dc9d0100170b9e54');assert.equal(manifest.operationCount,76);assert.equal(manifest.atpVersion,3);
 assert.equal(manifest.sha256['events-v2.json'],'88d41835f88c0cc4ad071b06ed4623882c6b64144baf312c4a095504c98cd7d6');
 assert.equal(createHash('sha256').update(readFileSync(new URL('../contracts/openapi-v2.json',import.meta.url))).digest('hex'),'bbe7fcc23415e25012fdb88f1931fd8d12a96f7884de8d58c875459a557c5155');
 assert.deepEqual(Object.keys(manifest.sources).sort(),['events-v2.json','events.json','openapi.yaml','smidja-native.json','terminal-snapshot.json','wiki.json']);
 for(const [name,source]of Object.entries(manifest.sources)){const bytes=readFileSync(new URL('../contracts/'+name,import.meta.url));assert.equal(bytes.length,source.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),source.sha256);assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),source.git_blob_sha);assert.equal(source.repository_path,'packages/contracts/'+name);}
 const openapi=JSON.parse(readFileSync(new URL('../contracts/openapi.json',import.meta.url),'utf8'));const ids=Object.values(openapi.paths).flatMap(path=>Object.values(path).filter(x=>x?.operationId).map(x=>x.operationId));assert.deepEqual(ids.sort(),Object.keys(operations).sort());
 assert.ok(openapi.components.schemas.ImageGenerationRequest.properties.aspect_ratio.enum.every(x=>typeof x==='string'));
});
test('derived OpenAPI and shared attachment fixtures retain separate provenance',async()=>{
 const {createHash}=await import('node:crypto');const manifest=JSON.parse(readFileSync(new URL('../contracts/manifest.json',import.meta.url),'utf8'));
 assert.deepEqual(Object.keys(manifest.derived_artifacts),['openapi.json']);
 assert.deepEqual(Object.keys(manifest.shared_fixtures),['failed.json','pending.json','ready.json','recoverable.json']);
 for(const [collection,entries]of Object.entries({derived_artifacts:manifest.derived_artifacts,shared_fixtures:manifest.shared_fixtures}))for(const[name,entry]of Object.entries(entries)){
  const bytes=readFileSync(new URL('../'+entry.snapshot_path,import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256);assert.ok(entry.origin);
  if(collection==='derived_artifacts'){assert.equal(bytes.length,entry.bytes);assert.equal(entry.source_repository_path,'packages/contracts/openapi.yaml');}
  else assert.equal(entry.repository_path,'packages/contracts/fixtures/chat-attachments/'+name);
 }
});
test('actual control-plane HTTP payloads hydrate through selected contracts with verified provenance',async()=>{
 const load=name=>JSON.parse(readFileSync(new URL('../testdata/control-plane-http/'+name+'.json',import.meta.url),'utf8'));
 const cases=[['source','source-headers',3,'getWikiSource',{workspace_id:'w',file_id:'f'}],['completion-pending','completion-headers',3,'getCompletion',{workspace_id:'w',chat_id:'c',completion_id:'t'}],['legacy-completion',null,2,'getCompletion',{workspace_id:'w',chat_id:'c',completion_id:'t'}]];
 for(const [name,headersFile,version,method,params] of cases){const body=load(name);const headers=headersFile?Object.fromEntries(Object.entries(load(headersFile)).map(([key,value])=>[key,Array.isArray(value)?value.join(', '):value])):{'X-Envai-Contract-Version':'2'};const c=new EnvaiClient({baseUrl,contractVersion:version,fetch:async()=>new Response(JSON.stringify(body),{headers})});const decoded=await c[method](params);assert.deepEqual(decoded,body.data);if(name==='completion-pending')assert.equal(decoded.cost_usd,null);}
 const provenance=load('provenance');const {createHash}=await import('node:crypto');for(const [file,meta]of Object.entries(provenance.files)){const bytes=readFileSync(new URL('../testdata/control-plane-http/'+file,import.meta.url));assert.equal(bytes.length,meta.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),meta.sha256);}
});
test('legacy completion nested reserved cost keys remain numeric without discarding unknown usage data',()=>{
 for(const key of ['cost','cost_usd','chat_cost'])for(const cost of [null,'0',-1,Infinity,[],{}]){
  const record={...completion,cost_usd:0,usage:{agent:{children:[{[key]:cost}]},metadata:{nullable:null}}};
  assert.throws(()=>validateContractValue('Completion',record,2),ProtocolError);
 }
 const record={...completion,cost_usd:0,usage:{agent:{children:[{cost:0,cost_usd:0.25,chat_cost:1}]},metadata:{nullable:null,label:'reserved keys only'}}};
 assert.deepEqual(validateContractValue('Completion',record,2),record);
 const nullable={...record,usage:{agent:{cost_usd:null}}};assert.deepEqual(validateContractValue('Completion',nullable,3),nullable);
});
test('legacy duplicate, backwards and pre-cursor sequences fail atomically; v3 dedup remains separate',async()=>{
 for(const [events,options]of [[[event('turn.started',1),event('turn.completed',1)],{}],[[event('turn.started',1),event('agent.text.delta',2),event('turn.completed',1)],{}],[[event('turn.started',2),event('turn.completed',1)],{after:1,resume:'same-runtime'}],[[event('turn.started',1)],{after:1,resume:'same-runtime'}]]){
  const c=new EnvaiClient({baseUrl,contractVersion:2,fetch:async()=>{const r=sse(events);r.headers.set('X-Envai-Contract-Version','2');return r;}});const got=[];await assert.rejects(async()=>{for await(const e of c.events(chatId,options))got.push(e);},/duplicate or backwards/);assert.equal(got.length,0);
 }
});
test('canonical capabilities fixture matches provenance and accepts list or strict map',async()=>{
 const {createHash}=await import('node:crypto');
 const fixture=JSON.parse(readFileSync(new URL('../testdata/capabilities/canonical-v3.json',import.meta.url),'utf8'));
 const provenance=JSON.parse(readFileSync(new URL('../testdata/capabilities/provenance.json',import.meta.url),'utf8'));
 assert.equal(provenance.source_repository,'digitalygo/envai-teams');
 assert.equal(provenance.source_path,'apps/execution-plane/internal/gateway/capabilities.go');
 assert.equal(provenance.source_commit,'7192fc05ebec817bddc705186c8f195cc0dc5ec5');
 assert.equal(provenance.captured_source_commit,'6c3202118b914d2b2ff68577edb44495bfa1ca3b');
 assert.equal(provenance.sdk_reference_commit,'93eafc02271035065ac975f91cd4f77d148c9d2c');
 assert.equal(provenance.files['canonical-v3.json'],createHash('sha256').update(readFileSync(new URL('../testdata/capabilities/canonical-v3.json',import.meta.url))).digest('hex'));
 const listed=await new EnvaiClient({baseUrl,fetch:async()=>json(fixture.body)}).getCapabilities();
 assert.deepEqual(listed.features,fixture.body.features);
 const mapped=await new EnvaiClient({baseUrl,fetch:async()=>json({...fixture.body,features:{chat_attachments:true,chat_attachment_originals:true,wiki_original_sources:true,wiki_original_sources_beta:false}})}).getCapabilities();
 assert.deepEqual(mapped.features,['chat_attachments','chat_attachment_originals','wiki_original_sources']);
 for(const features of ['wiki_original_sources',[1],['wiki_original_sources',42],{wiki_original_sources:'true'},{wiki_original_sources:1},null])await assert.rejects(new EnvaiClient({baseUrl,fetch:async()=>json({...fixture.body,features})}).getCapabilities(),CompatibilityError);
});
test('canonical capabilities drive native attachment upload with one preflight',async()=>{
 const fixture=JSON.parse(readFileSync(new URL('../testdata/capabilities/canonical-v3.json',import.meta.url),'utf8'));
 const attachment=JSON.parse(readFileSync(new URL('../testdata/chat-attachments/original-ready.json',import.meta.url),'utf8')).data;
 const dir=mkdtempSync(join(tmpdir(),'envai-canonical-'));const path=join(dir,'native.txt');writeFileSync(path,'canonical bytes');
 try{
  const requests=[];let body;const c=new EnvaiClient({baseUrl:'https://envai.example',fetch:async(u,i)=>{requests.push([new URL(u).pathname,i.method]);if(i.method==='POST')body=i.body;return u.endsWith('/capabilities')?json(fixture.body):json({data:attachment},202);}});
  assert.equal((await uploadAttachmentFile(c,'w','c',path,'canonical-key')).attachment_id,attachment.attachment_id);
  assert.deepEqual(requests,[['/api/v1/atp/v3/capabilities','GET'],['/api/v1/workspaces/w/chats/c/attachments','POST']]);
  assert.equal(await body.get('file').text(),'canonical bytes');assert.equal(body.get('file').name,'native.txt');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('wiki wait recognizes original inbox readiness without starting indexing',async()=>{
 const original=wikiFixture('source-original-ready').data;
 const uploaded={...original,lifecycle:'uploaded',indexing:{status:'pending_conversion'}};
 const requests=[];let reads=0;
 const c=new EnvaiClient({baseUrl,fetch:async(u,i)=>{requests.push([new URL(u).pathname,i.method]);return json({data:++reads===1?uploaded:original});}});
 assert.deepEqual(await waitForSource(c,'w','f',{intervalMs:1,timeoutMs:100}),original);
 assert.deepEqual(requests,[['/api/v1/workspaces/w/files/sources/f','GET'],['/api/v1/workspaces/w/files/sources/f','GET']]);
 assert.equal(validateContractValue('WikiSource',original).conversion.status,'not_required');
 const raw={...original,lifecycle:'raw',indexing:{status:'processed'}};
 assert.deepEqual(await waitForSource(new EnvaiClient({baseUrl,fetch:async()=>json({data:raw})}),'w','f',{timeoutMs:100}),raw);
});
test('original wiki helper and low-level upload require wiki_original_sources before multipart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'envai-wiki-original-'));const path=join(dir,'source.txt');writeFileSync(path,'original bytes');
 const source=wikiFixture('source-original-ready').data;
 try{
  for(const features of [[],['chat_attachments'],{wiki_original_sources:false},{wiki_original_sources:'true'},{wiki_original_sources_beta:true},['wiki_original_sources',42]])for(const method of ['helper','low']){
   const requests=[];const c=new EnvaiClient({baseUrl:'https://envai.example',fetch:async(u,i)=>{requests.push([new URL(u).pathname,i.method]);return json({...capabilities,features});}});
   const upload=method==='helper'?uploadSourceFile(c,'w',path,'original-key',{processing:'original'}):c.uploadWikiSource({workspace_id:'w',idempotencyKey:'original-key',body:{file:new File(['original bytes'],'source.txt'),processing:'original'}});
   await assert.rejects(upload,CompatibilityError);
   assert.deepEqual(requests,[['/api/v1/atp/v3/capabilities','GET']]);
  }
  for(const features of [['wiki_original_sources'],{wiki_original_sources:true}]){
   const requests=[];let body;const c=new EnvaiClient({baseUrl:'https://envai.example',fetch:async(u,i)=>{requests.push([new URL(u).pathname,i.method]);if(i.method==='POST')body=i.body;return u.endsWith('/capabilities')?json({...capabilities,features}):json({data:source},202);}});
   assert.equal((await uploadSourceFile(c,'w',path,'original-key',{processing:'original',filename:'source.txt',mimeType:'text/plain'})).conversion.status,'not_required');
   assert.deepEqual(requests,[['/api/v1/atp/v3/capabilities','GET'],['/api/v1/workspaces/w/files/sources','POST']]);
   assert.equal(body.get('processing'),'original');assert.equal(body.get('file').name,'source.txt');assert.equal(await body.get('file').text(),'original bytes');
  }
  const requests=[];let body;const c=new EnvaiClient({baseUrl:'https://envai.example',fetch:async(u,i)=>{requests.push([new URL(u).pathname,i.method]);if(i.method==='POST')body=i.body;return u.endsWith('/capabilities')?json({...capabilities,features:{wiki_original_sources:true}}):json({data:source},202);}});
  assert.equal((await c.uploadWikiSource({workspace_id:'w',idempotencyKey:'low-key',body:{file:new File(['low bytes'],'low.txt'),processing:'original'}})).conversion.status,'not_required');
  assert.deepEqual(requests,[['/api/v1/atp/v3/capabilities','GET'],['/api/v1/workspaces/w/files/sources','POST']]);
  assert.equal(body.get('processing'),'original');assert.equal(await body.get('file').text(),'low bytes');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('wiki upload omits processing for default and explicit convert and rejects invalid modes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'envai-wiki-convert-'));const path=join(dir,'source.txt');writeFileSync(path,'converted bytes');
 const source=wikiFixture('source-accepted').data;
 try{
  for(const options of [{},{processing:'convert'}])for(const features of [[]]){
   let body;const requests=[];const c=new EnvaiClient({baseUrl:'https://envai.example',fetch:async(u,i)=>{requests.push([new URL(u).pathname,i.method]);if(i.method==='POST')body=i.body;return u.endsWith('/capabilities')?json({...capabilities,features}):json({data:source},202);}});
   await uploadSourceFile(c,'w',path,'convert-key',options);
   assert.deepEqual(requests,[['/api/v1/atp/v3/capabilities','GET'],['/api/v1/workspaces/w/files/sources','POST']]);
   assert.equal(body.has('processing'),false);assert.equal(await body.get('file').text(),'converted bytes');
  }
  for(const action of [
   ()=>uploadSourceFile(new EnvaiClient({baseUrl:'https://envai.example',fetch:async()=>{throw Error('must not send');}}),'w',path,'key',{processing:'ocr'}),
   ()=>new EnvaiClient({baseUrl:'https://envai.example',fetch:async()=>{throw Error('must not send');}}).uploadWikiSource({workspace_id:'w',idempotencyKey:'key',body:{file:new File(['x'],'x.txt'),processing:'ocr'}}),
  ])await assert.rejects(action(),e=>e instanceof TypeError||e instanceof CompatibilityError);
  let body;const low=new EnvaiClient({baseUrl:'https://envai.example',fetch:async(u,i)=>{if(i.method==='POST')body=i.body;return u.endsWith('/capabilities')?json({...capabilities,features:[]}):json({data:source},202);}});
  await low.uploadWikiSource({workspace_id:'w',idempotencyKey:'key',body:{file:new File(['x'],'x.txt'),processing:'convert'}});
  assert.equal(body.has('processing'),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('feature advertisement guard accepts strict maps and rejects malformed shapes',()=>{
 assert.equal(hasCapabilityFeature(['chat_attachments'],'chat_attachments'),true);
 assert.equal(hasCapabilityFeature(['chat_attachments',1],'chat_attachments'),false);
 assert.equal(hasCapabilityFeature({chat_attachments:true,chat_attachment_originals:false},'chat_attachments'),true);
 assert.equal(hasCapabilityFeature({chat_attachments:false},'chat_attachments'),false);
 assert.equal(hasCapabilityFeature({chat_attachments:'true'},'chat_attachments'),false);
 assert.equal(hasCapabilityFeature(null,'chat_attachments'),false);
 assert.equal(isCapabilityFeatures([]),true);
 assert.equal(isCapabilityFeatures({wiki_original_sources:true}),true);
 assert.equal(isCapabilityFeatures([1]),false);
 assert.equal(isCapabilityFeatures({wiki_original_sources:1}),false);
});
