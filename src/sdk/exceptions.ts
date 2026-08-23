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
}

export class ComfyError extends Error {
  readonly code?: string;
  readonly httpStatus?: number;
  readonly details: Record<string, unknown> | null;

  constructor(message: string, options: ComfyErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.details = options.details ?? null;
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
 * `comfy.models.run` was reached with credentials in hand, but this release
 * has no model-execution route to call: the Comfy API v2 spec this SDK
 * generates its types from declares no such operation (see
 * `models.spec-contract.test.ts`, which fails the moment one appears).
 *
 * Placeholder — the request/response types must be generated from the spec
 * rather than hand-written, so `run` cannot be implemented before the route
 * is in `spec/openapi.yaml`. Running a workflow *graph* works today; the
 * message points there.
 */
export class ModelRunNotImplemented extends ComfyError {}

/** Backpressure: the queue is full. `retryAfter` is seconds to wait when supplied. */
export class QueueFull extends ComfyError {
  readonly retryAfter: number | null;

  constructor(message: string, options: ComfyErrorOptions & { retryAfter: number | null }) {
    super(message, options);
    this.retryAfter = options.retryAfter;
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
