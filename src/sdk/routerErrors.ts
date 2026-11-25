/**
 * Typed exceptions for the Comfy Router error contract — one class per
 * `error_type`, all descending from {@link RouterError}.
 *
 * Router answers every failure with a coarse, machine-readable bucket on the
 * `X-Comfy-Error-Type` response header (and, for the request-level body
 * shape, in `error_type` as well). The bucket set is *closed* at twenty-three
 * values in this release: eight request-level and fifteen transport-level. This
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
 *     // any bucket, known or not; `idempotencyKey` is set when the SDK stamped
 *     // this on the `models.submit` queue path, else null
 *     console.log(err.errorType, err.requestId, err.idempotencyKey);
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
 * the package root because four of the twenty-three names — `Unauthorized`,
 * `Forbidden`, `InsufficientCredits`, `RateLimited` — already exist at the
 * root as workflow-API exceptions descending from `ComfyError`, and here the
 * root class and the `routerErrors.*` class are two unrelated classes. The
 * Python SDK resolves the same collision differently: `comfy_sdk` re-exports
 * ONE class object per name out of `comfy_sdk.router_exceptions`, so its root
 * `RateLimited` is a `RouterError` and `except RateLimited` also catches a
 * Router 429, where `instanceof RateLimited` here does not. The names match,
 * so the name-only parity check cannot see this; it is declared in
 * `surface-parity.test.ts`'s `router-errors-namespaced` entry instead.
 *
 * A bucket the vendored contract grows before the Python SDK's table does is
 * declared as leading the Python SDK in `surface-parity.test.ts`'s allowlist
 * (`routerErrorClassesAheadOfPython`), which fails once the Python side catches
 * up so the entry cannot outlive the lead. None is declared today.
 */

/**
 * The eight request-level buckets, in the order the error contract lists them.
 *
 * Two distinctions here are load-bearing rather than cosmetic, because a
 * caller branches on them:
 *
 * - `content_policy_violation` is **not** `provider_error`. A policy refusal
 *   is deterministic; retrying the identical input will not succeed.
 * - `provider_timeout` is an *upstream* stall, not a Comfy-side deadline. A
 *   deadline that expires on our side shares the same `504` but arrives as
 *   `deadline_exceeded`.
 *
 * - `budget_exceeded` is **not** `insufficient_credits`. Both answer `402`,
 *   but this one says a hard spend cap set on the workspace was reached while
 *   the workspace may still hold credits (see {@link BudgetExceeded}).
 *
 * The last one, `byok_credential_rejected`, was added after the transport-level
 * buckets: the contract lists it at the very end of its set, and it keeps its
 * tier here, so each tier reads in the order the contract lists it. It names
 * the caller's own PROVIDER key (see {@link ByokCredentialRejected}).
 */
export const REQUEST_ERROR_TYPES = [
  "invalid_input",
  "content_policy_violation",
  "provider_error",
  "provider_timeout",
  "insufficient_credits",
  "budget_exceeded",
  "model_not_found",
  "byok_credential_rejected",
] as const;

/**
 * The fifteen transport-level buckets, in the order the error contract lists
 * them. They are part of the same closed set — a caller reads one value off
 * one header — but they are raised before or around the model call rather
 * than derived from a provider response.
 *
 * The first, `budget_check_unavailable`, is listed ahead of the others because
 * the contract places it beside `budget_exceeded`, in the middle of the
 * request-level run; it is a transport-level bucket all the same (a spend cap
 * that could not be CHECKED, answered `503`).
 *
 * The last five (`cancelled`, `queue_timeout`, `request_not_found`,
 * `queue_backlog_full`, `result_expired`) are the QUEUE tier: they are reported
 * by the queued `submit`/`handle` surface, the first four by status codes an
 * older bucket already owns and the last by `410`, which no other bucket uses.
 * Counting the request-level `byok_credential_rejected` and `budget_exceeded`
 * too, eight HTTP statuses here carry more than one bucket, and the status alone cannot tell them apart
 * — so a caller that branches on status gets the wrong answer for all but the
 * oldest member of each:
 *
 * - `401` is `unauthorized` (the caller's Comfy credential was missing or
 *   invalid) **or** `byok_credential_rejected` (the provider refused the key
 *   the caller supplied for it, so the Comfy credential was fine).
 * - `402` is `insufficient_credits` (the workspace is out of credits) **or**
 *   `budget_exceeded` (a hard spend cap was reached).
 * - `403` is `forbidden` (an entitlement decision about this caller) **or**
 *   `not_enabled` (a state of the Router rollout, nothing to do with the
 *   caller's entitlements).
 * - `404` is `model_not_found` (the `{provider}/{model}` id names nothing)
 *   **or** `request_not_found` (a queued `request_id` that names nothing).
 * - `409` is `concurrency_limit_exceeded` **or** `cancelled` (collecting the
 *   result of a request the caller withdrew).
 * - `429` is `concurrency_limit_exceeded` (clears when one of the caller's
 *   own in-flight calls finishes) **or** `rate_limited` (clears only when a
 *   time window rolls) **or** `queue_backlog_full` (clears as the caller's own
 *   QUEUED requests finish).
 * - `503` is `service_unavailable` (a dependency of Router's is down) **or**
 *   `budget_check_unavailable` (the spend cap could not be checked). Both
 *   clear on their own and both are retried.
 * - `504` is `provider_timeout` (the partner ran out of time) **or**
 *   `deadline_exceeded` (Comfy stopped holding the connection) **or**
 *   `queue_timeout` (a queued request was never admitted).
 *
 * The header is what disambiguates each; `ERROR_TYPE_BY_STATUS` below is only
 * consulted when there is no header at all, and it deliberately keeps naming
 * the older member of each shared status.
 */
export const TRANSPORT_ERROR_TYPES = [
  "budget_check_unavailable",
  "unauthorized",
  "forbidden",
  "concurrency_limit_exceeded",
  "client_disconnected",
  "internal_error",
  "deadline_exceeded",
  "not_enabled",
  "service_unavailable",
  "rate_limited",
  "cancelled",
  "queue_timeout",
  "request_not_found",
  "queue_backlog_full",
  "result_expired",
] as const;

/**
 * The closed error-type set for this release, in the order the contract lists
 * it: the five oldest request-level buckets, then `budget_exceeded`
 * (request-level) and `budget_check_unavailable` (transport-level), which the
 * contract lists together, then `model_not_found`, the transport-level ones,
 * and finally `byok_credential_rejected`, a request-level bucket the contract
 * added after them. That is why this is not
 * `[...REQUEST_ERROR_TYPES, ...TRANSPORT_ERROR_TYPES]`: each tier keeps its own
 * order, and `router-spec-coverage.test.ts` checks the whole list and each tier
 * against the contract.
 */
export const ROUTER_ERROR_TYPES = [
  "invalid_input",
  "content_policy_violation",
  "provider_error",
  "provider_timeout",
  "insufficient_credits",
  "budget_exceeded",
  "budget_check_unavailable",
  "model_not_found",
  "unauthorized",
  "forbidden",
  "concurrency_limit_exceeded",
  "client_disconnected",
  "internal_error",
  "deadline_exceeded",
  "not_enabled",
  "service_unavailable",
  "rate_limited",
  "cancelled",
  "queue_timeout",
  "request_not_found",
  "queue_backlog_full",
  "result_expired",
  "byok_credential_rejected",
] as const satisfies readonly (
  | (typeof REQUEST_ERROR_TYPES)[number]
  | (typeof TRANSPORT_ERROR_TYPES)[number]
)[];

/** One of the twenty-three buckets this release knows about. */
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
 * `X-Comfy-Refusal-Subject` — which input or output a content-policy refusal
 * was about. Mirrored in the body as `refusal_subject`; see
 * {@link RouterError.refusalSubject}.
 */
export const REFUSAL_SUBJECT_HEADER = "X-Comfy-Refusal-Subject";

/**
 * The refusal subjects the upstream Router contract documents, for
 * autocomplete and for a caller who wants to enumerate them.
 *
 * Pinned to `spec/router-openapi.yaml` by `router-spec-contract.test.ts`,
 * along with {@link REFUSAL_SUBJECT_HEADER} and the body's `refusal_subject`:
 * the contract lists this closed vocabulary in the header's and the body
 * field's descriptions, and a sync that changes it fails that test.
 *
 * The bare `input` / `output` name the side when the provider did not name a
 * modality; the other eight name the side and the modality both.
 *
 * {@link RouterError.refusalSubject} is deliberately NOT narrowed to this list,
 * for the same reason `errorType` is not narrowed to
 * {@link ROUTER_ERROR_TYPES}: a newer server may name a subject this release
 * has not heard of, and that value reaches the caller verbatim. Treat a value
 * outside this list as unspecified — as if Router had named no subject — rather
 * than switching exhaustively over it.
 */
export const REFUSAL_SUBJECTS = [
  "input",
  "output",
  "input_text",
  "input_image",
  "input_video",
  "input_audio",
  "output_text",
  "output_image",
  "output_video",
  "output_audio",
] as const;

/** One of the ten refusal subjects this release knows about. */
export type RefusalSubject = (typeof REFUSAL_SUBJECTS)[number];

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

/**
 * One hard spend budget, as a `402 budget_exceeded` body names it — the
 * camelCase of the contract's `RouterSpendBudgetDetail`.
 *
 * Only {@link scopeKind}, {@link resetsAt} and {@link setBy} are required.
 * The contract says the identifiers, the mode and the amounts are visible to
 * workspace Owners, so expect them to be missing for anyone else. A missing
 * field is left absent here, never filled with a zero, so read an absent
 * amount as "not disclosed", never as "nothing spent".
 *
 * The strings are open, not unions: the contract declares no closed vocabulary
 * for `scope_kind`, `mode` or `set_by`, and a newer server's value must reach
 * the caller verbatim.
 */
export interface SpendBudgetDetail {
  /** What the budget is set on (`scope_kind`), verbatim. */
  readonly scopeKind: string;
  /** When the budget resets (`resets_at`), as the ISO-8601 date-time string Router sent. */
  readonly resetsAt: string;
  /** Who set the budget (`set_by`), verbatim. */
  readonly setBy: string;
  /** The budget's id (`id`) — Owner-visible. */
  readonly id?: string;
  /** The id of the scope the budget is set on (`scope_id`) — Owner-visible. */
  readonly scopeId?: string;
  /** The budget's mode (`mode`), verbatim — Owner-visible. */
  readonly mode?: string;
  /** The budget's limit in millionths of a US dollar (`limit_micro_usd`) — Owner-visible. */
  readonly limitMicroUsd?: number;
  /** What has been spent against it, in millionths of a US dollar (`spent_micro_usd`) — Owner-visible. */
  readonly spentMicroUsd?: number;
  /** The budget's limit in Comfy credits (`limit_credits`) — Owner-visible. */
  readonly limitCredits?: number;
  /** What has been spent against it, in Comfy credits (`spent_credits`) — Owner-visible. */
  readonly spentCredits?: number;
}

/**
 * The wire names of every `RouterSpendBudgetDetail` field
 * {@link SpendBudgetDetail} reads. Pinned to the vendored Router contract by
 * `router-spec-contract.test.ts`, so a sync that adds or renames one fails
 * there rather than being dropped here without a word.
 */
export const SPEND_BUDGET_DETAIL_FIELDS = [
  "scope_kind",
  "resets_at",
  "set_by",
  "id",
  "scope_id",
  "mode",
  "limit_micro_usd",
  "spent_micro_usd",
  "limit_credits",
  "spent_credits",
] as const;

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
  /** See {@link RouterError.refusalSubject}. */
  refusalSubject?: string | null;
  /** See {@link RouterError.idempotencyKey}. */
  idempotencyKey?: string | null;
  /** See {@link RouterError.refusalCode}. */
  refusalCode?: string | null;
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

  /**
   * Which input or output a content-policy refusal was about — `"output_audio"`,
   * `"input_image"`, … — off `X-Comfy-Refusal-Subject`, falling back to the
   * body's `refusal_subject`; `null` when the response named none.
   *
   * Router sets it only on a {@link ContentPolicyViolation}, and only when the
   * provider named the refused subject with a machine-readable code, so its
   * absence is the common case and means "not said", not "the whole request".
   * It lets a caller change the one thing that was refused rather than give
   * up. Router names a subject on a `comfy.models.run` refusal today, which
   * that method raises as a `ComfyError` with
   * `code: "content_policy_violation"` carrying the same value, read the same
   * way, on `ComfyError.refusalSubject`:
   *
   * ```ts
   * try {
   *   return await comfy.models.run(model, input);
   * } catch (err) {
   *   if (err instanceof ComfyError && err.code === "content_policy_violation" && err.refusalSubject === "output_audio") {
   *     return comfy.models.run(model, { ...input, generate_audio: false });
   *   }
   *   throw err;
   * }
   * ```
   *
   * The surfaces that raise `routerErrors.*` read it here — the queued
   * `submit`, and a refused completion from `subscribe` or
   * `RequestHandle.get()` (`status()` and `events()` report a completion as
   * data and do not throw). Router's terminal queue status does not carry a
   * subject yet, so on a refused queued completion this is `null` until
   * Router starts sending one; do not build a queued retry branch on it today.
   *
   * It is the raw string, not narrowed to {@link REFUSAL_SUBJECTS}: a newer
   * server may send a subject this release does not know, and a caller should
   * treat one as unspecified. It is on the BASE class, like
   * {@link retryAfter}, so an unrecognized bucket from a newer server keeps it.
   */
  readonly refusalSubject: string | null;

  /**
   * The `Idempotency-Key` the failed queue call was sent under, or `null` when
   * none was in scope.
   *
   * It is here for the same reason it is on `ComfyError.idempotencyKey`:
   * on a transport failure comfy-api never minted an {@link requestId}, so the
   * key is the only value that correlates the failure to the server-side
   * record. A queue-path error the SDK stamps in `models.submit` (a bare `502`
   * `ProviderError`, say) reports it here rather than as a duck-typed own
   * property, so a caller who caught a `RouterError` can read it by type.
   */
  readonly idempotencyKey: string | null;

  /**
   * The finer-grained refusal reason a realtime session upgrade names in its
   * body's `code` field (`router.realtime.session_already_live`, say), or
   * `null` when the body carried none — which is every non-realtime response.
   *
   * It sits BESIDE {@link errorType} rather than replacing it: the coarse
   * bucket stays the thing to branch on, and this is the detail that tells
   * two refusals in the same bucket apart (a `429` for a session already live
   * on the workspace versus one for the concurrency limit). An open string,
   * for the same reason `errorType` is not narrowed. See `./realtime.ts`.
   */
  readonly refusalCode: string | null;

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
    this.refusalSubject = options.refusalSubject ?? null;
    this.idempotencyKey = options.idempotencyKey ?? null;
    this.refusalCode = options.refusalCode ?? null;
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
 *
 * What CAN succeed is a changed request, and {@link RouterError.refusalSubject}
 * says which input or output to change when the provider named one.
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

/**
 * A hard spend cap has been reached, and the answer is `402`. Sending the same
 * request again is refused the same way while the cap stays reached, so do
 * not retry it.
 *
 * It shares `402` with {@link InsufficientCredits} and is not the same thing:
 * that one says the workspace has run out of credits, whereas this says a
 * spend cap stopped the call, which says nothing about the credit balance.
 * The response body's `budget` names the exhausted cap, on {@link budget}, and
 * `blocking_budgets` lists every exhausted one, on {@link blockingBudgets}.
 */
export class BudgetExceeded extends RouterError {
  static override readonly errorType = "budget_exceeded";

  /** The exhausted budget the body names, or `undefined` when it named none. */
  readonly budget: SpendBudgetDetail | undefined;

  /**
   * Every exhausted hard budget the body lists; empty when it listed none. The
   * contract makes this list visible to the workspace Owner.
   */
  readonly blockingBudgets: readonly SpendBudgetDetail[];

  constructor(
    message: string,
    options: RouterErrorOptions & {
      budget?: SpendBudgetDetail;
      blockingBudgets?: readonly SpendBudgetDetail[];
    } = {},
  ) {
    super(message, options);
    this.budget = options.budget;
    this.blockingBudgets = Object.freeze([...(options.blockingBudgets ?? [])]);
  }
}

/** No such model — the `{provider}/{model}` pair is not one Router serves. */
export class ModelNotFound extends RouterError {
  static override readonly errorType = "model_not_found";
}

/**
 * The model provider rejected the key the caller supplied for this call, and
 * the answer is `401`. Sending the same key again is refused the same way, so
 * check the key stored for this provider rather than retrying.
 *
 * It shares `401` with {@link Unauthorized} and is not the same thing: that one
 * says the caller's COMFY credential was missing or invalid, whereas this names
 * the caller's own PROVIDER key. It is not {@link ProviderError} either, which
 * reports a failure on the provider's side. An upstream `403` is the same
 * refusal and also arrives as this `401`, with the provider's own status on
 * `X-Comfy-Upstream-Status`.
 */
export class ByokCredentialRejected extends RouterError {
  static override readonly errorType = "byok_credential_rejected";
}

// -- transport-level buckets -------------------------------------------------

/**
 * Router could not check a hard spend cap, so it refused the call, and the
 * answer is `503`.
 *
 * It clears on its own, like {@link ServiceUnavailable} on the same status, and
 * is retried the same way: `models.run` re-sends it under the call's own
 * `Idempotency-Key` on the ordinary 5xx backoff. The contract asks a caller to
 * wait the `Retry-After` delay first, which {@link RouterError.retryAfter}
 * carries for a manual re-send. It is not {@link BudgetExceeded}: no cap was
 * found to be reached.
 */
export class BudgetCheckUnavailable extends RouterError {
  static override readonly errorType = "budget_check_unavailable";
}

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

// -- queue buckets -----------------------------------------------------------

/**
 * A queued request was withdrawn before it produced a result — through the
 * cancel route, or by an operator — and it is TERMINAL.
 *
 * It is not by itself a statement about the charge: a request cancelled while
 * still `IN_QUEUE` was never dispatched and cannot be charged, while one
 * cancelled after it was admitted may still be, since a partner generation that
 * completes is charged whether or not anyone collected it — which is why the
 * cancel route calls the ask a request, not a guarantee. It is NOT
 * {@link ClientDisconnected}: that says nobody is listening any more while a
 * generation may still be running and billable; this says the request itself
 * was withdrawn. The status read answers `200` with this in the body (the
 * request ended, so the read succeeded); collecting the result answers `409` —
 * the read worked and found a request whose terminal state, the caller's own
 * decision, leaves nothing to return. Deliberately not `410` (which on that
 * route means the result aged out of retention) and not a `5xx` (which would
 * report the caller's own cancellation as a Router fault worth retrying).
 */
export class Cancelled extends RouterError {
  static override readonly errorType = "cancelled";
}

/**
 * A queued request waited past its queue timeout without ever being admitted.
 * **Terminal, unbilled, and it never took a concurrency slot** — the job never
 * reached a provider.
 *
 * Deliberately not {@link DeadlineExceeded}, which is the synchronous route's
 * connection bound and may leave a generation running and billable; this one
 * provably never started. It is returned under `504`, shared with
 * {@link ProviderTimeout} and {@link DeadlineExceeded} because a status can
 * only say a clock ran out — which clock (the partner's, Comfy's connection
 * bound, or the queue's admission bound) is what `errorType` carries. The
 * request is terminal: submit a new one rather than re-reading this one.
 */
export class QueueTimeout extends RouterError {
  static override readonly errorType = "queue_timeout";
}

/**
 * The `request_id` names no queued request of the caller's under this model.
 *
 * The second of the two conditions the queued reads' `404` covers; the first is
 * the `{provider}/{model}` id resolving to no partner model, which is
 * {@link ModelNotFound} and carries fuzzy suggestions. It also covers the
 * right-id / wrong-model URL the path shape refuses, and it is deliberately
 * indistinguishable from a request in another workspace, so a probe with a
 * guessed id learns nothing. A request that merely aged out of its retention
 * window is `410`, not this.
 */
export class RequestNotFound extends RouterError {
  static override readonly errorType = "request_not_found";
}

/**
 * A queued submit was refused because the caller already has too many queued
 * requests waiting to run.
 *
 * It shares `429` with {@link ConcurrencyLimitExceeded} and is not the same
 * thing: that one is the synchronous route's bound on calls in flight at once,
 * whereas the queue accepts a submit at that limit and parks it — this is the
 * separate bound on how many a caller may leave waiting, so that parking
 * cannot mean enqueuing without end. Nothing was submitted and nothing was
 * charged. It clears as the caller's own queued requests finish, so submit
 * again once some of them complete.
 */
export class QueueBacklogFull extends RouterError {
  static override readonly errorType = "queue_backlog_full";
}

/**
 * The queued request existed and finished, but its result is no longer stored,
 * so the collect has nothing to return. It answers `410` and is PERMANENT for
 * that `request_id`: re-reading answers the same way, so do not retry it.
 *
 * It is deliberately not {@link RequestNotFound}, which would say the id was
 * never valid and invite re-submitting a generation that has already run.
 * Running the model again means submitting a new request. Under a
 * zero-data-retention agreement a result is removed shortly after the first
 * collect, so a second collect can raise this: store the result on your side
 * the first time.
 */
export class ResultExpired extends RouterError {
  static override readonly errorType = "result_expired";
}

type RouterErrorClass = new (message: string, options: RouterErrorOptions) => RouterError;

const BY_ERROR_TYPE: Record<string, RouterErrorClass> = {
  invalid_input: InvalidInput,
  content_policy_violation: ContentPolicyViolation,
  provider_error: ProviderError,
  provider_timeout: ProviderTimeout,
  insufficient_credits: InsufficientCredits,
  budget_exceeded: BudgetExceeded,
  budget_check_unavailable: BudgetCheckUnavailable,
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
  cancelled: Cancelled,
  queue_timeout: QueueTimeout,
  request_not_found: RequestNotFound,
  queue_backlog_full: QueueBacklogFull,
  result_expired: ResultExpired,
  byok_credential_rejected: ByokCredentialRejected,
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
 * `provider_timeout`. The queue tier adds four more of the same shape —
 * `cancelled` shares `409`, `queue_timeout` shares `504`, `request_not_found`
 * shares `404` and `queue_backlog_full` shares `429` — and stays out for the
 * same reason: the table keeps naming `model_not_found` for `404` and the
 * run-route member for `409`/`429`/`504`. So does `byok_credential_rejected`,
 * which shares `401` with `unauthorized`: a header-less `401` keeps reading as
 * a rejected Comfy credential, and `budget_exceeded`, which shares `402` with
 * `insufficient_credits`: a header-less `402` keeps reading as out of credits.
 * Guessing the newer member of a shared status
 * would relabel failures this table has always classified, on exactly the
 * responses that carry the least evidence. `result_expired` shares `410` with
 * no other bucket, but the Python SDK's table maps no `410` either, so a
 * header-less `410` raises the base {@link RouterError} here too.
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
 *   Router to have such a statement made about it. The same holds for
 *   `budget_check_unavailable`, Router's other `503`.
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
  refusal_subject?: unknown;
  code?: unknown;
  budget?: unknown;
  blocking_budgets?: unknown;
}

/**
 * One refusal subject out of a header or body value, or `null` when the value
 * names none: not a string, blank once trimmed, or comma-joined from two
 * different subjects — `Headers.get` joins a repeated header with `", "`, and
 * two subjects are not one subject. A repeat of the SAME subject (a proxy
 * re-adding a header the origin already set) still names that one.
 *
 * Exported, like {@link parseRetryAfter}, so `comfy.models.run` reads
 * `ComfyError.refusalSubject` through the same normalizer — this module
 * imports nothing, so a shared helper has to live here rather than beside it.
 */
export function readRefusalSubject(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const [first, ...rest] = value.split(",").map((part) => part.trim());
  return first === "" || rest.some((part) => part !== first) ? null : first;
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

/**
 * Parse one `RouterSpendBudgetDetail`, keeping it only if its three required
 * fields are present strings — the same rule as {@link parseDetailEntry}: a
 * budget with no `scope_kind` is worse than no budget at all. An optional field
 * of the wrong type is left out rather than failing the whole entry, and an
 * amount counts only as a safe integer, since the contract declares `int64`
 * and a JavaScript number past 2^53 no longer says which one it was.
 * Frozen, so nothing holding the error can change what it reports.
 */
function parseSpendBudget(raw: unknown): SpendBudgetDetail | null {
  if (!isRecord(raw)) return null;
  const { scope_kind, resets_at, set_by } = raw;
  if (typeof scope_kind !== "string" || typeof resets_at !== "string") return null;
  if (typeof set_by !== "string") return null;
  const parsed: { -readonly [K in keyof SpendBudgetDetail]: SpendBudgetDetail[K] } = {
    scopeKind: scope_kind,
    resetsAt: resets_at,
    setBy: set_by,
  };
  // Absent stays absent: only a field the body carried is set, so
  // `"id" in budget` never claims one it did not.
  if (typeof raw.id === "string") parsed.id = raw.id;
  if (typeof raw.scope_id === "string") parsed.scopeId = raw.scope_id;
  if (typeof raw.mode === "string") parsed.mode = raw.mode;
  if (isAmount(raw.limit_micro_usd)) parsed.limitMicroUsd = raw.limit_micro_usd;
  if (isAmount(raw.spent_micro_usd)) parsed.spentMicroUsd = raw.spent_micro_usd;
  if (isAmount(raw.limit_credits)) parsed.limitCredits = raw.limit_credits;
  if (isAmount(raw.spent_credits)) parsed.spentCredits = raw.spent_credits;
  return Object.freeze(parsed);
}

function isAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
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

  // Header first, body second — the same order the bucket is read in. Router
  // mirrors one onto the other, so they only disagree if something between
  // here and Router rewrote one of them, and the header is the half this module
  // already trusts for the bucket. A value that names no single subject says
  // nothing and falls through, like an empty bucket.
  const refusalSubject =
    readRefusalSubject(headers.get(REFUSAL_SUBJECT_HEADER)) ??
    readRefusalSubject(envelope.refusal_subject);

  const options: RouterErrorOptions = {
    errorType,
    requestId,
    httpStatus: status,
    retryAfter: parseRetryAfter(headers),
    refusalSubject,
    refusalCode: typeof envelope.code === "string" ? envelope.code : null,
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

  // `status` is `0` only when `errorFromCompletion` built this from a
  // COMPLETED payload, where there was no failing HTTP status to name. Saying
  // `HTTP 0` there reports a status no server ever sent — the same thing the
  // `httpStatus: null` override in that function exists to prevent, and the
  // message is the half a caller actually reads and logs. Fall back to the
  // bucket instead, matching the Python SDK's `error_from_completion`, which
  // the doc on that function claims parity with.
  const message =
    typeof envelope.detail === "string"
      ? envelope.detail
      : status > 0
        ? `HTTP ${status}`
        : `the request completed with error_type '${errorType ?? ""}'`;

  if (cls === BudgetExceeded) {
    // Every entry that parses is kept and every one that does not is
    // dropped, so a single malformed budget does not cost the caller the
    // others. A `budget` that does not parse is `undefined`, as if absent.
    const blockingBudgets = Array.isArray(envelope.blocking_budgets)
      ? envelope.blocking_budgets
          .map(parseSpendBudget)
          .filter((b): b is SpendBudgetDetail => b !== null)
      : [];
    return new BudgetExceeded(message, {
      ...options,
      budget: parseSpendBudget(envelope.budget) ?? undefined,
      blockingBudgets,
    });
  }

  return new (cls ?? RouterError)(message, options);
}

/**
 * The typed exception a COMPLETED queued request reports, or `null`.
 *
 * The queue (`comfy.models.submit` and friends) expresses a failure — and a
 * cancellation — the same way it expresses a success: the request reaches
 * `COMPLETED`, and the failure rides in the body as an `error_type`. There is
 * no error STATUS to read, since the poll that discovered it was a `200`, so a
 * client that only mapped HTTP status codes would hand a caller a failed
 * generation back as a successful result. This maps that body through the same
 * `error_type` table {@link toRouterError} uses, so one bucket is one class
 * however it arrived.
 *
 * Returns `null` when the payload names no `error_type`, which is the ordinary
 * success path; every caller has to read that as "no error found" rather than
 * as "no error possible".
 *
 * `httpStatus` is left `null` on what this builds, deliberately: there was no
 * failing status, and reporting one would invite a caller to branch on a code
 * the server never sent. That also keeps `./retry.ts` out of it — a completion
 * carrying an `error_type` is the server's final answer about a request that
 * already ran, not a transport condition another attempt could survive.
 *
 * Like {@link toRouterError} it never throws: a malformed body degrades to the
 * least specific exception the payload still supports. Mirrors the Python
 * SDK's `error_from_completion`.
 */
export function errorFromCompletion(body: unknown, requestId: string | null): RouterError | null {
  if (!isRecord(body)) return null;
  const raw = body.error_type;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  // Routed through the shared builder so the `detail[]` handling, the
  // unknown-bucket fallback and the prototype-pollution guard are the ones
  // already tested there. The stand-in headers name no bucket, so the body's
  // `error_type` is what decides the class, and the status argument is `0` —
  // outside `ERROR_TYPE_BY_STATUS` — so nothing is inferred from it. They DO
  // carry the request id, because a completion arrives on a `200` whose own
  // `X-Comfy-Request-Id` identifies the poll rather than the queued request,
  // and the queued request's id is the one worth quoting.
  const headers: HeadersLike = {
    get: (name) => (name === REQUEST_ID_HEADER ? requestId : null),
  };
  const error = toRouterError(0, headers, { ...body, error_type: raw.trim() });
  // `httpStatus` is `readonly`, and `0` is not a status any server sent.
  return Object.defineProperty(error, "httpStatus", {
    value: null,
    writable: false,
    enumerable: true,
    configurable: true,
  });
}
