import { createHash } from 'node:crypto';
import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import draft6 from 'ajv/dist/refs/json-schema-draft-06.json' with { type: 'json' };
import addFormats from 'ajv-formats';
import { ToolExecutionError } from './errors.js';
import { parseEvent, isEvent, isTerminal } from './events.js';
import type { ATPEvent, KnownEvent } from './event-types.js';
import { positive, type RequestOptions, type Observation } from './http.js';
import { canonicalize, ToolRequestVerifier } from './security.js';

export interface ToolContext { signal: AbortSignal; chatId: string; turnId: string; taskId?: string; callId: string; idempotencyKey: string; }
export interface LocalTool<T = Record<string, unknown>> {
  name: string; description?: string;
  parameters: { type: 'object'; [key: string]: unknown };
  timeoutSeconds?: number;
  handler: (args: T, context: ToolContext) => unknown | Promise<unknown>;
}
interface RegisteredTool { definition: LocalTool; validate: ValidateFunction; timeoutMs: number; }
export class ClientToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();
  readonly #ajv = new Ajv2020({ strict: false, allErrors: true });
  readonly #legacy = new Ajv({ strict: false, allErrors: true });
  readonly #draft2019 = new Ajv2019({ strict: false, allErrors: true });
  constructor() {
    this.#legacy.addMetaSchema(draft6);
    for (const validator of [this.#ajv, this.#legacy, this.#draft2019]) (addFormats as unknown as (a: Ajv) => void)(validator);
  }
  register<T = Record<string, unknown>>(definition: LocalTool<T>): this {
    if (!/^[a-z][a-z0-9_]{0,254}$/.test(definition.name) || this.#tools.has(definition.name)) throw new TypeError('Invalid or duplicate local tool name');
    if (definition.parameters.type !== 'object') throw new TypeError('Local tool schema root must be object');
    const seconds = definition.timeoutSeconds ?? 120;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) throw new RangeError('timeoutSeconds must be 1..600');
    const copy = { ...definition, parameters: structuredClone(definition.parameters) } as unknown as LocalTool;
    const dialect = typeof copy.parameters.$schema === 'string' ? copy.parameters.$schema.replace(/#$/, '') : copy.parameters.$schema;
    const validator = typeof dialect === 'string' && /^http:\/\/json-schema.org\/draft-0[67]\/schema#?$/.test(dialect) ? this.#legacy
      : dialect === 'https://json-schema.org/draft/2019-09/schema' ? this.#draft2019 : this.#ajv;
    this.#tools.set(copy.name, { definition: copy, validate: validator.compile(copy.parameters), timeoutMs: seconds * 900 });
    return this;
  }
  get(name: string): RegisteredTool | undefined { return this.#tools.get(name); }
  /** Registration payloads only. Register remotely using client.tools.create; this performs no I/O. */
  definitions(): Array<{ name: string; kind: 'client'; description?: string; parameters: LocalTool['parameters']; timeout_seconds: number }> {
    return [...this.#tools.values()].map(({ definition: d }) => ({ name: d.name, kind: 'client', description: d.description, parameters: structuredClone(d.parameters), timeout_seconds: d.timeoutSeconds ?? 120 }));
  }
}
export type ToolState = 'claimed' | 'completed' | 'submitted' | 'ambiguous' | 'resolved' | 'abandoned';
export interface ToolRecord {
  state: ToolState; fingerprint: string; chatId: string; turnId: string; callId: string;
  taskId?: string; output?: string; isError?: boolean;
}
/** Validate persisted JSON before treating it as an execution barrier or changing it.
 * Keys are the opaque values returned by ClientToolRunner.key (or its turn barriers).
 * Corruption is a local storage failure, never permission to reclaim a call.
 */
export function assertToolRecord(key: string, value: unknown, turnId?: string): asserts value is ToolRecord {
  const fail = (): never => { throw new ToolExecutionError('Invalid persisted tool state; reconcile storage before retrying', 'invalid_tool_state'); };
  let identity: unknown;
  try { identity = JSON.parse(key); } catch { fail(); }
  if (!Array.isArray(identity) || ![3, 4].includes(identity.length) || identity.some(v => typeof v !== 'string' || !v)) fail();
  const parts = identity as string[];
  const barrier = parts.length === 4;
  if (barrier && !['turn', 'task'].includes(parts[2]!)) fail();
  const ulid = '[0-7][0-9a-hjkmnp-tv-zA-HJKMNP-TV-Z]{25}';
  if (!new RegExp('^cht_' + ulid + '$').test(parts[1]!) || (!barrier && !new RegExp('^tc_' + ulid + '$').test(parts[2]!))) fail();
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  const states: readonly unknown[] = ['claimed', 'completed', 'submitted', 'ambiguous', 'resolved', 'abandoned'];
  if (!['state', 'fingerprint', 'chatId', 'turnId', 'callId'].every(k => Object.hasOwn(record, k)) || !states.includes(record.state)) fail();
  if (record.chatId !== parts[1] || typeof record.turnId !== 'string' || !new RegExp('^cmpl_' + ulid + '$').test(record.turnId) || (turnId !== undefined && record.turnId !== turnId)) fail();
  if (record.callId !== (barrier ? '' : parts[2]) || (barrier && (parts[2] === 'task' ? record.taskId !== parts[3] : record.turnId !== parts[3]))) fail();
  if (typeof record.fingerprint !== 'string' || (!/^[a-f0-9]{64}$/.test(record.fingerprint) && !(record.fingerprint === '' && (barrier || record.state === 'resolved')))) fail();
  if (record.taskId !== undefined && (typeof record.taskId !== 'string' || !record.taskId)) fail();
  const hasOutput = Object.hasOwn(record, 'output'), hasError = Object.hasOwn(record, 'isError');
  if (hasOutput !== hasError || (hasOutput && (typeof record.output !== 'string' || !record.output || Buffer.byteLength(record.output, 'utf8') > 131_072 || typeof record.isError !== 'boolean'))) fail();
  if (['completed', 'submitted', 'ambiguous'].includes(record.state as string) && !hasOutput) fail();
  if ((record.state === 'claimed' && hasOutput) || (barrier && (record.state !== 'abandoned' || record.fingerprint !== '' || hasOutput))) fail();
}
/** Implement both mutations atomically and durably before resolving, across all runner processes.
 * get returns undefined ONLY for an absent key; reject null, invalid JSON, shape, state or identity.
 * Never overwrite corrupt entries, automatically expire, or steal claims: effects may have happened.
 */
export interface ToolStateStore {
  claim(key: string, initial: ToolRecord): Promise<boolean>;
  get(key: string): Promise<ToolRecord | undefined>;
  transition(key: string, expected: readonly ToolState[], patch: Partial<ToolRecord>): Promise<boolean>;
}
/** Explicitly non-durable. Appropriate for tests or a single process where replay-after-crash is not allowed. */
export class MemoryToolStateStore implements ToolStateStore {
  readonly #records = new Map<string, ToolRecord>();
  async claim(key: string, initial: ToolRecord): Promise<boolean> {
    if (this.#records.has(key)) { assertToolRecord(key, this.#records.get(key)); return false; }
    assertToolRecord(key, initial); this.#records.set(key, structuredClone(initial)); return true;
  }
  async get(key: string): Promise<ToolRecord | undefined> {
    if (!this.#records.has(key)) return undefined;
    const value = this.#records.get(key); assertToolRecord(key, value); return structuredClone(value);
  }
  async transition(key: string, expected: readonly ToolState[], patch: Partial<ToolRecord>): Promise<boolean> {
    if (!this.#records.has(key)) return false;
    const value = this.#records.get(key); assertToolRecord(key, value);
    if (!expected.includes(value.state)) return false;
    const next = { ...value, ...patch }; assertToolRecord(key, next, value.turnId);
    if (next.fingerprint !== value.fingerprint || next.taskId !== value.taskId) throw new ToolExecutionError('Cannot change tool call identity', 'invalid_tool_state');
    this.#records.set(key, structuredClone(next)); return true;
  }
}
export interface ToolRunnerOptions {
  /** Stable, non-secret account + deployment namespace. Never use an API key here. */
  scope: string; store: ToolStateStore; registry: ClientToolRegistry; verifier: ToolRequestVerifier;
  submit: (chatId: string, body: { call_id: string; output: string; is_error: boolean }, options: RequestOptions) => Promise<void>;
  concurrency?: number; maxPending?: number; signal?: AbortSignal; onObservation?: (event: Observation) => void;
}
interface Job { taskId?: string; key: string; fingerprint: string; event: KnownEvent<'agent.tool.request'>; controller: AbortController; admitted: number; }
function controlled(code: string): { output: string; isError: true } { return { output: JSON.stringify({ code, message: `Client tool failed: ${code}` }), isError: true }; }
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(v => { cleanup(); resolve(v); }, e => { cleanup(); reject(e); });
  });
}
export class ClientToolRunner {
  readonly #options: ToolRunnerOptions; readonly #concurrency: number; readonly #maxPending: number;
  readonly #jobs = new Map<string, Job>(); readonly #queue: Job[] = []; readonly #tasks = new Set<Promise<void>>(); readonly #errors: unknown[] = [];
  readonly #failureListeners = new Set<{chatId:string;listener:(error:unknown)=>void}>();
  readonly #jobErrors: {chatId:string;error:unknown}[] = [];
  readonly #abort = new AbortController(); #admitting = 0;
  readonly #endingTurns = new Set<string>(); readonly #resolvingCalls = new Set<string>();
  constructor(options: ToolRunnerOptions) {
    if (!options.store || !['claim', 'get', 'transition'].every(method => typeof (options.store as unknown as Record<string, unknown>)[method] === 'function')) throw new TypeError('An explicit ToolStateStore is required');
    if (!options.scope.trim()) throw new TypeError('A stable account/deployment scope and explicit store are required');
    this.#options = options; this.#concurrency = positive(options.concurrency ?? 4, 'concurrency'); this.#maxPending = positive(options.maxPending ?? 64, 'maxPending');
    if (!Number.isInteger(this.#concurrency) || !Number.isInteger(this.#maxPending)) throw new RangeError('Tool limits must be integers');
  }
  key(chatId: string, callId: string): string { return JSON.stringify([this.#options.scope, chatId, callId]); }
  private turnKey(chatId: string, turnId: string): string { return JSON.stringify([this.#options.scope, chatId, 'turn', turnId]); }
  private async stored(key: string, turnId: string, fingerprint?: string): Promise<ToolRecord | undefined> {
    const value = await this.#options.store.get(key);
    if (value !== undefined) {
      assertToolRecord(key, value, turnId);
      if (fingerprint !== undefined && value.fingerprint && value.fingerprint !== fingerprint) throw new ToolExecutionError('Persisted tool fingerprint changed', 'invalid_tool_state');
    }
    return value;
  }
  private async ended(event: ATPEvent, taskId?: string): Promise<boolean> {
    if (!event.turn_id) return false;
    const key = taskId ? JSON.stringify([this.#options.scope, event.chat_id, 'task', taskId]) : this.turnKey(event.chat_id, event.turn_id);
    if (this.#endingTurns.has(key)) return true;
    return (await this.stored(key, event.turn_id)) !== undefined || this.#endingTurns.has(key);
  }
  private observe(event: Observation): void { try { this.#options.onObservation?.(event); } catch {} }
  /** Admit verified requests without awaiting handler completion, so result/terminal events remain observable. */
  async accept(input: ATPEvent): Promise<void> {
    let event = parseEvent(input); // Fail closed even when callers bypass the SSE parser.
    const signal = this.#options.signal ? AbortSignal.any([this.#abort.signal, this.#options.signal]) : this.#abort.signal;
    signal.throwIfAborted();
    let taskId: string | undefined;
    if (isEvent(event, 'task.completed') || isEvent(event, 'task.failed') || isEvent(event, 'task.cancelled')) {
      const taskKey = JSON.stringify([this.#options.scope, event.chat_id, 'task', event.data.task_id]);
      this.#endingTurns.add(taskKey);
      const jobs = [...this.#jobs.values()].filter(job => job.event.chat_id === event.chat_id && job.taskId === event.data.task_id);
      for (const job of jobs) job.controller.abort(new DOMException('Task ended', 'AbortError'));
      await this.stored(taskKey, event.data.origin_turn_id);
      await this.#options.store.claim(taskKey, { state: 'abandoned', fingerprint: '', chatId: event.chat_id, turnId: event.data.origin_turn_id, taskId: event.data.task_id, callId: '' });
      await Promise.all(jobs.map(job => this.#options.store.transition(job.key, ['claimed', 'completed', 'submitted'], { state: 'abandoned' })));
      this.#endingTurns.delete(taskKey);
      return;
    }
    if (isEvent(event, 'task.event')) {
      if (!['agent.tool.request', 'agent.tool.result'].includes(event.data.event_type)) return;
      taskId = event.data.task_id;
      // Keep the execution chat and agent, validate the actual inner payload, and verify its unchanged signature below.
      event = parseEvent({ ...event, type: event.data.event_type, data: event.data.event_payload, turn_id: event.data.origin_turn_id });
    }
    if (isEvent(event, 'agent.tool.result')) {
      const key = this.key(event.chat_id, event.data.call_id);
      this.#resolvingCalls.add(key);
      this.#jobs.get(key)?.controller.abort(new DOMException('Server resolved tool', 'AbortError'));
      const resolved = await this.stored(key, event.turn_id!);
      if (resolved && resolved.taskId !== taskId) throw new ToolExecutionError('Call ID changed task ownership', 'call_id_conflict');
      await this.#options.store.claim(key, { state: 'resolved', fingerprint: '', chatId: event.chat_id, turnId: event.turn_id!, ...(taskId ? { taskId } : {}), callId: event.data.call_id });
      await this.#options.store.transition(key, ['claimed','completed','submitted','ambiguous','abandoned'], { state: 'resolved' });
      this.#resolvingCalls.delete(key);
      return;
    }
    if (isTerminal(event)) {
      const turnKey = this.turnKey(event.chat_id, event.turn_id!);
      this.#endingTurns.add(turnKey);
      const endingJobs = [...this.#jobs.values()].filter(j => j.event.chat_id === event.chat_id && j.event.turn_id === event.turn_id && !j.taskId);
      for (const job of endingJobs) job.controller.abort(new DOMException('Turn ended', 'AbortError'));
      // Persist a turn admission barrier even if no request has arrived yet.
      await this.stored(turnKey, event.turn_id!);
      await this.#options.store.claim(turnKey, { state: 'abandoned', fingerprint: '', chatId: event.chat_id, turnId: event.turn_id!, callId: '' });
      await Promise.all(endingJobs.map(async job => {
        await this.#options.store.transition(job.key, ['claimed','completed','submitted'], { state: 'abandoned' });
      }));
      this.#endingTurns.delete(turnKey);
      return;
    }
    if (!isEvent(event, 'agent.tool.request')) return;
    const admitted = Date.now();
    await this.#options.verifier.verify(event.data, signal);
    const key = this.key(event.chat_id, event.data.call_id);
    const fingerprint = createHash('sha256').update(event.data.call_id + '\n' + event.data.tool_name + '\n' + canonicalize(event.data.args)).digest('hex');
    if (this.#resolvingCalls.has(key) || await this.ended(event, taskId)) return;
    const existing = await this.stored(key, event.turn_id!);
    if (this.#resolvingCalls.has(key)) return;
    if (existing !== undefined) { if (existing.taskId !== taskId) throw new ToolExecutionError('Call ID changed task ownership', 'call_id_conflict'); if (existing.fingerprint && existing.fingerprint !== fingerprint) throw new ToolExecutionError('Call ID reused with different arguments', 'call_id_conflict'); return; }
    if (this.#jobs.size + this.#admitting >= this.#maxPending) throw new ToolExecutionError('Client tool queue is full', 'queue_full');
    const record: ToolRecord = { state: 'claimed', fingerprint, chatId: event.chat_id, turnId: event.turn_id!, ...(taskId ? { taskId } : {}), callId: event.data.call_id };
    this.#admitting++;
    let claimed: boolean;
    try { claimed = await this.#options.store.claim(key, record); } finally { this.#admitting--; }
    if (!claimed) return;
    if (this.#resolvingCalls.has(key) || await this.ended(event, taskId)) {
      await this.#options.store.transition(key, ['claimed'], { state: 'abandoned' }); return;
    }
    const current = await this.stored(key, event.turn_id!, fingerprint);
    if (current?.state !== 'claimed' || this.#resolvingCalls.has(key)) return;
    const job: Job = { taskId, key, fingerprint, event, controller: new AbortController(), admitted };
    this.#jobs.set(key, job); this.#queue.push(job); this.pump();
  }
  private pump(): void {
    while (this.#tasks.size < this.#concurrency && this.#queue.length) {
      const job = this.#queue.shift()!;
      const task = this.execute(job).catch(error => { this.#errors.push(error); this.#jobErrors.push({chatId:job.event.chat_id,error}); for(const subscription of this.#failureListeners) if(subscription.chatId===job.event.chat_id) { try { subscription.listener(error); } catch { /* observers cannot mask failure */ } } }).finally(() => { this.#tasks.delete(task); this.#jobs.delete(job.key); this.pump(); });
      this.#tasks.add(task);
    }
  }
  private async execute(job: Job): Promise<void> {
    const { event, key, taskId } = job;
    const registered = this.#options.registry.get(event.data.tool_name);
    const timeout = new AbortController();
    const signal = AbortSignal.any([job.controller.signal, this.#abort.signal, timeout.signal, ...(this.#options.signal ? [this.#options.signal] : [])]);
    let timer: ReturnType<typeof setTimeout> | undefined; let handler: Promise<unknown> | undefined;
    this.observe({ kind: 'tool.start', chatId: event.chat_id, turnId: event.turn_id, callId: event.data.call_id });
    try {
      signal.throwIfAborted();
      if (await this.ended(event, taskId) || (await this.stored(key, event.turn_id!, job.fingerprint))?.state !== 'claimed') {
        await this.#options.store.transition(key, ['claimed'], { state: 'abandoned' }); return;
      }
      signal.throwIfAborted();
      const remaining = job.admitted + (registered?.timeoutMs ?? 108_000) - Date.now();
      let result: { output: string; isError: boolean };
      if (remaining <= 0) result = controlled('tool_timeout');
      else if (!registered) result = controlled('unknown_tool');
      else if (!registered.validate(event.data.args)) result = controlled('invalid_arguments');
      else {
        timer = setTimeout(() => timeout.abort(new DOMException('Local tool deadline exceeded', 'TimeoutError')), remaining);
        try {
          handler = Promise.resolve().then(() => { signal.throwIfAborted(); return registered.definition.handler(event.data.args, { signal, chatId: event.chat_id, turnId: event.turn_id!, ...(taskId ? { taskId } : {}), callId: event.data.call_id, idempotencyKey: key }); });
          const value = await abortable(handler, signal);
          const output = typeof value === 'string' ? value : JSON.stringify(value);
          result = typeof output !== 'string' ? controlled('invalid_output') : output.length === 0 ? controlled('empty_output') : Buffer.byteLength(output, 'utf8') > 131_072 ? controlled('output_too_large') : { output, isError: false };
        } catch { if (job.controller.signal.aborted || this.#abort.signal.aborted || this.#options.signal?.aborted) throw signal.reason; result = controlled(timeout.signal.aborted ? 'tool_timeout' : 'handler_error'); }
      }
      clearTimeout(timer);
      if (!await this.#options.store.transition(key, ['claimed'], { state: 'completed', ...result })) return;
      // The local execution deadline does not cancel the one permitted delivery of its timeout result.
      const deliverySignal = AbortSignal.any([job.controller.signal, this.#abort.signal, ...(this.#options.signal ? [this.#options.signal] : [])]);
      deliverySignal.throwIfAborted();
      try {
        await this.#options.submit(event.chat_id, { call_id: event.data.call_id, output: result.output, is_error: result.isError }, { signal: deliverySignal });
        await this.#options.store.transition(key, ['completed'], { state: 'submitted' });
      } catch (error) {
        // A 409/404 or dropped response never proves successful delivery. Wait for the matching result or reconcile.
        await this.#options.store.transition(key, ['completed'], { state: 'ambiguous' });
        throw error;
      }
    } catch (error) {
      if (job.controller.signal.aborted || this.#abort.signal.aborted || this.#options.signal?.aborted) await this.#options.store.transition(key, ['claimed','completed'], { state: 'abandoned' });
      else throw error;
    } finally {
      clearTimeout(timer);
      // Preserve the actual concurrency bound even if a handler ignores cooperative cancellation.
      if (handler) await handler.catch(() => {});
      this.observe({ kind: 'tool.end', chatId: event.chat_id, turnId: event.turn_id, callId: event.data.call_id });
    }
  }
  /** Observe delivery/storage failures for a chat without consuming errors or taking ownership of the runner. */
  onFailure(chatId: string, listener: (error: unknown) => void): () => void {
    const subscription={chatId,listener}; this.#failureListeners.add(subscription);
    for(const failure of this.#jobErrors) if(failure.chatId===chatId) { try { listener(failure.error); } catch { /* observers cannot mask failure */ } }
    return () => { this.#failureListeners.delete(subscription); };
  }
  /** Wait for admitted jobs; errors include ambiguous submission outcomes. A noncooperative handler can keep a slot occupied. */
  async drain(signal?: AbortSignal): Promise<void> {
    while (this.#tasks.size || this.#queue.length) await (signal ? abortable(Promise.all([...this.#tasks]), signal) : Promise.all([...this.#tasks]));
    if (this.#errors.length) { this.#jobErrors.length=0; throw new AggregateError(this.#errors.splice(0), 'Client tool jobs failed; inspect durable state before reconciliation'); }
  }
  close(): void { this.#abort.abort(new DOMException('Tool runner closed', 'AbortError')); }
  async run(events: AsyncIterable<ATPEvent>): Promise<void> { try { for await (const event of events) await this.accept(event); await this.drain(this.#options.signal); } finally { this.close(); } }
}
