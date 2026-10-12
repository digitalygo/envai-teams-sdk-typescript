# Envai Teams TypeScript SDK

A Node.js 22+ ESM client for the current Envai Teams **alpha** API. It includes typed primitives for all **52 HTTP operations**, all **28 ATP v2 event types**, async SSE streams, turn helpers, and opt-in signed client tools.

**Status:** initial alpha implementation; package publication, deployment, and production API calls are outside this change. This SDK does not remove the server limitations described below.

## Install and verify from source

```sh
npm ci --ignore-scripts
npm run check
npm run check:package
```

The package name is `@digitalygo/envai-client`. No registry release is assumed. After building, a local `npm pack` archive can be installed into an application. This is a Node-only ESM package; it does not claim browser or CommonJS compatibility.

## Quick start

```ts
import { EnvaiClient } from '@digitalygo/envai-client';

const client = new EnvaiClient({
  baseUrl: 'http://localhost:8111/api/v1',
  apiKey: process.env.ENVAI_API_KEY,
});

// These calls create real resources when you run them.
const workspace = await client.workspaces.create({ body: { name: 'Research' } });
const chat = await client.chats.create({
  workspace_id: workspace.id,
  body: { team_id: 'team_YOUR_EXISTING_TEAM_ID' },
});
const result = await client.sendAndWait(chat.id, { message: 'Hello!' });
console.log(result.text, result.terminal.type, result.lastSeq);
```

Provide your own credentials and existing team ID. The constructor reads no environment variables and makes no network calls. A base URL containing only an origin gets `/api/v1`; an explicit path is treated as the complete API prefix. Trailing slashes are removed. Use the edge URL for the combined API, not the execution-plane-only gateway on port 8081.

See [typed quickstart](examples/quickstart.ts), [client tools](examples/client-tools.ts), and the [durable-store adapter example](examples/postgres-tool-store.ts). Examples are typechecked. The PostgreSQL adapter is also exercised with an in-memory SQL test double; tests and CI never connect to a database.

## API and generated types

Every OpenAPI `operationId` is a public method, for example `client.sendChatMessage({ chat_id, body: { message } })`. Service aliases provide `workspaces`, `tools`, `chats`, `completions`, `workspaceFiles`, `agents`, `teams`, `apiKeys`, `models`, `images`, and `capabilities`.

- Request fields preserve the contract's snake_case names; runtime options use camelCase.
- Path/query parameters are fields of the parameter object. JSON and multipart input go under `body`.
- Resource and non-paginated collection `{ data: ... }` wrappers are unwrapped. Paginated completion results retain `data`, `links`, and `meta`; model catalogs retain their dedicated envelopes.
- `204` responses return `undefined`. Binary downloads and the low-level `streamChatEvents`/`chats.eventsResponse` return a `Response`, allowing streaming via `response.body` without buffering the whole file.
- Image uploads accept `{ body: { file: new Blob([...], { type: 'image/png' }) } }`. Fetch generates the multipart boundary.
- Optional provider webhook signature headers go in `RequestOptions.headers`. The webhook primitive is exposed for complete contract coverage; the SDK never calls it automatically.
- `downloadArtifact` takes current signed `artifact`, `generation`, optional `expires`, and `signature` query fields, in Laravel's canonical alphabetical order, without a bearer token. It does not accept the historical `path` parameter. Do not log signed URLs.
- API-key creation preserves omitted `expires_at` (server default) versus explicit `"never"`.
- Completion `page` is absent from the pinned request contract, although the response is paginated. This SDK preserves the declared parameters and metadata; it does not invent an automatic page traversal API.

[Complete operation inventory](docs/api-inventory.md) and generated `*Params`/`*Result` types document the full surface. Authentication headers and host overrides cannot be supplied through per-call headers.

## Streaming and turns

```ts
import { isEvent } from '@digitalygo/envai-client';
const abort = new AbortController();
for await (const event of client.sendAndStream(chat.id, { message: 'Explain it' }, {
  signal: abort.signal,
  maxDurationMs: 120_000,
})) {
  if (isEvent(event, 'agent.text.delta') && event.agent?.role === 'orchestrator') {
    process.stdout.write(event.data.delta);
  }
}
```

`sendAndStream` opens the SSE reader and waits for the first `ping` before it sends the message. HTTP 200 alone is not proof of a registered live subscription on alpha. Readiness has a 30-second default timeout. Message submission is never automatically retried.

`sendAndWait` returns orchestrator-only text, the terminal event, usage, server cost, chat/turn IDs, and the terminal sequence. `agent.text.done` replaces accumulated orchestrator deltas. Subagent and reasoning content is excluded. A failed or cancelled turn returns its typed terminal event so callers must inspect `terminal.type`.

Low-level use is separate:

```ts
const stream = client.events(chat.id, {
  after: savedSeq,
  resume: 'same-runtime', // Required for nonzero cursors; see limitations below.
  maxReconnects: 5,
  maxDurationMs: 120_000,
});
for await (const event of stream) {
  // Validate/process and commit your own durable checkpoint here.
}
```

A stream permits one consumer. Break iteration or call `stream.close()` for deterministic cleanup. The stream's diagnostic `lastSeq` advances when the consumer requests the next item, after delivery of the preceding item; it may lag the last yielded event if you break. Save `event.seq` only after your application successfully processes it. `ping` uses sequence zero and never advances the cursor.

The parser supports fragmented UTF-8, BOM, CR/LF/CRLF, multi-line data, comments, and unknown SSE fields. It validates full ATP envelopes and known payloads against the pinned JSON Schema. Unknown additive event types remain accessible with `known: false`; use `isEvent` for typed narrowing. Unsupported versions, malformed known payloads, wrong-chat events, inconsistent turn IDs, and unsafe sequence integers fail closed. `ProtocolError.raw` is diagnostic data and can contain private content; do not log it indiscriminately.

Duplicate sequence numbers are suppressed. An observable live gap triggers one replay recovery attempt from the delivered cursor; a repeated gap raises `ReplayGapError`. Stream retries are bounded (five reconnects by default), jittered, cancellable, and observable. Fatal protocol/authentication errors stop immediately. The default idle timeout is 45 seconds; connection timeout is 15 seconds; `maxDurationMs` is optional. Low-level `chats.cancel` asks the server to cancel a turn; only `turn.cancelled` confirms completion. Local `AbortSignal` cancellation closes this client's work and does **not** implicitly cancel a server turn.

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

Unknown tools, invalid arguments, handler errors, empty output, and oversized output generate controlled errors. Structured output is JSON-serialized once; the 128 KiB bound is measured in UTF-8 bytes. Empty string output is rejected by the current gateway despite the schema omitting `minLength`, so the runner converts it to `empty_output`.

### Durable state and reconciliation

`ToolStateStore` is intentionally mandatory. For production side effects, implement atomic, durable `claim`, `get`, and conditional `transition` operations across all application processes. Use a stable, non-secret deployment/account `scope`. The [Postgres adapter example](examples/postgres-tool-store.ts) accepts a caller-owned database connection; table creation and credentials are never automatic.

The state machine is `claimed → completed → submitted → resolved`, with `ambiguous` and `abandoned` branches. A matching server result creates a durable resolved tombstone even if its request was never seen. Terminal events create durable per-turn admission barriers, including when signature verification or storage operations are still in flight. Claims precede handler effects; all existing calls are skipped on replay. Store failures fail closed. `get` must return `undefined` only for an absent key; malformed JSON, JSON `null`, invalid shapes/states, mismatched call/turn identities, and invalid saved output must raise an error without overwriting the stored record. The runner validates every record it reads and reports `invalid_tool_state` for corrupt values. Adapters must use `assertToolRecord` and atomically preserve valid identity during mutations. The PostgreSQL example validates the complete row, rejects duplicate-row reads from an incorrectly restored table, and uses a compare-and-swap update, so a concurrent change cannot be overwritten. A failed transition to `completed`, including a missing claim after the handler returns, prevents output submission. These checks address pre-existing local storage corruption, not a remotely exploitable storage-write path.

Never expire, steal, delete, or re-execute a claim automatically. A crash between an external side effect and saving its result is inherently ambiguous. Reconcile using your own transactional/idempotent downstream operation. Persisted output may contain sensitive information: protect the store appropriately. The SDK never persists API keys, arguments, or signature material in the state store.

There is no automatic tool-output resubmission. A dropped response, `409 tool_already_resolved`, `409 tool_timed_out`, or `404` after turn cleanup is not proof of successful delivery. The record remains ambiguous until the corresponding `agent.tool.result` is observed or your application reconciles it. `drain()` exposes job failures through an `AggregateError`. Feed server result and terminal events to the same runner, even if you do not want to execute requests from that stream. A signature establishes origin and integrity, not freshness; callers must not replay arbitrary historical requests as fresh work.

## Transport, errors, and observation

Provide `fetch` for a custom transport or mock. The normal request timeout defaults to 30 seconds. JSON bodies are decoded within this timeout; raw binary/SSE bodies remain caller-managed streams, so use a signal while reading. A custom Fetch must honor signals and `redirect: 'manual'`.

Only GETs retry automatically: transient transport failures and 429/502/503/504, with exponential jitter and bounded `Retry-After` handling. Defaults are two retries, 250 ms base delay, 30 s maximum delay. POST/PUT/DELETE are never retried. Redirects are refused rather than forwarding bearer credentials or signed query values to another endpoint.

`EnvaiError` includes `httpStatus`, `type`, `code`, `details`, and `requestId`. Subclasses include authentication, access-denied, not-found, conflict, validation, rate-limit, provider, file, and server errors. Branch on `code`, never human message text. Transport errors do not retain request URLs, bodies, or credentials.

`onObservation` receives request durations/status, retry/reconnect events, stream lifecycle, ATP IDs/type/sequence, and tool lifecycle. It excludes credentials, arguments, output, text, and URLs. Observer exceptions cannot change runtime behavior. Standard trace headers can be supplied in per-call headers.

## Current alpha limitations

This package is pinned to `digitalygo/envai-teams` commit `55275860c9a950eaad8e39e9d2b728149084779c`, API 2.0.0, ATP v2. Source hashes are in `contracts/manifest.json`.

- Replay has 10,000 in-memory events, no durable epoch, no cursor-expired response, and sequence reset after eviction/restart. A reused cursor can silently receive an incomplete tail or only pings. Gap checks cannot detect every reset. Resume is best-effort **within the same resident runtime**; require an application reconciliation policy after known eviction/restart.
- Replay and live subscription are not atomic. Waiting for the first post-subscription ping reduces the new-turn attach race; it cannot restore already lost events or guarantee every interleaving. Subscriber overflow can silently drop events; observable upward gaps trigger recovery.
- Capabilities currently advertises 17 emitted events and six features. The schema's 28 declared events remain valid; capabilities is feature discovery, not a parser allowlist.
- `steer` validates and emits `turn.steered`, but currently does not inject text into the LLM loop. Do not treat its HTTP acknowledgment as an execution change.
- Approval resolution is a `409` stub. The primitive/types are exposed, but no automatic approval workflow exists.
- Context hydration is fail-open; persistence is asynchronous and best-effort. The SDK cannot promise full history after hydration. Resident chat usage totals reset and are not durable billing records.
- Fork requires a separately created empty destination chat in the same owner/workspace, with both chats idle. Restore returns `turn_id: null` and does not start a turn.
- Completion pagination omits the `page` request parameter in this contract; empty tool output lacks a schema minimum although the gateway rejects it.

Advanced PHP definitions/CLI/synchronization parity is deliberately outside this V1.

## Development and provenance

`npm run generate` deterministically regenerates 86 HTTP models, request/response types, operation primitives, and 28 event payload types from both pinned contracts. SSE, cryptography, tools, and helpers remain handwritten. `npm run check:generated` fails on drift without rewriting files. The exact server source contracts and foundation document are preserved with hash provenance in `testdata/contracts/provenance.json`. `sources` identifies each pinned repository path, local snapshot, byte count, SHA-256 and Git blob SHA. `generated_fixtures` separately identifies SDK-authored conformance cases and the generated OpenAPI JSON; these are not presented as raw server files. Tests verify every source and derived-file hash, including the foundation snapshot, without exclusions.

Tests make no live Envai requests and need no credentials. CI typechecks the runtime and examples, verifies generation, tests all 52 operations plus schema/SSE/signature/state-machine conformance, enforces at least 95% line/function and 90% branch coverage, and smoke-tests the packed archive on Node 22 and 24. Contract fixtures include public RFC 8032 test-key material only; no private key or credential is shipped.

MIT, copyright 2026 DigItalyGo. Existing license text is preserved.
