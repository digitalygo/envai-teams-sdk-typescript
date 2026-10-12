import { EnvaiError, ProtocolError, ReplayGapError, TransportError } from './errors.js';
import { parseEvent } from './events.js';
import type { ATPEvent } from './event-types.js';
import { HttpTransport, delay, positive, type RequestOptions } from './http.js';
import { operations } from './operations.js';

/** SSE wire parser: UTF-8 chunking, BOM, LF/CRLF/CR, comments and multi-line data. */
export async function* parseSSE(body: ReadableStream<Uint8Array>, options: { signal?: AbortSignal; maxFrameBytes?: number; idleTimeoutMs?: number } = {}): AsyncGenerator<string> {
  const limit = positive(options.maxFrameBytes ?? 1_048_576, 'maxFrameBytes');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '', data: string[] = [], sawData = false, skipLF = false, size = 0;
  const abort = () => { void reader.cancel(options.signal?.reason).catch(() => {}); };
  options.signal?.addEventListener('abort', abort, { once: true });
  function consumeLine(): string | undefined {
    const current = line; line = '';
    if (!current) { const result = sawData ? data.join('\n') : undefined; data = []; sawData = false; size = 0; return result; }
    if (current.startsWith(':')) return;
    const separator = current.indexOf(':');
    const field = separator < 0 ? current : current.slice(0, separator);
    let value = separator < 0 ? '' : current.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') { data.push(value); sawData = true; }
  }
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let expired = false;
      if (options.idleTimeoutMs !== undefined) timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, positive(options.idleTimeoutMs, 'idleTimeoutMs'));
      let read: ReadableStreamReadResult<Uint8Array>;
      try { read = await reader.read(); } finally { clearTimeout(timer); }
      options.signal?.throwIfAborted();
      if (expired) throw new TransportError('SSE idle timeout');
      let text: string;
      try { text = decoder.decode(read.value, { stream: !read.done }); } catch { throw new ProtocolError('Invalid SSE UTF-8'); }
      for (const char of text) {
        if (skipLF) { skipLF = false; if (char === '\n') continue; }
        size += Buffer.byteLength(char, 'utf8');
        if (size > limit) throw new ProtocolError('SSE frame exceeded maxFrameBytes');
        if (char === '\r' || char === '\n') {
          if (char === '\r') skipLF = true;
          const frame = consumeLine(); if (frame !== undefined) yield frame;
        } else line += char;
      }
      if (read.done) return; // Unterminated frames are discarded, as required by SSE.
    }
  } finally { options.signal?.removeEventListener('abort', abort); try { await reader.cancel(); } catch {} reader.releaseLock(); }
}
export interface StreamOptions extends RequestOptions {
  after?: number;
  /** Explicit acknowledgement that an existing cursor belongs to this resident server runtime. */
  resume?: 'same-runtime';
  maxReconnects?: number; reconnectDelayMs?: number; idleTimeoutMs?: number; maxDurationMs?: number; maxFrameBytes?: number;
}
/** Single-consumer, best-effort resident-runtime stream. Call close() or break iteration. */
export class EventStream implements AsyncIterable<ATPEvent> {
  readonly #abort = new AbortController(); #used = false; #lastSeq: number;
  constructor(readonly chatId: string, readonly transport: HttpTransport, readonly options: StreamOptions = {}) {
    this.#lastSeq = options.after ?? 0;
    if (!Number.isSafeInteger(this.#lastSeq) || this.#lastSeq < 0) throw new RangeError('after must be a non-negative safe integer');
    if (this.#lastSeq > 0 && options.resume !== 'same-runtime') throw new ProtocolError('Nonzero resume requires resume: same-runtime; server cursors do not survive restart or eviction');
    const reconnects = positive(options.maxReconnects ?? 5, 'maxReconnects', true);
    if (!Number.isInteger(reconnects)) throw new RangeError('maxReconnects must be an integer');
  }
  get lastSeq(): number { return this.#lastSeq; }
  close(): void { this.#abort.abort(new DOMException('Stream closed', 'AbortError')); }
  [Symbol.asyncIterator](): AsyncIterator<ATPEvent> {
    if (this.#used) throw new ProtocolError('EventStream allows only one consumer');
    this.#used = true; return this.iterate();
  }
  private async *iterate(): AsyncGenerator<ATPEvent> {
    const signal = this.options.signal ? AbortSignal.any([this.#abort.signal, this.options.signal]) : this.#abort.signal;
    const maxReconnects = this.options.maxReconnects ?? 5;
    let reconnects = 0, recoveringGap = false;
    const timer = this.options.maxDurationMs === undefined ? undefined : setTimeout(() => this.#abort.abort(new DOMException('Stream duration exceeded', 'TimeoutError')), positive(this.options.maxDurationMs, 'maxDurationMs'));
    try {
      for (;;) {
        signal.throwIfAborted();
        let sawGap = false;
        try {
          const response = await this.transport.request<Response>(operations.streamChatEvents, { chat_id: this.chatId, after: this.#lastSeq }, { signal, headers: this.options.headers });
          if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) { await response.body?.cancel(); throw new ProtocolError('Expected text/event-stream response'); }
          if (!response.body) throw new ProtocolError('SSE response has no body');
          this.transport.observe({ kind: 'stream.open', chatId: this.chatId, seq: this.#lastSeq });
          for await (const frame of parseSSE(response.body, { signal, maxFrameBytes: this.options.maxFrameBytes, idleTimeoutMs: this.options.idleTimeoutMs ?? 45_000 })) {
            const event = parseEvent(frame);
            if (event.chat_id !== this.chatId) throw new ProtocolError('Event belongs to a different chat', event);
            if (event.type !== 'ping') {
              if (event.seq <= this.#lastSeq) continue;
              if (event.seq !== this.#lastSeq + 1) {
                if (recoveringGap) throw new ReplayGapError(this.#lastSeq, event.seq);
                recoveringGap = true; sawGap = true; break;
              }
              recoveringGap = false;
            }
            this.transport.observe({ kind: 'event', eventType: event.type, eventId: event.id, seq: event.seq, chatId: event.chat_id, turnId: event.turn_id });
            const deliveredSeq = event.seq;
            const replayable = event.type !== 'ping';
            yield event;
            // Advance only when control returns after the consumer successfully receives it.
            if (replayable) this.#lastSeq = deliveredSeq;
          }
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof ProtocolError || error instanceof EnvaiError && ![429,502,503,504].includes(error.httpStatus)) throw error;
          if (reconnects >= maxReconnects) throw error;
        } finally { this.transport.observe({ kind: 'stream.close', chatId: this.chatId, seq: this.#lastSeq }); }
        if (reconnects >= maxReconnects) throw sawGap ? new ProtocolError('Replay recovery exceeds reconnect limit') : new TransportError('SSE disconnected; reconnect limit reached');
        reconnects++;
        this.transport.observe({ kind: 'stream.reconnect', chatId: this.chatId, seq: this.#lastSeq, attempt: reconnects });
        await delay(positive(this.options.reconnectDelayMs ?? 250, 'reconnectDelayMs', true) * Math.min(2 ** (reconnects - 1), 16) * (0.5 + Math.random()), signal);
      }
    } finally { clearTimeout(timer); this.close(); }
  }
}
