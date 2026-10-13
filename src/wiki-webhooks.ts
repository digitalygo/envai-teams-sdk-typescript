import { createHash, createPublicKey, verify } from 'node:crypto';
import { SignatureError } from './errors.js';
import { validateContractValue } from './contract.js';
import { positive } from './http.js';
import type { JwksSource } from './security.js';
import type { WikiWebhookEvent } from './generated.js';

/** Prefer IncomingMessage.rawHeaders or raw tuples: duplicate signing headers are rejected, not collapsed. */
export type WikiWebhookHeaders = Headers | ReadonlyArray<readonly [string, string]> | ReadonlyArray<string> | Record<string, string | string[] | undefined>;
export interface WikiWebhookRequest { method: string; headers: WikiWebhookHeaders; rawBody: Uint8Array; }
export interface VerifiedWikiWebhook { event: WikiWebhookEvent; rawBody: Uint8Array; payloadHash: string; }
const names = ['envai-webhook-id', 'envai-webhook-timestamp', 'envai-webhook-key-id', 'envai-webhook-signature'] as const;
function signingHeaders(input: WikiWebhookHeaders): Record<typeof names[number], string> {
  const entries: Array<[string, string | string[] | undefined]> = [];
  if (input instanceof Headers) entries.push(...input.entries());
  else if (Array.isArray(input)) {
    if (input.length && typeof input[0] === 'string') {
      if (input.length % 2) throw new SignatureError('Malformed raw headers');
      for (let n = 0; n < input.length; n += 2) entries.push([input[n] as string, input[n + 1] as string]);
    } else for (const pair of input as ReadonlyArray<readonly [string, string]>) {
      if (!Array.isArray(pair) || pair.length !== 2) throw new SignatureError('Malformed header pair');
      entries.push([pair[0], pair[1]]);
    }
  } else entries.push(...Object.entries(input));
  const result: Record<string, string> = {};
  let contentType: string | undefined;
  for (const [name, value] of entries) {
    if (typeof name !== 'string') throw new SignatureError('Malformed header name');
    const key = name.toLowerCase();
    if (key === 'content-type') {
      if (contentType !== undefined || typeof value !== 'string') throw new SignatureError('Duplicate or malformed wiki content type');
      contentType = value.split(';', 1)[0]!.trim().toLowerCase();
      if (!/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/.test(contentType)) throw new SignatureError('Wiki webhook content type must be JSON');
      continue;
    }
    if (!names.includes(key as typeof names[number])) continue;
    if (Object.hasOwn(result, key) || typeof value !== 'string' || !/^[!-~]+$/.test(value) || value.includes(',')) throw new SignatureError('Duplicate or malformed wiki signing header');
    result[key] = value;
  }
  if (contentType === undefined) throw new SignatureError('Missing wiki content type');
  if (names.some(key => !result[key])) throw new SignatureError('Missing wiki signing header');
  return result as Record<typeof names[number], string>;
}
function decode(value: string, size: number): Buffer {
  if (typeof value !== 'string') throw new SignatureError('Missing signature or key bytes');
  const bytes = Buffer.from(value, 'base64url');
  if (!/^[A-Za-z0-9_-]+$/.test(value) || bytes.length !== size || bytes.toString('base64url') !== value) throw new SignatureError('Non-canonical wiki signature or key');
  return bytes;
}
/** Outgoing Envai Ed25519 protocol only. This never verifies inbound provider HMAC callbacks. */
export class WikiWebhookVerifier {
  readonly #maxBody: number; readonly #tolerance: number; readonly #now: () => number;
  constructor(readonly jwks: JwksSource, readonly workspaceId: string,
    options: { maxBodyBytes?: number; toleranceSeconds?: number; now?: () => number } = {}) {
    if (!workspaceId || /[\x00-\x20\x7f]/.test(workspaceId)) throw new TypeError('Expected workspace is required');
    this.#maxBody = positive(options.maxBodyBytes ?? 1_048_576, 'maxBodyBytes');
    this.#tolerance = positive(options.toleranceSeconds ?? 300, 'toleranceSeconds', true);
    if (this.#tolerance > 300) throw new RangeError('Wiki replay tolerance cannot exceed 300 seconds');
    this.#now = options.now ?? (() => Date.now() / 1000);
  }
  async verify(request: WikiWebhookRequest, signal?: AbortSignal): Promise<VerifiedWikiWebhook> {
    signal?.throwIfAborted();
    if (typeof request.method !== 'string' || request.method.toUpperCase() !== 'POST') throw new SignatureError('Wiki webhooks require POST');
    if (!(request.rawBody instanceof Uint8Array) || request.rawBody.byteLength > this.#maxBody) throw new SignatureError('Invalid or oversized wiki body');
    const rawBody = Buffer.from(request.rawBody); // Own the exact verified bytes across async key resolution.
    const h = signingHeaders(request.headers), eventId = h['envai-webhook-id'], kid = h['envai-webhook-key-id'], timestamp = h['envai-webhook-timestamp'];
    const now = this.#now();
    if (!/^[A-Za-z0-9_-]{1,255}$/.test(eventId) || !/^[A-Za-z0-9_-]{1,255}$/.test(kid) || !/^[1-9][0-9]{0,10}$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp)) || !Number.isFinite(now) || Math.abs(now - Number(timestamp)) > this.#tolerance) throw new SignatureError('Invalid or expired wiki delivery timestamp');
    const signature = decode(h['envai-webhook-signature'], 64);
    const payloadHash = createHash('sha256').update(rawBody).digest('hex');
    const message = Buffer.from(`envai-webhook-v1\n${kid}\n${eventId}\n${timestamp}\n${payloadHash}`, 'utf8');
    let document = await this.jwks.get(false, signal);
    if (!document.keys.some(key => key.kid === kid)) document = await this.jwks.get(true, signal);
    const matches = document.keys.filter(key => key.kid === kid), key = matches[0];
    if (matches.length !== 1 || !key || key.kty !== 'OKP' || key.crv !== 'Ed25519' || key.alg !== 'EdDSA' || key.use !== 'sig' || key.key_ops !== undefined && (!Array.isArray(key.key_ops) || !key.key_ops.includes('verify')) || 'd' in key) throw new SignatureError('Untrusted wiki signing key');
    decode(key.x, 32);
    let valid = false;
    try { valid = verify(null, message, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.x }, format: 'jwk' }), signature); }
    catch { throw new SignatureError('Invalid wiki public key'); }
    if (!valid) throw new SignatureError('Invalid wiki signature');
    signal?.throwIfAborted();
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)); } catch { throw new SignatureError('Invalid wiki JSON body'); }
    const event = validateContractValue<WikiWebhookEvent>('WikiWebhookEvent', payload);
    if (event.event_id !== eventId || event.workspace_id !== this.workspaceId) throw new SignatureError('Wiki event identity or workspace mismatch');
    return { event, rawBody, payloadHash };
  }
}
