import { EnvaiClient, uploadSourceFile, waitForSource, waitForWikiOperation } from '../src/index.js';

export async function indexDocument(client: EnvaiClient, workspaceId: string, localPath: string,
  uploadKey: string, operationKey: string, webhookUrl: string, signal?: AbortSignal) {
  const source = await uploadSourceFile(client, workspaceId, localPath, uploadKey, { signal });
  const ready = await waitForSource(client, workspaceId, source.file_id, { signal });
  if (ready.conversion.status !== 'completed' || ready.lifecycle !== 'inbox') return { source: ready, operation: null };
  const accepted = await client.wiki.inbox({ workspace_id: workspaceId, idempotencyKey: operationKey, body: { webhook_url: webhookUrl } }, { signal });
  return { source: ready, operation: await waitForWikiOperation(client, workspaceId, accepted.operation_id, { signal }) };
}
