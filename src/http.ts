import { CompatibilityError, hasCapabilityFeature, validateBackgroundRequest, validateResponse, type ContractVersion } from './contract.js';
import { apiError, EnvaiError, ProtocolError, TransportError } from './errors.js';
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface RequestOptions { signal?: AbortSignal; headers?: HeadersInit; }
export type SourceProcessing = 'convert' | 'original';
export function sourceProcessing(value: unknown): SourceProcessing {
  if (value === undefined || value === 'convert') return 'convert';
  if (value === 'original') return 'original';
  throw new TypeError('Source processing must be convert or original');
}
export interface Observation {
  kind: 'request.start' | 'request.end' | 'request.retry' | 'stream.open' | 'stream.close' | 'stream.reconnect' | 'event' | 'tool.start' | 'tool.end';
  operation?: string; method?: string; status?: number; durationMs?: number; attempt?: number;
  eventType?: string; eventId?: string; seq?: number; chatId?: string; turnId?: string | null; callId?: string;
}
export interface ClientOptions {
  apiKey?: string; baseUrl: string;
  /** Contract 2 permits only historical reads. Contract 3 is the default. */
  contractVersion?: ContractVersion;
  /** Opt in to native detached-task events and model diagnostics. Requires contract 3. */
  nativeTasks?: boolean; jwksUrl?: string; fetch?: Fetch;
  requestTimeoutMs?: number; streamConnectTimeoutMs?: number;
  retry?: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number };
  onObservation?: (event: Observation) => void;
}
export interface Operation {
  readonly id: string; readonly method: string; readonly path: string; readonly public: boolean; readonly origin: boolean;
  readonly parameters: readonly { readonly name: string; readonly in: string; readonly required: boolean }[];
  readonly bodyMime?: string; readonly bodyRequired: boolean; readonly mode: string; readonly unwrap: boolean;
}
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export function positive(value: number, name: string, allowZero = false): number {
  if (!Number.isFinite(value) || value < (allowZero ? 0 : 1)) throw new RangeError(`Invalid ${name}`);
  return value;
}
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return;
  const seconds = Number(header);
  const result = /^\d+(\.\d+)?$/.test(header) ? seconds * 1000 : Date.parse(header) - now;
  return Number.isFinite(result) ? Math.max(0, result) : undefined;
}
export class HttpTransport {
  readonly nativeTasks: boolean;
  readonly baseUrl: string; readonly jwksUrl: string; readonly #contractVersion: ContractVersion;
  readonly #key?: string; readonly #fetch: Fetch; readonly #observe?: ClientOptions['onObservation'];
  readonly #timeout: number; readonly #connectTimeout: number; readonly #retries: number; readonly #baseDelay: number; readonly #maxDelay: number;
  constructor(options: ClientOptions) {
    this.#contractVersion = options.contractVersion ?? 3;
    this.nativeTasks = options.nativeTasks ?? false;
    if (this.nativeTasks && this.contractVersion !== 3) throw new CompatibilityError('Native tasks require contract 3');
    if (this.contractVersion !== 2 && this.contractVersion !== 3) throw new TypeError('Unsupported contractVersion');
    const base = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new TypeError('baseUrl must be an HTTP(S) URL without credentials, query, or fragment');
    if (base.pathname === '/') base.pathname = '/api/v1';
    this.baseUrl = base.href.replace(/\/+$/, '');
    this.jwksUrl = options.jwksUrl ?? new URL('/.well-known/jwks.json', base.origin).href;
    const jwks = new URL(this.jwksUrl);
    if (!['http:', 'https:'].includes(jwks.protocol) || jwks.username || jwks.password) throw new TypeError('Invalid jwksUrl');
    this.#key = options.apiKey; this.#fetch = options.fetch ?? globalThis.fetch; this.#observe = options.onObservation;
    this.#timeout = positive(options.requestTimeoutMs ?? 30_000, 'requestTimeoutMs');
    this.#connectTimeout = positive(options.streamConnectTimeoutMs ?? 15_000, 'streamConnectTimeoutMs');
    this.#retries = positive(options.retry?.maxRetries ?? 2, 'maxRetries', true);
    if (!Number.isInteger(this.#retries)) throw new RangeError('maxRetries must be an integer');
    this.#baseDelay = positive(options.retry?.baseDelayMs ?? 250, 'baseDelayMs', true);
    this.#maxDelay = positive(options.retry?.maxDelayMs ?? 30_000, 'maxDelayMs', true);
  }
  get contractVersion(): ContractVersion { return this.#contractVersion; }
  async negotiate(options: RequestOptions = {}): Promise<{ features?: string[] }> {
    if (this.contractVersion !== 3) throw new CompatibilityError('Contract 2 cannot start tracked work');
    return this.request<{ features?: string[] }>({ id: 'negotiateContract', method: 'GET', path: '/atp/v3/capabilities', public: false, origin: false, parameters: [], bodyRequired: false, mode: 'json', unwrap: false }, {}, options);
  }
  observe(event: Observation): void { try { this.#observe?.(Object.freeze({ ...event })); } catch { /* Telemetry cannot change protocol behavior. */ } }
  async request<T>(operation: Operation, params: object, options: RequestOptions = {}): Promise<T> {
    const values = params as Record<string, unknown>;
    validateBackgroundRequest(operation.id, values.body);
    const sourceMode = operation.id === 'uploadWikiSource' ? sourceProcessing((values.body as { processing?: unknown } | undefined)?.processing) : undefined;
    let path = operation.path;
    if (operation.id.endsWith('Legacy') && this.contractVersion !== 2) throw new CompatibilityError('Legacy operations require contractVersion: 2');
    const atp = path.startsWith('/chats/') || path.startsWith('/atp/v3/') || path === '/capabilities';
    const wiki = !operation.public && /\/(wiki|files\/sources)(\/|$)/.test(path);
    const attachment = /\/chats\/[^/]+\/attachments(\/|$)/.test(path);
    const backgroundFeature = ({ deliverWorkflowResult: 'native_deliveries', delegateToTeam: 'cross_team_delegation', getDetachedTask: 'detached_background', cancelDetachedTask: 'detached_background', classifyPhase: 'phase_classification' } as Record<string, string>)[operation.id];
    if (!this.nativeTasks && (backgroundFeature || (values.body as { strict_model?: unknown } | undefined)?.strict_model === true)) throw new CompatibilityError('Create the client with nativeTasks: true to opt in to native-tasks-v1');
    const negotiated = atp || wiki || attachment || /\/completions(\/|$)/.test(path);
    if (this.contractVersion === 2 && (wiki || attachment || operation.method !== 'GET')) throw new CompatibilityError('Contract 2 is historical read-only; wiki requires contract 3');
    if (atp) path = this.contractVersion === 3 ? '/atp/v3' + path.replace(/^\/atp\/v3/, '') : path.replace(/^\/atp\/v3/, '');
    const query = new URLSearchParams();
    const headers = new Headers(options.headers);
    // Neither a hook nor per-call headers may overwrite credentials or smuggle an alternative host.
    if (headers.has('authorization') || headers.has('host') || headers.has('x-envai-contract-version') || headers.has('x-envai-extensions')) throw new TypeError('Reserved request header');
    for (const p of operation.id === 'downloadArtifact' ? [...operation.parameters].sort((a, b) => a.name.localeCompare(b.name)) : operation.parameters) {
      const v = p.in === 'header' ? (p.name === 'Idempotency-Key' ? values.idempotencyKey ?? headers.get(p.name) : p.name === 'X-Envai-Contract-Version' ? this.contractVersion : p.name === 'X-Envai-Extensions' ? (this.nativeTasks ? 'native-tasks-v1' : undefined) : headers.get(p.name)) : values[p.name];
      if (p.required && (v === undefined || v === null || v === '')) throw new TypeError(`Missing ${p.name}`);
      if (v === undefined || v === null) continue;
      if (p.in === 'header') {
        if (p.name === 'Idempotency-Key' && (typeof v !== 'string' || !/^[!-~]{1,255}$/.test(v))) throw new TypeError('Invalid Idempotency-Key');
        if (p.name !== 'X-Envai-Contract-Version') headers.set(p.name, String(v));
      } else if (p.in === 'path') {
        if (String(v) === '.' || String(v) === '..') throw new TypeError('Invalid path segment');
        path = path.replace(`{${p.name}}`, encodeURIComponent(String(v)));
      } else if (p.in === 'query') query.set(p.name, String(v));
    }
    if (operation.id === 'getWikiCategoryIndex') {
      const all = values.all === true;
      if (all ? values.from !== undefined || values.to !== undefined : !Number.isSafeInteger(values.from) || !Number.isSafeInteger(values.to) || Number(values.from) < 1 || Number(values.to) < Number(values.from)) throw new TypeError('Choose all=true or inclusive positive from/to');
      if (values.type !== undefined && values.type !== 'raw' && values.type !== 'artifact') throw new TypeError('Invalid category entry type');
      if (values.catalog_revision !== undefined && (!Number.isSafeInteger(values.catalog_revision) || Number(values.catalog_revision) < 0)) throw new TypeError('Invalid catalog_revision');
    }
    if (['uploadWikiSource', 'uploadChatAttachment'].includes(operation.id)) {
      const file = (values.body as { file?: unknown } | undefined)?.file;
      if (!(file instanceof Blob) || file.size > 1_000_000_000) throw new TypeError('Source file must be a Blob of at most 1,000,000,000 bytes');
    }
    if (operation.bodyRequired && values.body === undefined) throw new TypeError('Missing request body');
    let url = operation.id === 'getJwks' ? this.jwksUrl : operation.origin ? new URL(path, new URL(this.baseUrl).origin).href : this.baseUrl + path;
    if (query.size) url += (url.includes('?') ? '&' : '?') + query.toString();
    if (negotiated) {
      headers.set('X-Envai-Contract-Version', String(this.contractVersion));
      if (this.nativeTasks) headers.set('X-Envai-Extensions', 'native-tasks-v1');
    }
    headers.set('accept', operation.mode === 'stream' ? 'text/event-stream' : operation.mode === 'binary' ? '*/*' : 'application/json');
    headers.set('user-agent', `envai-typescript/0.1.0-alpha.1 (node/${process.versions.node})`);
    if (!operation.public && this.#key) headers.set('authorization', `Bearer ${this.#key}`);
    let body: BodyInit | undefined;
    if (values.body !== undefined) {
      if (operation.bodyMime === 'multipart/form-data') {
        const data = new FormData();
        for (const [key, value] of Object.entries(values.body as object)) {
          if (operation.id === 'uploadWikiSource' && key === 'processing' && sourceMode === 'convert') continue;
          if (value instanceof Blob) data.append(key, value);
          else if (value !== undefined && value !== null) data.append(key, typeof value === 'string' ? value : JSON.stringify(value));
        }
        headers.delete('content-type'); body = data;
      } else { headers.set('content-type', 'application/json'); body = JSON.stringify(values.body); }
    }
    const attachmentIds = operation.id === 'sendChatMessage' ? (values.body as { attachment_ids?: string[] } | undefined)?.attachment_ids ?? [] : [];
    if (attachmentIds.length && !headers.has('Idempotency-Key')) throw new TypeError('Attachment messages require Idempotency-Key');
    if (negotiated && (operation.method !== 'GET' || backgroundFeature)) {
      const capabilities = await this.negotiate(options);
      const required = [backgroundFeature];
      if (this.nativeTasks && atp) required.push('detached_background');
      const request = values.body as { strict_model?: boolean; notify_origin?: boolean } | undefined;
      if (request?.strict_model === true) required.push('strict_model');
      if (operation.id === 'delegateToTeam' && request?.notify_origin === false) required.push('delegation_notify_origin');
      for (const feature of required) if (feature && !hasCapabilityFeature(capabilities.features, feature)) throw new CompatibilityError(`Server does not advertise ${feature}`);
      if (operation.id === 'uploadChatAttachment') {
        if (!hasCapabilityFeature(capabilities.features, 'chat_attachments')) throw new CompatibilityError('Server does not advertise chat_attachments');
        if (!hasCapabilityFeature(capabilities.features, 'chat_attachment_originals')) throw new CompatibilityError('Server does not advertise chat_attachment_originals');
      } else if ((attachment || attachmentIds.length > 0) && !hasCapabilityFeature(capabilities.features, 'chat_attachments')) throw new CompatibilityError('Server does not advertise chat_attachments');
      if (operation.id === 'uploadWikiSource' && sourceMode === 'original' && !hasCapabilityFeature(capabilities.features, 'wiki_original_sources')) throw new CompatibilityError('Server does not advertise wiki_original_sources');
    }
    for (let attempt = 0; ; attempt++) {
      options.signal?.throwIfAborted();
      const controller = new AbortController();
      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), operation.mode === 'stream' ? this.#connectTimeout : this.#timeout);
      const start = Date.now();
      let response: Response | undefined;
      this.observe({ kind: 'request.start', operation: operation.id, method: operation.method, attempt });
      try {
        response = await this.#fetch(url, { method: operation.method, headers, body, signal, redirect: 'manual' });
        if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new ProtocolError('Redirect refused; credentials and signed URLs must not be forwarded'); }
        if (!response.ok) {
          let data: unknown; try { data = await response.json(); } catch { data = null; }
          if (negotiated && (response.status === 426 || response.status === 404 && atp && !backgroundFeature || (data as { error?: { code?: string } } | null)?.error?.code === 'unsupported_contract_version')) throw new CompatibilityError('Selected Envai contract is not supported by this server');
          throw apiError(response.status, data, response.headers.get('x-request-id'));
        }
        if (negotiated && response.headers.get('X-Envai-Contract-Version') !== String(this.contractVersion)) { await response.body?.cancel(); throw new CompatibilityError('Missing or mismatched contract acknowledgment; mutation outcome may be unknown'); }
        if (atp && this.nativeTasks && response.headers.get('X-Envai-Extensions') !== 'native-tasks-v1') { await response.body?.cancel(); throw new CompatibilityError('Missing or mismatched native extension acknowledgment; mutation outcome may be unknown'); }
        if (operation.mode === 'stream' || operation.mode === 'binary') return response as T;
        if (operation.mode === 'empty') return undefined as T;
        let data: unknown;
        try { data = await response.json(); } catch { throw new ProtocolError('Invalid JSON response'); }
        if (operation.unwrap) {
          if (!data || typeof data !== 'object' || !('data' in data)) throw new ProtocolError('Missing resource data envelope', data);
          return validateResponse(operation.id, (data as { data: T }).data, this.contractVersion) as T;
        }
        if (attachmentIds.length && JSON.stringify((data as { attachment_ids?: string[] }).attachment_ids) !== JSON.stringify(attachmentIds)) throw new ProtocolError('Message acceptance omitted or changed attachment IDs', data);
        return validateResponse(operation.id, data, this.contractVersion) as T;
      } catch (error) {
        options.signal?.throwIfAborted();
        if (controller.signal.aborted) throw controller.signal.reason;
        const transient = error instanceof EnvaiError ? [429,502,503,504].includes(error.httpStatus) : !(error instanceof ProtocolError);
        if (operation.method !== 'GET' || !transient || attempt >= this.#retries) throw error instanceof EnvaiError || error instanceof ProtocolError ? error : new TransportError();
        const wait = Math.min(this.#maxDelay, retryAfterMs(response?.headers.get('retry-after') ?? null) ?? this.#baseDelay * 2 ** attempt * (0.5 + Math.random()));
        this.observe({ kind: 'request.retry', operation: operation.id, method: operation.method, status: response?.status, attempt: attempt + 1 });
        clearTimeout(timer);
        await delay(wait, options.signal);
      } finally {
        clearTimeout(timer);
        this.observe({ kind: 'request.end', operation: operation.id, method: operation.method, status: response?.status, durationMs: Date.now() - start, attempt });
      }
    }
  }
}
