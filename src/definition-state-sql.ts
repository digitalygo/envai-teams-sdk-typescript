import { randomUUID } from 'node:crypto';
import {
  assertDefinitionState, definitionRecordKey,
  type DefinitionDatabasePool, type DefinitionDatabaseConnection,
  type DefinitionState, type DefinitionStateSession, type DefinitionStateStore,
} from './definition-state.js';

export type DefinitionSQLDialect = 'sqlite' | 'mysql';
/** Explicit migration statements: stores never execute DDL automatically. */
export function definitionSQLSchema(dialect: DefinitionSQLDialect): readonly string[] {
  if (dialect === 'sqlite') return [
    'CREATE TABLE envai_definition_state (scope TEXT PRIMARY KEY, state TEXT NOT NULL)',
    'CREATE TABLE envai_definition_locks (scope TEXT PRIMARY KEY, owner TEXT NOT NULL)',
  ];
  if (dialect === 'mysql') return [
    'CREATE TABLE envai_definition_state (scope VARBINARY(191) PRIMARY KEY, state LONGTEXT NOT NULL) ENGINE=InnoDB',
    'CREATE TABLE envai_definition_locks (scope VARBINARY(191) PRIMARY KEY, owner VARCHAR(64) NOT NULL) ENGINE=InnoDB',
  ];
  throw new TypeError('Definitions SQL dialect must be sqlite or mysql');
}

export interface DefinitionSQLStoreOptions { lockTimeoutMs?: number; pollIntervalMs?: number }
/**
 * Portable SQLite/MySQL store using a caller-owned driver adapter. A query must
 * return rows for SELECT and rowCount for writes. Connections must use autocommit
 * outside the explicit BEGIN/COMMIT checkpoint transactions below. Do not share
 * a checked-out connection with unrelated work.
 *
 * Committed lock rows have random owner tokens and no automatic takeover. A
 * crashed holder stays fail-closed until an operator investigates remote effects
 * and removes that exact abandoned scope/owner row. Earlier successful mutation
 * checkpoints survive later failures; there is no fictitious remote rollback.
 */
export class SQLDefinitionStateStore implements DefinitionStateStore {
  private readonly lockTimeoutMs: number;
  private readonly pollIntervalMs: number;
  constructor(private readonly pool: DefinitionDatabasePool, readonly dialect: DefinitionSQLDialect, options: DefinitionSQLStoreOptions = {}) {
    definitionSQLSchema(dialect);
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 10;
    if (!Number.isFinite(this.lockTimeoutMs) || this.lockTimeoutMs < 0 || !Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs <= 0) throw new TypeError('Invalid definition SQL lock timing');
  }
  async withScope<T>(scope: string, action: (session: DefinitionStateSession) => Promise<T>): Promise<T> {
    if (!scope || Buffer.byteLength(scope, 'utf8') > 191) throw new TypeError('Definition scope must contain 1..191 UTF-8 bytes');
    const db = await this.pool.connect();
    const owner = randomUUID();
    let locked = false;
    let active = true;
    let queue: Promise<void> = Promise.resolve();
    let pendingError: unknown;
    let failed = false;
    const assertActive = () => { if (!active) throw new Error('Definition state session has expired'); };
    try {
      if(this.dialect==='mysql') {
        const columns=await db.query<{table_name:string;data_type:string}>("SELECT TABLE_NAME AS table_name, DATA_TYPE AS data_type FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('envai_definition_state','envai_definition_locks') AND COLUMN_NAME='scope'");
        if(columns.rows.length!==2 || columns.rows.some(column=>column.data_type!=='varbinary')) throw new Error('Definitions MySQL scope columns require VARBINARY; apply an explicit schema migration before use');
      }
      const deadline = Date.now() + this.lockTimeoutMs;
      for (;;) {
        try { await db.query('INSERT INTO envai_definition_locks(scope,owner) VALUES (?,?)', [scope, owner]); locked = true; break; }
        catch (error) {
          const held = await db.query<{owner: string}>('SELECT owner FROM envai_definition_locks WHERE scope = ?', [scope]);
          if (held.rows.length !== 1) throw error; // Missing schema/permission/unknown failure is not contention.
          if (Date.now() >= deadline) throw new Error('Definition state lock unavailable; inspect crash ownership before recovery', { cause: error });
          await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
        }
      }
      const read = async (): Promise<DefinitionState> => {
        assertActive();
        const result = await db.query<{state: unknown}>('SELECT state FROM envai_definition_state WHERE scope = ?', [scope]);
        if (result.rows.length > 1) throw new Error('Duplicate definition scope');
        const encoded = result.rows[0]?.state;
        const state: unknown = result.rows.length ? (typeof encoded === 'string' ? JSON.parse(encoded) : encoded) : { records: {} };
        assertDefinitionState(state);
        return structuredClone(state);
      };
      const mutate = (change: (state: DefinitionState) => void): Promise<void> => {
        assertActive();
        const work = queue.then(async () => {
          assertActive();
          if(failed) throw pendingError;
          await db.query(this.dialect === 'sqlite' ? 'BEGIN IMMEDIATE' : 'START TRANSACTION');
          try {
            const held = await db.query<{owner: string}>(`SELECT owner FROM envai_definition_locks WHERE scope = ?${this.dialect === 'mysql' ? ' FOR UPDATE' : ''}`, [scope]);
            if (held.rows.length !== 1 || held.rows[0]!.owner !== owner) throw new Error('Definition lock ownership changed');
            const state = await read(); change(state); assertDefinitionState(state);
            const update = this.dialect === 'sqlite'
              ? 'INSERT INTO envai_definition_state(scope,state) VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET state=excluded.state'
              : 'INSERT INTO envai_definition_state(scope,state) VALUES (?,?) ON DUPLICATE KEY UPDATE state=VALUES(state)';
            await db.query(update, [scope, JSON.stringify(state)]);
            await db.query('COMMIT');
          } catch (error) { await db.query('ROLLBACK'); throw error; }
        });
        queue = work.catch(error => { if (!failed) { failed = true; pendingError = error; } });
        return work;
      };
      const session: DefinitionStateSession = {
        read: () => { assertActive();const work=queue.then(read);queue=work.then(()=>{}).catch(error=>{failed=true;pendingError=error;});return work; },
        save: record => mutate(state => { Object.defineProperty(state.records, definitionRecordKey(record.type, record.local_key), { value: structuredClone(record), enumerable: true, configurable: true, writable: true }); }),
        delete: (type, key) => mutate(state => { delete state.records[definitionRecordKey(type, key)]; }),
        markReady: ready => mutate(state => { if (ready) state.ready = structuredClone(ready); else delete state.ready; }),
      };
      const result = await action(session);
      await queue;
      if (failed) throw pendingError;
      return result;
    } finally {
      await queue;
      active = false;
      try { if (locked) await db.query('DELETE FROM envai_definition_locks WHERE scope = ? AND owner = ?', [scope, owner]); }
      finally { db.release(); }
    }
  }
}
export class SQLiteDefinitionStateStore extends SQLDefinitionStateStore {
  constructor(pool: DefinitionDatabasePool, options?: DefinitionSQLStoreOptions) { super(pool, 'sqlite', options); }
}
export class MySQLDefinitionStateStore extends SQLDefinitionStateStore {
  constructor(pool: DefinitionDatabasePool, options?: DefinitionSQLStoreOptions) { super(pool, 'mysql', options); }
}

/** Adapter for Node's caller-owned DatabaseSync (node:sqlite). No database is
 * opened, closed or migrated here; use a distinct connection per withScope. */
export function sqliteDefinitionConnection(database: {
  prepare(sql: string): { all(...values: unknown[]): unknown[]; run(...values: unknown[]): { changes: number | bigint } };
}, release: () => void): DefinitionDatabaseConnection {
  return {
    async query<T>(sql: string, values: unknown[] = []) {
      const statement = database.prepare(sql);
      if (/^\s*SELECT\b/i.test(sql)) return { rows: statement.all(...values) as T[], rowCount: null };
      return { rows: [] as T[], rowCount: Number(statement.run(...values).changes) };
    },
    release,
  };
}
/** Adapter for a caller-owned mysql2/promise-style checked-out connection. */
export function mysqlDefinitionConnection(connection: {
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
  release(): void;
}): DefinitionDatabaseConnection {
  return {
    async query<T>(sql: string, values: unknown[] = []) {
      const [result] = await connection.query(sql, values);
      if (Array.isArray(result)) return { rows: result as T[], rowCount: result.length };
      return { rows: [] as T[], rowCount: Number((result as {affectedRows?: number}).affectedRows ?? 0) };
    },
    release: () => connection.release(),
  };
}
