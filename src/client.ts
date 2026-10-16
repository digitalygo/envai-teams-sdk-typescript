import { GeneratedClient, type ChatMessageRequest, type ImageGenerationRequest } from './generated.js';
import { HttpTransport, delay, positive, type ClientOptions, type RequestOptions } from './http.js';
import { EventStream, type StreamOptions } from './stream.js';
import { isEvent, isTerminal } from './events.js';
import { CompatibilityError } from './contract.js';
import { WikiWebhookVerifier } from './wiki-webhooks.js';
import { ProtocolError } from './errors.js';
import type { ATPEvent, KnownEvent } from './event-types.js';
import { ClientToolRunner, type ToolRunnerOptions } from './tools.js';
import { JwksCache, ToolRequestVerifier, type SigningJwks, type JwksSource } from './security.js';
export interface TurnOptions extends StreamOptions { toolRunner?: ClientToolRunner; readyTimeoutMs?: number; idempotencyKey?: string; }
export interface TurnResult {
  chatId: string; turnId: string; text: string; lastSeq: number;
  terminal: KnownEvent<'turn.completed' | 'turn.failed' | 'turn.cancelled'>;
  usage: KnownEvent<'turn.completed'>['data']['usage']; cost: number | null;
}
export class EnvaiClient extends GeneratedClient {
  readonly jwks: JwksSource;
  constructor(options: ClientOptions & { jwksCache?: JwksSource; jwksCacheTtlMs?: number }) {
    super(new HttpTransport(options));
    this.jwks = options.jwksCache ?? new JwksCache(async signal => await this.getJwks({}, { signal }) as SigningJwks, options.jwksCacheTtlMs);
  }
  createWikiWebhookVerifier(workspaceId: string): WikiWebhookVerifier {
    return new WikiWebhookVerifier(new JwksCache(async signal => await this.getWikiWebhookJwks({}, { signal }) as SigningJwks), workspaceId);
  }
  events(chatId: string, options: StreamOptions = {}): EventStream { return new EventStream(chatId, this.transport, options); }
  createToolRunner(options: Omit<ToolRunnerOptions, 'submit' | 'verifier' | 'onObservation'> & { verifier?: ToolRequestVerifier }): ClientToolRunner {
    return new ClientToolRunner({ ...options, verifier: options.verifier ?? new ToolRequestVerifier(this.jwks), submit: (chatId, body, requestOptions) => this.resolveChatTool({ chat_id: chatId, body }, requestOptions), onObservation: e => this.transport.observe(e) });
  }
  /** Open stream and wait for the first post-subscription ping BEFORE submitting the non-retryable message. */
  async *sendAndStream(chatId: string, message: ChatMessageRequest, options: TurnOptions = {}): AsyncGenerator<ATPEvent> {
    if (this.transport.contractVersion !== 3) throw new CompatibilityError('Contract 2 cannot start a new turn');
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const stream = this.events(chatId, { ...options, signal });
    const iterator = stream[Symbol.asyncIterator]();
    const replay: ATPEvent[] = [];
    let replayBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => controller.abort(new DOMException('Live subscription ping did not arrive', 'TimeoutError')), positive(options.readyTimeoutMs ?? 30_000, 'readyTimeoutMs'));
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) throw new ProtocolError('Stream ended before subscription readiness');
        if (isEvent(next.value, 'ping')) break;
        if (options.idempotencyKey) {
          replayBytes += Buffer.byteLength(JSON.stringify(next.value));
          if (replayBytes > 16 * 1024 * 1024) throw new ProtocolError('Idempotent send replay exceeds 16 MiB; resume the known turn using its cursor');
          replay.push(next.value);
        } else if (options.toolRunner && !isEvent(next.value, 'agent.tool.request')) await options.toolRunner.accept(next.value);
      }
      clearTimeout(timer); timer = undefined;
      const accepted = await this.sendChatMessage({ chat_id: chatId, body: message, idempotencyKey: options.idempotencyKey }, { signal, headers: options.headers });
      if (!accepted.turn_id) throw new ProtocolError('Message acceptance omitted turn_id');
      const replayCompleted = replay.some(event => event.turn_id === accepted.turn_id && isTerminal(event));
      for (;;) {
        const replayed = replay.length > 0;
        const next = replayed ? { done: false, value: replay.shift()! } : await iterator.next();
        if (next.done) throw new ProtocolError('Stream ended before terminal event');
        const event = next.value;
        if (event.turn_id !== accepted.turn_id) continue;
        if (options.toolRunner && !(replayed && replayCompleted && isEvent(event, 'agent.tool.request'))) await options.toolRunner.accept(event);
        yield event;
        if (isTerminal(event)) return;
      }
    } finally { clearTimeout(timer); stream.close(); await iterator.return?.(); }
  }
  async sendAndWait(chatId: string, message: ChatMessageRequest, options: TurnOptions = {}): Promise<TurnResult> {
    let text = '';
    for await (const event of this.sendAndStream(chatId, message, options)) {
      if (event.agent?.role === 'orchestrator') {
        if (isEvent(event, 'agent.text.delta')) text += event.data.delta;
        if (isEvent(event, 'agent.text.done')) text = event.data.text;
      }
      if (isTerminal(event)) return { chatId, turnId: event.turn_id!, text, lastSeq: event.seq, terminal: event, usage: event.data.usage, cost: event.data.cost };
    }
    throw new ProtocolError('Turn stream ended without terminal event');
  }
  async generateAndWait(body: ImageGenerationRequest, options: RequestOptions & { pollIntervalMs?: number; timeoutMs?: number } = {}) {
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new DOMException('Image polling timed out', 'TimeoutError')), positive(options.timeoutMs ?? 300_000, 'timeoutMs'));
    try {
      const accepted = await this.createImageGeneration({ body }, { ...options, signal });
      if (!accepted.id) throw new ProtocolError('Image acceptance omitted id');
      for (;;) {
        const result = await this.getImageGeneration({ record: accepted.id }, { ...options, signal });
        if (['succeeded', 'failed', 'cancelled'].includes(String(result.status))) return result;
        await delay(positive(options.pollIntervalMs ?? 1_000, 'pollIntervalMs'), signal);
      }
    } finally { clearTimeout(timer); }
  }
}
