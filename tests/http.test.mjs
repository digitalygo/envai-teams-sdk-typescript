import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvaiClient, operations, HttpTransport, EnvaiError, AuthenticationError, AccessDeniedError, NotFoundError, ConflictError, ValidationError, RateLimitError, ProviderError, FileError, ServerError, TransportError, ProtocolError, retryAfterMs, delay, positive } from '../dist/index.js';
import {fixture,json,negotiatedFetch,capabilities,turnId} from './helpers.mjs';
const completion={id:'cmpl_01ARZ3NDEKTSV4RRFFQ69G5FAV',workspace_id:'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',chat_id:'cht_01ARZ3NDEKTSV4RRFFQ69G5FAV',team_id:'team_01ARZ3NDEKTSV4RRFFQ69G5FAV',user_id:'usr_01ARZ3NDEKTSV4RRFFQ69G5FAV',models_subagents:[],started_at:'2026-10-13T00:00:00Z',usage:{},cost_usd:null,status:'running',created_at:'2026-10-13T00:00:00Z',updated_at:'2026-10-13T00:00:00Z'};
const baseUrl='https://example.test/api/v1';
for(const item of fixture('operations.json'))test(`inventory and wire: ${item.id}`,async()=>{
 const operation=operations[item.id];assert.equal(operation.method,item.method);assert.equal(operation.path.replace('/atp/v3',''),item.path);assert.equal(!operation.public,item.authenticated);
 let seen;
 const client=new EnvaiClient({baseUrl,apiKey:'secret-key',fetch:negotiatedFetch(async(url,init)=>{seen={url,init};return operation.mode==='empty'?new Response(null,{status:204}):operation.mode==='stream'?new Response('data: x\n\n',{headers:{'content-type':'text/event-stream'}}):operation.mode==='binary'?new Response('binary'):json(item.id==='sendChatMessage'?{status:'accepted',turn_id:turnId}:item.id==='getCapabilities'?{...capabilities,object:'list'}:item.id==='getCompletion'?{data:completion}:item.id==='listCompletions'?{data:[],links:{},meta:{current_page:1},object:'list'}:operation.unwrap?{data:{id:'value'}}:{data:[],meta:{current_page:1},object:'list'});},item.id!=='getCapabilities')});
 const params=Object.fromEntries(operation.parameters.filter(p=>p.required).map(p=>[p.name,p.in==='query'?'value':p.name==='name'?'a/b':'id']));
 if(operation.bodyRequired)params.body=operation.bodyMime==='multipart/form-data'?{file:new Blob(['input'],{type:'image/png'})}:{name:'example'};

 if(item.id==='testGenerateImage')params.body={files:[new Blob(['image'],{type:'image/png'})],prompt:'diagnostic',model_code:'model'};
 const result=await client[item.id](params);
 assert.equal(seen.init.method,item.method);assert.equal(seen.init.redirect,'manual');assert.equal(seen.init.headers.get('authorization'),item.authenticated?'Bearer secret-key':null);
 const parsed=new URL(seen.url);assert.equal(parsed.origin,'https://example.test');
 if(item.id==='getJwks')assert.equal(parsed.pathname,'/.well-known/jwks.json');
 else assert.ok(parsed.pathname.startsWith('/api/v1/'));
 if(item.id==='getUserTool'||item.id==='deleteUserTool'||item.id==='updateUserTool')assert.ok(parsed.pathname.endsWith('/a%2Fb'));
 if(operation.mode==='empty')assert.equal(result,undefined);
 else if(operation.mode==='binary'||operation.mode==='stream')assert.ok(result instanceof Response);
 else if(operation.unwrap)assert.deepEqual(result,item.id==='getCompletion'?completion:{id:'value'});
 else if(item.id==='sendChatMessage')assert.deepEqual(result,{status:'accepted',turn_id:turnId});
 else assert.equal(result.object,'list');
 if(operation.bodyMime==='multipart/form-data'){assert.ok(seen.init.body instanceof FormData);assert.equal(seen.init.headers.get('content-type'),null);}
});
test('all inventory methods and service aliases available, secrets hidden',()=>{
 const c=new EnvaiClient({baseUrl,apiKey:'do-not-expose'});
 assert.equal(Object.keys(operations).length,76);assert.ok(c.chats.sendMessage&&c.workspaceFiles.convertToPdf&&c.images.models&&c.apiKeys.create);
 assert.ok(!JSON.stringify(c).includes('do-not-expose'));
});
test('origin base normalization, prefix preservation, JWKS override and query encoding',async()=>{
 let url;
 const c=new EnvaiClient({baseUrl:'https://example.test/',jwksUrl:'https://keys.test/jwks',fetch:async u=>{url=u;return json({keys:[]});}});
 await c.getJwks();assert.equal(url,'https://keys.test/jwks');
 const transport=new HttpTransport({baseUrl:'https://example.test/api/v1///',fetch:async u=>{url=u;return json({data:{}});}});
 await transport.request(operations.indexWorkspaceFiles,{workspace_id:'x',path:'/wiki/a b?.md'});assert.equal(new URL(url).searchParams.get('path'),'/wiki/a b?.md');assert.ok(!url.includes('/api/v1/api/v1'));
});
test('artifact signed URL uses Laravel canonical alphabetical query order and no bearer',async()=>{
 let url,init;const c=new EnvaiClient({baseUrl,apiKey:'secret',fetch:async(u,i)=>{url=u;init=i;return new Response('bytes');}});
 await c.downloadArtifact({generation:'igr_x',artifact:'art_x',signature:'abc',expires:123});
 assert.equal(new URL(url).search,'?artifact=art_x&expires=123&generation=igr_x&signature=abc');assert.equal(init.headers.get('authorization'),null);
});
test('omitted api-key expiration stays omitted; explicit never preserved',async()=>{
 const bodies=[];const c=new EnvaiClient({baseUrl,fetch:async(_,i)=>{bodies.push(JSON.parse(i.body));return json({data:{}});}});
 await c.apiKeys.create({body:{name:'demo'}});await c.apiKeys.create({body:{name:'demo',expires_at:'never'}});
 assert.ok(!('expires_at'in bodies[0]));assert.equal(bodies[1].expires_at,'never');
});
for(const [status,type,Klass]of [[401,'unauthenticated',AuthenticationError],[403,'access_denied',AccessDeniedError],[404,'not_found',NotFoundError],[409,'conflict',ConflictError],[400,'invalid_request',ValidationError],[422,'validation_error',ValidationError],[429,'too_many_requests',RateLimitError],[503,'server_error',ServerError],[404,'file_not_found',FileError],[401,'provider_error',ProviderError],[418,'teapot',EnvaiError]])test(`error mapping ${type}`,async()=>{
 const c=new EnvaiClient({baseUrl,retry:{maxRetries:0},fetch:async()=>json({error:{type,code:'machine_code',message:'Problem',details:{field:'x'}}},status,{'x-request-id':'req-1'})});
 await assert.rejects(c.getWorkspace({workspace_id:'x'}),e=>e instanceof Klass&&e.httpStatus===status&&e.type===type&&e.code==='machine_code'&&e.requestId==='req-1'&&e.details.field==='x');
});
test('non-envelope/invalid JSON errors are safe and preserve HTTP status',async()=>{
 const c=new EnvaiClient({baseUrl,fetch:async()=>new Response('<html>secret request url</html>',{status:401})});
 await assert.rejects(c.getCapabilities(),e=>e.message==='HTTP 401'&&e.details===null);
});
test('GET retries transient statuses honoring Retry-After and telemetry never sees secrets',async()=>{
 let count=0;const seen=[];const c=new EnvaiClient({baseUrl,apiKey:'supersecret',retry:{baseDelayMs:0},onObservation:e=>seen.push(e),fetch:async()=>++count<3?json({error:{type:'too_many_requests'}},429,{'retry-after':'0'}):json({...capabilities,ok:true})});
 assert.deepEqual(await c.getCapabilities(),{...capabilities,ok:true});assert.equal(count,3);assert.equal(seen.filter(e=>e.kind==='request.retry').length,2);assert.ok(!JSON.stringify(seen).includes('supersecret'));
});
for(const op of ['sendChatMessage','createWorkspace','updateWorkspace','deleteUserTool'])test(`mutations never retry: ${op}`,async()=>{
 let calls=0;const c=new EnvaiClient({baseUrl,fetch:negotiatedFetch(async()=>{calls++;throw Error('network lost');})});
 const params={chat_id:'chat',workspace_id:'wsp',name:'tool',body:{message:'hi'}};
 await assert.rejects(c[op](params),TransportError);assert.equal(calls,1);
});
test('GET network failures retry bounded; redirects and malformed JSON do not',async()=>{
 for(const mode of ['network','redirect','json','envelope']){
  let calls=0;const c=new EnvaiClient({baseUrl,retry:{baseDelayMs:0},fetch:async()=>{calls++;if(mode==='network')throw Error('network');if(mode==='redirect')return new Response(null,{status:302,headers:{location:'https://evil.test'}});if(mode==='json')return new Response('bad json');return json({bad:1});}});
  await assert.rejects(mode==='envelope'?c.getWorkspace({workspace_id:'x'}):c.getCapabilities(),mode==='network'?TransportError:ProtocolError);assert.equal(calls,mode==='network'?3:1);
 }
});
test('per-call cancellation and request timeout',async()=>{
 const fetch=async(_,init)=>new Promise((_,reject)=>{init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});});
 const c=new EnvaiClient({baseUrl,requestTimeoutMs:5,fetch});await assert.rejects(c.getCapabilities(),e=>e.name==='TimeoutError');
 const abort=new AbortController();abort.abort();await assert.rejects(c.getCapabilities({}, {signal:abort.signal}),e=>e.name==='AbortError');
 const another=new AbortController();const p=c.getCapabilities({}, {signal:another.signal});another.abort();await assert.rejects(p,e=>e.name==='AbortError');
});
test('input validation and reserved headers',async()=>{
 for(const url of ['ftp://example.test','https://u:p@example.test','https://example.test/?x=1','https://example.test/#f'])assert.throws(()=>new EnvaiClient({baseUrl:url}));
 assert.throws(()=>new EnvaiClient({baseUrl,jwksUrl:'ftp://bad'}));
 assert.throws(()=>new EnvaiClient({baseUrl,retry:{maxRetries:1.5}}));
 const c=new EnvaiClient({baseUrl,fetch:async()=>json({})});
 await assert.rejects(c.getWorkspace({}),/Missing workspace_id/);await assert.rejects(c.getWorkspace({workspace_id:'..'}),/Invalid path/);await assert.rejects(c.createWorkspace({}),/Missing request body/);await assert.rejects(c.getCapabilities({}, {headers:{authorization:'bad'}}),/Reserved/);
 assert.throws(()=>positive(NaN,'x'));assert.equal(retryAfterMs('2'),2000);assert.equal(retryAfterMs('bad'),undefined);assert.equal(retryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT',0),1445412480000);
 const abort=new AbortController();const wait=delay(1000,abort.signal);abort.abort();await assert.rejects(wait);await delay(0);
});
test('observation callback failures cannot corrupt a request',async()=>{
 const c=new EnvaiClient({baseUrl,onObservation:()=>{throw Error('observer');},fetch:async()=>json({...capabilities,ok:1})});assert.equal((await c.getCapabilities()).ok,1);
});
test('exact server source snapshots match SHA-256, Git blob SHA and byte length',async()=>{
 const {readFileSync}=await import('node:fs');const {createHash}=await import('node:crypto');const provenance=fixture('provenance.json');
 assert.equal(provenance.repository,'digitalygo/envai-teams');
 assert.equal(provenance.commit,'55275860c9a950eaad8e39e9d2b728149084779c');
 assert.equal(provenance.protocol_version,2);assert.equal(provenance.operations,52);
 assert.deepEqual(Object.keys(provenance.sources).sort(),['events.json','openapi.yaml']);
 for(const [name,source]of Object.entries(provenance.sources)){
  const data=readFileSync(new URL('../'+source.snapshot_path,import.meta.url));
  assert.equal(data.length,source.bytes,name);
  assert.equal(createHash('sha256').update(data).digest('hex'),source.sha256,name);
  assert.equal(createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex'),source.git_blob_sha,name);
  assert.equal(source.repository_path,'packages/contracts/'+name);
 }
 assert.equal(readFileSync(new URL('../testdata/contracts/events.json',import.meta.url),'utf8'),readFileSync(new URL('../testdata/contracts/events.json',import.meta.url),'utf8'));
});
test('derived SDK fixtures are labelled separately and match their complete hashes',async()=>{
 const {readFileSync}=await import('node:fs');const {createHash}=await import('node:crypto');const provenance=fixture('provenance.json');
 assert.deepEqual(Object.keys(provenance.generated_fixtures).sort(),['events-invalid.json','events-valid.json','openapi.json','operations.json','signatures.json','sse-cases.json','tool-schema-matrix.json']);
 for(const [name,derived]of Object.entries(provenance.generated_fixtures)){
  assert.ok(derived.origin.length>0,name);assert.equal(derived.repository_path,undefined,name);
  assert.equal(createHash('sha256').update(readFileSync(new URL('../'+derived.snapshot_path,import.meta.url))).digest('hex'),derived.sha256,name);
 }
});
