// Run intentionally against your own non-production environment after configuring credentials.
import { EnvaiClient, isEvent } from '../src/index.js';
const client = new EnvaiClient({
  baseUrl: process.env.ENVAI_BASE_URL ?? 'http://localhost:8111/api/v1',
  apiKey: process.env.ENVAI_API_KEY,
});
// Select an existing team. This example does not create a fallback team.
const teamId = process.env.ENVAI_TEAM_ID;
if (!teamId) throw new Error('Set ENVAI_TEAM_ID to a team you own');
const workspace = await client.workspaces.create({ body: { name: 'SDK example' } });
const chat = await client.chats.create({ workspace_id: workspace.id, body: { team_id: teamId } });
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
for await (const event of client.sendAndStream(chat.id, { message: 'Hello!' }, { signal: controller.signal })) {
  if (isEvent(event, 'agent.text.delta') && event.agent?.role === 'orchestrator') process.stdout.write(event.data.delta);
}
// Local abort closes HTTP/SSE; cancelling the server turn is an explicit action:
// await client.chats.cancel({ chat_id: chat.id });
