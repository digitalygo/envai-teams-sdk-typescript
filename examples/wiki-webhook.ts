import { EnvaiClient, PostgresWikiWebhookInbox, type WikiPostgresPool, type WikiWebhookRequest } from '../src/index.js';

/** Framework-neutral HTTP handler core. Pass exact raw bytes before JSON/body-parser middleware. */
export function wikiWebhookHandler(client: EnvaiClient, pool: WikiPostgresPool, workspaceId: string, connectionScope: string) {
  const inbox = new PostgresWikiWebhookInbox(pool, client.createWikiWebhookVerifier(workspaceId));
  return async (request: WikiWebhookRequest): Promise<number> => {
    // Let verification/storage failures become a non-2xx response in your framework.
    const outcome = await inbox.receive(request, connectionScope);
    return outcome === 'collision' ? 409 : 204;
  };
}
