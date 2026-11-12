// Deterministic, deliberately small generator for this pinned OpenAPI 3.1 contract.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parse} from 'yaml';
const spec=parse(readFileSync('contracts/openapi.yaml','utf8'));
const events=JSON.parse(readFileSync('contracts/events.json','utf8'));
const legacyEvents=JSON.parse(readFileSync('contracts/events-v2.json','utf8'));
const json=JSON.stringify;
const check=process.argv.includes('--check');
function write(path,body){if(check){if(readFileSync(path,'utf8')!==body)throw Error(`Generated drift: ${path}`);}else writeFileSync(path,body);}
const refName=r=>r.split('/').at(-1).replace(/~/g,'_');
const eventName=n=>'Atp'+n.split(/[.]/).map(x=>x[0].toUpperCase()+x.slice(1)).join('');
function type(s={},context='http'){
 if(s===true)return 'unknown';if(s===false)return 'never';
 if(s.$ref){const n=refName(s.$ref);return s.$ref.includes('$defs')?(context==='legacy-event'?'Legacy':'')+eventName(n):n;}
 if(Object.hasOwn(s,'const'))return json(s.const);
 if(s.enum)return s.enum.map(json).join(' | ');
 if(s.oneOf||s.anyOf){
  const alternatives=(s.oneOf||s.anyOf).map(branch=>{
   // JSON Schema alternatives inherit sibling properties. A required-only branch
   // still narrows those properties; dropping them turns update bodies into unknown.
   if(s.properties&&branch.required)branch={...branch,additionalProperties:branch.additionalProperties??false,properties:{...Object.fromEntries(branch.required.map(name=>[name,s.properties[name]??{}])),...branch.properties}};
   return type(branch,context);
  });
  const union='('+alternatives.join(' | ')+')';
  return s.properties?'('+type({...s,oneOf:undefined,anyOf:undefined},context)+' & '+union+')':union;
 }
 if(s.allOf){const parts=[type({...s,allOf:undefined},context),...s.allOf.map(x=>type(x,context))].filter(x=>x!=='unknown');return parts.length?'('+parts.join(' & ')+')':'unknown';}
 if(Array.isArray(s.type))return s.type.map(t=>type({...s,type:t},context)).join(' | ');
 if(s.format==='binary')return 'Blob';
 switch(s.type){case 'string':return 'string';case 'number':case 'integer':return 'number';case 'boolean':return 'boolean';case 'null':return 'null';case 'array':return `Array<${type(s.items,context)}>`;}
 if(s.type==='object'||s.properties){const lines=Object.entries(s.properties||{}).map(([k,v])=>`${json(k)}${(s.required||[]).includes(k)?'':'?'}: ${type(v,context)}`);if(s.additionalProperties!==false)lines.push(`[key: string]: ${typeof s.additionalProperties==='object'?type(s.additionalProperties,context):'unknown'}`);return `{ ${lines.join('; ')} }`;}
 return 'unknown';
}
function resolve(s){return s?.$ref?s.$ref.slice(2).split('/').reduce((a,k)=>a[k],spec):s;}
const supportedOperations = new Set(JSON.parse(readFileSync('scripts/sdk-operations.json','utf8')));
const aliases = {createUserTool:'createProjectTool',listUserTools:'listProjectTools',getUserTool:'getProjectTool',updateUserTool:'updateProjectTool',deleteUserTool:'deleteProjectTool'};
const entries=[];
for(const [path,item]of Object.entries(spec.paths))for(const [method,op]of Object.entries(item)){
 if(!op.operationId || !supportedOperations.has(op.operationId))continue;
 const parameters=[...(item.parameters||[]),...(op.parameters||[])].map(resolve);
 const rb=resolve(op.requestBody), [bodyMime,bodyInfo]=Object.entries(rb?.content||{})[0]||[];
 const success=Object.entries(op.responses).filter(([code])=>/^2\d\d$/.test(code)).map(([,v])=>resolve(v));
 const content=success.find(x=>x.content)?.content;const [mime,info]=Object.entries(content||{})[0]||[];
 let result=info?.schema;let decoded=resolve(result);
 const unwrap=!!(decoded?.properties?.data&&!decoded.properties.links&&!decoded.properties.meta&&!decoded.properties.object&&Object.keys(decoded.properties).length===1);
 if(unwrap)result=decoded.properties.data;
 const mode=mime==='text/event-stream'?'stream':mime&&mime!=='application/json'?'binary':!mime?'empty':'json';
 const meta={id:op.operationId,method:method.toUpperCase(),path,public:op.security?.length===0,origin:!!item.servers,parameters:parameters.map(({name,in:loc,required})=>({name,in:loc,required:!!required})),bodyMime,bodyRequired:!!rb?.required,mode,unwrap};
 const fields=parameters.filter(x=>x.in!=='header'||x.name==='Idempotency-Key').map(p=>`${json(p.in==='header'?'idempotencyKey':p.name)}${p.required?'':'?'}: ${type(p.schema)}`);
 if(rb)fields.push(`body${rb.required?'':'?'}: ${type(bodyInfo.schema)}`);
 const req=fields.length?`{ ${fields.join('; ')} }`:'Record<string, never>';
 const optional=!parameters.some(p=>p.required&&(p.in!=='header'||p.name==='Idempotency-Key'))&&!rb?.required;
 entries.push({meta,request:req,response:mode==='binary'||mode==='stream'?'Response':mode==='empty'?'void':op.operationId==='getCapabilities'?'Capabilities | CapabilitiesLegacy':type(result),optional,summary:op.summary??op.operationId});
}
if(entries.length!==supportedOperations.size)throw Error(`Reviewed SDK inventory drift: expected ${supportedOperations.size}, got ${entries.length}`);
let out='// Generated by scripts/generate.mjs. Do not edit.\nimport { HttpTransport, type RequestOptions } from "./http.js";\nimport { operations } from "./operations.js";\nimport type { AtpUsage } from "./event-types.js";\n';
for(const[n,s]of Object.entries(spec.components.schemas))out+=`export type ${n} = ${type(s)};\n`;
for(const n of ['UserTool','UserToolCreateRequest','UserToolUpdateRequest','UserToolResource','UserToolCollection'])out+=`/** @deprecated Tools are project-scoped; use ${n.replace('User','Project')}. */\nexport type ${n} = ${n.replace('User','Project')};\n`;
for(const e of entries){const n=e.meta.id;out+=`export type ${n[0].toUpperCase()+n.slice(1)}Params = ${e.request};\nexport type ${n[0].toUpperCase()+n.slice(1)}Result = ${e.response};\n`;}
for(const [name,target]of Object.entries(aliases)){const n=name[0].toUpperCase()+name.slice(1),t=target[0].toUpperCase()+target.slice(1);out+=`/** @deprecated Use ${t}Params. */\nexport type ${n}Params = ${t}Params;\n/** @deprecated Use ${t}Result. */\nexport type ${n}Result = ${t}Result;\n`;}
out+='export class GeneratedClient {\n constructor(protected readonly transport: HttpTransport) {}\n';
for(const e of entries){const n=e.meta.id,t=n[0].toUpperCase()+n.slice(1);out+=` /** ${['createApiKey','listApiKeys','deleteApiKey'].includes(n)?'Unsupported in the project-key SDK: use the human console session with CSRF.':e.summary} */\n ${n}(params: ${t}Params${e.optional?' = {}':''}, options: RequestOptions = {}): Promise<${t}Result> { return this.transport.request(operations.${n}, params, options); }\n`;}
for(const [name,target]of Object.entries(aliases)){const e=entries.find(e=>e.meta.id===target),t=target[0].toUpperCase()+target.slice(1);out+=` /** @deprecated Use ${target}; tools now belong to the key project, not the user. */\n ${name}(params: ${t}Params${e.optional?' = {}':''}, options: RequestOptions = {}): Promise<${t}Result> { return this.${target}(params, options); }\n`;}
const groups={attachments:{upload:'uploadChatAttachment',list:'listChatAttachments',get:'getChatAttachment',retry:'retryChatAttachment',delete:'deleteChatAttachment',download:'downloadChatAttachment'},workspaces:{create:'createWorkspace',list:'listWorkspaces',get:'getWorkspace',update:'updateWorkspace',delete:'deleteWorkspace'},tools:{create:'createProjectTool',list:'listProjectTools',get:'getProjectTool',update:'updateProjectTool',delete:'deleteProjectTool'},chats:{create:'createChat',list:'listChats',get:'getChat',update:'updateChat',delete:'deleteChat',sendMessage:'sendChatMessage',eventsResponse:'streamChatEvents',cancel:'cancelChatTurn',steer:'steerChatTurn',submitToolOutput:'resolveChatTool',submitApproval:'resolveChatApproval',deliver:'deliverWorkflowResult',delegate:'delegateToTeam',task:'getDetachedTask',cancelTask:'cancelDetachedTask',classifyPhase:'classifyPhase',classifyChoice:'classifyChoice',startJob:'startIndependentJob',fork:'forkChat',restore:'restoreChat'},chatCrons:{list:'listChatCrons',get:'getChatCron',update:'updateChatCron',delete:'deleteChatCron'},completions:{list:'listCompletions',get:'getCompletion'},projectSkills:{list:'listProjectSkills',create:'createProjectSkill',get:'getProjectSkill',update:'updateProjectSkill',delete:'deleteProjectSkill'},projectReports:{usageRequest:'getProjectUsage',logsRequest:'getProjectLogs'},workspaceFiles:{get:'indexWorkspaceFiles',create:'createWorkspaceFile',update:'updateWorkspaceFile',delete:'deleteWorkspaceFile',download:'downloadWorkspaceFile',convertToPdf:'convertWorkspaceFileToPdf',uploadSource:'uploadWikiSource',sourceStatus:'getWikiSource',downloadSource:'downloadWikiSource'},agents:{create:'createAgent',list:'listAgents',get:'getAgent',update:'updateAgent',delete:'deleteAgent'},teams:{create:'createTeam',list:'listTeams',get:'getTeam',update:'updateTeam',delete:'deleteTeam'},apiKeys:{create:'createApiKey',list:'listApiKeys',delete:'deleteApiKey'},models:{list:'listModels'},images:{create:'createImageGeneration',get:'getImageGeneration',upload:'uploadImage',models:'listImageModels',testGenerate:'testGenerateImage',downloadArtifact:'downloadArtifact'},wiki:{inbox:'createWikiInboxRun',outbox:'createWikiOutboxRun',sync:'createWikiSyncRun',operation:'getWikiOperation',withdraw:'withdrawWikiSource',categories:'listWikiCategories',categoryIndex:'getWikiCategoryIndex'},capabilities:{get:'getCapabilities'}};
for(const [group,methods]of Object.entries(groups))out+=` readonly ${group} = { ${Object.entries(methods).map(([name,method])=>`${name}: this.${method}.bind(this)`).join(', ')} };\n`;
out+='}\n';write('src/generated.ts',out);
write('src/operations.ts','// Generated by scripts/generate.mjs. Do not edit.\nimport type { Operation } from "./http.js";\nexport const operations = '+JSON.stringify(Object.fromEntries(entries.map(e=>[e.meta.id,e.meta])),null,2)+' as const satisfies Record<string, Operation>;\n');
let old='// Generated from immutable events-v2.json. Do not edit.\n';
for(const[n,s]of Object.entries(legacyEvents.$defs)){if(n!=='Event')old+=`export type Legacy${eventName(n)} = ${type(s,'legacy-event')};\n`;}
const oldTypes=Object.keys(legacyEvents.$defs).filter(n=>n.includes('.')||n==='ping');
old+='export interface LegacyEventDataMap {\n'+oldTypes.map(n=>`${json(n)}: Legacy${eventName(n)};`).join('\n')+'\n}\n';
old+='export type LegacyEventType = keyof LegacyEventDataMap;\nexport type LegacyKnownEvent<T extends LegacyEventType = LegacyEventType> = { [K in T]: LegacyAtpEnvelope & { known: true; type: K; data: LegacyEventDataMap[K] } }[T];\nexport type LegacyATPEvent = LegacyKnownEvent | (LegacyAtpEnvelope & { known: false });\n';
write('src/legacy-event-types.ts',old);
let evt='// Generated from events.json. Do not edit.\nimport type { LegacyAtpEnvelope, LegacyKnownEvent, LegacyEventType } from \"./legacy-event-types.js\";\n';
for(const[n,s]of Object.entries(events.$defs)){if(n==='Event')continue;evt+=`export type ${eventName(n)} = ${type(s,'event')};\n`;}
const types=Object.keys(events.$defs).filter(n=>n.includes('.')||n==='ping');
evt+='export interface EventDataMap {\n'+types.map(n=>`${json(n)}: ${eventName(n)};`).join('\n')+'\n}\n';
evt+='export type EventType = keyof EventDataMap;\nexport type KnownEvent<T extends EventType = EventType> = { [K in T]: AtpEnvelope & { known: true; type: K; data: EventDataMap[K] } }[T] | LegacyKnownEvent<Extract<T, LegacyEventType>>;\nexport type UnknownEvent = (AtpEnvelope | LegacyAtpEnvelope) & { known: false };\nexport type ATPEvent = KnownEvent | UnknownEvent;\nexport const knownEventTypes = '+json(types)+' as const;\n';
write('src/event-types.ts',evt);
write('contracts/openapi.json',json(spec,null,2)+'\n');
const sourceNames=['smidja-native.json','openapi.yaml','events.json','events-v2.json','wiki.json','terminal-snapshot.json'];
const sourceMetadata=Object.fromEntries(sourceNames.map(name=>{const bytes=readFileSync('contracts/'+name);return [name,{repository_path:'packages/contracts/'+name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),git_blob_sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')}];}));
const derivedApiBytes=Buffer.from(json(spec,null,2)+'\n');
const derivedArtifacts={'openapi.json':{snapshot_path:'contracts/openapi.json',source_repository_path:'packages/contracts/openapi.yaml',origin:'Generated JSON representation of the pinned OpenAPI YAML; not an upstream repository file.',bytes:derivedApiBytes.length,sha256:createHash('sha256').update(derivedApiBytes).digest('hex')}};
const attachmentFixtures=Object.fromEntries(['failed.json','pending.json','ready.json','recoverable.json'].map(name=>[name,{snapshot_path:'testdata/chat-attachments/'+name,repository_path:'packages/contracts/fixtures/chat-attachments/'+name,origin:'Shared synthetic conformance fixture copied from the pinned server commit; not captured provider traffic.',sha256:createHash('sha256').update(readFileSync('testdata/chat-attachments/'+name)).digest('hex')}]));
write('contracts/manifest.json',json({repository:'digitalygo/1-1-5-envai-aaas',commit:'ba021aa61e30e379880f809d45f90e5d3564d43e',apiVersion:spec.info.version,atpVersion:3,operationCount:entries.length,serverOperationCount:Object.values(spec.paths).flatMap(item=>Object.values(item)).filter(op=>op.operationId).length,unsupportedOperations:['createApiKey','listApiKeys','deleteApiKey'],sdk_fixtures:{'tenancy-responses.json':{snapshot_path:'testdata/tenancy-responses.json',origin:'Synthetic resource responses authored from this pinned server OpenAPI, not captured production traffic.',sha256:createHash('sha256').update(readFileSync('testdata/tenancy-responses.json')).digest('hex')}},sources:sourceMetadata,derived_artifacts:derivedArtifacts,shared_fixtures:attachmentFixtures,sha256:Object.fromEntries(['openapi.yaml','events.json','events-v2.json','wiki.json','terminal-snapshot.json'].map(n=>[n,createHash('sha256').update(readFileSync('contracts/'+n)).digest('hex')]))},null,2)+'\n');
console.log(`${check?'Checked':'Generated'} ${entries.length} operations, ${Object.keys(spec.components.schemas).length} HTTP models, ${types.length} event types.`);
