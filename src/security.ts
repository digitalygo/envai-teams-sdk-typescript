import { createPublicKey, verify } from 'node:crypto';
import { SignatureError } from './errors.js';
import { positive } from './http.js';
import type { AtpAgentToolRequest } from './event-types.js';

function validUnicode(s: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const next = s.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) throw new SignatureError('Unpaired Unicode surrogate'); }
    else if (c >= 0xdc00 && c <= 0xdfff) throw new SignatureError('Unpaired Unicode surrogate');
  }
}
/** RFC 8785: ECMAScript number serialization and UTF-16 key sorting, recursively. */
export function canonicalize(value: unknown): string {
  const seen = new Set<object>();
  function visit(v: unknown): string {
    if (v === null) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') { if (!Number.isFinite(v)) throw new SignatureError('Non-finite JSON number'); return JSON.stringify(v); }
    if (typeof v === 'string') { validUnicode(v); return JSON.stringify(v); }
    if (typeof v !== 'object') throw new SignatureError('Value is not JSON');
    if (seen.has(v)) throw new SignatureError('Cyclic JSON');
    seen.add(v);
    try {
      if (Array.isArray(v)) { if (Object.keys(v).length !== v.length) throw new SignatureError('Sparse or extended arrays are not JSON'); return '[' + v.map(visit).join(',') + ']'; }
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new SignatureError('Non-JSON object');
      if (Object.getOwnPropertySymbols(v).length) throw new SignatureError('Symbol keys are not JSON');
      const descriptors = Object.getOwnPropertyDescriptors(v);
      return '{' + Object.keys(v).sort().map(key => {
        validUnicode(key); const descriptor = descriptors[key]!;
        if (!Object.hasOwn(descriptor, 'value')) throw new SignatureError('JSON accessors are not allowed');
        return JSON.stringify(key) + ':' + visit(descriptor.value);
      }).join(',') + '}';
    } finally { seen.delete(v); }
  }
  return visit(value);
}
export interface SigningJwk { kid: string; kty: string; crv: string; x: string; alg?: string; use?: string; key_ops?: string[]; [key: string]: unknown; }
export interface SigningJwks { keys: SigningJwk[]; }
export interface JwksSource { get(forceRefresh: boolean, signal?: AbortSignal): Promise<SigningJwks>; }
/** Cache only public keys. A custom source can implement application-specific caching. */
export class JwksCache implements JwksSource {
  #value?: SigningJwks; #expires = 0; #pending?: Promise<SigningJwks>;
  constructor(readonly load: (signal?: AbortSignal) => Promise<SigningJwks>, readonly ttlMs = 300_000) { positive(ttlMs, 'ttlMs', true); }
  async get(forceRefresh = false, signal?: AbortSignal): Promise<SigningJwks> {
    signal?.throwIfAborted();
    if (!forceRefresh && this.#value && Date.now() < this.#expires) return this.#value;
    if (!this.#pending) this.#pending = this.load(signal).then(value => {
      if (!value || !Array.isArray(value.keys) || value.keys.length > 128) throw new SignatureError('Invalid JWKS');
      this.#value = value; this.#expires = Date.now() + this.ttlMs; return value;
    }).finally(() => { this.#pending = undefined; });
    const result = await this.#pending; signal?.throwIfAborted(); return result;
  }
}
function base64url(value: string, length: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new SignatureError('Invalid unpadded base64url');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== length || bytes.toString('base64url') !== value) throw new SignatureError('Invalid signature or public key length');
  return bytes;
}
export class ToolRequestVerifier {
  constructor(readonly jwks: JwksSource) {}
  async verify(request: AtpAgentToolRequest, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (request.signature?.alg !== 'EdDSA' || !request.signature.kid || request.kind !== 'client') throw new SignatureError('Unsupported client tool signature');
    const signature = base64url(request.signature.sig, 64);
    const payload = Buffer.from(request.call_id + '\n' + request.tool_name + '\n' + canonicalize(request.args), 'utf8');
    for (let attempt = 0; attempt < 2; attempt++) {
      const document = await this.jwks.get(attempt > 0, signal);
      const matches = document.keys.filter(k => k.kid === request.signature.kid);
      const key = matches.length === 1 ? matches[0] : undefined;
      if (key && key.kty === 'OKP' && key.crv === 'Ed25519' && (!key.alg || key.alg === 'EdDSA') && (!key.use || key.use === 'sig') && (!key.key_ops || key.key_ops.includes('verify')) && !('d' in key)) {
        let verified = false;
        try {
          base64url(key.x, 32);
          const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.x }, format: 'jwk' });
          verified = verify(null, payload, publicKey, signature);
        } catch (error) { if (!(error instanceof SignatureError)) throw new SignatureError('Invalid JWKS key'); }
        if (verified) { signal?.throwIfAborted(); return; }
      }
    }
    throw new SignatureError('Client tool signature verification failed after JWKS refresh');
  }
}
