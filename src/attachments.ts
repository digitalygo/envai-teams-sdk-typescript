import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import type { EnvaiClient } from './client.js';
import { delay, positive, type RequestOptions } from './http.js';
import type { ChatAttachment } from './generated.js';

export async function uploadAttachmentFile(client: EnvaiClient, workspaceId: string, chatId: string, path: string, idempotencyKey: string,
  options: RequestOptions & { filename?: string; mimeType?: string } = {}): Promise<ChatAttachment> {
  options.signal?.throwIfAborted();
  const blob = await openAsBlob(path, { type: options.mimeType });
  const file = new File([blob], options.filename ?? basename(path), { type: blob.type });
  return client.uploadChatAttachment({ workspace_id: workspaceId, chat_id: chatId, idempotencyKey, body: { file } }, options);
}
export async function waitForAttachment(client: EnvaiClient, workspaceId: string, chatId: string, attachmentId: string,
  options: RequestOptions & { intervalMs?: number; timeoutMs?: number } = {}): Promise<ChatAttachment> {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const interval = positive(options.intervalMs ?? 1_000, 'intervalMs');
  const timer = setTimeout(() => controller.abort(new DOMException('Attachment polling timed out', 'TimeoutError')), positive(options.timeoutMs ?? 600_000, 'timeoutMs'));
  try {
    for (;;) {
      signal.throwIfAborted();
      const value = await client.getChatAttachment({ workspace_id: workspaceId, chat_id: chatId, attachment_id: attachmentId }, { ...options, signal });
      if (value.conversion.status === 'completed' || value.conversion.status === 'failed' && !value.conversion.recoverable || value.conversion.status === 'not_required' && value.lifecycle === 'ready' || value.lifecycle === 'deleted' || value.lifecycle === 'deleting') return value;
      await delay(interval, signal);
    }
  } finally { clearTimeout(timer); }
}
