# TypeScript API reference

[README](../README.md) · [Configuration](getting-started.md) · [API reference](api-reference.md) · [Streaming](streaming.md) · [Client tools](client-tools.md)

## API and generated types

Every OpenAPI `operationId` is a public method, for example `client.sendChatMessage({ chat_id, body: { message } })`. Service aliases provide `workspaces`, `tools`, `chats`, `completions`, `workspaceFiles`, `agents`, `teams`, `apiKeys`, `models`, `images`, `wiki`, and `capabilities`.

- Request fields preserve the contract's snake_case names; runtime options use camelCase. The required idempotency header is exposed as `idempotencyKey` on upload/run parameters.
- Path/query parameters are fields of the parameter object. JSON and multipart input go under `body`.
- Resource and non-paginated collection `{ data: ... }` wrappers are unwrapped. Paginated completion results retain `data`, `links`, and `meta`; model catalogs retain their dedicated envelopes.
- `204` responses return `undefined`. Binary downloads and the low-level `streamChatEvents`/`chats.eventsResponse` return a `Response`, allowing streaming via `response.body` without buffering the whole file.
- Image uploads accept `{ body: { file: new Blob([...], { type: 'image/png' }) } }`. Fetch generates the multipart boundary.
- Optional provider webhook signature headers go in `RequestOptions.headers`. The webhook primitive is exposed for complete contract coverage; the SDK never calls it automatically.
- `downloadArtifact` takes current signed `artifact`, `generation`, optional `expires`, and `signature` query fields, in canonical alphabetical order, without a bearer token. It does not accept the historical `path` parameter. Do not log signed URLs.
- API-key creation preserves omitted `expires_at` (server default) versus explicit `"never"`.
- Completion `page` is absent from the pinned request contract, although the response is paginated. This SDK preserves the declared parameters and metadata; it does not invent an automatic page traversal API.

[Complete operation inventory](api-inventory.md) and generated `*Params`/`*Result` types document the full surface. Authentication headers, contract selectors and host overrides cannot be supplied through per-call headers.


## Transport, errors, and observation

Provide `fetch` for a custom transport or mock. The normal request timeout defaults to 30 seconds. JSON bodies are decoded within this timeout; raw binary/SSE bodies remain caller-managed streams, so use a signal while reading. A custom Fetch must honor signals and `redirect: 'manual'`.

Only GETs retry automatically: transient transport failures and 429/502/503/504, with exponential jitter and bounded `Retry-After` handling. Defaults are two retries, 250 ms base delay, 30 s maximum delay. POST/PUT/DELETE are never retried. Redirects are refused rather than forwarding bearer credentials or signed query values to another endpoint.

`EnvaiError` includes `httpStatus`, `type`, `code`, `details`, and `requestId`. Subclasses include authentication, access-denied, not-found, conflict, validation, rate-limit, provider, file, and server errors. Branch on `code`, never human message text. Transport errors do not retain request URLs, bodies, or credentials.

`onObservation` receives request durations/status, retry/reconnect events, stream lifecycle, ATP IDs/type/sequence, and tool lifecycle. It excludes credentials, arguments, output, text, and URLs. Observer exceptions cannot change runtime behavior. Standard trace headers can be supplied in per-call headers.


## Additional helpers

`client.generateAndWait(body, options)` creates an image generation and polls until `succeeded`, `failed`, or `cancelled`. Defaults are one-second polling and a five-minute timeout. Inspect the returned status; a local timeout does not prove remote cancellation. Download methods return a `Response`; consume or cancel its body. Large responses are caller-managed streams.

Exact request/response declarations are in [generated.ts](../src/generated.ts), and the bundled [OpenAPI contract](../contracts/openapi.yaml) defines required fields, constraints, and enums. Use server-returned identifiers as opaque strings. `undefined` fields are omitted by JSON serialization; send null only when the field permits it. Unknown REST properties remain JavaScript data; Wiki/source and completion metadata are schema-validated before return, including finite costs and safe integer revisions; other legacy REST annotations are not complete runtime validation. ATP events validate against the exact selected v2/v3 schema. `LegacyAtpUsage` retains numeric v2 costs; `AtpUsage` exposes nullable v3 costs.

`CompatibilityError` reports unsupported contract selection, old-server/version acknowledgment failures and required upgrades. Default v3 requests never silently downgrade. Explicit `getCapabilitiesLegacy` and `streamChatEventsLegacy` require `contractVersion: 2`, which refuses mutations. `uploadSourceFile`, `waitForSource`, `waitForWikiOperation`, `WikiWebhookVerifier` and `PostgresWikiWebhookInbox` are described in [Wiki integration](WIKI.md).
