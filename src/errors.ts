/** API failures preserve the server's machine-readable fields; never retain credentials or URLs. */
export class EnvaiError extends Error {
  constructor(message: string, readonly httpStatus: number, readonly type: string,
    readonly code: string | null = null, readonly details: unknown = null, readonly requestId: string | null = null) {
    super(message); this.name = new.target.name;
  }
}
export class AuthenticationError extends EnvaiError {}
export class AccessDeniedError extends EnvaiError {}
export class NotFoundError extends EnvaiError {}
export class ConflictError extends EnvaiError {}
export class ValidationError extends EnvaiError {}
export class RateLimitError extends EnvaiError {}
export class ProviderError extends EnvaiError {}
export class FileError extends EnvaiError {}
export class ServerError extends EnvaiError {}
export class TransportError extends Error { constructor(message = 'HTTP transport failed; outcome of a mutation may be unknown') { super(message); this.name = new.target.name; } }
export class ProtocolError extends Error { constructor(message: string, readonly raw?: unknown) { super(message); this.name = new.target.name; } }
export class ReplayGapError extends ProtocolError {
  constructor(readonly lastSeq: number, readonly receivedSeq: number) { super(`Replay gap: expected ${lastSeq + 1}, received ${receivedSeq}`); }
}
export class SignatureError extends Error { constructor(message: string) { super(message); this.name = new.target.name; } }
export class ToolExecutionError extends Error { constructor(message: string, readonly code: string) { super(message); this.name = new.target.name; } }
export function apiError(status: number, body: unknown, requestId: string | null): EnvaiError {
  const root = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const err = root.error && typeof root.error === 'object' ? root.error as Record<string, unknown> : {};
  const type = typeof err.type === 'string' ? err.type : 'http_error';
  const Klass = type.startsWith('file_') ? FileError : type === 'provider_error' ? ProviderError
    : status === 401 ? AuthenticationError : status === 403 ? AccessDeniedError : status === 404 ? NotFoundError
    : status === 409 ? ConflictError : status === 422 || status === 400 ? ValidationError
    : status === 429 ? RateLimitError : status >= 500 ? ServerError : EnvaiError;
  return new Klass(typeof err.message === 'string' ? err.message : `HTTP ${status}`, status, type,
    typeof err.code === 'string' ? err.code : null, err.details ?? null, requestId);
}
