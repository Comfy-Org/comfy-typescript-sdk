/**
 * The shared error envelope mapped to a typed exception per `code`.
 *
 * This is the `low` (protocol) view of errors: one class per documented error
 * `code`, plus a fallback. The `sdk` layer re-raises these as its own
 * idiomatic exceptions where it adds value (e.g. `JobFailed` carrying node
 * details), but the protocol codes are defined here so the generated layer
 * has a stable, typed error surface. Mirrors `comfy_low.errors` in the
 * Python SDK.
 */

export interface ApiErrorOptions {
  code?: string;
  httpStatus: number;
  details?: Record<string, unknown> | null;
  retryAfter?: number | null;
}

export class ApiError extends Error {
  static readonly code: string = "error";

  readonly code: string;
  readonly httpStatus: number;
  readonly details: Record<string, unknown> | null;
  readonly retryAfter: number | null;

  constructor(message: string, options: ApiErrorOptions) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? (new.target as typeof ApiError).code;
    this.httpStatus = options.httpStatus;
    this.details = options.details ?? null;
    this.retryAfter = options.retryAfter ?? null;
  }
}

export class InvalidWorkflow extends ApiError {
  static override readonly code = "invalid_workflow";
}

export class WorkflowFormatUi extends ApiError {
  static override readonly code = "workflow_format_ui";
}

export class MissingAsset extends ApiError {
  static override readonly code = "missing_asset";
}

export class HashMismatch extends ApiError {
  static override readonly code = "hash_mismatch";
}

export class BlobNotFound extends ApiError {
  static override readonly code = "blob_not_found";
}

export class IdempotencyKeyReuse extends ApiError {
  static override readonly code = "idempotency_key_reuse";
}

export class QueueFull extends ApiError {
  static override readonly code = "queue_full";
}

export class InsufficientCredits extends ApiError {
  static override readonly code = "insufficient_credits";
}

export class NotFound extends ApiError {
  static override readonly code = "not_found";
}

export class Unauthorized extends ApiError {
  static override readonly code = "unauthorized";
}

export class Forbidden extends ApiError {
  static override readonly code = "forbidden";
}

type ApiErrorClass = new (message: string, options: ApiErrorOptions) => ApiError;

const BY_CODE: Record<string, ApiErrorClass> = {
  invalid_workflow: InvalidWorkflow,
  workflow_format_ui: WorkflowFormatUi,
  missing_asset: MissingAsset,
  hash_mismatch: HashMismatch,
  blob_not_found: BlobNotFound,
  idempotency_key_reuse: IdempotencyKeyReuse,
  queue_full: QueueFull,
  insufficient_credits: InsufficientCredits,
  not_found: NotFound,
  // public-api currently returns entity-specific 404 codes even though the spec
  // documents the generic `not_found`; map them so callers still get a typed
  // NotFound. (Server/spec reconciliation is a separate follow-up.)
  job_not_found: NotFound,
  asset_not_found: NotFound,
  unauthorized: Unauthorized,
  // The terminal SSE `error` frame on `GET /jobs/{id}/events` names an expired
  // credential with its own code; it is still a 401-class failure.
  credential_expired: Unauthorized,
  forbidden: Forbidden,
};

const CODE_BY_STATUS: Record<number, string> = {
  401: "unauthorized",
  402: "insufficient_credits",
  403: "forbidden",
  404: "not_found",
  409: "hash_mismatch",
  422: "invalid_workflow",
  429: "queue_full",
};

interface ErrorEnvelopeBody {
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown> | null;
  };
  /** Not part of the ErrorEnvelope contract: echo's `HTTPError` body shape,
   * `{"message": "..."}`, which a request-decoder 400 or a BodyLimit 413
   * reaches the caller as instead of an envelope. */
  message?: string;
}

/**
 * Build the typed exception for an error response. Falls back to a
 * status-derived code when the body is missing or not a well-formed
 * envelope, so a bare 401 with no JSON still maps to `Unauthorized`; a bare
 * `{message}` body (echo's HTTPError shape, e.g. a request-decoder 400 or a
 * BodyLimit 413) still contributes its message. A non-empty envelope message
 * wins over a top-level one; an empty or non-string message counts as absent.
 */
export function errorFromEnvelope(
  httpStatus: number,
  body: ErrorEnvelopeBody | null | undefined,
  options: { retryAfter?: number | null } = {},
): ApiError {
  const err = body && typeof body === "object" ? body.error : undefined;
  let code = err && typeof err === "object" ? err.code : undefined;
  let message = err && typeof err === "object" ? err.message : undefined;
  const details = err && typeof err === "object" ? err.details : undefined;
  if (typeof message !== "string" || !message) message = undefined;
  if (message === undefined && body && typeof body === "object") {
    if (typeof body.message === "string" && body.message) message = body.message;
  }

  if (!code) {
    code = CODE_BY_STATUS[httpStatus] ?? "error";
  }
  if (!message) {
    message = `HTTP ${httpStatus}`;
  }

  // Own-property lookup: `code` is server-controlled, and a code such as
  // `constructor` must not resolve through `Object.prototype`.
  const cls = Object.hasOwn(BY_CODE, code) ? BY_CODE[code] : ApiError;
  return new cls(message, {
    code,
    httpStatus,
    details: details && typeof details === "object" ? details : null,
    retryAfter: options.retryAfter ?? null,
  });
}

/**
 * The HTTP status each terminal SSE `error` frame code stands in for. The
 * frame arrives inside a `200` stream, so there is no response status to read;
 * this keeps `httpStatus` meaningful on the typed error the frame becomes.
 * Covers every code `BY_CODE` maps to `Unauthorized`, `Forbidden` or
 * `NotFound`, so a frame naming the generic `unauthorized` / `not_found`
 * carries the same status as the specific one.
 */
const SSE_STATUS_BY_CODE: Record<string, number> = {
  unauthorized: 401,
  credential_expired: 401,
  forbidden: 403,
  not_found: 404,
  job_not_found: 404,
  asset_not_found: 404,
};

/**
 * Build the typed exception for the terminal `error` frame of
 * `GET /jobs/{id}/events`, whose `data` is an error envelope. The server sends
 * it when it ends the stream for a reason other than the job finishing. The
 * envelope's `code` is kept verbatim; a code with no known status yields a bare
 * {@link ApiError} with `httpStatus` `0`. A frame with no message keeps its raw
 * payload (or names the frame) rather than reporting a nonexistent `HTTP 0`.
 */
export function sseErrorFromFrame(data: Record<string, unknown>): ApiError {
  // Every field is narrowed by a runtime check rather than an assertion: the
  // frame is server-controlled and has not been validated against the schema.
  const raw = data.error;
  const err = isRecord(raw) ? raw : undefined;
  const code = typeof err?.code === "string" && err.code ? err.code : "error";
  const httpStatus = Object.hasOwn(SSE_STATUS_BY_CODE, code) ? SSE_STATUS_BY_CODE[code] : 0;
  // With no envelope message, keep whatever the server did say: a string
  // `error`, a non-JSON line (`raw`), a non-object JSON value (`value`), or
  // failing those the payload itself.
  const stated =
    (typeof err?.message === "string" && err.message) ||
    (typeof raw === "string" && raw) ||
    (err === undefined ? framePayloadText(data) : "");
  // The fallback interpolates `code`, which is server-controlled too, so it is
  // sanitized as a whole; `error.code` itself stays verbatim.
  const message =
    sanitizeFrameMessage(stated) ||
    sanitizeFrameMessage(`event stream ended with an \`error\` frame (${code})`);
  const details = isRecord(err?.details) ? err.details : null;
  return errorFromEnvelope(httpStatus, { error: { code, message, details } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function framePayloadText(data: Record<string, unknown>): string {
  const payload = Object.hasOwn(data, "raw")
    ? data.raw
    : Object.hasOwn(data, "value")
      ? data.value
      : data;
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object" && Object.keys(payload).length === 0) return "";
  return JSON.stringify(payload) ?? "";
}

/** Longest server-stated reason an SSE `error` frame may put in `Error.message`. */
const MAX_FRAME_MESSAGE_LENGTH = 500;

/**
 * The server's stated reason, made safe for a log line: line breaks (a
 * multi-line `data:` field arrives joined with `\n`) collapse to a space, and
 * the text is bounded so a frame cannot pin megabytes on the error.
 */
function sanitizeFrameMessage(text: string): string {
  const flat = text.replace(/[\r\n]+/g, " ").trim();
  return flat.length > MAX_FRAME_MESSAGE_LENGTH
    ? `${flat.slice(0, MAX_FRAME_MESSAGE_LENGTH)}…`
    : flat;
}
