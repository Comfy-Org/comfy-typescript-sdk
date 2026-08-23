/**
 * Typed exceptions for the Comfy Router error contract — one class per
 * `error_type`, all descending from {@link RouterError}.
 *
 * Router answers every failure with a coarse, machine-readable bucket on the
 * `X-Comfy-Error-Type` response header (and, for the request-level body
 * shape, in `error_type` as well). The bucket set is *closed* at eleven
 * values in this release: six request-level and five transport-level. This
 * module turns that value into a class an integrator can `catch`. The names
 * below are the shared set: the Python SDK spells every one of them
 * identically, so a snippet, a doc page or a forum answer transfers between
 * the two languages unchanged. They are the PascalCase of the wire value,
 * which is idiomatic in both languages — no per-language casing deviation was
 * needed, and none should be introduced.
 *
 * ```ts
 * import { routerErrors } from "@comfyorg/sdk";
 * // or: import { ContentPolicyViolation } from "@comfyorg/sdk/errors";
 *
 * try {
 *   await comfy.models.run("owner/model", { prompt: "..." });
 * } catch (err) {
 *   if (err instanceof routerErrors.ContentPolicyViolation) {
 *     // Deterministic refusal — retrying the same input will not succeed.
 *   } else if (err instanceof routerErrors.InvalidInput) {
 *     for (const d of err.detail) console.log(d.loc.join("."), d.type, d.msg);
 *   } else if (err instanceof routerErrors.RouterError) {
 *     console.log(err.errorType, err.requestId); // any bucket, known or not
 *   }
 * }
 * ```
 *
 * Two things this module deliberately does not do:
 *
 * - **It does not narrow `errorType` to the closed set at runtime.** A newer
 *   server may send a bucket this release has never heard of (three more are
 *   already planned), and an SDK that threw on an unrecognized value would
 *   fail hardest exactly when something has already gone wrong. An unknown
 *   bucket surfaces as a plain {@link RouterError} carrying the raw string;
 *   the contract says to treat one as `internal_error`.
 * - **It is not generated from `spec/openapi.yaml`.** The vendored v2 spec
 *   does not yet carry the Router error components, so the closed set is
 *   restated here and pinned by `routerErrors.test.ts`. When the components
 *   land in the spec, that test is where the two get reconciled.
 *
 * These classes are namespaced (`routerErrors.*`) rather than exported from
 * the package root because three of the eleven names — `Unauthorized`,
 * `Forbidden`, `InsufficientCredits` — already exist at the root as
 * workflow-API exceptions descending from `ComfyError`. The Python SDK has
 * the same three at the top level of `comfy_sdk`, so both SDKs resolve the
 * collision the same way: a dedicated module, and the class names themselves
 * left untouched.
 */

/**
 * The six request-level buckets, in the order the error contract lists them.
 *
 * Two distinctions here are load-bearing rather than cosmetic, because a
 * caller branches on them:
 *
 * - `content_policy_violation` is **not** `provider_error`. A policy refusal
 *   is deterministic; retrying the identical input will not succeed.
 * - `provider_timeout` is an *upstream* stall, not a Comfy-side deadline. A
 *   deadline that expires on our side arrives as `internal_error`.
 */
export const REQUEST_ERROR_TYPES = [
  "invalid_input",
  "content_policy_violation",
  "provider_error",
  "provider_timeout",
  "insufficient_credits",
  "model_not_found",
] as const;

/**
 * The five transport-level buckets. They are part of the same closed set — a
 * caller reads one value off one header — but they are raised before or
 * around the model call rather than derived from a provider response.
 */
export const TRANSPORT_ERROR_TYPES = [
  "unauthorized",
  "forbidden",
  "concurrency_limit_exceeded",
  "client_disconnected",
  "internal_error",
] as const;

/** The closed error-type set for this release: request-level, then transport-level. */
export const ROUTER_ERROR_TYPES = [...REQUEST_ERROR_TYPES, ...TRANSPORT_ERROR_TYPES] as const;

/** One of the eleven buckets this release knows about. */
export type RouterErrorType = (typeof ROUTER_ERROR_TYPES)[number];

/** `X-Comfy-Error-Type` — the coarse bucket, set on every Router error response. */
export const ERROR_TYPE_HEADER = "X-Comfy-Error-Type";

/** `X-Comfy-Request-Id` — the server-minted id for the call, set on every response. */
export const REQUEST_ID_HEADER = "X-Comfy-Request-Id";

/**
 * One model-level validation failure, in the fal/FastAPI `detail[]` form.
 *
 * `type` is the SPECIFIC provider reason (`value_error`, `missing`,
 * `image_too_small`, `unsupported_audio_format`, `greater_than`,
 * `file_too_large`, ...) — granularity the coarse `error_type` bucket cannot
 * express. It is an open string, not a union: the provider vocabulary runs to
 * dozens of values across two tiers and grows on the provider's release
 * cycle, not this SDK's, so an unmodelled value must reach the caller rather
 * than fail deserialization.
 */
export interface ValidationErrorDetail {
  /**
   * Path to the offending field, outermost segment first — e.g.
   * `["body", "image_url"]`, or `["body", "images", 0]` where an integer
   * indexes into an array.
   */
  loc: readonly (string | number)[];
  /** Human-readable description of this single failure. */
  msg: string;
  /** Specific, machine-readable reason, passed through from the provider. */
  type: string;
  /**
   * The violated bound, when the reason carries one — `{ limit_value: 8 }`
   * alongside `greater_than`, `{ min_width: 512 }` alongside
   * `image_too_small`. The key set is specific to the provider and the
   * reason, so this stays an open object: narrowing it to a fixed field list
   * is how a ported integration compiles and then silently loses the branch
   * that read the bound.
   */
  ctx?: Record<string, unknown>;
  /** The offending input value, echoed back verbatim. Any JSON type, or absent. */
  input?: unknown;
}

export interface RouterErrorOptions {
  /**
   * The raw `error_type` off the wire. Defaults to the class's own
   * `errorType`, so `new ProviderTimeout("...")` is already correct; pass it
   * explicitly to preserve a bucket this release does not recognize.
   */
  errorType?: string;
  /** `X-Comfy-Request-Id`. `null` when the response carried no id. */
  requestId?: string | null;
  /** The HTTP status the failure arrived with. `null` when it was not an HTTP failure. */
  httpStatus?: number | null;
}

/**
 * Base for every Router failure. Catch this to handle any of them —
 * including a bucket from a server newer than the installed SDK, which
 * surfaces as this class rather than as an untyped throw.
 */
export class RouterError extends Error {
  /**
   * The bucket instances of this class report when the caller does not pass
   * one. On the base class it is `internal_error` because that is what the
   * contract says to do with a bucket you do not recognize — but an unknown
   * value read off the wire is preserved verbatim in {@link errorType}
   * rather than being rewritten to it.
   */
  static readonly errorType: string = "internal_error";

  /** The `error_type` bucket, exactly as it arrived. */
  readonly errorType: string;

  /**
   * The server-minted id for this call, off `X-Comfy-Request-Id`. It is the
   * value to quote in a support request: the same id is written into the
   * call's usage record, so a question about a charge can be joined to the
   * charge itself.
   */
  readonly requestId: string | null;

  /** The HTTP status this failure arrived with, or `null`. */
  readonly httpStatus: number | null;

  constructor(message: string, options: RouterErrorOptions = {}) {
    super(message);
    // Restore the prototype explicitly. Extending a built-in is the classic
    // `instanceof` trap: a consumer who down-levels this package's ES2022
    // output to ES5 gets a constructor whose returned object is chained to
    // `Error.prototype`, and `err instanceof ContentPolicyViolation` is then
    // false for an error this module itself threw. One line here makes the
    // chain hold either way; `routerErrors.test.ts` asserts it for every
    // class, both directly and through a down-level-shaped construction.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
    this.errorType = options.errorType ?? (new.target as typeof RouterError).errorType;
    this.requestId = options.requestId ?? null;
    this.httpStatus = options.httpStatus ?? null;
  }
}

// -- request-level buckets ---------------------------------------------------

/**
 * The request was rejected as invalid — either by Router before dispatch, or
 * by the model itself.
 *
 * The model-level case is the `422`, whose body is a per-field `detail[]`
 * array; those entries are on {@link detail} with their `loc`, `msg`, `type`
 * and `ctx` intact, because flattening them into the message would destroy
 * the granularity an integration branches on. {@link detail} is an empty
 * array for the Router-level case, which names no field.
 */
export class InvalidInput extends RouterError {
  static override readonly errorType = "invalid_input";

  /** Per-field validation failures; empty when the rejection named no field. */
  readonly detail: readonly ValidationErrorDetail[];

  constructor(
    message: string,
    options: RouterErrorOptions & { detail?: readonly ValidationErrorDetail[] } = {},
  ) {
    super(message, options);
    this.detail = options.detail ?? [];
  }
}

/**
 * The model's content policy refused the request. Deterministic: retrying the
 * same input will not succeed, so this is the one failure a retry policy must
 * not treat like {@link ProviderError}.
 */
export class ContentPolicyViolation extends RouterError {
  static override readonly errorType = "content_policy_violation";
}

/** The upstream model provider returned an error. */
export class ProviderError extends RouterError {
  static override readonly errorType = "provider_error";
}

/**
 * The upstream model provider did not respond in time. Distinct from a
 * Comfy-side deadline, which arrives as {@link InternalError}.
 */
export class ProviderTimeout extends RouterError {
  static override readonly errorType = "provider_timeout";
}

/** The account does not have enough credits to run this model. */
export class InsufficientCredits extends RouterError {
  static override readonly errorType = "insufficient_credits";
}

/** No such model — the `{provider}/{model}` pair is not one Router serves. */
export class ModelNotFound extends RouterError {
  static override readonly errorType = "model_not_found";
}

// -- transport-level buckets -------------------------------------------------

/** Authentication is required, or the credential presented was not valid. */
export class Unauthorized extends RouterError {
  static override readonly errorType = "unauthorized";
}

/** The credential is valid but does not grant access to this model. */
export class Forbidden extends RouterError {
  static override readonly errorType = "forbidden";
}

/** Too many concurrent requests for this account. */
export class ConcurrencyLimitExceeded extends RouterError {
  static override readonly errorType = "concurrency_limit_exceeded";
}

/** The client closed the connection before the request completed. */
export class ClientDisconnected extends RouterError {
  static override readonly errorType = "client_disconnected";
}

/** Something failed on the Comfy side. Also what an unrecognized bucket means. */
export class InternalError extends RouterError {
  static override readonly errorType = "internal_error";
}

type RouterErrorClass = new (message: string, options: RouterErrorOptions) => RouterError;

const BY_ERROR_TYPE: Record<string, RouterErrorClass> = {
  invalid_input: InvalidInput,
  content_policy_violation: ContentPolicyViolation,
  provider_error: ProviderError,
  provider_timeout: ProviderTimeout,
  insufficient_credits: InsufficientCredits,
  model_not_found: ModelNotFound,
  unauthorized: Unauthorized,
  forbidden: Forbidden,
  concurrency_limit_exceeded: ConcurrencyLimitExceeded,
  client_disconnected: ClientDisconnected,
  internal_error: InternalError,
};

/**
 * Last-resort bucket for a response that carried no `X-Comfy-Error-Type` and
 * no `error_type` in its body — a proxy or gateway that failed before Router
 * was reached, say. Mapping by status is strictly better than dropping every
 * such failure into {@link InternalError}, but it is a fallback: the header is
 * the contract, and Router sets it on every error response it writes.
 */
const ERROR_TYPE_BY_STATUS: Record<number, string> = {
  400: "invalid_input",
  401: "unauthorized",
  402: "insufficient_credits",
  403: "forbidden",
  404: "model_not_found",
  422: "invalid_input",
  429: "concurrency_limit_exceeded",
  499: "client_disconnected",
  502: "provider_error",
  504: "provider_timeout",
};

/** Just enough of `Headers` to read one value; anything `Headers`-shaped works. */
export interface HeadersLike {
  get(name: string): string | null;
}

interface RequestErrorBody {
  detail?: unknown;
  error_type?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse one `detail[]` entry, keeping it only if the three required fields are
 * present and well-typed. A malformed entry is dropped rather than
 * half-materialized: `detail[]` is branched on, so an entry with no `type` is
 * worse than no entry at all.
 */
function parseDetailEntry(raw: unknown): ValidationErrorDetail | null {
  if (!isRecord(raw)) return null;
  const { loc, msg, type, ctx, input } = raw;
  if (!Array.isArray(loc) || typeof msg !== "string" || typeof type !== "string") return null;
  if (!loc.every((seg) => typeof seg === "string" || typeof seg === "number")) return null;
  const parsed: ValidationErrorDetail = { loc: loc as (string | number)[], msg, type };
  if (isRecord(ctx)) parsed.ctx = ctx;
  if ("input" in raw) parsed.input = input;
  return parsed;
}

/** Summarize a `detail[]` array into the one-line message the exception carries. */
function summarizeDetail(entries: readonly ValidationErrorDetail[]): string {
  if (entries.length === 0) return "The request was rejected as invalid for this model.";
  const [first] = entries;
  const where = first.loc.length > 0 ? first.loc.join(".") : "request";
  const rest = entries.length - 1;
  const suffix =
    rest > 0 ? ` (and ${rest} more validation ${rest === 1 ? "error" : "errors"})` : "";
  return `${where}: ${first.msg}${suffix}`;
}

/**
 * Build the typed exception for a Router error response.
 *
 * The bucket is read off `X-Comfy-Error-Type` first and the body's
 * `error_type` second, in that order and not the other way around: the `422`
 * body is the per-field `detail[]` shape and carries no `error_type` of its
 * own, so the header is the only field present on every error response. A
 * response with neither falls back to {@link ERROR_TYPE_BY_STATUS}.
 *
 * An `error_type` outside the closed set yields a plain {@link RouterError}
 * carrying the unrecognized value — never a throw, and never a silent
 * rewrite to `internal_error`.
 */
export function toRouterError(status: number, headers: HeadersLike, body: unknown): RouterError {
  const requestId = headers.get(REQUEST_ID_HEADER);
  const envelope: RequestErrorBody = isRecord(body) ? body : {};

  const headerType = headers.get(ERROR_TYPE_HEADER);
  const bodyType = typeof envelope.error_type === "string" ? envelope.error_type : null;
  const errorType = headerType || bodyType || ERROR_TYPE_BY_STATUS[status] || "internal_error";

  const options: RouterErrorOptions = { errorType, requestId, httpStatus: status };
  // Own-property lookup only. A plain `BY_ERROR_TYPE[errorType]` would resolve
  // an `error_type` of `constructor` or `toString` off `Object.prototype` and
  // hand back something that is not a RouterError at all — and the whole point
  // of the unknown-bucket path is that a server value can never produce an
  // untyped throw.
  const cls = Object.hasOwn(BY_ERROR_TYPE, errorType) ? BY_ERROR_TYPE[errorType] : undefined;

  if (cls === InvalidInput) {
    const entries = Array.isArray(envelope.detail)
      ? envelope.detail.map(parseDetailEntry).filter((e): e is ValidationErrorDetail => e !== null)
      : [];
    const message =
      typeof envelope.detail === "string" ? envelope.detail : summarizeDetail(entries);
    return new InvalidInput(message, { ...options, detail: entries });
  }

  const message = typeof envelope.detail === "string" ? envelope.detail : `HTTP ${status}`;
  return new (cls ?? RouterError)(message, options);
}
