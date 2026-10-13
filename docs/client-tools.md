# Signed client tools

[README](../README.md) · [Configuration](getting-started.md) · [API reference](api-reference.md) · [Streaming](streaming.md) · [Client tools](client-tools.md)

## Signed client tools

Nothing is executed unless the application explicitly installs a local handler and supplies a state store. No filesystem tools, shell handlers, account discovery, or automatic registry synchronization are installed.

```ts
import { ClientToolRegistry, MemoryToolStateStore } from '@digitalygo/envai-client';
const registry = new ClientToolRegistry().register<{ text: string }>({
  name: 'echo',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  timeoutSeconds: 30,
  handler: async ({ text }, { signal, idempotencyKey }) => {
    signal.throwIfAborted();
    return { text }; // Use idempotencyKey with your own side-effecting service.
  },
});
const runner = client.createToolRunner({
  scope: 'deployment/account-id',
  registry,
  store: new MemoryToolStateStore(), // Explicitly NOT durable: examples/tests only.
});
try {
  const result = await client.sendAndWait(chat.id, { message: 'Use echo' }, { toolRunner: runner });
  await runner.drain();
} finally { runner.close(); }
```

Register account tools deliberately with `client.tools.create({ body: definition })` using `registry.definitions()`. The selected agent must also contain `external_tools_enabled: [{ name: 'echo' }]`. Registration alone does not enable a tool for an agent.

Before invoking a handler, the runner owns a deep event snapshot, validates the event, verifies Ed25519 over `call_id + "\n" + tool_name + "\n" + RFC8785(args)`, validates local arguments, and atomically claims the call in the state store. RFC 8785 includes nested UTF-16 key ordering, ECMAScript number formatting, and rejection of non-finite values, cycles, non-JSON objects, and lone surrogates. JWKS is fetched from the origin-level `/.well-known/jwks.json`, without bearer authentication. Override `jwksUrl` or supply a `JwksSource` if needed. The public-key cache defaults to five minutes and refreshes once for an unknown key or failed verification.

Handlers receive an `AbortSignal` and a stable idempotency key. Concurrency defaults to four actual running handlers and pending admission to 64 calls. The local deadline is 90% of the declared tool timeout, including signature and queue delays, because the server's deadline started earlier. A non-cooperative timed-out handler retains its slot until it settles, so actual concurrency never silently exceeds the bound. JavaScript cannot forcibly undo or terminate an external side effect. Supply a signal to `drain` to bound waiting on non-cooperative handlers.

Local tool schemas default to JSON Schema 2020-12. Explicit `$schema` declarations support drafts 6, 7, 2019-09 and 2020-12 using their standard meta-schema URIs; unsupported dialects fail registration. Each dialect uses the appropriate Ajv compiler, including draft-7 `dependencies`/tuple `items` and modern `dependentRequired`/`prefixItems`. Nested `const` and `enum` objects remain literal JSON values. Registration does no network I/O.

Unknown tools, invalid arguments, handler errors, empty output, and oversized output generate controlled errors. Structured output is JSON-serialized once; the 128 KiB bound is measured in UTF-8 bytes. Empty string output is rejected by the current API despite the schema omitting `minLength`, so the runner converts it to `empty_output`.

### Durable state and reconciliation

`ToolStateStore` is intentionally mandatory. For production side effects, implement atomic, durable `claim`, `get`, and conditional `transition` operations across all application processes. Use a stable, non-secret deployment/account `scope`. The [Postgres adapter example](../examples/postgres-tool-store.ts) accepts a caller-owned database connection; table creation and credentials are never automatic.

The state machine is `claimed → completed → submitted → resolved`, with `ambiguous` and `abandoned` branches. A matching server result creates a durable resolved tombstone even if its request was never seen. Terminal events create durable per-turn admission barriers, including when signature verification or storage operations are still in flight. Claims precede handler effects; all existing calls are skipped on replay. Store failures fail closed. `get` must return `undefined` only for an absent key; malformed JSON, JSON `null`, invalid shapes/states, mismatched call/turn identities, and invalid saved output must raise an error without overwriting the stored record. The runner validates every record it reads and reports `invalid_tool_state` for corrupt values. Adapters must use `assertToolRecord` and atomically preserve valid identity during mutations. The PostgreSQL example validates the complete row, rejects duplicate-row reads from an incorrectly restored table, and uses a compare-and-swap update, so a concurrent change cannot be overwritten. A failed transition to `completed`, including a missing claim after the handler returns, prevents output submission. Protect database permissions and backups; validation cannot make an attacker-controlled store trustworthy.

Never expire, steal, delete, or re-execute a claim automatically. A crash between an external side effect and saving its result is inherently ambiguous. Reconcile using your own transactional/idempotent downstream operation. Persisted output may contain sensitive information: protect the store appropriately. The SDK never persists API keys, arguments, or signature material in the state store.

There is no automatic tool-output resubmission. A dropped response, `409 tool_already_resolved`, `409 tool_timed_out`, or `404` after turn cleanup is not proof of successful delivery. The record remains ambiguous until the corresponding `agent.tool.result` is observed or your application reconciles it. `drain()` exposes job failures through an `AggregateError`. Feed server result and terminal events to the same runner, even if you do not want to execute requests from that stream. A signature authenticates the call ID, tool name, and canonical arguments. It does not sign the chat, turn, account, timestamp, or freshness. Only feed trusted authenticated stream events to the runner; never treat arbitrary historical requests as fresh work.


## Application authorization and sandboxing

Handlers run as ordinary Node.js code with the process’s privileges. The SDK does not sandbox handlers, create a database, or install filesystem/shell tools. A valid signature does not grant permission for every side effect. Enforce account/resource authorization and least privilege in the handler. For file or command tools, allowlist paths and operations, defend against symlink/path traversal, use explicit argument arrays rather than shell interpolation, bound output, and use OS isolation. Check the signal before effects and propagate it to downstream work. Never put credentials into output.

## Running the example

The [echo example](../examples/client-tools.ts) reads `ENVAI_BASE_URL`, `ENVAI_API_KEY`, `ENVAI_CHAT_ID`, and `ENVAI_ACCOUNT_SCOPE`. It uses an in-memory store for a harmless echo handler. Set `ENVAI_REGISTER_TOOLS=1` only when deliberately creating the account tool for the first time; this is a remote mutation and not an upsert. Enable `echo` on the intended agent separately. Run examples using the compile commands in [getting started](getting-started.md#run-the-examples).
