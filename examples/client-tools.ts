import { EnvaiClient, ClientToolRegistry, MemoryToolStateStore } from '../src/index.js';
const client = new EnvaiClient({ baseUrl: 'http://localhost:8111/api/v1', apiKey: process.env.ENVAI_API_KEY });
const registry = new ClientToolRegistry().register<{ text: string }>({
  name: 'echo', description: 'Return the supplied text', timeoutSeconds: 30,
  parameters: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'], additionalProperties: false },
  handler: async ({ text }, { signal }) => { signal.throwIfAborted(); return { text }; },
});
// Registration is intentional and explicit. Skip this step if the account tool already exists.
for (const definition of registry.definitions()) await client.tools.create({ body: definition });
// Your selected agent must also enable external_tools_enabled: [{ name: 'echo' }].
const chatId = process.env.ENVAI_CHAT_ID;
if (!chatId) throw new Error('Set ENVAI_CHAT_ID');
const runner = client.createToolRunner({
  scope: 'local-demo/account-identifier', registry,
  // This is explicitly process-local. Use a durable adapter for side-effecting production handlers.
  store: new MemoryToolStateStore(), concurrency: 2,
});
try {
  const result = await client.sendAndWait(chatId, { message: 'Use echo to return hello.' }, { toolRunner: runner, maxDurationMs: 120_000 });
  await runner.drain(); // Surface ambiguous tool delivery before treating the application workflow as done.
  console.log(result.text);
} finally { runner.close(); }
