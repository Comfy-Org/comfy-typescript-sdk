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
   * Any failure that carried the header has it — a `429` throttle or a proxy's
   * `503` as much as the two answers a same-key re-send can COLLECT from, a
   * `409` naming `concurrency_limit_exceeded` and a `504` naming
   * `deadline_exceeded`. So on its own it says "wait this long", not "your
   * generation is still running": tell the collectable pair apart by
   * {@link ComfyError.code}. On those two it is the interval Router itself
   * would wait before asking again, and `comfy.models.run` already re-asks for
   * you inside its own collect budget — so one that reaches you OUTLIVED that
   * budget (or the call's deadline), and this is what pacing a manual re-ask
   * needs. Pair it with {@link ComfyError.idempotencyKey}: waiting is only
   * half of the collect, and re-asking under a fresh key would dispatch — and
   * bill — a second generation rather than gathering the one already running.
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
   *
   * A raw transport failure or abort thrown by `comfy.models.run` /
   * `comfy.models.submit` carries it too — not as a `ComfyError` but as an own
   * `idempotencyKey` property stamped onto the underlying throwable (undici's
   * `TypeError` "fetch failed", a `DOMException` `AbortError`), which is the
   * only value that ties such a failure to the server-side record, since none
   * of them ever collected an `X-Comfy-Request-Id`. See {@link stampIdempotencyKey}.
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

/**
 * The readable {@link ComfyError} attributes a stamped error is guaranteed to
 * answer to. Mirrors Python's `_STAMPED_ATTRIBUTES`.
 */
const STAMPED_ATTRIBUTES = ["requestId", "retryAfter"] as const;

/** Options for {@link stampIdempotencyKey} and {@link stamping}. */
export interface StampOptions {
  /**
   * The signal the CALLER handed this call, when there is one.
   *
   * `fetch` rejects with `signal.reason`, and `AbortSignal.any` hands the
   * composite the SOURCE signal's reason OBJECT rather than a copy — so when
   * one `AbortController` is shared across concurrent `run`/`submit` calls,
   * every one of them rejects with the very same throwable. Stamping that in
   * place would write the first call's key onto an object the other calls (and
   * the caller, as `controller.signal.reason`) are still holding, so they would
   * each read a key belonging to a DIFFERENT generation — and a manual collect
   * under someone else's key is worse than no key at all. Naming the caller's
   * signal here is how the stamp recognises that object and hands this call a
   * private stand-in instead.
   */
  callerSignal?: AbortSignal | undefined;
  /**
   * What `retryAfter` should read when the throwable carries none of its own.
   * Defaults to `null`. The collect path passes the pace Router named on the
   * 409/504 that started the collect, so a failure to collect hands back the
   * pace as well as the key.
   */
  retryAfter?: number | null;
}

/**
 * Is `exc` an object other calls are holding too, so that writing this call's
 * key onto it would be read by one of them as its own?
 *
 * Two ways that happens: it is the caller's abort reason (handed to every
 * concurrent call on that controller), or it already carries a key that is not
 * ours (some other call stamped it first, by a route we did not plumb).
 */
function isSharedAcrossCalls(
  exc: object,
  idempotencyKey: string,
  callerSignal: AbortSignal | undefined,
): boolean {
  if (callerSignal?.aborted === true && (callerSignal.reason as unknown) === exc) return true;
  let existing: unknown;
  try {
    existing = (exc as Record<string, unknown>).idempotencyKey;
  } catch {
    // A throwing getter: not something we can classify, and not something we
    // can safely write to either. `writeStamp` re-reads it and bails the same
    // way, leaving the error untouched.
    return false;
  }
  return typeof existing === "string" && existing !== idempotencyKey;
}

/**
 * A private stand-in for a throwable this call must not mutate: same
 * prototype, same message, same stack, same own properties — everything a
 * caller branches on (`err.name === "AbortError"`, `instanceof DOMException`,
 * `instanceof TypeError`) reads identically. Only the object identity differs,
 * which is the point: the caller's `controller.signal.reason` is left exactly
 * as they handed it to us.
 *
 * `null` when there is no faithful stand-in to make, in which case the caller
 * keeps an UNSTAMPED error rather than one carrying another generation's key.
 */
function replicate(exc: object): object | null {
  const descriptors = Object.getOwnPropertyDescriptors(exc);
  // Another call's key is the whole reason we are standing this object in.
  delete descriptors.idempotencyKey;
  // `stack` is an ACCESSOR on both a V8 `Error` and a Node `DOMException`, and
  // its getter is bound to the object it was installed on — copying the
  // descriptor would hand the stand-in a getter that answers for the original.
  // Read the string out here and pin it as a data property below instead.
  let stack: unknown;
  try {
    stack = (exc as Record<string, unknown>).stack;
  } catch {
    stack = undefined;
  }
  delete descriptors.stack;
  const pinStack = (replica: object): void => {
    if (typeof stack !== "string") return;
    Object.defineProperty(replica, "stack", {
      value: stack,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  };
  if (exc instanceof DOMException) {
    // `DOMException` keeps `name`/`message` in internal slots behind prototype
    // accessors, so a descriptor copy of one reads back as a `TypeError`
    // ("Value of `this` must be of DOMException") the moment anyone touches
    // `err.name`. It has to be rebuilt through the constructor, which carries
    // both — and re-defining them here would shadow those accessors.
    const replica = new DOMException(exc.message, exc.name);
    delete descriptors.name;
    delete descriptors.message;
    Object.defineProperties(replica, descriptors);
    pinStack(replica);
    return replica;
  }
  const prototype = Object.getPrototypeOf(exc) as object | null;
  // An `Error` (its `message` is an own data property, so the descriptor copy
  // carries it, and the prototype carries the class) or a plain object — the
  // other thing `controller.abort(reason)` is routinely handed. Both are
  // faithfully reproduced by copying own descriptors onto a fresh object.
  if (exc instanceof Error || prototype === Object.prototype || prototype === null) {
    const replica = Object.create(prototype) as object;
    Object.defineProperties(replica, descriptors);
    pinStack(replica);
    return replica;
  }
  // Anything else may keep state in internal slots a descriptor copy cannot
  // reach (the way a `DOMException` does), and a stand-in that reads wrong is
  // worse than no stamp — so the error travels on untouched.
  return null;
}

/** Write the key and the guaranteed attributes onto `target`, in place. */
function writeStamp(target: object, idempotencyKey: string, options: StampOptions): object {
  const record = target as Record<string, unknown>;
  const defaults: Record<string, unknown> = {
    requestId: null,
    retryAfter: options.retryAfter ?? null,
  };
  try {
    if (record.idempotencyKey === undefined || record.idempotencyKey === null)
      record.idempotencyKey = idempotencyKey;
    // A value check, not an `in` check, for all three alike: an error carrying
    // an own `requestId: undefined` reads as the `null` the docstring promises.
    for (const name of STAMPED_ATTRIBUTES)
      if (record[name] === undefined) record[name] = defaults[name];
  } catch {
    // `Object.isExtensible` passing does not make the write safe, and this
    // module is strict-mode ESM: an own non-writable `idempotencyKey` holding
    // `undefined`, a getter-only accessor, or a Proxy with a throwing `set`
    // trap each raise a `TypeError` from here — inside `stamping`'s catch,
    // where it would REPLACE the transport failure this helper exists to
    // preserve. The error travels on with whatever the stamp managed to write.
  }
  return target;
}

/**
 * Attach `idempotencyKey` to `exc` and hand back the error to throw.
 *
 * The transport failures `comfy.models.run` / `comfy.models.submit` re-throw
 * are undici's own `TypeError` ("fetch failed") and `DOMException`
 * (`AbortError`) — throwables this SDK does not construct, so there is no
 * constructor argument to thread the key through and no subclass to catch by.
 * Stamping the own property is how those raw errors carry the
 * `Idempotency-Key` all the same: on a transport failure comfy-api never
 * minted an `X-Comfy-Request-Id`, so the key is the only value that correlates
 * the failure to the server-side record. Mirrors Python's `_stamp()`.
 *
 * Stamps IN PLACE — same object, same stack — except when the throwable is
 * shared with other calls, which is the caller's abort reason: `fetch` rejects
 * with `signal.reason` and `AbortSignal.any` propagates the source signal's
 * reason object, so one `AbortController` driving N concurrent calls rejects
 * all N with one object. That one gets a private per-call stand-in instead
 * (see {@link replicate}), leaving `controller.signal.reason` exactly as the
 * caller built it. Pass {@link StampOptions.callerSignal} so this is detected.
 *
 * Never overwrites a value already set — so a {@link ComfyError} built WITH a
 * key keeps it (the field is `readonly` at the type level only; the write goes
 * through a `Record` cast deliberately, and the guard makes it a no-op there).
 * A `null` key writes nothing; a non-object, a non-extensible throwable (a
 * string, a frozen object) or one whose write raises passes through untouched.
 * `requestId` and `retryAfter` are defaulted to `null` when absent, so a
 * stamped transport error reads every attribute the way a caller who caught a
 * ComfyError expects, without clobbering a value the error already carried.
 */
export function stampIdempotencyKey<E>(
  exc: E,
  idempotencyKey: string | null,
  options: StampOptions = {},
): E {
  if (idempotencyKey === null || exc === null || typeof exc !== "object") return exc;
  if (isSharedAcrossCalls(exc, idempotencyKey, options.callerSignal)) {
    const replica = replicate(exc);
    if (replica === null) return exc;
    return writeStamp(replica, idempotencyKey, options) as E;
  }
  if (!Object.isExtensible(exc)) return exc;
  return writeStamp(exc, idempotencyKey, options) as E;
}

/**
 * Run `fn`; anything it throws leaves stamped with `idempotencyKey` — the same
 * object with the same stack, unless that object is shared with other calls
 * (see {@link StampOptions.callerSignal}), in which case a private stand-in
 * carries the key instead. Mirrors the second arm of Python's
 * `translating(idempotency_key=…)` — the arm that stamps a raw transport
 * failure rather than translating a protocol error.
 */
export async function stamping<T>(
  idempotencyKey: string | null,
  fn: () => Promise<T>,
  options: StampOptions = {},
): Promise<T> {
  try {
    return await fn();
  } catch (exc) {
    throw stampIdempotencyKey(exc, idempotencyKey, options);
  }
}
