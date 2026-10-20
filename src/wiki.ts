import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import type { EnvaiClient } from './client.js';
import { delay, positive, sourceProcessing, type RequestOptions, type SourceProcessing } from './http.js';
import type { WikiOperation, WikiSource } from './generated.js';

/** Node 22+ filesystem-backed multipart. Keep the file unchanged for this request and any deliberate idempotent replay. */
export async function uploadSourceFile(client: EnvaiClient, workspaceId: string, path: string, idempotencyKey: string,
  options: RequestOptions & { filename?: string; mimeType?: string; processing?: SourceProcessing } = {}): Promise<WikiSource> {
  options.signal?.throwIfAborted();
  const processing = sourceProcessing(options.processing);
  const blob = await openAsBlob(path, { type: options.mimeType });
  const file = new File([blob], options.filename ?? basename(path), { type: blob.type });
  return client.uploadWikiSource({ workspace_id: workspaceId, idempotencyKey, body: processing === 'original' ? { processing, file } : { file } }, options);
}
export interface WikiPollOptions extends RequestOptions { intervalMs?: number; timeoutMs?: number; }
/** Conversion is independent of indexing: a completed conversion enters the inbox and does not start a run. */
export async function waitForSource(client: EnvaiClient, workspaceId: string, fileId: string, options: WikiPollOptions = {}): Promise<WikiSource> {
  return poll(signal => client.getWikiSource({ workspace_id: workspaceId, file_id: fileId }, { ...options, signal }), value =>
    value.conversion.status === 'completed' || value.conversion.status === 'not_required' && (value.lifecycle === 'inbox' || value.lifecycle === 'raw') || value.conversion.status === 'failed' && !value.conversion.recoverable || value.lifecycle === 'deleted' || value.lifecycle === 'deleting' || value.lifecycle === 'outbox', options);
}
export async function waitForWikiOperation(client: EnvaiClient, workspaceId: string, operationId: string, options: WikiPollOptions = {}): Promise<WikiOperation> {
  return poll(signal => client.getWikiOperation({ workspace_id: workspaceId, operation_id: operationId }, { ...options, signal }), value => value.status === 'completed' || value.status === 'failed', options);
}
async function poll<T>(read: (signal: AbortSignal) => Promise<T>, done: (value: T) => boolean, options: WikiPollOptions): Promise<T> {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const interval = positive(options.intervalMs ?? 1_000, 'intervalMs');
  const timer = setTimeout(() => controller.abort(new DOMException('Wiki polling timed out', 'TimeoutError')), positive(options.timeoutMs ?? 300_000, 'timeoutMs'));
  try {
    for (;;) {
      signal.throwIfAborted();
      const result = await read(signal);
      if (done(result)) return result;
      await delay(interval, signal);
    }
  } finally { clearTimeout(timer); }
}
