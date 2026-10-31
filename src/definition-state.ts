import { mkdir, open, readFile, rename, unlink, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { definitionObject, definitionTypes, type DefinitionType, type DefinitionPayload } from './definitions.js';

export interface DefinitionRecord { type: DefinitionType; local_key: string; remote_id: string; remote_name: string; desired_hash: string; last_applied: DefinitionPayload; remote_marker: unknown; status: 'applied'|'drifted'|'conflicted'|'missing'|'ambiguous'; updated_at: string; pending_payload?: DefinitionPayload; pending_action?: 'create'|'update'|'delete' }
export interface DefinitionReady { manifest_hash: string; updated_at: string }
export interface DefinitionState { records: Record<string,DefinitionRecord>; ready?: DefinitionReady }
export interface DefinitionStateSession { read(): Promise<DefinitionState>; save(record: DefinitionRecord): Promise<void>; delete(type: DefinitionType,key: string): Promise<void>; markReady(ready: DefinitionReady | undefined): Promise<void> }
export interface DefinitionStateStore { withScope<T>(scope: string, action: (session: DefinitionStateSession) => Promise<T>): Promise<T> }
export const definitionRecordKey = (type: DefinitionType, key: string): string => `${type}:${key}`;
export function assertDefinitionState(value: unknown): asserts value is DefinitionState {
  if (!definitionObject(value) || !definitionObject(value.records) || Object.keys(value).some(k => !['records','ready'].includes(k))) throw new Error('Corrupt definition state');
  for (const [key,r] of Object.entries(value.records)) {
    if (!definitionObject(r) || !definitionTypes.includes(r.type as DefinitionType) || typeof r.local_key !== 'string' || key !== definitionRecordKey(r.type as DefinitionType,r.local_key) || ['remote_id','remote_name','desired_hash','updated_at'].some(f => typeof r[f] !== 'string' || !r[f] && !(f === 'remote_id' && r.status === 'ambiguous')) || !definitionObject(r.last_applied) || !['applied','drifted','conflicted','missing','ambiguous'].includes(String(r.status))) throw new Error('Corrupt definition resource record');
    if (r.pending_payload !== undefined && !definitionObject(r.pending_payload) || r.pending_action !== undefined && !['create','update','delete'].includes(String(r.pending_action))) throw new Error('Corrupt pending definition mutation');
  }
  if (value.ready !== undefined && (!definitionObject(value.ready) || typeof value.ready.manifest_hash !== 'string' || typeof value.ready.updated_at !== 'string')) throw new Error('Corrupt ready marker');
}
function session(read: () => Promise<DefinitionState>, write: (state: DefinitionState) => Promise<void>): DefinitionStateSession & { finish(): Promise<void> } {
  let active=true; let queue:Promise<void>=Promise.resolve(); let failed=false; let failure:unknown;
  const check=()=>{if(!active) throw new Error('Definition state session has expired');};
  const mutate=(change:(state:DefinitionState)=>void):Promise<void>=>{
    check(); const work=queue.then(async()=>{if(failed) throw failure;const state=await read();assertDefinitionState(state);change(state);assertDefinitionState(state);await write(state);});
    queue=work.catch(error=>{failed=true;failure=error;});return work;
  };
  return {
    read:()=>{check();const work=queue.then(read);queue=work.then(()=>{}).catch(error=>{failed=true;failure=error;});return work;},
    save:record=>mutate(state=>{Object.defineProperty(state.records,definitionRecordKey(record.type,record.local_key),{value:structuredClone(record),enumerable:true,configurable:true,writable:true});}),
    delete:(type,key)=>mutate(state=>{delete state.records[definitionRecordKey(type,key)];}),
    markReady:ready=>mutate(state=>{if(ready)state.ready=structuredClone(ready);else delete state.ready;}),
    finish:async()=>{active=false;await queue;if(failed)throw failure;},
  };
}
async function useSession<T>(current: ReturnType<typeof session>,action:(session:DefinitionStateSession)=>Promise<T>):Promise<T>{try{return await action(current);}finally{await current.finish();}}
/** Explicitly ephemeral, suitable for tests or single-process development. */
export class MemoryDefinitionStateStore implements DefinitionStateStore {
  private readonly states = new Map<string,DefinitionState>(); private readonly locks = new Map<string,Promise<void>>();
  async withScope<T>(scope: string, action: (session: DefinitionStateSession) => Promise<T>): Promise<T> {
    if (!scope) throw new TypeError('Connection scope is required');
    const previous = this.locks.get(scope) ?? Promise.resolve(); let release!: () => void; const locked = new Promise<void>(r => { release=r; }); this.locks.set(scope,locked); await previous;
    try { return await useSession(session(async () => structuredClone(this.states.get(scope) ?? {records:{}}), async state => { this.states.set(scope,structuredClone(state)); }),action); }
    finally { release(); if (this.locks.get(scope) === locked) this.locks.delete(scope); }
  }
}
interface StateFile { format_version: '1'; scopes: Record<string,DefinitionState> }
function assertFile(value: unknown): asserts value is StateFile {
  if (!definitionObject(value) || value.format_version !== '1' || !definitionObject(value.scopes) || Object.keys(value).some(k => !['format_version','scopes'].includes(k))) throw new Error('Unknown/corrupt definition state file');
  for (const state of Object.values(value.scopes)) assertDefinitionState(state);
}
/** Atomic private file state. Separate lock directory serializes processes; a crash leaves a fail-closed lock for operator recovery. */
export class FileDefinitionStateStore implements DefinitionStateStore {
  constructor(readonly path: string, private readonly lockTimeoutMs = 10_000) {}
  /** Explicit provisioning only. Existing files are validated, never reset. */
  async initialize(): Promise<void> {
    await mkdir(dirname(this.path),{recursive:true,mode:0o700});
    let handle; try { handle=await open(this.path,'wx',0o600); } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await this.readFile(); return; }
    try { await handle.writeFile(JSON.stringify({format_version:'1',scopes:{}})); await handle.sync(); } finally { await handle.close(); }
  }
  private async readFile(): Promise<StateFile> { const value: unknown = JSON.parse(await readFile(this.path,'utf8')); assertFile(value); return value; }
  private async readScope(scope: string): Promise<DefinitionState> { const file=await this.readFile(); return Object.hasOwn(file.scopes,scope) ? file.scopes[scope]! : {records:{}}; }
  private async writeFile(value: StateFile): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`; const handle = await open(temporary,'wx',0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary,this.path); const directory = await open(dirname(this.path),'r'); try { await directory.sync(); } finally { await directory.close(); } } catch(error) { await unlink(temporary).catch(() => {}); throw error; }
  }
  async withScope<T>(scope: string, action: (session: DefinitionStateSession) => Promise<T>): Promise<T> {
    if (!scope) throw new TypeError('Connection scope is required');
    // Whole-file lock also protects independent scope updates from lost writes.
    const lock = `${this.path}.lock`; const deadline = Date.now()+this.lockTimeoutMs;
    for (;;) { try { await mkdir(lock,{mode:0o700}); break; } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (Date.now() >= deadline) throw new Error('Definition state lock unavailable; inspect crash ownership before recovery'); await new Promise(r => setTimeout(r,10)); } }
    try {
      await this.readFile();
      return await useSession(session(async () => structuredClone(await this.readScope(scope)), async state => { const file = await this.readFile(); Object.defineProperty(file.scopes,scope,{value:state,enumerable:true,configurable:true,writable:true}); await this.writeFile(file); }),action);
    } finally { await rmdir(lock); }
  }
}
export interface DefinitionDatabaseConnection { query<T = Record<string,unknown>>(sql: string, values?: unknown[]): Promise<{rows:T[];rowCount:number|null}>; release(error?: Error): void }
export interface DefinitionDatabasePool { connect(): Promise<DefinitionDatabaseConnection> }
/** Provision envai_definition_state(scope text PRIMARY KEY, state jsonb NOT NULL) separately. No automatic DDL. */
export class PostgresDefinitionStateStore implements DefinitionStateStore {
  constructor(private readonly pool: DefinitionDatabasePool) {}
  async withScope<T>(scope: string, action: (session: DefinitionStateSession) => Promise<T>): Promise<T> {
    if (!scope) throw new TypeError('Connection scope is required');
    const db=await this.pool.connect();let locked=false;let discard:Error|undefined;
    try {
      try{await db.query('SELECT pg_advisory_lock(hashtextextended($1, 0))',[`envai-definitions:${scope}`]);locked=true;}
      catch(error){discard=new Error('Definition advisory lock acquisition is uncertain',{cause:error});throw error;}
      return await useSession(session(async()=>{
        const result=await db.query<{state:unknown}>('SELECT state FROM envai_definition_state WHERE scope = $1',[scope]);
        if(result.rows.length>1)throw new Error('Duplicate definition scope');
        const state=result.rows.length?result.rows[0]!.state:{records:{}};assertDefinitionState(state);return structuredClone(state);
      },async state=>{await db.query('INSERT INTO envai_definition_state(scope,state) VALUES ($1,$2::jsonb) ON CONFLICT(scope) DO UPDATE SET state=EXCLUDED.state',[scope,JSON.stringify(state)]);}),action);
    } finally {
      try {if(locked){const result=await db.query<{unlocked:boolean}>('SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked',[`envai-definitions:${scope}`]);if(result.rows[0]?.unlocked!==true)throw new Error('Definition advisory lock ownership lost');}}
      catch(error){discard=new Error('Definition advisory unlock failed',{cause:error});throw error;}
      finally{db.release(discard);}
    }
  }
}
