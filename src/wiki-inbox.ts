import { createHash } from 'node:crypto';
import type { WikiWebhookVerifier, WikiWebhookRequest } from './wiki-webhooks.js';

export interface WikiPostgresConnection {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
  release(error?: Error | boolean): void;
}
/** A pool must supply a fresh, idle PostgreSQL connection exclusively owned until release(). Compatible with pg.Pool. */
export interface WikiPostgresPool { connect(): Promise<WikiPostgresConnection>; }
export type WikiReceiptOutcome = 'accepted' | 'duplicate' | 'collision';
/** PostgreSQL-only, durable atomic receipt + application outbox enqueue. No network/application effects run inside the transaction. */
export class PostgresWikiWebhookInbox {
  constructor(readonly pool: WikiPostgresPool, readonly verifier: WikiWebhookVerifier) {}
  async receive(request: WikiWebhookRequest, connectionScope: string, signal?: AbortSignal): Promise<WikiReceiptOutcome> {
    if (!connectionScope || /[\x00-\x1f\x7f]/.test(connectionScope)) throw new TypeError('A stable connection scope is required');
    const verified = await this.verifier.verify(request, signal);
    const event = verified.event;
    const identity = createHash('sha256').update(connectionScope + '\0' + event.workspace_id + '\0' + event.event_id).digest('hex');
    signal?.throwIfAborted();
    const database = await this.pool.connect();
    let broken = false;
    try {
      await database.query('BEGIN');
      const inserted = await database.query('INSERT INTO envai_wiki_webhook_receipts (deduplication_key, connection_scope, workspace_id, event_id, payload_hash) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING deduplication_key', [identity, connectionScope, event.workspace_id, event.event_id, verified.payloadHash]);
      if (inserted.rowCount !== 0 && inserted.rowCount !== 1) throw new Error('Invalid wiki receipt insert count');
      const stored = await database.query('SELECT payload_hash FROM envai_wiki_webhook_receipts WHERE deduplication_key = $1 FOR UPDATE', [identity]);
      if (stored.rows.length !== 1 || typeof stored.rows[0]?.payload_hash !== 'string') throw new Error('Wiki receipt was not readable');
      if (stored.rows[0].payload_hash !== verified.payloadHash) { await database.query('ROLLBACK'); return 'collision'; }
      if (inserted.rowCount === 1) {
        const work = await database.query('INSERT INTO envai_wiki_application_outbox (deduplication_key, event_type, payload, raw_body) VALUES ($1, $2, $3::jsonb, $4)', [identity, event.event_type, JSON.stringify(event), Buffer.from(verified.rawBody)]);
        if (work.rowCount !== 1) throw new Error('Wiki application work was not inserted');
      }
      signal?.throwIfAborted();
      await database.query('COMMIT'); // Only after this succeeds may an HTTP handler acknowledge 2xx.
      return inserted.rowCount === 1 ? 'accepted' : 'duplicate';
    } catch (error) {
      try { await database.query('ROLLBACK'); } catch { broken = true; }
      throw error;
    } finally { database.release(broken); }
  }
}
