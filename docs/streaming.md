# Streaming and recovery

[README](../README.md) · [Configuration](getting-started.md) · [API reference](api-reference.md) · [Streaming](streaming.md) · [Client tools](client-tools.md)

## Turn helpers

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

`sendAndStream` opens the SSE reader and waits for the first `ping` before it sends the message. HTTP 200 alone does not establish live readiness. Readiness has a 30-second default timeout. Message submission is never automatically retried.

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

V3 duplicate sequence numbers are suppressed; finite legacy replay instead rejects duplicate or backwards sequences atomically. An observable live gap triggers one replay recovery attempt from the delivered cursor; a repeated gap raises `ReplayGapError`. Stream retries are bounded (five reconnects by default), jittered, cancellable, and observable. Fatal protocol/authentication errors stop immediately. The default idle timeout is 45 seconds; connection timeout is 15 seconds; `maxDurationMs` is optional. Low-level `chats.cancel` asks the server to cancel a turn; only `turn.cancelled` confirms completion. Local `AbortSignal` cancellation closes this client's work and does **not** implicitly cancel a server turn.


## Recovery limits

### Current API compatibility

The default client negotiates contract 3 before mutations and validates acknowledgment before decoding. Legacy mode is historical read-only. Unknown costs remain null. See [migration](MIGRATION_V3.md) and [Wiki](WIKI.md).

The bundled contracts describe API 3.0.0 and negotiated ATP v3. Exact source hashes are in `contracts/manifest.json`; using this SDK does not require access to another repository.

- Replay is best-effort, with no durable epoch or cursor-expired response, and sequences can reset after eviction/restart. A reused cursor can silently receive an incomplete tail or only pings. Gap checks cannot detect every reset. Resume is best-effort **within the same resident runtime**; require an application reconciliation policy after known eviction/restart.
- Replay and live subscription are not atomic. Waiting for the first post-subscription ping reduces the new-turn attach race; it cannot restore already lost events or guarantee every interleaving. Subscriber overflow can silently drop events; observable upward gaps trigger recovery.
- Capabilities is positive feature discovery, not a parser allowlist. All 29 declared event types remain valid even when discovery lists fewer events.
- A successful `steer` acknowledgement does not guarantee changed execution.
- Approval resolution currently responds with HTTP 409 and is unavailable as a completed workflow. The primitive preserves that error.
- Context restore is best-effort. A restore acknowledgement does not guarantee complete or durable history. Reported chat usage can reset and is not a durable billing record.
- Fork requires a separately created empty destination chat in the same owner/workspace, with both chats idle. Restore returns `turn_id: null` and does not start a turn.
- Completion pagination omits the `page` request parameter in this contract; empty tool output lacks a schema minimum although the gateway rejects it.



The `events()` iterator in read-only contract 2 buffers and validates the complete finite replay before yielding any event. A mixed-version/malformed/truncated tail, cancellation or buffer overflow exposes no prefix. `maxLegacySnapshotBytes` defaults to 64 MiB of exact SSE wire bytes and may be configured explicitly; exceeding it fails instead of truncating. Legacy EOF ends iteration with no reconnect. V3 remains incremental. Low-level raw `Response` methods leave parsing to the caller.
