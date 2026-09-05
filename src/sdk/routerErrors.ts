/**
 * Typed exceptions for the Comfy Router error contract — one class per
 * `error_type`, all descending from {@link RouterError}.
 *
 * Router answers every failure with a coarse, machine-readable bucket on the
 * `X-Comfy-Error-Type` response header (and, for the request-level body
 * shape, in `error_type` as well). The bucket set is *closed* at fifteen
 * values in this release: six request-level and nine transport-level. This
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
 *   server may send a bucket this release has never heard of, and an SDK
 *   that threw on an unrecognized value would fail hardest exactly when
 *   something has already gone wrong. An unknown bucket surfaces as a plain
 *   {@link RouterError} carrying the raw string; the contract says a CALLER
 *   should treat one as `internal_error`, which is advice for the caller and
 *   not licence for this module to rewrite what the server said. A response
 *   that named no bucket at all surfaces the same way with `errorType` empty.
 * - **It is not generated from a spec.** Nothing in this repo generates code
 *   from `spec/router-openapi.yaml`, so the closed set is restated here by
 *   hand — but it is no longer restated *unchecked*:
 *   `router-spec-coverage.test.ts` reads that vendored contract's
 *   `x-comfy-error-types` and fails if a bucket, its tier, its order or its
 *   class is missing on either side. A spec sync that adds a bucket is not
 *   done until a class exists for it here.
 *
 * These classes are namespaced (`routerErrors.*`) rather than exported from
 * the package root because three of the fifteen names — `Unauthorized`,
 * `Forbidden`, `InsufficientCredits` — already exist at the root as
 * workflow-API exceptions descending from `ComfyError`. The Python SDK has
 * the same three at the top level of `comfy_sdk`, so both SDKs resolve the
 * collision the same way: a dedicated module, and the class names themselves
 * left untouched.
 *
 * Four of the fifteen buckets — `deadline_exceeded`, `not_enabled`,
 * `service_unavailable` and `rate_limited` — are newer than the Python SDK's
 * table. Until its twin lands they are declared as leading this SDK in
 * `surface-parity.test.ts`'s allowlist, which fails once the Python side
 * catches up so the entry cannot outlive the lag.
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
 *   deadline that expires on our side shares the same `504` but arrives as
 *   `deadline_exceeded`.
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
 * The nine transport-level buckets, in the order the error contract lists
 * them. They are part of the same closed set — a caller reads one value off
 * one header — but they are raised before or around the model call rather
 * than derived from a provider response.
 *
 * Three pairs here share an HTTP status and are separate buckets precisely
 * because the status cannot tell them apart, so a caller that branches on
 * status alone gets the wrong answer for one of each pair:
 *
 * - `403` is `forbidden` (an entitlement decision about this caller) **or**
 *   `not_enabled` (a state of the Router rollout, nothing to do with the
 *   caller's entitlements).
 * - `429` is `concurrency_limit_exceeded` (clears when one of the caller's
 *   own in-flight calls finishes) **or** `rate_limited` (clears only when a
 *   time window rolls).
 * - `504` is `provider_timeout` (the partner ran out of time) **or**
 *   `deadline_exceeded` (Comfy stopped holding the connection).
 *
 * The header is what disambiguates each pair; `ERROR_TYPE_BY_STATUS` below
 * is only consulted when there is no header at all, and it deliberately
 * keeps naming the older member of each pair.
 */
export const TRANSPORT_ERROR_TYPES = [
  "unauthorized",
  "forbidden",
  "concurrency_limit_exceeded",
  "client_disconnected",
  "internal_error",
  "deadline_exceeded",
  "not_enabled",
  "service_unavailable",
  "rate_limited",
] as const;

/** The closed error-type set for this release: request-level, then transport-level. */
export const ROUTER_ERROR_TYPES = [...REQUEST_ERROR_TYPES, ...TRANSPORT_ERROR_TYPES] as const;

/** One of the fifteen buckets this release knows about. */
export type RouterErrorType = (typeof ROUTER_ERROR_TYPES)[number];

/** `X-Comfy-Error-Type` — the coarse bucket, set on every Router error response. */
export const ERROR_TYPE_HEADER = "X-Comfy-Error-Type";

/** `X-Comfy-Request-Id` — the server-minted id for the call, set on every response. */
export const REQUEST_ID_HEADER = "X-Comfy-Request-Id";

/**
 * `Retry-After` — seconds to wait before re-sending the SAME request under the
 * SAME `Idempotency-Key`.
 *
 * Router sets it on exactly the two answers such a re-send can COLLECT from: a
 * `409` naming `concurrency_limit_exceeded` (the original call for that key is
 * still running) and a `504` naming `deadline_exceeded` (Comfy stopped holding
 * the connection but still holds a handle to a generation the provider is
 * running). Its absence is meaningful, not merely missing: it is Router saying
 * there is nothing to collect, which is why `isCollectable` in `./retry.ts`
 * gates on the header being present at all.
 */
export const RETRY_AFTER_HEADER = "Retry-After";

/**
 * Read `Retry-After` as a whole number of seconds, or `null`.
 *
 * The Router contract pins this header to `type: integer, minimum: 1`, so the
 * delay-seconds form is the only one it can send and anything else — the
 * HTTP-date form an intermediary may use, a decimal, a negative, a blank — is
 * a value this SDK cannot pace from and reads as absent. Deliberately strict
 * rather than `parseInt`: `parseInt` reads `"2 hours"` as `2` and would invent
 * a pace out of a string that named none.
 *
 * `0` is kept and NOT flattened to `null`, because the two say different
 * things. `null` means the response named nothing to collect; `0` means it did
 * name a handle but paced it uselessly, and the caller of
 * `nextCollectDelayMs` falls back to its own backoff for that one rather than
 * spinning. See `./retry.ts`.
 */
export function parseRetryAfter(headers: HeadersLike): number | null {
  const raw = headers.get(RETRY_AFTER_HEADER);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const seconds = Number(trimmed);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

/**
 * One model-level validation failure, in the FastAPI `detail[]` form.
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
  /** See {@link RouterError.retryAfter}. */
  retryAfter?: number | null;
}

/**
 * Base for every Router failure. Catch this to handle any of them —
 * including a bucket from a server newer than the installed SDK, which
 * surfaces as this class rather than as an untyped throw.
 */
export class RouterError extends Error {
  /**
   * The bucket instances of this class report when the caller does not pass
   * one. On the base class it is the EMPTY STRING, which reads as "no bucket"
   * — the base is reached only when the response named no bucket this release
   * recognizes, and an unknown value read off the wire is preserved verbatim
   * in {@link errorType} rather than being rewritten.
   *
   * It is deliberately not `internal_error`. That is a real member of the
   * closed set, so defaulting to it would make "we could not tell" and "the
   * server said Router itself failed" indistinguishable to a caller reading
   * `errorType`, on exactly the responses that carry the least evidence. The
   * Python SDK's base declares `error_type = ""` for the same reason, and
   * `surface-parity.test.ts` now compares the two defaults.
   */
  static readonly errorType: string = "";

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

  /**
   * Seconds Router asked the caller to wait before re-sending this request
   * under the same `Idempotency-Key`, off `Retry-After`; `null` when the
   * response carried no usable one.
   *
   * It is on the BASE class rather than on the two buckets that can carry it,
   * so a caller who caught a `RouterError` can pace a manual re-ask without
   * first narrowing to a subclass — and so an unrecognized bucket from a newer
   * server keeps a pace it sent. A non-null value on a
   * {@link ConcurrencyLimitExceeded} `409` or a {@link DeadlineExceeded} `504`
   * is Router saying it still holds the generation your key names; `models.run`
   * already re-asks for you inside its collect budget, and this is what is left
   * to re-ask with once that budget is spent.
   */
  readonly retryAfter: number | null;

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
    this.retryAfter = options.retryAfter ?? null;
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
 * Comfy-side deadline, which shares the same `504` but arrives as
 * {@link DeadlineExceeded}.
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

/**
 * Two different conditions share this bucket, and the STATUS is what says
 * which — so a caller that branches on the class alone is answering the wrong
 * question:
 *
 * - At **`429`** the account's slot pool is full: every call the workspace is
 *   allowed to hold in flight is already held, and this one was refused before
 *   it reached the model. It clears when one of the caller's OWN in-flight
 *   calls finishes, which is what separates it from {@link RateLimited} on the
 *   same status. Nothing is running under this request's key.
 * - At **`409` with a {@link RouterError.retryAfter}** the same key is still
 *   running: another call is already in flight for the `Idempotency-Key` this
 *   request presented, and re-sending THAT SAME key after `Retry-After`
 *   seconds collects its result rather than starting a second generation.
 *   `models.run` re-asks for you, on the server's own pace, for as long as its
 *   `retry.collectBudgetMs` allows — so a `409` that reaches a caller is one
 *   that outlived that budget, and {@link RouterError.retryAfter} is the pace
 *   to re-ask at manually.
 *
 * A `409` with NO `Retry-After` is neither of those: it is the contract's
 * deterministic key refusal (the key names a different request, or its answer
 * cannot be replayed), it arrives as {@link InvalidInput} rather than this
 * class, and the answer is a NEW key. Waiting changes nothing there, which is
 * why the header is absent.
 */
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

/**
 * Comfy stopped holding the connection at its own configured bound before an
 * answer arrived. It shares `504` with {@link ProviderTimeout} and the pair
 * says which side ran out of time; this one is Comfy's own bound, so nothing
 * about the request was rejected and the same request may be retried. It says
 * nothing about the charge: a provider generation that completed is billed
 * regardless of whether the caller received the response.
 *
 * Retry it with the SAME `Idempotency-Key` — when the provider had already
 * accepted the generation, the retry collects that generation rather than
 * dispatching another, and the `Retry-After` on the `504` says when to ask.
 * `models.run` performs that collect itself, paced by that header and
 * bounded by `retry.collectBudgetMs` (twenty minutes by default: one Router
 * deadline window to reach the `504`, one to collect what it left running), so
 * this reaches a caller only once the collect budget or the call's own
 * `timeoutMs` deadline is spent. {@link RouterError.retryAfter} carries the
 * pace to re-ask at by hand after that.
 *
 * The `Retry-After` is present only when Comfy still holds a handle to a
 * running generation. A `504` WITHOUT it — an intermediary's, or a bound that
 * expired before the provider accepted anything — has nothing to collect, and
 * the same-key re-send falls back to the ordinary 5xx backoff instead.
 */
export class DeadlineExceeded extends RouterError {
  static override readonly errorType = "deadline_exceeded";
}

/**
 * Comfy Router is not switched on for this caller yet. Nothing about the
 * request is wrong and the model exists, which is why this is not
 * {@link ModelNotFound}; it shares `403` with {@link Forbidden} and is NOT
 * the same thing, because `forbidden` is an entitlement decision about the
 * caller while this is a state of the rollout. It is TERMINAL: do not retry,
 * and do not treat it as an outage.
 */
export class NotEnabled extends RouterError {
  static override readonly errorType = "not_enabled";
}

/**
 * A service Comfy Router depends on is temporarily unavailable and the caller
 * did nothing wrong. Retry it with backoff: it is the one bucket here whose
 * condition clears on its own, without the caller changing the request and
 * without a concurrency slot freeing, which is what distinguishes it from the
 * other retryable answers ({@link ConcurrencyLimitExceeded},
 * {@link DeadlineExceeded}). It is separate from {@link InternalError} —
 * which is a `500` and means Router itself failed — so a client can tell
 * "come back shortly" from "this call is not going to work".
 */
export class ServiceUnavailable extends RouterError {
  static override readonly errorType = "service_unavailable";
}

/**
 * The caller has spent an allowance measured over a WINDOW and must wait for
 * that window to roll. It shares `429` with
 * {@link ConcurrencyLimitExceeded} and is not the same thing: that one clears
 * the moment one of the caller's own in-flight calls finishes, so retrying in
 * seconds is right, whereas nothing the caller does drains this one early.
 * `detail` names the window.
 */
export class RateLimited extends RouterError {
  static override readonly errorType = "rate_limited";
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
  deadline_exceeded: DeadlineExceeded,
  not_enabled: NotEnabled,
  service_unavailable: ServiceUnavailable,
  rate_limited: RateLimited,
};

/**
 * Last-resort bucket for a response that carried no `X-Comfy-Error-Type` and
 * no `error_type` in its body — a proxy, gateway or load balancer that
 * rejected the call before it reached Router, say, so that `catch
 * (Unauthorized)` still fires for a rejected key. It is a fallback: the header
 * is the contract, and Router repeats the bucket on it for every error
 * response it writes, so nothing here is ever consulted for an answer Router
 * itself sent.
 *
 * Read each entry as "what does an INTERMEDIARY's answer most likely mean",
 * not "which bucket owns this status". This table is byte-for-byte the Python
 * SDK's `_ERROR_TYPE_BY_STATUS`, and `surface-parity.test.ts` asserts that,
 * so the same header-less response raises the same thing in both languages.
 *
 * Which is why the buckets that SHARE a status with an older one are absent
 * here, and adding them would be a regression rather than an improvement: a
 * header-less `403` cannot be told from a `forbidden`, a header-less `429`
 * from a `concurrency_limit_exceeded`, or a header-less `504` from a
 * `provider_timeout`. Guessing the newer member of the pair would relabel
 * failures this table has always classified, on exactly the responses that
 * carry the least evidence.
 *
 * A status stays OUT of the table entirely when the plain HTTP reading does
 * not pick ONE bucket, and such a response raises the base {@link RouterError}
 * with the raw status and no bucket at all — which is the honest answer:
 *
 * - `400` carries either `invalid_input` or `content_policy_violation`, and
 *   those differ in whether a retry can ever succeed. Guessing `invalid_input`
 *   tells a caller to fix-and-retry what may be a deterministic refusal.
 * - `422` has no bucket pinned to it by the contract at all: the per-field
 *   validation response carries its bucket ONLY on `X-Comfy-Error-Type`, since
 *   its body is the `detail[]` array and has no `error_type` field, so a
 *   header-less `422` is genuinely ambiguous.
 * - `503` from an intermediary is not Router's `service_unavailable`: that
 *   bucket is Router's own statement that a dependency of ITS is briefly down,
 *   and a gateway's `503` says nothing about whether the request ever reached
 *   Router to have such a statement made about it.
 */
const ERROR_TYPE_BY_STATUS: Record<number, string> = {
  401: "unauthorized",
  402: "insufficient_credits",
  403: "forbidden",
  404: "model_not_found",
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
 * response with neither falls back to {@link ERROR_TYPE_BY_STATUS}, and a
 * status that table deliberately does not name — `400`, `422`, `503`, or any
 * other — yields the base {@link RouterError} with an empty `errorType`,
 * carrying the raw `httpStatus`. Guessing a bucket there would be worse than
 * saying nothing; see that table for the per-status reasoning.
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
  // Annotated rather than inferred: without `noUncheckedIndexedAccess` an
  // index into a `Record<number, string>` types as `string`, which would hide
  // the very "no bucket" case the next line exists to produce.
  const statusType: string | undefined = ERROR_TYPE_BY_STATUS[status];
  // No trailing `|| "internal_error"` here, deliberately: a response that
  // named no bucket, on a status the table above does not map, has told us
  // nothing about which bucket it is — and `internal_error` is a real member
  // of the closed set rather than a way to say "unknown". Leaving this
  // undefined lets the base class's own default ("") stand, which is what the
  // Python SDK does with the same response.
  const errorType = headerType || bodyType || statusType;

  const options: RouterErrorOptions = {
    errorType,
    requestId,
    httpStatus: status,
    retryAfter: parseRetryAfter(headers),
  };
  // Own-property lookup only. A plain `BY_ERROR_TYPE[errorType]` would resolve
  // an `error_type` of `constructor` or `toString` off `Object.prototype` and
  // hand back something that is not a RouterError at all — and the whole point
  // of the unknown-bucket path is that a server value can never produce an
  // untyped throw.
  const cls =
    errorType !== undefined && Object.hasOwn(BY_ERROR_TYPE, errorType)
      ? BY_ERROR_TYPE[errorType]
      : undefined;

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
