import { assertToolRecord, ToolExecutionError, type ToolRecord, type ToolState, type ToolStateStore } from '../src/index.js';
/** Supply your own database connection and authorization. The SDK opens no database or filesystem. */
interface Database {
  query<T>(sql: string, values: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}
/** Create this table in a reviewed migration, not automatically:
 * CREATE TABLE envai_tool_state (key text PRIMARY KEY, record jsonb NOT NULL);
 * Apply account isolation, encryption/access control, backup and retention in your application.
 * SQL NOT NULL does not exclude JSON null. Every existing row must be validated, not reclaimed.
 */
export class PostgresToolStateStore implements ToolStateStore {
  constructor(private readonly db: Database) {}
  async claim(key: string, initial: ToolRecord): Promise<boolean> {
    assertToolRecord(key, initial);
    if (await this.get(key) !== undefined) return false;
    const result = await this.db.query('INSERT INTO envai_tool_state (key, record) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING RETURNING key', [key, JSON.stringify(initial)]);
    if (result.rowCount === 1) return true;
    // A concurrent claim won. Check that it is a valid barrier, without overwriting it.
    await this.get(key);
    return false;
  }
  async get(key: string): Promise<ToolRecord | undefined> {
    const result = await this.db.query<{ record: unknown }>('SELECT record FROM envai_tool_state WHERE key = $1', [key]);
    if (result.rows.length === 0) return undefined;
    const value = result.rows[0]!.record;
    assertToolRecord(key, value);
    return value;
  }
  async transition(key: string, expected: readonly ToolState[], patch: Partial<ToolRecord>): Promise<boolean> {
    const current = await this.get(key);
    if (current === undefined || !expected.includes(current.state)) return false;
    const next = { ...current, ...patch };
    assertToolRecord(key, next, current.turnId);
    if (next.fingerprint !== current.fingerprint) throw new ToolExecutionError('Cannot change tool call identity', 'invalid_tool_state');
    // Compare the complete validated JSON in the atomic UPDATE. A racing writer makes this a no-op.
    const result = await this.db.query('UPDATE envai_tool_state SET record = $2::jsonb WHERE key = $1 AND record = $3::jsonb RETURNING key', [key, JSON.stringify(next), JSON.stringify(current)]);
    return result.rowCount === 1;
  }
}
