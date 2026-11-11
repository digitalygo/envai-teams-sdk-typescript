/** Explicit provisioning/configuration example; importing performs no I/O. */
import { DatabaseSync } from 'node:sqlite';
import type { Pool } from 'mysql2/promise';
import {
  SQLiteDefinitionStateStore, MySQLDefinitionStateStore,
  sqliteDefinitionConnection, mysqlDefinitionConnection,
} from '../src/definition-state-sql.js';

export function sqliteStore(path: string): SQLiteDefinitionStateStore {
  return new SQLiteDefinitionStateStore({
    async connect() {
      const database = new DatabaseSync(path);
      return sqliteDefinitionConnection(database, () => database.close());
    },
  });
}
export function mysqlStore(pool: Pool): MySQLDefinitionStateStore {
  return new MySQLDefinitionStateStore({
    async connect() { return mysqlDefinitionConnection(await pool.getConnection()); },
  });
}
