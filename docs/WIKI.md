# Wiki V1

Node.js 22+ SDK. Every authenticated source/wiki request selects contract 3 and requires the server's acknowledgment before decoding. Mutations first verify contract 3 capabilities. Public signing JWKS is unnegotiated and unauthenticated. Backend and FFS companion changes must be deployed together by your deployment process; installing this SDK does not deploy them.

## Source lifecycle

```ts
import { EnvaiClient, uploadSourceFile, waitForSource, waitForWikiOperation } from '@digitalygo/envai-client';
const client = new EnvaiClient({ baseUrl: 'https://envai.example/api/v1', apiKey: process.env.ENVAI_API_KEY });
const source = await uploadSourceFile(client, workspaceId, '/private/report.pdf', stableUploadKey);
const conversion = await waitForSource(client, workspaceId, source.file_id, { signal });
if (conversion.conversion.status !== 'completed' || conversion.lifecycle !== 'inbox') throw new Error('Conversion did not complete');
const accepted = await client.wiki.inbox({
  workspace_id: workspaceId, idempotencyKey: stableRunKey,
  body: { webhook_url: 'https://your-app.example/webhooks/wiki' },
}, { signal });
const operation = await waitForWikiOperation(client, workspaceId, accepted.operation_id, { signal });
```

- `workspaceFiles.uploadSource` / `uploadWikiSource`: multipart `file`, explicit `idempotencyKey`, HTTP 202 durable acceptance. Supply a `File` to retain its original filename. `uploadSourceFile` uses Node `openAsBlob` and a filesystem-backed multipart part; it does not read a 1 GB original into a Buffer. Keep the original unchanged for the request and any deliberate replay.
- `workspaceFiles.sourceStatus` / `getWikiSource`: current conversion (`queued|running|completed|failed`), indexing and lifecycle are separate. Conversion completion enters `inbox`; it never indexes or starts a wiki run. Optional `error_code`, `recoverable` and `next_retry_at` identify sanitized diagnostics and actual scheduled recovery. `waitForSource` continues a recoverable failure, stops at final failure/withdrawal, and honors cancellation/deadline.
- `workspaceFiles.downloadSource` / `downloadWikiSource`: returns a streaming `Response` through the authenticated current-RAW read gate. It is not a public storage URL. Consume/cancel the response body promptly.
- `wiki.inbox`, `wiki.outbox`, `wiki.sync`: explicit operation starts with webhook URL and stable idempotency key. `wiki.operation` returns captured phase batches, per-file outcomes, current cost projection and status. `waitForWikiOperation` returns completed/failed metadata, preserving partial per-file success.
- `wiki.withdraw`: POST `/workspaces/{workspace_id}/wiki/outbox/files` with `{file_id}` immediately withdraws visibility and references. It does not edit artifacts, start AI, or emit a file-deleted event. An explicit outbox run later cleans artifacts and deletes original/Markdown. Tombstones and monotonic `source_revision` prevent stale work restoring visibility.

MD/TXT, CSV, XLSX, PDF/DOCX OCR and MP3/MP4 audio are supported by the backend. MP4 does not perform frame analysis. The inclusive original limit is 1,000,000,000 bytes; align proxy/application timeouts and body limits. Provider limitations produce explicit errors, never successful truncated placeholders. No SDK method retries mutations automatically, including idempotent uploads/runs. A timeout may mean acceptance occurred: reconcile using the same key and original payload, never mint a new key automatically.

Each workspace has at most one active operation and 20 waiting operations. Identical replay retrieves the original operation; changed payload under the same key returns 409 `idempotency_conflict`. Queue rejection is 429 `wiki_queue_full` with a Retry-After hint, not a reservation. Sync attempts inbox then outbox even when the first phase fails. Conversion costs belong to upload and are not charged again by inbox. New files outside a phase snapshot wait for another run.

## Catalog, artifacts and exact public routes

```ts
const catalog = await client.wiki.categories({ workspace_id: workspaceId });
const first = await client.wiki.categoryIndex({
  workspace_id: workspaceId, category_id: categoryId, from: 1, to: 25,
  type: 'raw', catalog_revision: catalog.catalog_revision,
});
const whole = await client.wiki.categoryIndex({ workspace_id: workspaceId, category_id: categoryId, all: true });
await client.wiki.withdraw({ workspace_id: workspaceId, body: { file_id: source.file_id } });
```

The exhaustive public reads are GET `/wiki/categories` and GET `/wiki/categories/{category_id}/index`, relative to `/workspaces/{workspace_id}`. Choose `all: true` or inclusive, one-based `from` and `to`; `type: raw|artifact` is optional. Ordering is inserted time then entry ID. Requested/actual ranges, counts, completeness and catalog revision are explicit. Pass the same revision for subsequent pages; 409 `catalog_revision_changed` requires restarting the read. A previous revision never bypasses current-source withdrawal gates.

Catalog entries expose the backend's artifact/source metadata and revisions. Decisions QUERY, artifact creation/editing with CAS, asynchronous reference requests and managed confirmations are internal actor-bound runtime capabilities in Wiki V1. There is no public SDK QUERY or generic artifact-writer endpoint to invent. GET remains the exhaustive discovery path when probabilistic QUERY excludes an entry. Existing generic file methods cannot bypass managed namespace protections. Existing image artifact downloads retain their separate signed-URL semantics.

## Provider consumption, nullable legacy totals and immutable terminals

`billing.status` is `inactive`. `usage_cost` tracks provider consumption, never customer price, charge or settlement. `status: pending` has `totals: null`; `priced_subtotals` is only the known portion. Amounts are exact decimal strings grouped by original currency; preserve them without numeric conversion, FX or cross-currency addition. `basis: reported|calculated|mixed|none`, scope state, revision and as-of time describe provenance. A closed truly empty scope has zero invocations, `basis: none`, and empty totals/subtotals. Unknown never becomes zero.

Functional success and complete cost are independent. Failures may cost money, successful operations may remain pending. Poll current GET metadata for late reconciliation. Terminal webhook bytes and completion `terminal_snapshot` identity/data are immutable, even when current usage revisions advance. No second terminal event is generated. Completion `cost_usd`, ATP `usage.cost_usd`, terminal `cost` and `chat_cost` are nullable in v3. Numeric legacy v2 events remain accepted, but null-bearing v2 events are rejected. Current completion and immutable snapshot turn IDs must agree.

## Exact-byte Ed25519 verification

```ts
const verifier = client.createWikiWebhookVerifier(expectedWorkspaceId);
const verified = await verifier.verify({ method: incoming.method, headers: incoming.rawHeaders, rawBody: exactBytes });
```

Require POST and a single JSON Content-Type. Use `IncomingMessage.rawHeaders` or raw tuples. The verifier rejects missing, duplicate or malformed signing headers; `Headers`-coalesced duplicates are also rejected. Body bytes are copied before asynchronous key lookup, signature-verified before parsing, then checked against the discriminated event schema and expected workspace/event ID. Default body limit is 1 MiB and delivery timestamp tolerance is 300 seconds. Applications may configure stricter tolerance and explicit bounded body limits with `WikiWebhookVerifier`.

Signing input is UTF-8 `envai-webhook-v1\n{kid}\n{event_id}\n{canonical_positive_unix_seconds}\n{lowercase_sha256_of_exact_body}`, without a final LF. Detached signatures are canonical unpadded base64url Ed25519. Resolve public keys only from the configured Envai origin `/.well-known/wiki-webhook-jwks.json`; the factory does this automatically, caches for 300 seconds and refreshes once for an unknown key ID. Never use a payload-supplied URL. A retry retains logical event/body but gets a fresh timestamp. Old event occurrence times can therefore be delivered legitimately.

Outgoing wiki signatures are distinct from client-tool signatures and incoming provider HMAC callbacks. Do not reserialize a parsed request body before verification. This package uses Node filesystem/crypto and does not claim browser runtime support; protect bearer credentials in a server-side application.

## Durable receipt and application outbox

```ts
import { PostgresWikiWebhookInbox } from '@digitalygo/envai-client';
// pg.Pool implements the small WikiPostgresPool interface.
const inbox = new PostgresWikiWebhookInbox(pool, verifier);
const outcome = await inbox.receive({ method: incoming.method, headers: incoming.rawHeaders, rawBody: exactBytes }, 'production-envai');
response.statusCode = outcome === 'collision' ? 409 : 204;
response.end();
```

Apply `migrations/wiki-webhook-inbox.sql` explicitly through your migration process. Constructors never create tables. Supply an actual PostgreSQL pool that leases a fresh idle connection, not a connection already in a caller-owned transaction. The adapter verifies before opening the transaction, atomically inserts the scoped receipt and application outbox row, and acknowledges only after commit. Deduplication is connection scope + workspace + event ID; the same ID with different bytes is a collision. Concurrent duplicates enqueue exactly one job. A rollback leaves neither receipt nor job; retry after an ambiguous successful commit returns duplicate.

Return non-2xx on verification/database exceptions. Accepted and duplicate are the only successful acknowledgments. Process the durable application outbox separately; mark `processed_at` according to your worker's own idempotency policy. The adapter guarantees atomic local enqueue, not exactly-once remote effects. It deliberately runs no user callback/network effect inside the receipt transaction. Preserve source revision tombstones and re-read current source state before downstream access or work, because delivery order is not guaranteed. Historical generic callback claims need reconciliation before migrating.

The integration suite exercises real PostgreSQL concurrency, rollback, commit ambiguity and collisions using synthetic fixtures. It makes no paid provider call and does not provision credentials or deploy anything.

The `events()` iterator in read-only contract 2 buffers and validates the complete finite replay before yielding any event. A mixed-version/malformed/truncated tail, cancellation or buffer overflow exposes no prefix. `maxLegacySnapshotBytes` defaults to 64 MiB of exact SSE wire bytes and may be configured explicitly; exceeding it fails instead of truncating. Legacy EOF ends iteration with no reconnect. V3 remains incremental. Low-level raw `Response` methods leave parsing to the caller.
