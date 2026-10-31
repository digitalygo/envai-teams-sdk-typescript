import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definitionSQLSchema, SQLDefinitionStateStore, SQLiteDefinitionStateStore, MySQLDefinitionStateStore, sqliteDefinitionConnection, mysqlDefinitionConnection } from '../dist/definition-state-sql.js';

const record = () => ({ type:'tool',local_key:'echo',remote_id:'id-echo',remote_name:'echo',desired_hash:'sha256:test',last_applied:{parameters:{enum:[null,{},[]]}},remote_marker:null,status:'applied',updated_at:'2026-01-01T00:00:00Z' });
async function exerciseStore(t, dialect, pool, raw) {
  const Store = dialect === 'sqlite' ? SQLiteDefinitionStateStore : MySQLDefinitionStateStore;
  for (const ddl of definitionSQLSchema(dialect)) await raw.query(ddl);
  const store = new Store(pool,{lockTimeoutMs:30,pollIntervalMs:2});
  assert.deepEqual(await store.withScope('empty',s=>s.read()),{records:{}});
  let expired;
  await store.withScope('production',async s=>{
    expired=s;
    await Promise.all([s.save(record()),s.markReady({manifest_hash:'sha256:manifest',updated_at:'now'})]);
    assert.deepEqual((await s.read()).records['tool:echo'],record());
  });
  assert.throws(()=>expired.read(),/expired/);
  assert.throws(()=>expired.save(record()),/expired/);
  const restarted = new Store(pool,{lockTimeoutMs:20,pollIntervalMs:2});
  const identities=['Account','account','cafe','café','account '];
  for(const scope of identities) await store.withScope(scope,s=>s.markReady({manifest_hash:scope,updated_at:'now'}));
  for(const scope of identities) assert.equal((await restarted.withScope(scope,s=>s.read())).ready.manifest_hash,scope);
  // Case/accent/whitespace variants must also have independent lock rows.
  await store.withScope('Account',async()=>{await restarted.withScope('account',async()=>{});await restarted.withScope('account ',async()=>{});});
  const state=await restarted.withScope('production',s=>s.read());
  assert.equal(state.ready.manifest_hash,'sha256:manifest');
  assert.deepEqual(state.records['tool:echo'].last_applied.parameters.enum,[null,{},[]]);
  await store.withScope('production',async s=>{
    await assert.rejects(()=>restarted.withScope('production',async()=>assert.fail('stole lock')),/lock unavailable/);
    await s.delete('tool','echo'); await s.markReady(undefined);
    assert.deepEqual(await s.read(),{records:{}});
  });
  // Failure releases the owner lock but preserves already committed checkpoints.
  await assert.rejects(()=>store.withScope('partial',async s=>{await s.save(record());throw new Error('later operation failed');}),/later operation/);
  assert.equal((await restarted.withScope('partial',s=>s.read())).records['tool:echo'].status,'applied');
  // Invalid state rolls back atomically and releases ownership.
  await assert.rejects(()=>store.withScope('invalid',async s=>{await s.save({...record(),status:'invalid'});}),/Corrupt/);
  assert.deepEqual(await store.withScope('invalid',s=>s.read()),{records:{}});
  // Owner loss cannot write a checkpoint; rollback leaves no state row.
  await assert.rejects(()=>store.withScope('lost',async s=>{
    await raw.query('UPDATE envai_definition_locks SET owner = ? WHERE scope = ?',['another-owner','lost']);
    await s.save(record());
  }),/ownership changed/);
  assert.equal((await raw.query('SELECT state FROM envai_definition_state WHERE scope = ?',['lost'])).rows.length,0);
  await raw.query('DELETE FROM envai_definition_locks WHERE scope = ?',['lost']);
  // Corrupt JSON and structurally corrupt snapshots are never silently reset.
  await raw.query('UPDATE envai_definition_state SET state = ? WHERE scope = ?',['not json','partial']);
  await assert.rejects(()=>store.withScope('partial',s=>s.read()));
  await raw.query('UPDATE envai_definition_state SET state = ? WHERE scope = ?',[JSON.stringify({records:[],ready:null}),'partial']);
  await assert.rejects(()=>store.withScope('partial',s=>s.read()),/Corrupt/);
  // An abandoned lock stays closed even after waiting; no lease is stolen.
  await raw.query('INSERT INTO envai_definition_locks(scope,owner) VALUES (?,?)',['crashed','dead-process']);
  await assert.rejects(()=>store.withScope('crashed',async()=>{}),/lock unavailable/);
  await raw.query('DELETE FROM envai_definition_locks WHERE scope = ?',['crashed']);
  if(dialect==='mysql') {
    await raw.query('DELETE FROM envai_definition_state');await raw.query('DELETE FROM envai_definition_locks');
    await raw.query('ALTER TABLE envai_definition_state MODIFY scope VARCHAR(191)');
    await assert.rejects(()=>store.withScope('unsafe-schema',async()=>assert.fail('unsafe schema admitted')),/explicit schema migration/);
  }
  await assert.rejects(()=>store.withScope('',async()=>{}),/scope/);
  await assert.rejects(()=>store.withScope('x'.repeat(192),async()=>{}),/scope/);
}

test('SQLite definitions: durable state, owner locks, corruption and transaction rollback',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'envai-definitions-sql-'));
  const path=join(dir,'state.db');
  const pool={async connect(){const db=new DatabaseSync(path);return sqliteDefinitionConnection(db,()=>db.close());}};
  const raw=await pool.connect();
  try { await exerciseStore(t,'sqlite',pool,raw); } finally {raw.release();await rm(dir,{recursive:true,force:true});}
});

test('MySQL definitions: durable state, owner locks, corruption and transaction rollback',{skip:!process.env.ENVAI_TEST_MYSQL_DSN},async t=>{
  const {createPool}=await import('mysql2/promise');
  const mysql=createPool(process.env.ENVAI_TEST_MYSQL_DSN);
  const pool={async connect(){return mysqlDefinitionConnection(await mysql.getConnection());}};
  const raw=await pool.connect();
  try { await exerciseStore(t,'mysql',pool,raw); } finally {await raw.query('DROP TABLE IF EXISTS envai_definition_state');await raw.query('DROP TABLE IF EXISTS envai_definition_locks');raw.release();await mysql.end();}
});

test('SQL definitions validates options and fails closed for unavailable schema',async()=>{
  assert.throws(()=>definitionSQLSchema('postgres'),/dialect/);
  for(const options of [{lockTimeoutMs:-1},{lockTimeoutMs:Infinity},{pollIntervalMs:0},{pollIntervalMs:NaN}]) assert.throws(()=>new SQLDefinitionStateStore({},'sqlite',options),/timing/);
  const db=new DatabaseSync(':memory:');const connection=sqliteDefinitionConnection(db,()=>{});
  const store=new SQLiteDefinitionStateStore({async connect(){return connection;}},{lockTimeoutMs:0});
  await assert.rejects(()=>store.withScope('schema',async()=>assert.fail('missing schema accepted')),/no such table/);
  db.close();
});

test('SQL definitions releases after query failures and rejects duplicate scope',async()=>{
  let releases=0;
  const connection={async query(sql){if(sql.includes('information_schema.columns'))return {rows:[{table_name:'envai_definition_state',data_type:'varbinary'},{table_name:'envai_definition_locks',data_type:'varbinary'}],rowCount:2};if(sql.startsWith('INSERT INTO envai_definition_locks'))return {rows:[],rowCount:1};if(sql.startsWith('SELECT state'))return {rows:[{state:{}},{state:{}}],rowCount:2};return {rows:[],rowCount:1};},release(){releases++;}};
  const store=new MySQLDefinitionStateStore({async connect(){return connection;}});
  await assert.rejects(()=>store.withScope('duplicate',s=>s.read()),/Duplicate/);
  assert.equal(releases,1);
  // Non-contention insert error must propagate, never spin/retry a mutation.
  connection.query=async sql=>{if(sql.includes('information_schema.columns'))return {rows:[{data_type:'varbinary'},{data_type:'varbinary'}],rowCount:2};if(sql.startsWith('INSERT'))throw new Error('denied');return {rows:[],rowCount:0};};
  await assert.rejects(()=>store.withScope('denied',async()=>{}),/denied/);
  assert.equal(releases,2);
  const wrapped=mysqlDefinitionConnection({async query(){return [{},[]];},release(){releases++;}});
  assert.deepEqual(await wrapped.query('UPDATE x'),{rows:[],rowCount:0});wrapped.release();
});

test('Memory and file definition sessions serialize parallel writes and expire',async()=>{
  const {MemoryDefinitionStateStore,FileDefinitionStateStore}=await import('../dist/definition-state.js');
  const dir=await mkdtemp(join(tmpdir(),'envai-definitions-session-'));const file=new FileDefinitionStateStore(join(dir,'state.json'));await file.initialize();
  try {for(const store of [new MemoryDefinitionStateStore(),file]){
    let escaped;
    await store.withScope('scope',async s=>{escaped=s;await Promise.all([s.save(record()),s.save({...record(),local_key:'other',remote_name:'other',remote_id:'id-other'}),s.markReady({manifest_hash:'ready',updated_at:'now'})]);assert.equal(Object.keys((await s.read()).records).length,2);});
    assert.throws(()=>escaped.read(),/expired/);assert.throws(()=>escaped.markReady(undefined),/expired/);
    assert.equal(Object.keys((await store.withScope('scope',s=>s.read())).records).length,2);
  }}finally{await rm(dir,{recursive:true,force:true});}
});

test('PostgreSQL discards uncertain lock connections and preserves scoped session safety',async()=>{
  const {PostgresDefinitionStateStore}=await import('../dist/definition-state.js');
  for(const failure of ['acquire','unlock','unlock-false','none']){
    let released;let stored={records:{}};let escaped;
    const db={async query(sql,values){
      if(sql.includes('pg_advisory_lock')){if(failure==='acquire')throw new Error('lost acquisition response');return {rows:[],rowCount:1};}
      if(sql.includes('pg_advisory_unlock')){if(failure==='unlock')throw new Error('lost unlock response');return {rows:[{unlocked:failure!=='unlock-false'}],rowCount:1};}
      if(sql.startsWith('SELECT state'))return {rows:[{state:structuredClone(stored)}],rowCount:1};
      if(sql.startsWith('INSERT'))stored=JSON.parse(values[1]);return {rows:[],rowCount:1};
    },release(error){released=error??'healthy';}};
    const store=new PostgresDefinitionStateStore({async connect(){return db;}});
    const action=()=>store.withScope('scope',async s=>{escaped=s;await Promise.all([s.save(record()),s.markReady({manifest_hash:'hash',updated_at:'now'})]);});
    if(failure==='none'){await action();assert.equal(released,'healthy');assert.throws(()=>escaped.save(record()),/expired/);assert.equal(stored.ready.manifest_hash,'hash');assert.equal(stored.records['tool:echo'].remote_id,'id-echo');}
    else {await assert.rejects(action);assert.ok(released instanceof Error);}
  }
});
