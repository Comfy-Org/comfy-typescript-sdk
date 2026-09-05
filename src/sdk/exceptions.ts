/**
 * Idiomatic `sdk` exceptions.
 *
 * These wrap the protocol-level `low.ApiError` codes with names an
 * integrator catches directly (`JobFailed`, `QueueFull`, ...). `toSdkError`
 * maps a raised `ApiError` to the right subclass; anything unmapped stays a
 * `ComfyError` carrying the original code. Mirrors `comfy_sdk.exceptions`
 * in the Python SDK.
 */

import { ApiError } from "../low/index.js";
import type { JobError } from "../low/index.js";

export interface ComfyErrorOptions {
  code?: string;
  httpStatus?: number;
  details?: Record<string, unknown> | null;
  /** See {@link ComfyError.requestId}. */
  requestId?: string | null;
  /** See {@link ComfyError.retryAfter}. */
  retryAfter?: number | null;
  /** See {@link ComfyError.idempotencyKey}. */
  idempotencyKey?: string | null;
  /** The underlying failure, when this error wraps one (a fetch abort, say). */
  cause?: unknown;
}

export class ComfyError extends Error {
  readonly code?: string;
  readonly httpStatus?: number;
  readonly details: Record<string, unknown> | null;
  /**
   * Server-generated identifier for the call that failed, read off the
   * `X-Comfy-Request-Id` response header — the value to quote in a support
   * request, so a user never has to inspect headers to find one.
   *
   * `null` when there was no response to read it from (a connection failure,
   * a client-side timeout) or when the response carried no such header —
   * which a proxy or load-balancer error page, generated before the request
   * reached Comfy, genuinely does not.
   */
  readonly requestId: string | null;

  /**
   * Seconds the server asked the caller to wait before re-sending this exact
   * request, off `Retry-After`; `null` when it named none.
   *
   * Set on the two answers a same-key re-send can collect from — a `409`
   * naming `concurrency_limit_exceeded` and a `504` naming `deadline_exceeded`
   * — where it is the interval Router itself would wait before asking again.
   * `comfy.models.run` already re-asks for you inside its own collect budget,
   * so an error carrying one is an answer that OUTLIVED that budget, and this
   * is what pacing a manual re-ask needs. Pair it with
   * {@link ComfyError.idempotencyKey}: waiting is only half of the collect,
   * and re-asking under a fresh key would dispatch — and bill — a second
   * generation rather than gathering the one already running.
   */
  readonly retryAfter: number | null;

  /**
   * The `Idempotency-Key` the failed call was sent under, or `null` for a
   * failure raised before any request went out.
   *
   * Surfaced for the same reason {@link ComfyError.requestId} is: it is a
   * value the caller needs and would otherwise have to have captured up front.
   * A key minted inside `comfy.models.run` is not otherwise visible anywhere,
   * so without this an interrupted call could not be re-asked for at all — the
   * generation Router is holding is addressed by that string and nothing else.
   */
  readonly idempotencyKey: string | null;

  constructor(message: string, options: ComfyErrorOptions = {}) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.details = options.details ?? null;
    this.requestId = options.requestId ?? null;
    this.retryAfter = options.retryAfter ?? null;
    this.idempotencyKey = options.idempotencyKey ?? null;
  }
}

/** The surface rejected the request for lack of a valid key. Comfy Cloud
 * and serverless require a key; a self-hosted proxy needs none. */
export class Unauthorized extends ComfyError {}
export class Forbidden extends ComfyError {}
export class NotFound extends ComfyError {}

/** Structural/validation failure; `details` carries per-node errors. */
export class InvalidWorkflow extends ComfyError {}

/** UI-export JSON was submitted instead of the API-format graph. */
export class WorkflowFormatUi extends InvalidWorkflow {}

/** A `core/ASSET` reference was not usable (unknown/unscanned/not owned). */
export class MissingAsset extends ComfyError {}

/** Uploaded bytes did not match the declared `expectedHash`. */
export class HashMismatch extends ComfyError {}

/** from-hash / existence probe found no blob the caller can mint from. */
export class BlobNotFound extends ComfyError {}

/** The idempotency key was reused. Keys are single-use (reject-on-duplicate,
 * no replay): any second request with the same key — a retry, a concurrent
 * duplicate, or the same key with a different body — is rejected. */
export class IdempotencyKeyReuse extends ComfyError {}

export class InsufficientCredits extends ComfyError {}

/**
 * No credential was configured for a `comfy.*` call. Raised locally, before
 * any request goes out, so a misconfigured process fails at the call site
 * instead of as a 401 from the server.
 *
 * The message names the two ways to supply one and never echoes a
 * credential — there is none to echo, and `credentials.test.ts` pins that.
 */
export class MissingCredentials extends ComfyError {}

/**
 * Backpressure: the queue is full. `retryAfter` is seconds to wait when
 * supplied.
 *
 * It declares `retryAfter` REQUIRED where {@link ComfyError} leaves it
 * optional, which is the whole difference and why the narrowing stays: on
 * every other error the field is "the server may have named a pace", while a
 * `QueueFull` is constructed only where that question has already been
 * answered, so a caller who caught this one never has to wonder whether the
 * `null` means "no pace" or "nobody looked".
 */
export class QueueFull extends ComfyError {
  constructor(message: string, options: ComfyErrorOptions & { retryAfter: number | null }) {
    super(message, options);
  }
}

/**
 * A job reached a non-success terminal state. `error` carries the
 * node-level detail (`code`, `nodeId`, `message`, `traceback`) when the
 * platform provided one.
 */
export class JobFailed extends ComfyError {
  readonly error: JobError | null;

  constructor(message: string, options: { error?: JobError | null } = {}) {
    super(message, { code: options.error?.code ?? "job_failed" });
    this.error = options.error ?? null;
  }
}

type ComfyErrorClass = new (message: string, options: ComfyErrorOptions) => ComfyError;

const BY_CODE: Record<string, ComfyErrorClass> = {
  invalid_workflow: InvalidWorkflow,
  workflow_format_ui: WorkflowFormatUi,
  missing_asset: MissingAsset,
  hash_mismatch: HashMismatch,
  blob_not_found: BlobNotFound,
  idempotency_key_reuse: IdempotencyKeyReuse,
  insufficient_credits: InsufficientCredits,
  not_found: NotFound,
  // public-api returns entity-specific 404 codes even though the spec documents
  // the generic not_found; map them so a missing job/asset raises the typed
  // NotFound. (Server/spec reconciliation of the code set is a separate follow-up.)
  job_not_found: NotFound,
  asset_not_found: NotFound,
  unauthorized: Unauthorized,
  forbidden: Forbidden,
};

/** Translate a protocol `ApiError` into the idiomatic SDK exception. */
export function toSdkError(exc: ApiError): ComfyError {
  if (exc.code === "queue_full") {
    return new QueueFull(exc.message, {
      retryAfter: exc.retryAfter,
      code: exc.code,
      httpStatus: exc.httpStatus,
      details: exc.details,
    });
  }
  const cls = BY_CODE[exc.code] ?? ComfyError;
  return new cls(exc.message, { code: exc.code, httpStatus: exc.httpStatus, details: exc.details });
}

/**
 * Run `fn`, re-raising any protocol `ApiError` as its idiomatic SDK
 * exception. Wrap every `sdk`-level operation that calls into `low` with
 * this so integrators only ever catch `sdk` exceptions (`MissingAsset`,
 * `HashMismatch`, `NotFound`, ...), never the raw protocol error.
 */
export async function translate<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (exc) {
    if (exc instanceof ApiError) {
      throw toSdkError(exc);
    }
    throw exc;
  }
}
