// Run intentionally against your own non-production environment after configuring credentials.
import { EnvaiClient, isEvent } from '../src/index.js';
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`Set ${name}`); return value; }
const client = new EnvaiClient({
  baseUrl: required('ENVAI_BASE_URL'),
  apiKey: required('ENVAI_API_KEY'),
});
// Select an existing team. This example does not create a fallback team.
const teamId = process.env.ENVAI_TEAM_ID;
if (!teamId) throw new Error('Set ENVAI_TEAM_ID to a team you own');
const workspace = await client.workspaces.create({ body: { name: 'SDK example' } });
const chat = await client.chats.create({ workspace_id: workspace.id, body: { team_id: teamId } });
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
for await (const event of client.sendAndStream(chat.id, { message: 'Hello!' }, { signal: controller.signal, maxDurationMs: 120_000 })) {
  if (isEvent(event, 'agent.text.delta') && event.agent?.role === 'orchestrator') process.stdout.write(event.data.delta);
  if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled') {
    console.log('\nterminal:', event.type);
    if (event.type !== 'turn.completed') throw new Error(`Turn ended with ${event.type}`);
  }
}
// Local abort closes HTTP/SSE; cancelling the server turn is an explicit action:
// await client.chats.cancel({ chat_id: chat.id });
