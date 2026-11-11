import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {EnvaiClient,ProtocolError,operations,validateHttpResponse} from '../dist/index.js';
import {json,negotiatedFetch} from './helpers.mjs';
const {responses}=JSON.parse(readFileSync(new URL('../testdata/tenancy-responses.json',import.meta.url),'utf8'));
const ids={workspace_id:'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',chat_id:'cht_01ARZ3NDEKTSV4RRFFQ69G5FAV',agent_id:'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',team_id:'team_01ARZ3NDEKTSV4RRFFQ69G5FAV',completion_id:'cmpl_01ARZ3NDEKTSV4RRFFQ69G5FAV'};
for(const strictValidation of [false,true])for(const [model,response]of Object.entries(responses).filter(([name])=>name!=='ProjectTool'))for(const creator of [null,'usr_01ARZ3NDEKTSV4RRFFQ69G5FAV'])test(`tenancy ${model} strict=${strictValidation} nullable creator=${creator===null}`,async()=>{
 const data={...response,[model==='Completion'?'user_id':'created_by_user_id']:creator};
 const client=new EnvaiClient({baseUrl:'https://offline.test',apiKey:'project-test-key',strictValidation,fetch:negotiatedFetch(async(_url,init)=>{assert.equal(init.headers.get('authorization'),'Bearer project-test-key');return json({data});})});
 const actual=await client['get'+model](ids);assert.deepEqual(actual,data);assert.equal(actual.project_id,response.project_id);
 if(model!=='Completion')assert.equal(Object.hasOwn(actual,'user_id'),false);else assert.equal(actual.api_key_id,response.api_key_id);
});
test('completion collection accepts project attribution and null user by default and in strict mode',async()=>{
 for(const strictValidation of [false,true]){const page={data:[responses.Completion],links:{first:null,last:null,prev:null,next:null},meta:{current_page:1,from:1,last_page:1,path:'https://offline.test',per_page:20,to:1,total:1}};
 const client=new EnvaiClient({baseUrl:'https://offline.test',strictValidation,fetch:negotiatedFetch(async()=>json(page))});assert.deepEqual((await client.listCompletions(ids)).data,[responses.Completion]);}
});
test('tenancy validation rejects missing ownership and invalid nullable types',()=>{
 for(const model of ['Workspace','Chat','Agent','Team','Completion']){
  const response=responses[model],field=model==='Completion'?'user_id':'created_by_user_id';
  for(const data of [{...response,[field]:7},Object.fromEntries(Object.entries(response).filter(([key])=>key!=='project_id'))])assert.throws(()=>validateHttpResponse('get'+model,200,{data},3),ProtocolError);
 }
});
test('ProjectTool canonical methods and deprecated aliases preserve the project endpoint',async()=>{
 assert.ok(operations.getProjectTool);assert.equal(operations.getUserTool,undefined);
 for(const name of ['getProjectTool','getUserTool']){const client=new EnvaiClient({baseUrl:'https://offline.test',apiKey:'project-key',strictValidation:true,fetch:async(url,init)=>{assert.equal(new URL(url).pathname,'/api/v1/tools/echo');assert.equal(init.headers.get('authorization'),'Bearer project-key');return json({data:responses.ProjectTool});}});assert.deepEqual(await client[name]({name:'echo'}),responses.ProjectTool);}
 const legacy={...responses.ProjectTool};delete legacy.project_id;delete legacy.created_by_user_id;
 const old=new EnvaiClient({baseUrl:'https://offline.test',contractVersion:2,strictValidation:true,fetch:async()=>json({data:legacy})});assert.deepEqual(await old.getUserTool({name:'echo'}),legacy);
});
test('workspace response accepts the server default empty metadata array',async()=>{
 const data={...responses.Workspace,metadata:[]};
 for(const strictValidation of [false,true]){const client=new EnvaiClient({baseUrl:'https://offline.test',strictValidation,fetch:async()=>json({data})});assert.deepEqual(await client.getWorkspace(ids),data);}
});
test('tenancy synthetic fixture has explicit provenance and verified checksum',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../contracts/manifest.json',import.meta.url)));
 const entry=manifest.sdk_fixtures['tenancy-responses.json'];assert.match(entry.origin,/Synthetic/);
 assert.equal(createHash('sha256').update(readFileSync(new URL('../'+entry.snapshot_path,import.meta.url))).digest('hex'),entry.sha256);
});
test('reviewed SDK surface cannot silently acquire human or internal operations',()=>{
 const schema=JSON.parse(readFileSync(new URL('../contracts/openapi.json',import.meta.url)));
 const manifest=JSON.parse(readFileSync(new URL('../contracts/manifest.json',import.meta.url)));
 const humanOnly=Object.values(schema.paths).flatMap(item=>Object.values(item)).filter(op=>Object.hasOwn(operations,op.operationId)&&op.security?.length&&!op.security.some(scheme=>Object.hasOwn(scheme,'bearerAuth'))).map(op=>op.operationId);
 assert.deepEqual(humanOnly.sort(),manifest.unsupportedOperations.toSorted());
 const client=new EnvaiClient({baseUrl:'https://offline.test'});
 for(const name of ['login','createCompany','createCompanyBillingTopup','reserveBilling','internalWikiDispatch','updateApiKeySpendLimit','getProjectLogs'])assert.equal(client[name],undefined);
});
