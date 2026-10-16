# Migrating to negotiated contract 3

This is a breaking runtime/type change. The default client selects `X-Envai-Contract-Version: 3` and uses ATP `/api/v1/atp/v3/...` while keeping your existing base URL ending in `/api/v1`. Completion and public wiki/source responses use the same selector and acknowledgment. Other existing control-plane CRUD and public JWKS remain unchanged.

1. Deploy the compatible backend, execution-plane and FFS changes under your own rollout process. Publishing this SDK does not deploy those dependencies.
2. Handle nullable cost fields: `Completion.cost_usd`, ATP usage `cost_usd`, terminal `cost`/`chat_cost`, and `TurnResult.cost` are `number | null`. Keep unknown/pending/non-USD totals null. Preserve provider decimal strings and currencies in `usage_cost`.
3. Handle `CompatibilityError`. The SDK checks capabilities before negotiated mutations, requires protocol version 3 and response acknowledgment, and never silently downgrades or resubmits ambiguous mutations. A missing acknowledgment after submission means its outcome can be unknown. Versioned mutation paths prevent an old server ignoring the header from accepting new-contract paid work.
4. Preserve reconnect cursors only for the same resident runtime as before. Stream selection remains version 3 on every reconnect. V3 streams accept valid historical numeric v2 events and v3 events without changing version, ID, sequence or payload; v2 nulls remain invalid. Client-tool signature preimages are unchanged.
5. Use explicit `idempotencyKey` for source upload and inbox/outbox/sync. Reconcile ambiguous acceptance using the same key/payload. Requests are never automatically resubmitted even with an idempotency key.
6. Use current completion/source/operation GET for reconciled cost. Immutable terminal snapshots do not gain later cost data or recovered response text.

For historical reads only:

```ts
const legacy = new EnvaiClient({ baseUrl, apiKey, contractVersion: 2 });
const capabilities = await legacy.getCapabilitiesLegacy();
for await (const event of legacy.events(chatId)) {
  // Finite strict numeric v2 replay. No live subscription/reconnect.
}
```

Legacy mode refuses mutations and wiki APIs. V2 completion reads require truthful numeric representations; the server may fail an entire selected page/replay with HTTP 426 when any item cannot be represented. The SDK never turns null into zero or silently filters a page. Error 426 is a compatibility failure. Existing unrelated control-plane reads remain usable.

The generated API includes both current canonical methods and explicit `getCapabilitiesLegacy` / `streamChatEventsLegacy` transport methods. Canonical stream helpers use the configured selection. A v3 client cannot invoke an explicitly legacy method accidentally. See [Wiki integration](WIKI.md) for all source, catalog, webhook and durable-outbox methods and public/internal capability boundaries.

The `events()` iterator in read-only contract 2 buffers and validates the complete finite replay before yielding any event. A mixed-version/malformed/truncated tail, cancellation or buffer overflow exposes no prefix. `maxLegacySnapshotBytes` defaults to 64 MiB of exact SSE wire bytes and may be configured explicitly; exceeding it fails instead of truncating. Legacy EOF ends iteration with no reconnect. V3 remains incremental. Low-level raw `Response` methods leave parsing to the caller.

## Chat attachments and deferred Wiki outcomes

Update to the matching backend before enabling attachment sends. Contract 3 remains selected, and `chat_attachments` is an additional capability requirement. Preserve message idempotency keys and ordered IDs; verify acceptance. Handle the new `deferred` Wiki file outcome. See [attachment integration](CHAT_ATTACHMENTS.md).
