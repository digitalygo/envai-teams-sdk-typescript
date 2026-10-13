import { EnvaiClient, ClientToolRegistry, MemoryToolStateStore } from '../src/index.js';
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`Set ${name}`); return value; }
const client = new EnvaiClient({ baseUrl: required('ENVAI_BASE_URL'), apiKey: required('ENVAI_API_KEY') });
const registry = new ClientToolRegistry().register<{ text: string }>({
  name: 'echo', description: 'Return the supplied text', timeoutSeconds: 30,
  parameters: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'], additionalProperties: false },
  handler: async ({ text }, { signal }) => { signal.throwIfAborted(); return { text }; },
});
// Registration is intentional and explicit. Skip this step if the account tool already exists.
if (process.env.ENVAI_REGISTER_TOOLS === '1') {
  for (const definition of registry.definitions()) await client.tools.create({ body: definition });
}
// Your selected agent must also enable external_tools_enabled: [{ name: 'echo' }].
const chatId = process.env.ENVAI_CHAT_ID;
if (!chatId) throw new Error('Set ENVAI_CHAT_ID');
const runner = client.createToolRunner({
  scope: required('ENVAI_ACCOUNT_SCOPE'), registry,
  // This is explicitly process-local. Use a durable adapter for side-effecting production handlers.
  store: new MemoryToolStateStore(), concurrency: 2,
});
try {
  const result = await client.sendAndWait(chatId, { message: 'Use echo to return hello.' }, { toolRunner: runner, maxDurationMs: 120_000 });
  await runner.drain(); // Surface ambiguous tool delivery before treating the application workflow as done.
  console.log(result.text, result.terminal.type);
  if (result.terminal.type !== 'turn.completed') throw new Error(`Turn ended with ${result.terminal.type}`);
} finally { runner.close(); }
