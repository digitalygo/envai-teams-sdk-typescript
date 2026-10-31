import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm,writeFile,readFile,mkdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compileDefinitions,compileAgentMarkdown,loadDefinitions,manifestHash,resourceHash,definitionHash,normalizeDefinition} from '../dist/definitions.js';
import {MemoryDefinitionStateStore,FileDefinitionStateStore,PostgresDefinitionStateStore,assertDefinitionState} from '../dist/definition-state.js';
import {DefinitionSynchronizer,planDefinitions,definitionDiff} from '../dist/definition-sync.js';
import {TransportError,EnvaiError} from '../dist/errors.js';
const golden=JSON.parse(readFileSync(new URL('../testdata/parity/tooling-golden.json',import.meta.url),'utf8'));
const safety=JSON.parse(readFileSync(new URL('../testdata/parity/tooling-safety-overrides.json',import.meta.url),'utf8'));
const manifest=()=>structuredClone(golden.dependency_order.manifest);
const document=tool=>({format_version:'1',tools:tool?{echo:tool}:{},agents:{},teams:{}});
const record=(type,key,payload)=>({type,local_key:key,remote_id:`${type==='tool'?'twl':type==='agent'?'agt':'tea'}_${payload.name}`,remote_name:payload.name,desired_hash:resourceHash(type,key,payload),last_applied:payload,remote_marker:'2026-01-01T00:00:00Z',status:'applied',updated_at:'2026-01-01T00:00:00Z'});
function remote(seed={}){const data={tool:[],agent:[],team:[],...structuredClone(seed)},calls=[];return{data,calls,models:async()=>['fixture'],list:async t=>structuredClone(data[t]),get:async(t,id)=>structuredClone(data[t].find(r=>r.id===id)),create:async(t,p)=>{calls.push({method:`create${t[0].toUpperCase()+t.slice(1)}`,target:`${t}:${p.name}`,payload:structuredClone(p)});const r={...structuredClone(p),id:`${t==='tool'?'twl':t==='agent'?'agt':'tea'}_${p.name}`,updated_at:'2026-01-01T00:00:00Z'};data[t].push(r);return structuredClone(r);},update:async(t,id,name,p)=>{calls.push({method:`update${t[0].toUpperCase()+t.slice(1)}`,target:`${t}:${name}`,payload:structuredClone(p)});const i=data[t].findIndex(r=>r.id===id);assert.notEqual(i,-1);data[t][i]={...structuredClone(p),id,updated_at:'2026-01-01T00:00:00Z'};return structuredClone(data[t][i]);},delete:async(t,id,name)=>{calls.push({method:`delete${t[0].toUpperCase()+t.slice(1)}`,target:`${t}:${name}`,payload:null});data[t]=data[t].filter(r=>r.id!==id);}};}
for(const vector of golden.hash_vectors)test('TOOLING-03 hash '+vector.id,()=>assert.equal(manifestHash(vector.document),vector.sha256));
for(const vector of golden.planner_reconciler_cases)test('TOOLING-04 golden '+vector.id,async()=>{
 const store=new MemoryDefinitionStateStore(),m=document(vector.desired),r=remote({tool:vector.remote?[{...vector.remote,id:'twl_echo',updated_at:'2026-01-01T00:00:00Z'}]:[]});
 if(vector.last_applied)await store.withScope('account',s=>s.save(record('tool','echo',vector.last_applied)));
 const sync=new DefinitionSynchronizer('account',store,r,m),options=Array.isArray(vector.options)?{}:vector.options;
 const plan=await sync.plan(options);assert.deepEqual(plan.operations,vector.expected.operations);assert.equal((await sync.plan(options)).hash,plan.hash);
 const report=await sync.sync(options);assert.equal(report.status,vector.expected.report_status);assert.equal(report.manifest_ready,safety.overrides.find(o=>o.case_id===vector.id)?.expected.manifest_ready??vector.expected.manifest_ready);assert.deepEqual(report.outcomes.map(o=>o.status),vector.expected.outcomes);assert.deepEqual(r.calls,vector.expected.mutation_calls);
 const stored=(await sync.state()).records['tool:echo'];assert.deepEqual(stored?{remote_id:stored.remote_id,remote_name:stored.remote_name,status:stored.status,last_applied:stored.last_applied}:null,vector.expected.stored);
});
test('TOOLING-05 ordered dependencies, readiness, stable rename, rerun writes zero',async()=>{
 const m=manifest(),r=remote(),store=new MemoryDefinitionStateStore(),sync=new DefinitionSynchronizer('account',store,r,m);
 await assert.rejects(sync.team('team'),/not synchronized/);assert.equal(manifestHash(m),golden.dependency_order.expected.manifest_hash);
 assert.equal((await sync.sync()).manifest_ready,true);assert.deepEqual(r.calls,golden.dependency_order.expected.mutation_calls);
 assert.equal(await sync.team('team'),'tea_Example team');assert.equal(await sync.agent('worker'),'agt_Worker');assert.equal(await sync.tool('echo'),'echo');await assert.rejects(sync.tool('unknown'),/Unknown/);await sync.requireSynchronized();assert.equal((await sync.status()).operations.every(o=>o.classification==='unchanged'),true);r.calls.length=0;await sync.sync();assert.equal(r.calls.length,0);
 m.agents.worker.name='Renamed worker';m.teams.team.name='Renamed team';assert.equal((await sync.sync()).manifest_ready,true);assert.equal(await sync.agent('worker'),'agt_Worker');assert.equal(await sync.team('team'),'tea_Example team');assert.deepEqual(r.calls.map(c=>c.method),['updateAgent','updateTeam']);
});
test('TOOLING-01 Markdown JSON and native data preserve optional presence and literals',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'envai-definitions-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const markdown='---\r\nformat: 1\r\nmode: primary\r\nname: Coordinator\r\n---\r\nCoordinate.\r\n';const agent=compileAgentMarkdown('coordinator',markdown);assert.deepEqual(agent,manifest().agents.coordinator);
 const m=manifest();delete m.agents.coordinator;await writeFile(join(dir,'manifest.json'),JSON.stringify(m));await mkdir(join(dir,'agents'));await writeFile(join(dir,'agents/coordinator.md'),markdown);assert.deepEqual(await loadDefinitions(dir),manifest());assert.deepEqual(await loadDefinitions(join(dir,'manifest.json')).catch(e=>e.message),'Team orchestrator must reference a primary agent');
 await writeFile(join(dir,'all.json'),JSON.stringify(manifest()));assert.deepEqual(await loadDefinitions(join(dir,'all.json')),manifest());
 const hashes=[];for(const optional of [{},{description:null},{permissions:{}},{tools_enabled:[]}]){const x=manifest();Object.assign(x.agents.coordinator,optional);hashes.push(manifestHash(x));}assert.equal(new Set(hashes).size,4);
 const x=manifest();x.agents.coordinator.tools_enabled=[{name:'z'},{name:'a'},{name:'z'}];assert.deepEqual(compileDefinitions(x).agents.coordinator.tools_enabled,[{name:'a'},{name:'z'}]);x.tools.echo.parameters.properties.literal={const:{a:[],b:{}}};assert.deepEqual(compileDefinitions(x).tools.echo.parameters.properties.literal,{const:{a:[],b:{}}});
 const front=compileAgentMarkdown('agent','---\nformat: 1\nmode: primary\ntools:\n  client: [echo]\n  server: [web]\npermissions: {}\nconfig: {}\nmodel: null\ndescription: null\n---\nText');assert.deepEqual(front.external_tools_enabled,[{name:'echo'}]);assert.deepEqual(front.tools_enabled,[{name:'web'}]);assert.deepEqual(front.config,{});assert.equal(front.description,null);
 await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest()));await assert.rejects(loadDefinitions(dir),/Duplicate agent/);
});
test('TOOLING-02 validation rejects malformed local definitions and model references',()=>{
 const changes=[m=>m.format_version=1,m=>m.extra=true,m=>m.tools=[],m=>m.tools.echo=null,m=>m.tools.echo.name='other',m=>m.tools.echo.kind='server',m=>m.tools.echo.parameters={type:'array'},m=>m.tools.echo.timeout_seconds=1.5,m=>m.agents.worker.name=m.agents.coordinator.name,m=>m.agents.worker.extra=true,m=>m.agents.worker.description=5,m=>m.agents.worker.system_prompt='',m=>m.agents.worker.mode='invalid',m=>m.agents.worker.can_write_skills='yes',m=>m.agents.worker.config=[],m=>m.agents.worker.permissions=[],m=>m.agents.worker.config={nested:[{max_tokens:5}]},m=>m.agents.worker.model='unavailable',m=>m.agents.worker.tools_enabled={},m=>m.agents.worker.external_tools_enabled=[{name:'missing'}],m=>m.agents.worker.tools_enabled=[{}],m=>m.teams.team.orchestrator_id='worker',m=>m.teams.team.members={},m=>m.teams.team.members=[{agent_definition_id:'coordinator',role:null}],m=>m.teams.team.members.push(m.teams.team.members[0]),m=>m.teams.team.members[0].role=5,m=>m.teams.team.members[0].extra=true];
 for(const change of changes){const m=manifest();change(m);assert.throws(()=>compileDefinitions(m,['fixture']));}
 for(const md of ['no frontmatter','---\nformat: 1\n','---\nformat: 2\n---\nx','---\nformat: 1\nformat: 1\n---\nx','---\nformat: 1\nextra: true\n---\nx','---\nformat: 1\nmode: primary\ntools: []\n---\nx','---\nformat: 1\nmode: primary\ntools:\n  server: [5]\n---\nx'])assert.throws(()=>compileAgentMarkdown('key',md));
 const m=manifest();delete m.tools.echo.timeout_seconds;assert.equal(compileDefinitions(m).tools.echo.timeout_seconds,120);m.tools.echo.timeout_seconds=800;assert.equal(compileDefinitions(m).tools.echo.timeout_seconds,600);m.tools.echo.timeout_seconds=0;assert.equal(compileDefinitions(m).tools.echo.timeout_seconds,1);
});
test('comparison preserves arbitrary schema while normalizing server enrichment',()=>{
 assert.deepEqual(normalizeDefinition('agent',{id:'x',user_id:'u',created_at:'x',updated_at:'x',name:'n',description:null,model:null,permissions:{},config:[],tools_enabled:[],external_tools_enabled:null}),{name:'n'});
 assert.deepEqual(normalizeDefinition('team',{name:'t',description:null,orchestrator_id:'a',members:[{agent_definition_id:'b',role:null,name:'B',position:1}]},{a:'primary',b:'worker'}),{name:'t',orchestrator_id:'primary',members:[{agent_definition_id:'worker',role:null}]});
 assert.deepEqual(definitionDiff({nested:{a:1,b:2},list:[1],deleted:5},{nested:{a:2,c:3},list:[2],added:1}),[{path:'nested.a',kind:'changed'},{path:'nested.b',kind:'removed'},{path:'nested.c',kind:'added'},{path:'list',kind:'changed'},{path:'deleted',kind:'removed'},{path:'added',kind:'added'}]);
 assert.throws(()=>planDefinitions(manifest(),{records:{}},{tool:{},agent:{},team:{}},{scope:'invalid'}));assert.throws(()=>new DefinitionSynchronizer('',new MemoryDefinitionStateStore(),remote(),manifest()));
});
test('TOOLING-08 managed-only reverse prune and dependency failure preserve earlier successes',async()=>{
 const r=remote(),store=new MemoryDefinitionStateStore(),m=manifest();await new DefinitionSynchronizer('a',store,r,m).sync();r.calls.length=0;r.data.tool.push({...m.tools.echo,id:'unmanaged',name:'unmanaged'});
 const empty=document(null),sync=new DefinitionSynchronizer('a',store,r,empty);await sync.sync({prune:true});assert.deepEqual(r.calls.map(c=>c.method),['deleteTeam','deleteAgent','deleteAgent','deleteTool']);assert.equal(r.data.tool[0].name,'unmanaged');
 const r2=remote(),store2=new MemoryDefinitionStateStore();await new DefinitionSynchronizer('a',store2,r2,m).sync();r2.delete=async()=>{throw new EnvaiError('has chats',409,'team_has_chats');};const failed=await new DefinitionSynchronizer('a',store2,r2,empty).sync({prune:true});assert.equal(failed.status,'failed');assert.equal(failed.outcomes.filter(o=>o.status==='failed').length,1);assert.equal(failed.manifest_ready,false);assert.equal((await store2.withScope('a',s=>s.read())).ready,undefined);
});
test('TOOLING-09 uncertain mutations read back once without resending',async()=>{
 for(const landed of [true,false,'different','read_failure']){
  const r=remote(),base=r.create;let attempts=0,reads=0;r.create=async(t,p)=>{attempts++;if(landed===true||landed==='different')await base(t,landed===true?p:{...p,description:'different'});throw new TransportError();};const list=r.list;r.list=async t=>{reads++;if(landed==='read_failure'&&reads>3)throw new Error('offline');return list(t);};
  const report=await new DefinitionSynchronizer('a',new MemoryDefinitionStateStore(),r,document(manifest().tools.echo)).sync();assert.equal(attempts,1);assert.equal(report.status,landed===true?'succeeded':'ambiguous');assert.equal(report.manifest_ready,landed===true);assert.equal(reads,4);
 }
 const r=remote(),store=new MemoryDefinitionStateStore(),m=document(manifest().tools.echo),sync=new DefinitionSynchronizer('a',store,r,m);await sync.sync();const base=r.update;r.update=async(...args)=>{await base(...args);throw new DOMException('timeout','TimeoutError');};m.tools.echo.description='changed';assert.equal((await sync.sync()).status,'succeeded');
 const del=r.delete;r.delete=async(...args)=>{await del(...args);throw new TransportError();};assert.equal((await new DefinitionSynchronizer('a',store,r,document(null)).sync({prune:true})).status,'succeeded');
});
test('TOOLING-10 partial failure saves successful identities and does not mark ready',async()=>{
 const r=remote(),create=r.create;r.create=async(t,p)=>{if(t==='agent')throw new EnvaiError('invalid',422,'validation_error','code',{field:'model'});return create(t,p);};const sync=new DefinitionSynchronizer('a',new MemoryDefinitionStateStore(),r,manifest());const result=await sync.sync();assert.equal(result.status,'failed');assert.deepEqual(result.outcomes.map(o=>o.status),['succeeded','failed','skipped','skipped']);assert.deepEqual(result.outcomes[1].error,{type:'validation_error',code:'code',http_status:422,details:{field:'model'}});assert.equal(Object.keys((await sync.state()).records).length,1);await assert.rejects(sync.requireSynchronized());
});
test('TOOLING-13 readiness and lazy TTL hold lock and never implicitly synchronize lookups',async()=>{
 const store=new MemoryDefinitionStateStore(),r=remote(),sync=new DefinitionSynchronizer('a',store,r,manifest());for(const mode of ['manual','deploy','off'])await sync.gate(mode);assert.equal(r.calls.length,0);await assert.rejects(sync.requireSynchronized());await Promise.all([sync.gate('lazy'),sync.gate('lazy')]);assert.equal(r.calls.length,4);await sync.gate('lazy');assert.equal(r.calls.length,4);await assert.rejects(sync.gate('lazy',-1));
 r.models=async()=>{throw new Error('catalog down');};await assert.rejects(sync.plan(),/catalog down/);r.models=async()=>null;await assert.rejects(sync.plan(),/catalog/);
});
test('TOOLING-11 memory and file scope isolation, locks, fail-closed corruption and restart',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'envai-state-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'private/state.json'),file=new FileDefinitionStateStore(path);await file.initialize();await file.initialize();assert.equal((await stat(path)).mode&0o777,0o600);
 const item=record('tool','echo',manifest().tools.echo);await file.withScope('account',async s=>{await s.save(item);await s.markReady({manifest_hash:'hash',updated_at:'now'});});const restarted=new FileDefinitionStateStore(path);assert.deepEqual((await restarted.withScope('account',s=>s.read())).records['tool:echo'],item);assert.deepEqual(await file.withScope('other',s=>s.read()),{records:{}});
 await file.withScope('__proto__',s=>s.save(item));assert.deepEqual((await file.withScope('__proto__',s=>s.read())).records['tool:echo'],item);
 for(const store of [new MemoryDefinitionStateStore(),file]){let active=0,max=0;await Promise.all(Array.from({length:4},()=>store.withScope('same',async()=>{max=Math.max(max,++active);await new Promise(r=>setTimeout(r,2));active--;})));assert.equal(max,1);await assert.rejects(store.withScope('same',async()=>{throw new Error('failed');}));await store.withScope('same',async()=>{});await assert.rejects(store.withScope('',async()=>{}));}
 await mkdir(path+'.lock');await assert.rejects(new FileDefinitionStateStore(path,30).withScope('account',async()=>{}),/lock unavailable/);await rm(path+'.lock',{recursive:true});await writeFile(path,'null');await assert.rejects(file.initialize(),/corrupt/);await assert.rejects(file.withScope('account',async()=>{}),/corrupt/);assert.equal(await readFile(path,'utf8'),'null');
 for(const value of [null,[],{}, {records:[]},{records:{},extra:true},{records:{bad:item}},{records:{'tool:echo':{...item,status:'bad'}}},{records:{},ready:null},{records:{},ready:{manifest_hash:'x'}}])assert.throws(()=>assertDefinitionState(value));
});
test('TOOLING-09 crash checkpoint and ambiguous readback cannot be overridden or resent',async()=>{
 const m=document(manifest().tools.echo),store=new MemoryDefinitionStateStore(),r=remote();let attempts=0;r.create=async()=>{attempts++;throw new TransportError();};const sync=new DefinitionSynchronizer('a',store,r,m);
 assert.equal((await sync.sync()).status,'ambiguous');assert.equal((await sync.state()).records['tool:echo'].status,'ambiguous');assert.equal((await sync.sync({adopt:true,overwriteDrift:true,recreateMissing:true,prune:true})).status,'blocked');assert.equal(attempts,1);
 r.data.tool.push({...m.tools.echo,id:'landed',updated_at:'now'});assert.equal((await sync.sync()).status,'succeeded');assert.equal(attempts,1);assert.equal((await sync.state()).records['tool:echo'].remote_id,'landed');
 r.data.tool[0].description='drift';assert.equal((await sync.sync()).status,'blocked');assert.equal((await sync.state()).ready,undefined);
 const item=(await sync.state()).records['tool:echo'];await store.withScope('a',s=>s.save({...item,status:'ambiguous',pending_action:'delete',pending_payload:{}}));r.data.tool=[];const empty=new DefinitionSynchronizer('a',store,r,document(null));r.delete=async()=>{assert.fail('confirmed absent ambiguous delete must not mutate again');};assert.equal((await empty.sync({prune:true})).status,'succeeded');assert.deepEqual((await empty.state()).records,{});
});
test('TOOLING-12 PostgreSQL restart, scopes, concurrent sessions, corrupt rows and explicit schema lifecycle',{skip:!process.env.ENVAI_TEST_PG_URL},async()=>{
 const {Pool}=await import('pg');const admin=new Pool({connectionString:process.env.ENVAI_TEST_PG_URL});const schema='definitions_'+Date.now()+'_'+Math.floor(Math.random()*1e6);await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString:process.env.ENVAI_TEST_PG_URL,options:`-c search_path=${schema}`,max:8});
 try{
  const store=new PostgresDefinitionStateStore(pool);await assert.rejects(store.withScope('a',s=>s.read()),/does not exist/);await pool.query('CREATE TABLE envai_definition_state(scope text PRIMARY KEY,state jsonb NOT NULL)');
  const item=record('tool','echo',manifest().tools.echo);await store.withScope('a',s=>s.save(item));assert.deepEqual((await new PostgresDefinitionStateStore(pool).withScope('a',s=>s.read())).records['tool:echo'],item);assert.deepEqual(await store.withScope('b',s=>s.read()),{records:{}});
  let active=0,max=0;await Promise.all(Array.from({length:8},()=>store.withScope('a',async s=>{max=Math.max(max,++active);await new Promise(r=>setTimeout(r,2));await s.markReady({manifest_hash:'hash',updated_at:'now'});active--;})));assert.equal(max,1);
  await assert.rejects(store.withScope('a',async s=>{await s.save({...item,last_applied:{schema:{const:{object:{},array:[]}}}});throw new Error('later failure');}));assert.deepEqual((await store.withScope('a',s=>s.read())).records['tool:echo'].last_applied,{schema:{const:{object:{},array:[]}}});
  await pool.query("ALTER TABLE envai_definition_state ADD CONSTRAINT reject_test CHECK ((state #>> '{records,tool:echo,remote_name}') <> 'reject')");await assert.rejects(store.withScope('a',s=>s.save({...item,remote_name:'reject'})),/constraint/);assert.equal((await store.withScope('a',s=>s.read())).records['tool:echo'].remote_name,'echo');assert.deepEqual(await store.withScope('b',s=>s.read()),{records:{}});
  await pool.query("UPDATE envai_definition_state SET state='null'::jsonb WHERE scope='a'");await assert.rejects(store.withScope('a',s=>s.save(item)),/Corrupt/);assert.equal((await pool.query("SELECT state FROM envai_definition_state WHERE scope='a'")).rows[0].state,null);await assert.rejects(store.withScope('',async()=>{}));
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
test('TOOLING-11 independent Node processes serialize durable file changes',async t=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const run=promisify(execFile);const dir=await mkdtemp(join(tmpdir(),'envai-state-process-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'state.json'),store=new FileDefinitionStateStore(path);await store.initialize();await store.withScope('a',s=>s.save({...record('tool','echo',manifest().tools.echo),remote_marker:0}));
 const source=`import { FileDefinitionStateStore } from ${JSON.stringify(new URL('../dist/definition-state.js',import.meta.url).href)}; const store=new FileDefinitionStateStore(process.env.TEST_STATE);await store.withScope('a',async s=>{const r=(await s.read()).records['tool:echo'];await new Promise(resolve=>setTimeout(resolve,20));await s.save({...r,remote_marker:r.remote_marker+1});});`;
 await Promise.all(Array.from({length:4},()=>run(process.execPath,['--input-type=module','-e',source],{env:{...process.env,TEST_STATE:path}})));assert.equal((await store.withScope('a',s=>s.read())).records['tool:echo'].remote_marker,4);
});
test('ambiguity reconciliation resolves known landing without update even with overwrite override',async()=>{
 const m=document(manifest().tools.echo),store=new MemoryDefinitionStateStore(),r=remote({tool:[{...manifest().tools.echo,id:'landed'}]});await store.withScope('a',s=>s.save({...record('tool','echo',m.tools.echo),remote_id:'',status:'ambiguous',pending_action:'create',pending_payload:m.tools.echo}));
 const sync=new DefinitionSynchronizer('a',store,r,m);assert.equal((await sync.sync({overwriteDrift:true,adopt:true})).manifest_ready,true);assert.equal(r.calls.length,0);
 r.models=async()=>{throw new Error('offline');};await assert.rejects(sync.sync(),/offline/);assert.equal((await sync.state()).ready,undefined);
});
test('failOnDrift blocks overrides before writes and carries the reviewable plan',async()=>{
 const m=document(manifest().tools.echo),store=new MemoryDefinitionStateStore(),r=remote(),sync=new DefinitionSynchronizer('a',store,r,m);await sync.sync();r.data.tool[0].description='remote edit';r.calls.length=0;
 for(const action of ['plan','sync'])await assert.rejects(sync[action]({failOnDrift:true,overwriteDrift:true}),e=>e.name==='DefinitionDriftError'&&e.plan.operations[0].classification==='drift');assert.equal(r.calls.length,0);assert.equal((await sync.state()).ready,undefined);
});

test('definition policy flags require explicit booleans',()=>{for(const options of [{prune:'false'},{adopt:1},{overwriteDrift:null},{typo:true}])assert.throws(()=>planDefinitions(manifest(),{records:{}},{tool:{},agent:{},team:{}},options),TypeError);});
test('TOOLING-03 set order is canonical, team order significant, Unicode literal shapes retained',()=>{
 const a=manifest(),b=manifest();a.agents.coordinator.tools_enabled=[{name:'β'},{name:'a'},{name:'β'}];b.agents.coordinator.tools_enabled=[{name:'a'},{name:'β'}];assert.equal(manifestHash(a),manifestHash(b));
 a.agents.other={...a.agents.worker,name:'Other'};a.teams.team.members.push({agent_definition_id:'other',role:null});const ordered=manifestHash(a);a.teams.team.members.reverse();assert.notEqual(manifestHash(a),ordered);
 a.tools.echo.parameters.properties.unicode={enum:[{},[],{'💡':'é'}],const:{'𐀀':1,'\uE000':2}};const compiled=compileDefinitions(a);assert.deepEqual(compiled.tools.echo.parameters,a.tools.echo.parameters);assert.equal(manifestHash(compiled),manifestHash(a));
});
test('TOOLING-06 tool rename creates new identity and prunes old only explicitly',async()=>{
 const m=document(manifest().tools.echo),store=new MemoryDefinitionStateStore(),r=remote(),sync=new DefinitionSynchronizer('a',store,r,m);await sync.sync();r.calls.length=0;m.tools.renamed={...m.tools.echo,name:'renamed'};delete m.tools.echo;await sync.sync();assert.deepEqual(r.calls.map(c=>c.method),['createTool']);assert.equal(r.data.tool.length,2);r.calls.length=0;await sync.sync({prune:true});assert.deepEqual(r.calls.map(c=>c.method),['deleteTool']);assert.equal(r.data.tool[0].name,'renamed');
});
