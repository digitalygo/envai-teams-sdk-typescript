# TypeScript API reference

[README](../README.md) · [Configuration](getting-started.md) · [API reference](api-reference.md) · [Streaming](streaming.md) · [Client tools](client-tools.md)

## API and generated types

Every operation in the reviewed SDK allowlist is a public method, for example `client.sendChatMessage({ chat_id, body: { message } })`. Service aliases provide `workspaces`, `tools`, `chats`, `chatCrons`, `completions`, `projectSkills`, `projectReports`, `workspaceFiles`, `agents`, `teams`, `apiKeys`, `models`, `images`, `wiki`, and `capabilities`.

- Request fields preserve the contract's snake_case names; runtime options use camelCase. The required idempotency header is exposed as `idempotencyKey` on upload/run parameters.
- Path/query parameters are fields of the parameter object. JSON and multipart input go under `body`.
- Resource and non-paginated collection `{ data: ... }` wrappers are unwrapped. Paginated completion results retain `data`, `links`, and `meta`; model catalogs retain their dedicated envelopes.
- `204` responses return `undefined`. Binary downloads and the low-level `streamChatEvents`/`chats.eventsResponse` return a `Response`, allowing streaming via `response.body` without buffering the whole file.
- Image uploads accept `{ body: { file: new Blob([...], { type: 'image/png' }) } }`. Fetch generates the multipart boundary.
- Optional provider webhook signature headers go in `RequestOptions.headers`. The webhook primitive is exposed for complete contract coverage; the SDK never calls it automatically.
- `downloadArtifact` takes current signed `artifact`, `generation`, optional `expires`, and `signature` query fields, in canonical alphabetical order, without a bearer token. It does not accept the historical `path` parameter. Do not log signed URLs.
- API-key create/list/revoke methods are compatibility stubs that reject before HTTP. Key management requires an authenticated human console session with CSRF protection.
- Completion `page` is a typed positive safe integer selector, and `client.completions.iterate` traverses numeric pages (see [Completion pages](#completion-pages)).

[Complete operation inventory](api-inventory.md) and generated `*Params`/`*Result` types document the full surface. Authentication headers, contract selectors and host overrides cannot be supplied through per-call headers.

## Transport, errors, and observation

Provide `fetch` for a custom transport or mock. The normal request timeout defaults to 30 seconds. JSON bodies are decoded within this timeout; raw binary/SSE bodies remain caller-managed streams, so use a signal while reading. A custom Fetch must honor signals and `redirect: 'manual'`.

Only GETs retry automatically: transient transport failures and 429/502/503/504, with exponential jitter and bounded `Retry-After` handling. Defaults are two retries, 250 ms base delay, 30 s maximum delay. POST/PUT/PATCH/DELETE are never retried, including project resource mutations that receive 409, 402 or 503; reconcile the outcome before repeating a request. Redirects are refused rather than forwarding bearer credentials or signed query values to another endpoint.

`EnvaiError` includes `httpStatus`, `type`, `code`, `details`, and `requestId`. Subclasses include authentication, payment-required (`PaymentRequiredError`, HTTP 402), access-denied, not-found, conflict, validation, rate-limit, provider, file, and server errors. A 503 `provider_configuration_error` (for example on `createImageGeneration`) is a `ServerError`. Branch on `code`, never human message text. Transport errors do not retain request URLs, bodies, or credentials.

`onObservation` receives request durations/status, retry/reconnect events, stream lifecycle, ATP IDs/type/sequence, and tool lifecycle. It excludes credentials, arguments, output, text, and URLs. Observer exceptions cannot change runtime behavior. Standard trace headers can be supplied in per-call headers.

## Additional helpers

`client.generateAndWait(body, options)` creates an image generation and polls until `succeeded`, `failed`, or `cancelled`. Defaults are one-second polling and a five-minute timeout. Inspect the returned status; a local timeout does not prove remote cancellation. Download methods return a `Response`; consume or cancel its body. Large responses are caller-managed streams.

Exact request/response declarations are in [generated.ts](../src/generated.ts), and the bundled [OpenAPI contract](../contracts/openapi.yaml) defines required fields, constraints, and enums. Use server-returned identifiers as opaque strings. `undefined` fields are omitted by JSON serialization; send null only when the field permits it. Unknown REST properties remain JavaScript data; Wiki/source and completion metadata are schema-validated before return, including finite costs and safe integer revisions; other legacy REST annotations are not complete runtime validation. ATP events validate against the exact selected v2/v3 schema. `LegacyAtpUsage` retains numeric v2 costs; `AtpUsage` exposes nullable v3 costs.

`CompatibilityError` reports unsupported contract selection, old-server/version acknowledgment failures and required upgrades. Default v3 requests never silently downgrade. Explicit `getCapabilitiesLegacy` and `streamChatEventsLegacy` require `contractVersion: 2`, which refuses mutations. `uploadSourceFile`, `waitForSource`, `waitForWikiOperation`, `WikiWebhookVerifier` and `PostgresWikiWebhookInbox` are described in [Wiki integration](WIKI.md).

## Native background work

Opt in with `nativeTasks:true`. Native typed models include `NativeDeliveryRequest/Receipt`, `TeamDelegationRequest/Receipt`, `DetachedTaskSnapshot` and `PhaseClassificationRequest/Result`. Use `delegateAndWait` or `waitForDelegatedJob` for full origin-task outcomes, and `taskEvents` for a subscription that survives origin turn completion. See [background workflows](BACKGROUND.md) for negotiated capabilities, signature verification, deduplication and cancellation ownership.

### Completion pages

`client.completions.page({ workspace_id, chat_id, page: 2 })` validates a positive safe integer page. `client.completions.iterate(params, { maxPages: 1000, signal })` yields completions across numeric pages using the normal authenticated GET transport, including retries, contract acknowledgment, errors, timeout and cancellation. It preserves the original filters and API base path. Absolute or relative response links must identify the next page on the same origin and collection path; malformed, cross-origin, credential-bearing and inconsistent links fail closed before a second request. Collection pagination is not a snapshot when records change between pages.

Diagnostic image requests accept `files: Blob[]` (one to four files, at most 10240 KiB each). Use `File` to preserve names; multipart sends actual repeated `files[]` parts, not JSON placeholders.

### Complete optional HTTP validation

`new EnvaiClient({ baseUrl, apiKey, strictValidation: true })` enables canonical request and successful JSON-envelope validation across the reviewed callable SDK operations. Validation runs before preflight or mutations and before response unwrapping, using the actual response status. Canonical optional fields, explicit null, constraints and additive-field rules are preserved. Invalid inputs and responses raise `ProtocolError`; API error envelopes retain their existing typed errors and request identity. This option defaults to false; existing specialized validators remain enabled independently. Multipart validates actual binary values without consuming file content; SSE and downloads use separate stream/binary checks.

Capability discovery retains its compatibility rules in strict mode: valid boolean feature maps normalize to positive feature lists, and future family/feature names remain valid discovery data. Other canonical shape and contract-acknowledgment checks remain enforced.

## Project tenancy cutover

This SDK embeds the complete 146-operation server OpenAPI snapshot but generates only the explicit, reviewed 92-operation SDK allowlist in `scripts/sdk-operations.json` (89 callable operations plus 3 API-key compatibility stubs). It does not expose human administration, company financial, internal service, or human-session APIs. The three API-key management methods remain discoverable for compatibility but always throw `CompatibilityError` before HTTP, including without a configured bearer key. Use the human console to manage keys.

Use a **project API key**. `Workspace`, `Chat`, `Agent`, and `Team` now expose `project_id` and nullable `created_by_user_id`, not a user owner. `Completion` includes immutable `project_id` and `api_key_id`, while `user_id` is nullable audit provenance. Pre-tenancy v3 payloads are intentionally rejected by current strict validation; frozen v2 historical reads retain their older schema.

Tools are now shared within the key's **project**, not across the creator's projects. Prefer `createProjectTool`, `listProjectTools`, `getProjectTool`, `updateProjectTool`, and `deleteProjectTool`. Deprecated `*UserTool*` method/type aliases remain source-compatible and call the same `/tools` routes, with the new project scope. `client.tools` and definition synchronization use the project-scoped endpoints. No session authentication or CSRF bypass is added.

## Project resources

Source additions on `feature/user-company-projects` are unreleased. The `1.0.0-alpha.5` manifest is the baseline, not a release containing them. The contracts are pinned to backend commit `ba021aa61e30e379880f809d45f90e5d3564d43e` across six shared schema files; see `contracts/manifest.json`. They add 14 project-key operations, all callable with a project API key under contract 3 (contract 2 raises `CompatibilityError` before HTTP):

| Area | Operations | Convenience group |
| --- | --- | --- |
| Chat crons (4) | `listChatCrons`, `getChatCron`, `updateChatCron`, `deleteChatCron` | `client.chatCrons` (`list`, `get`, `update`, `delete`) |
| Project skills (5) | `listProjectSkills`, `createProjectSkill`, `getProjectSkill`, `updateProjectSkill`, `deleteProjectSkill` | `client.projectSkills` (`list`, `create`, `get`, `update`, `delete`) |
| Project reports (2) | `getProjectUsage`, `getProjectLogs` | `client.projectReports` |
| Chat rename and deletion (3) | `updateChat`, `deleteChat`, `deleteWorkspace` | `client.chats.update`, `client.chats.delete`, `client.workspaces.delete` |

There is no cron create method and no billing, payment, funding or retry helper. Human administration and company financial operations are excluded, and the API-key methods remain compatibility stubs.

### Behavior

- Chat updates accept only `title`: a string up to 255 code points, or `null` to clear it. Skill bodies accept `name`, `description` and `content`; the name must match `^[a-z][a-z0-9_-]{0,63}$` and must not be a reserved built-in skill name, and Markdown content keeps its exact whitespace but cannot be blank or contain NUL. Cron updates accept only the documented schedule fields. Invalid input throws `TypeError` or `ProtocolError` (schema validation) before HTTP, in default and strict modes.
- `deleteWorkspace` and `deleteChat` return `200` with `resource_type`, `resource_id` and `cleanup` intents. A pending cleanup means access is cut and removal is queued, not that data was physically purged.
- `deleteChatCron` and `deleteProjectSkill` return `204` as `undefined`.
- Mutations are never retried automatically. A 409 (for example `active_cron`), 402 `PaymentRequiredError` or 503 `ServerError` is returned to the caller after one request; the SDK sends no recovery or billing request.

### Project reports

Low-level `projectReports.usageRequest` and `projectReports.logsRequest` are aliases of `getProjectUsage` and `getProjectLogs`, taking flat parameters. Convenience helpers take the project id first and build validated parameters:

```ts
projectUsage(projectId, filters?, options?): Promise<UsageReportCollection>
projectUsagePage(projectId, page?, filters?, options?): Promise<UsageReportCollection>
iterateProjectUsage(projectId, filters?, { startPage?, maxPages?, signal? }): AsyncGenerator<UsageReportDay>
projectLogs(projectId, filters?, options?): Promise<ProjectLogCollection>        // alias: events
projectLogsPage(projectId, page?, filters?, options?): Promise<ProjectLogCollection> // alias: eventsPage
iterateProjectLogs(projectId, filters?, { startPage?, maxPages?, signal? }): AsyncGenerator<ProjectLogEntry> // alias: iterateEvents
projectAnalytics(projectId, filters?, options?): Promise<ProjectActivityAnalytics>
projectFilters(projectId, filters?, options?): Promise<ProjectEventTypeFilters>  // alias: eventTypes
```

Each helper is available on `client` and, bound, on `client.projectReports` (`usage`, `usagePage`, `iterateUsage`, `logs`, `events`, `logsPage`, `eventsPage`, `iterateLogs`, `iterateEvents`, `analytics`, `filters`, `eventTypes`).

- `getProjectLogs` has three views selected by `view`: `events` (default, paginated), `analytics` (retained activity analytics) and `filters` (event type catalog). The helpers select the view locally and return the unwrapped `data` for analytics and filters. A conflicting `view` in the filter object throws.
- Dates use `YYYY-MM-DD` real UTC dates, inclusive, with `from` not after `to` and a window of at most 90 days. Ids use `prj_`, `key_` and `cht_` ULID prefixes.
- Event filters accept scalar `type` and `api_key_id`, and lists `types`, `workspace_ids` and `api_key_ids` of 1 to 50 distinct values. The SDK serializes lists as repeated bracket keys (`types[]`, `workspace_ids[]`, `api_key_ids[]`); a scalar and its plural list conflict. `null` filters are rejected.
- Pagination is local: `*Page` helpers send `page`, and iterators start at `startPage`, then `filters.page`, then 1, and advance until `meta.last_page`. They check that `meta.current_page` matches the request, preserve filters, ignore absolute `links` (no cross-origin follow-up), honor `signal`, and stop with `ProtocolError` after `maxPages` (default 1000). `maxPages` and `startPage` must be positive safe integers. Pages are not a snapshot when data changes between requests.
- Usage money values (`totals[].amount`, media totals) are exact decimal strings per currency, never floats. Unknown-cost observations are counted separately (`unknown_invocations`, `unknown_observations`) and `by_project` can be `null`.
- An events entry whose `agent` or `data` arrives as an empty array is normalized to `{}`; a non-empty array is a `ProtocolError`.

### Events and billing

The four events `chat.title.updated`, `chat.cron.wakeup`, `billing.limit_reached` and `billing.credit_exhausted` were already typed among the 39 known ATP event types. Billing events may carry a `null` `turn_id` before admission or a real `turn_id` during a turn, and are non-terminal. Contract 2 stays frozen. Opt-in native and v2 behavior is unchanged.
