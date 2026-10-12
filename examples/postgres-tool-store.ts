import type { ToolRecord, ToolState, ToolStateStore } from '../src/index.js';
/** Supply your own database connection and authorization. The SDK opens no database or filesystem. */
interface Database {
  query<T>(sql: string, values: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}
/** Create this table in a reviewed migration, not automatically:
 * CREATE TABLE envai_tool_state (key text PRIMARY KEY, record jsonb NOT NULL);
 * Apply account isolation, encryption/access control, backup and retention in your application.
 */
export class PostgresToolStateStore implements ToolStateStore {
  constructor(private readonly db: Database) {}
  async claim(key: string, initial: ToolRecord): Promise<boolean> {
    const result = await this.db.query('INSERT INTO envai_tool_state (key, record) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING RETURNING key', [key, JSON.stringify(initial)]);
    return result.rowCount === 1;
  }
  async get(key: string): Promise<ToolRecord | undefined> {
    const result = await this.db.query<{ record: ToolRecord }>('SELECT record FROM envai_tool_state WHERE key = $1', [key]);
    return result.rows[0]?.record;
  }
  async transition(key: string, expected: readonly ToolState[], patch: Partial<ToolRecord>): Promise<boolean> {
    const result = await this.db.query('UPDATE envai_tool_state SET record = record || $3::jsonb WHERE key = $1 AND record->>\'state\' = ANY($2::text[]) RETURNING key', [key, [...expected], JSON.stringify(patch)]);
    return result.rowCount === 1;
  }
}
