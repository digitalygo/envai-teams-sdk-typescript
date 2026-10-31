import { compileDefinitions, definitionHash, definitionMap, definitionTypes, manifestHash, normalizeDefinition, resourceHash, type DefinitionManifest, type DefinitionPayload, type DefinitionType } from './definitions.js';
import { definitionRecordKey, type DefinitionState, type DefinitionStateSession, type DefinitionStateStore, type DefinitionRecord } from './definition-state.js';
import { EnvaiError, TransportError } from './errors.js';

export interface DefinitionRemote { models(): Promise<readonly string[]>; list(type: DefinitionType): Promise<DefinitionPayload[]>; get(type: DefinitionType,id: string,name: string): Promise<DefinitionPayload | undefined>; create(type: DefinitionType,payload: DefinitionPayload): Promise<DefinitionPayload>; update(type: DefinitionType,id: string,name: string,payload: DefinitionPayload): Promise<DefinitionPayload>; delete(type: DefinitionType,id: string,name: string): Promise<void> }
export interface DefinitionSyncOptions { adopt?: boolean; overwriteDrift?: boolean; recreateMissing?: boolean; prune?: boolean; dryRun?: boolean; failOnDrift?: boolean; scope?: 'all'|'tools'|'agents'|'teams' }
export type DefinitionClassification = 'create'|'unchanged'|'update'|'drift'|'conflict'|'adoption_required'|'missing_remote'|'orphan_managed';
export interface DefinitionChange { path: string; kind: 'added'|'removed'|'changed' }
export interface DefinitionOperation { id: string; type: DefinitionType; local_key: string; classification: DefinitionClassification; action: 'create'|'none'|'update'|'adopt'|'recreate'|'delete'|'forget'; blocking: boolean; reason_code: string | null; remote_id: string | null; remote_name: string | null; remote_marker: unknown; destructive: boolean; changes: DefinitionChange[] }
export interface DefinitionPlan { format_version: '1'; manifest_hash: string; hash: string; options: DefinitionSyncOptions; operations: DefinitionOperation[] }
export class DefinitionDriftError extends Error { constructor(readonly plan: DefinitionPlan) { super('Definition drift or conflict detected'); this.name='DefinitionDriftError'; } }
export interface DefinitionOutcome { id: string; status: 'pending'|'skipped'|'succeeded'|'failed'|'ambiguous'; error?: {type:string;code?:string|null;http_status?:number;details?:unknown} }
export interface DefinitionReport { format_version: '1'; status: 'succeeded'|'blocked'|'dry_run'|'failed'|'ambiguous'; manifest_ready: boolean; plan: DefinitionPlan; outcomes: DefinitionOutcome[] }
export type DefinitionSnapshot = Record<DefinitionType,Record<string,DefinitionPayload | undefined>>;
const equal = (a: unknown,b: unknown): boolean => definitionHash(a) === definitionHash(b);
export function definitionDiff(before: DefinitionPayload, after: DefinitionPayload, prefix = ''): DefinitionChange[] {
  const changes: DefinitionChange[] = [];
  for (const key of new Set([...Object.keys(before),...Object.keys(after)])) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in before)) changes.push({path,kind:'added'});
    else if (!(key in after)) changes.push({path,kind:'removed'});
    else if (!equal(before[key],after[key])) {
      const a=before[key],b=after[key];
      if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) changes.push(...definitionDiff(a as DefinitionPayload,b as DefinitionPayload,path));
      else changes.push({path,kind:'changed'});
    }
  }
  return changes;
}
export function planDefinitions(manifest: DefinitionManifest,state: DefinitionState,remote: DefinitionSnapshot,options: DefinitionSyncOptions = {}): DefinitionPlan {
  if(Object.keys(options).some(k=>!['adopt','overwriteDrift','recreateMissing','prune','dryRun','failOnDrift','scope'].includes(k))) throw new TypeError('Unknown definition option');
  for(const [key,value] of Object.entries(options)) if(key!=='scope' && value!==undefined && typeof value!=='boolean') throw new TypeError('Definition policy flags must be boolean');
  if (options.scope !== undefined && !['all','tools','agents','teams'].includes(options.scope)) throw new TypeError('Invalid definition scope');
  const ids = Object.fromEntries(Object.values(state.records).filter(r => r.type === 'agent').map(r => [r.remote_id,r.local_key]));
  const operations: DefinitionOperation[] = [];
  for (const type of definitionTypes) {
    if(options.scope && options.scope !== 'all' && options.scope !== definitionMap(type)) continue;
    const desired=manifest[definitionMap(type)]; const managed=Object.values(state.records).filter(r => r.type === type);
    for(const key of [...new Set([...Object.keys(desired),...managed.map(r=>r.local_key)])].sort()) {
      const d=desired[key],record=state.records[definitionRecordKey(type,key)],observed=remote[type][key];
      const D=d ? normalizeDefinition(type,d,ids) : {}, A=record ? normalizeDefinition(type,record.last_applied,ids) : {}, R=observed ? normalizeDefinition(type,observed,ids) : {};
      let classification: DefinitionClassification;
      if(!d) classification='orphan_managed'; else if(!record) classification=observed?'adoption_required':'create'; else if(!observed) classification='missing_remote'; else if(equal(D,A)) classification=equal(R,A)?'unchanged':'drift'; else classification=equal(R,A)?'update':'conflict';
      let action: DefinitionOperation['action']='none',blocking=false,reason: string|null=null;
      switch(classification) {
        case 'create': action='create'; break;
        case 'update': action='update'; break;
        case 'drift': if(options.overwriteDrift) action='update'; else {blocking=true;reason='drift';} break;
        case 'conflict': blocking=true;reason='conflict';break;
        case 'adoption_required': if(options.adopt) action='adopt';else {blocking=true;reason='adoption_required';}break;
        case 'missing_remote': if(options.recreateMissing) action='recreate';else {blocking=true;reason='missing_remote';}break;
        case 'orphan_managed': if(options.prune) action='delete';else reason='prune_disabled';break;
        case 'unchanged': break;
      }
      if(record?.status==='ambiguous') { const landed=record.pending_action==='delete' ? !observed : observed && record.pending_payload && equal(R,normalizeDefinition(type,record.pending_payload,ids)); if(landed && record.pending_action!=='delete') { classification='unchanged';action='adopt';blocking=false;reason=null; } else if(landed && !d) {action='forget';blocking=false;reason=null;} else {classification='conflict';action='none';blocking=true;reason='ambiguous';} }
      operations.push({id:definitionRecordKey(type,key),type,local_key:key,classification,action,blocking,reason_code:reason,remote_id:observed?String(observed.id ?? record?.remote_id ?? '')||null:record?.remote_id??null,remote_name:observed?String(observed.name):record?.remote_name??null,remote_marker:observed?.updated_at??record?.remote_marker??null,destructive:action==='delete',changes:definitionDiff(classification==='missing_remote'?A:R,D)});
    }
  }
  const content={format_version:'1' as const,manifest_hash:manifestHash(manifest),options:{...options},operations};return {...content,hash:definitionHash(content)};
}
export class DefinitionSynchronizer {
  constructor(readonly scope: string,readonly store: DefinitionStateStore,readonly remote: DefinitionRemote,readonly manifest: DefinitionManifest) { if(!scope) throw new TypeError('Connection scope is required'); compileDefinitions(manifest); }
  private async prepare(session: DefinitionStateSession,options: DefinitionSyncOptions): Promise<{plan:DefinitionPlan;state:DefinitionState;remote:DefinitionSnapshot}> {
    const models=await this.remote.models(); if(!Array.isArray(models) || !models.every(m=>typeof m==='string')) throw new TypeError('Model catalog unavailable'); const manifest=compileDefinitions(this.manifest,models);
    const state=await session.read(); const snapshot: DefinitionSnapshot={tool:{},agent:{},team:{}};
    for(const type of definitionTypes) {
      if(options.scope && options.scope!=='all' && options.scope!==definitionMap(type)) continue;
      const list=await this.remote.list(type); const names=new Map<string,DefinitionPayload>();
      for(const item of list) { if(typeof item.name!=='string' || typeof item.id!=='string' || names.has(item.name)) throw new Error('Ambiguous/invalid remote definitions'); names.set(item.name,item); }
      const desired=manifest[definitionMap(type)]; const managed=Object.values(state.records).filter(r=>r.type===type);
      for(const key of new Set([...Object.keys(desired),...managed.map(r=>r.local_key)])) {
        const record=state.records[definitionRecordKey(type,key)]; snapshot[type][key]=record?(record.remote_id?await this.remote.get(type,record.remote_id,record.remote_name):names.get(record.remote_name)):names.get(String(desired[key]!.name));
      }
    }
    const plan=planDefinitions(manifest,state,snapshot,options);
    if(options.failOnDrift && plan.operations.some(o=>o.classification==='drift'||o.classification==='conflict')) throw new DefinitionDriftError(plan);
    return {plan,state,remote:snapshot};
  }
  async plan(options: DefinitionSyncOptions = {}): Promise<DefinitionPlan> { return this.store.withScope(this.scope,async session=>(await this.prepare(session,options)).plan); }
  async status(): Promise<DefinitionPlan> { return this.plan(); }
  async state(): Promise<DefinitionState> { return this.store.withScope(this.scope,session=>session.read()); }
  async requireSynchronized(): Promise<void> { const state=await this.state(); if(state.ready?.manifest_hash!==manifestHash(this.manifest)) throw new Error('Definitions are not synchronized'); }
  async lookup(type: DefinitionType,key: string): Promise<string> { return this.store.withScope(this.scope,async session=>{const state=await session.read();if(state.ready?.manifest_hash!==manifestHash(this.manifest))throw new Error('Definitions are not synchronized');const record=state.records[definitionRecordKey(type,key)];if(!record || !Object.hasOwn(this.manifest[definitionMap(type)],key))throw new Error('Unknown definition identity');return type==='tool'?record.remote_name:record.remote_id;}); }
  team(key:string):Promise<string>{return this.lookup('team',key);} agent(key:string):Promise<string>{return this.lookup('agent',key);} tool(key:string):Promise<string>{return this.lookup('tool',key);}
  async sync(options: DefinitionSyncOptions = {}): Promise<DefinitionReport> { return this.store.withScope(this.scope,session=>this.applyLocked(session,options)); }
  private async applyLocked(session: DefinitionStateSession,options: DefinitionSyncOptions): Promise<DefinitionReport> {
    if(!options.dryRun) await session.markReady(undefined);
    const prepared=await this.prepare(session,options),plan=prepared.plan;
    const report:DefinitionReport={format_version:'1',status:'succeeded',manifest_ready:false,plan,outcomes:plan.operations.map(o=>({id:o.id,status:'pending'}))};
    if(options.dryRun){report.status='dry_run';return report;}
    if(plan.operations.some(o=>o.blocking)){await session.markReady(undefined);report.status='blocked';report.outcomes.forEach(o=>o.status='skipped');return report;}
    await session.markReady(undefined);
    const ordered=[...plan.operations.filter(o=>o.action!=='delete'),...plan.operations.filter(o=>o.action==='delete').reverse()];
    let adoptedDifferent=false;
    const outcome=new Map(report.outcomes.map(o=>[o.id,o]));
    for(const operation of ordered) {
      const result=outcome.get(operation.id)!;
      if(report.status!=='succeeded'){result.status='skipped';continue;}
      if(operation.action==='none'){result.status='skipped';continue;}
      const {type,local_key:key}=operation;
      const state=await session.read(),ids=Object.fromEntries(Object.values(state.records).filter(r=>r.type==='agent').map(r=>[r.remote_id,r.local_key]));
      const desired=compileDefinitions(this.manifest)[definitionMap(type)][key];let payload=desired?structuredClone(desired):{};
      if(type==='team' && desired){ const resolve=(local:unknown)=>{const record=state.records[definitionRecordKey('agent',String(local))];if(!record)throw new Error('Agent dependency is not synchronized');return record.remote_id;};payload.orchestrator_id=resolve(payload.orchestrator_id);payload.members=(payload.members as DefinitionPayload[]).map(m=>({...m,agent_definition_id:resolve(m.agent_definition_id)})); }
      let actual=prepared.remote[type][key];
      const previous=state.records[operation.id];
      try {
        const checkpoint=async (pending_action:'create'|'update'|'delete')=>session.save({...previous,type,local_key:key,remote_id:operation.remote_id??'',remote_name:operation.remote_name??String(payload.name),desired_hash:desired?resourceHash(type,key,desired):previous!.desired_hash,last_applied:previous?.last_applied??{},remote_marker:operation.remote_marker,status:'ambiguous',updated_at:new Date().toISOString(),pending_payload:normalizeDefinition(type,payload,ids),pending_action});
        if(operation.action==='delete' || operation.action==='forget') {
          if(operation.action==='delete') {
          await checkpoint('delete');
          try{await this.remote.delete(type,operation.remote_id!,operation.remote_name!);}catch(error){if(error instanceof EnvaiError && error.httpStatus===404){/* already gone */}else if(this.uncertain(error)){let absent=false;try{absent=await this.remote.get(type,operation.remote_id!,operation.remote_name!)===undefined;}catch{/* unresolved */}if(!absent)throw new AmbiguousDefinitionError(error);}else throw error;}
          }
          await session.delete(type,key);
        } else {
          const adoptOnly=operation.action==='adopt' && (previous?.status==='ambiguous' || !options.overwriteDrift);
          if(!adoptOnly) {
            await checkpoint(['create','recreate'].includes(operation.action)?'create':'update');
            try { actual=['create','recreate'].includes(operation.action)?await this.remote.create(type,payload):await this.remote.update(type,operation.remote_id!,operation.remote_name!,payload); }
            catch(error){if(!this.uncertain(error))throw error;let readback:DefinitionPayload|undefined;try{readback=['create','recreate'].includes(operation.action)?(await this.remote.list(type)).find(r=>r.name===payload.name):await this.remote.get(type,operation.remote_id!,operation.remote_name!);}catch{/* unresolved */}if(!readback || !equal(normalizeDefinition(type,readback,ids),normalizeDefinition(type,payload,ids)))throw new AmbiguousDefinitionError(error);actual=readback;}
          }
          if(!actual || typeof actual.id!=='string' || !actual.id || typeof actual.name!=='string')throw new AmbiguousDefinitionError(new Error('Mutation response lacks identity'));
          if(adoptOnly && !equal(normalizeDefinition(type,actual,ids),normalizeDefinition(type,payload,ids))) adoptedDifferent=true;
          const record:DefinitionRecord={type,local_key:key,remote_id:actual.id,remote_name:actual.name,desired_hash:resourceHash(type,key,desired!),last_applied:normalizeDefinition(type,actual,ids),remote_marker:actual.updated_at??null,status:'applied',updated_at:new Date().toISOString()};await session.save(record);
        }
        result.status='succeeded';
      } catch(error) {
        if(error instanceof EnvaiError && error.httpStatus<500) { if(previous) await session.save(previous); else await session.delete(type,key); }
        report.status=error instanceof AmbiguousDefinitionError?'ambiguous':'failed';result.status=report.status;
        const cause=error instanceof AmbiguousDefinitionError?error.original:error;
        result.error=cause instanceof EnvaiError?{type:cause.type,code:cause.code,http_status:cause.httpStatus,details:cause.details}:{type:report.status};
      }
    }
    if(report.status==='succeeded' && !adoptedDifferent && (!options.scope || options.scope==='all')){await session.markReady({manifest_hash:plan.manifest_hash,updated_at:new Date().toISOString()});report.manifest_ready=true;}
    return report;
  }
  private uncertain(error:unknown):boolean { return error instanceof TransportError || error instanceof Error && ['TimeoutError','AbortError'].includes(error.name) || error instanceof EnvaiError && error.httpStatus>=500; }
  /** Explicit lazy mode only. Recheck ready identity/TTL under the same lock as reconciliation. */
  async gate(mode:'deploy'|'manual'|'off'|'lazy',ttlMs=60_000):Promise<void>{if(mode!=='lazy')return;if(!Number.isFinite(ttlMs)||ttlMs<0)throw new RangeError('Invalid readiness TTL');await this.store.withScope(this.scope,async session=>{const state=await session.read();if(state.ready?.manifest_hash===manifestHash(this.manifest)&&Date.now()-Date.parse(state.ready.updated_at)<ttlMs)return;const result=await this.applyLocked(session,{});if(!result.manifest_ready)throw new Error(`Definition synchronization ${result.status}`);});}
}
class AmbiguousDefinitionError extends Error { constructor(readonly original:unknown){super('Definition mutation outcome is ambiguous');} }
