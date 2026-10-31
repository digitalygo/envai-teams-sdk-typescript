import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EnvaiClient,operations,ProtocolError,validateHttpRequest,validateHttpResponse,EnvaiError} from '../dist/index.js';
import {json,capabilities} from './helpers.mjs';
const fixtures=JSON.parse(readFileSync(new URL('../testdata/parity/schema-fixtures.json',import.meta.url),'utf8'));
const canonical=JSON.parse(readFileSync(new URL('../contracts/openapi.json',import.meta.url),'utf8'));
const agentId=fixtures.agent_id;
for(const [name,body]of Object.entries(fixtures.response_cases))test(`SCHEMA-01 strict getAgent canonical ${name}`,async()=>{
 let calls=0;const observations=[];const client=new EnvaiClient({baseUrl:'https://offline.test',apiKey:'safe-secret',strictValidation:true,onObservation:e=>observations.push(e),fetch:async(url,init)=>{calls++;assert.equal(init.headers.get('authorization'),'Bearer safe-secret');assert.equal(init.headers.get('X-Request-ID'),'caller');return json(body,200,{'X-Request-ID':'server'});}});
 const result=client.getAgent({agent_id:agentId},{headers:{'X-Request-ID':'caller'}});if(name==='valid')assert.deepEqual(await result,body.data);else await assert.rejects(result,e=>e instanceof ProtocolError&&!String(e).includes('safe-secret'));assert.equal(calls,1);assert.equal(observations.at(-1).requestId,'server');
});
test('SCHEMA-01 legacy default is preserved and malformed strict mutations perform zero HTTP',async()=>{
 const permissive=new EnvaiClient({baseUrl:'https://offline.test',fetch:async()=>json({data:{}})});assert.deepEqual(await permissive.getAgent({agent_id:agentId}),{});
 let calls=0;const client=new EnvaiClient({baseUrl:'https://offline.test',strictValidation:true,fetch:async()=>{calls++;throw Error('must not fetch');}});
 for(const [method,params]of [['createAgent',{body:{}}],['createAgent',{body:{name:'x',system_prompt:'x',mode:'invalid'}}],['updateAgent',{agent_id:agentId,body:{}}],['getAgent',{agent_id:'invalid'}],['listCompletions',{workspace_id:'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',chat_id:'cht_01ARZ3NDEKTSV4RRFFQ69G5FAV',page:0}],['getAgent',{}]])await assert.rejects(client[method](params),ProtocolError);assert.equal(calls,0);assert.throws(()=>new EnvaiClient({baseUrl:'https://offline.test',strictValidation:'true'}),TypeError);
});
test('strict valid create/update CRUD preserves nullable fields, status envelope and error identity',async()=>{
 const accepted=fixtures.response_cases.valid;const captured=[];
 const client=new EnvaiClient({baseUrl:'https://offline.test',strictValidation:true,fetch:async(url,init)=>{captured.push(JSON.parse(init.body));return json(accepted,init.method==='POST'?201:200);}});
 assert.deepEqual(await client.createAgent({body:{name:'worker',system_prompt:'work',mode:'subagent'}}),accepted.data);assert.deepEqual(await client.updateAgent({agent_id:agentId,body:{model:null}}),accepted.data);assert.deepEqual(captured[1],{model:null});
 const errors=new EnvaiClient({baseUrl:'https://offline.test',strictValidation:true,retry:{maxRetries:0},fetch:async()=>json({error:{type:'validation_error',code:'safe_code',details:{field:'name'}}},422,{'X-Request-ID':'server-error'})});await assert.rejects(errors.createAgent({body:{name:'x',system_prompt:'x',mode:'primary'}}),e=>e instanceof EnvaiError&&e.httpStatus===422&&e.code==='safe_code'&&e.requestId==='server-error');
 const wrongStatus=new EnvaiClient({baseUrl:'https://offline.test',strictValidation:true,fetch:async()=>json(accepted,202)});await assert.rejects(wrongStatus.getAgent({agent_id:agentId}),/Undeclared success status/);
});
test('strict multipart checks actual Blob slots before projection and preserves binary wire data',async()=>{
 let calls=0;const client=new EnvaiClient({baseUrl:'https://offline.test',strictValidation:true,fetch:async(url,init)=>{calls++;assert.equal(await init.body.get('files[]').text(),'binary bytes');return json({data:{status:'received',prompt:'test',model_code:'fixture',files_count:1,files:[{original_name:'sample.png',mime_type:'image/png',size:12}],received_at:'2026-10-31T00:00:00Z'}});}});
 const body={files:[new File(['binary bytes'],'sample.png',{type:'image/png'})],prompt:'test',model_code:'fixture'};await client.testGenerateImage({body});assert.equal(calls,1);
 for(const patch of [{files:['fake']},{files:[]},{prompt:5},{files:[{}]}])await assert.rejects(client.testGenerateImage({body:{...body,...patch}}),ProtocolError);assert.equal(calls,1);
});
test('all 76 canonical operations have request and success schema coverage; binary/SSE remain separate',()=>{
 const found=new Set();let jsonResponses=0,otherResponses=0;
 for(const item of Object.values(canonical.paths))for(const operation of Object.values(item)){
  if(!operation.operationId)continue;const id=operation.operationId;found.add(id);
  try{validateHttpRequest(id,{},3);}catch(error){assert.ok(error instanceof ProtocolError);assert.doesNotMatch(error.message,/No canonical HTTP schema/);}
  for(const [status,response]of Object.entries(operation.responses))if(/^2\d\d$/.test(status)){
   if(response.content?.['application/json']?.schema){jsonResponses++;try{validateHttpResponse(id,Number(status),null,3);}catch(error){assert.ok(error instanceof ProtocolError);assert.doesNotMatch(error.message,/No canonical HTTP schema|Undeclared success status/);}}
   else{otherResponses++;assert.doesNotThrow(()=>validateHttpResponse(id,Number(status),undefined,3));}
  }
 }
 assert.deepEqual([...found].sort(),Object.keys(operations).sort());assert.equal(found.size,76);assert.equal(jsonResponses,62);assert.ok(otherResponses>0);
 assert.throws(()=>validateHttpRequest('unknown',{},3),ProtocolError);
});
test('strict legacy historical CRUD uses its pinned schema and still refuses mutations',async()=>{
 const c=new EnvaiClient({baseUrl:'https://offline.test',contractVersion:2,strictValidation:true,fetch:async()=>json(fixtures.response_cases.valid)});assert.deepEqual(await c.getAgent({agent_id:agentId}),fixtures.response_cases.valid.data);await assert.rejects(c.createAgent({body:{name:'x',mode:'primary',system_prompt:'x'}}),/historical read-only/);
});
test('strict canonical additive fields survive and non-JSON/shape-invalid bodies fail before effects',async()=>{
 const extra={...fixtures.response_cases.valid.data,future_field:{version:1}};const c=new EnvaiClient({baseUrl:'https://offline.test',strictValidation:true,fetch:async()=>json({data:extra})});assert.deepEqual((await c.getAgent({agent_id:agentId})).future_field,{version:1});
 let calls=0;const strict=new EnvaiClient({baseUrl:'https://offline.test',strictValidation:true,fetch:async()=>{calls++;throw Error('unexpected');}});const circular={};circular.self=circular;
 for(const metadata of [circular,{value:1n},{value:NaN},{value:Infinity},new Date('2026-10-31T00:00:00Z')])await assert.rejects(strict.createWorkspace({body:{name:'test',metadata}}),ProtocolError);assert.equal(calls,0);
});
test('strict capability discovery preserves feature maps and additive future family names before admission',async()=>{
 for(const features of [['future_feature'],{future_feature:true,disabled:false}]){
  let posts=0;const advertised={...capabilities,families:['turn','future_family'],features};const c=new EnvaiClient({baseUrl:'https://offline.test',strictValidation:true,fetch:async(url,init)=>{if(url.endsWith('/capabilities'))return json(advertised);posts++;return json({status:'accepted',turn_id:'cmpl_01ARZ3NDEKTSV4RRFFQ69G5FAV'},202);}});
  const discovered=await c.getCapabilities();assert.deepEqual(discovered.features,['future_feature']);assert.deepEqual(discovered.families,['turn','future_family']);await c.sendChatMessage({chat_id:'cht_01ARZ3NDEKTSV4RRFFQ69G5FAV',body:{message:'test'}});assert.equal(posts,1);
 }
 for(const features of [{future:'true'},[1],null]){const c=new EnvaiClient({baseUrl:'https://offline.test',strictValidation:true,fetch:async()=>json({...capabilities,features})});await assert.rejects(c.getCapabilities(),ProtocolError);}
});
