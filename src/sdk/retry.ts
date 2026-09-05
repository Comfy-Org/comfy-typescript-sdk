/**
 * Retry policy for `comfy.models.run`.
 *
 * Sans-IO on purpose: everything here is a pure decision — is this failure
 * worth another attempt, and how long to wait before making it. The loop that
 * acts on those decisions lives in `./models.ts`, next to the `fetch` it
 * retries, so the policy stays testable without a socket.
 *
 * Three properties are load-bearing, and each is why this is a module rather
 * than three lines inline:
 *
 * - **The bound is total elapsed time, not an attempt count.** An attempt
 *   count bounds round trips but says nothing about the wall clock, so on a
 *   surface whose attempts are slow — this one holds the connection for the
 *   whole generation — "3 retries" can mean twenty minutes. The budget is
 *   measured against the clock, and a further attempt is only started if it
 *   can start inside it.
 * - **The backoff carries jitter.** A fleet of clients that all failed
 *   against the same server-side incident otherwise wakes up together and
 *   re-lands as one synchronized wave, which is how a recovering service is
 *   knocked back over. Half of each delay is fixed (so a struggling server
 *   still gets a real pause) and half is random (so the wave spreads).
 * - **A replay is only safe because the key is stable.** Every attempt of one
 *   logical call reuses that call's `Idempotency-Key`, so a retry after a lost
 *   response is a replay rather than a second generation — and a second
 *   charge. That is enforced in `./models.ts`; it is the premise this whole
 *   module rests on.
 *
 * # Two classes of resend, two budgets
 *
 * {@link isRetryableStatus} answers "the server failed to answer, and that may
 * not repeat" — a 5xx, on a schedule this module guesses. {@link isCollectable}
 * answers a different question: the server said the work THIS KEY already names
 * is still running, and named the interval to ask again at. Those are paced by
 * the server's own `Retry-After` rather than by the backoff here, and they get
 * their own, longer budget ({@link DEFAULT_COLLECT_BUDGET_MS}) because a
 * collect has to outlast a server-side deadline that the ordinary budget is
 * deliberately too short to survive. The Python SDK splits them the same way
 * (`is_collectable` / `collect_max_elapsed` in `comfy_sdk/retry.py`).
 */

/** Knobs for {@link RetryOptions.budgetMs} and friends. Pass `false` in place
 * of this object to switch retries off entirely. */
export interface RetryOptions {
  /**
   * Total wall-clock budget for one logical call, in milliseconds, measured
   * from the first attempt. A further attempt is started only if its backoff
   * would end inside the budget; `0` disables retries, same as `false`.
   */
  budgetMs?: number;
  /** Backoff before the first retry, in milliseconds. Doubles per attempt,
   * capped at {@link maxDelayMs}, then jittered. */
  baseDelayMs?: number;
  /** Ceiling for a single backoff, in milliseconds (applied before jitter). */
  maxDelayMs?: number;
  /**
   * Wall-clock budget for the COLLECT class specifically, in milliseconds,
   * measured from the same first attempt as {@link budgetMs} and used in its
   * place once the server has said the work is still running (see
   * {@link isCollectable}). Defaults to {@link DEFAULT_COLLECT_BUDGET_MS}.
   *
   * `0` switches the collect loop off while leaving ordinary retries alone, so
   * a Router `409`/`504` that named a pace is raised to the caller instead of
   * being re-asked. It is ignored entirely when {@link budgetMs} is `0` (and
   * under `retry: false`), so a caller who asked for one attempt still gets
   * exactly one.
   */
  collectBudgetMs?: number;
}

/**
 * Default retry budget: two minutes of wall clock from the first attempt.
 *
 * Sized against what this surface actually does rather than against a generic
 * HTTP client. A call that fails fast — connection refused, a 503 off a
 * load balancer — burns milliseconds per attempt, so two minutes is a long
 * run of retries across a short outage. A call that already held the
 * connection for longer than this was mid-generation when it broke, and
 * replaying it is the expensive kind of retry; that one is left to the caller
 * to ask for by raising the budget.
 */
export const DEFAULT_RETRY_BUDGET_MS = 120_000;

/** Default backoff before the first retry. */
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;

/** Default ceiling for a single backoff, before jitter. */
export const DEFAULT_RETRY_MAX_DELAY_MS = 8_000;

/**
 * Default collect budget: twenty minutes of wall clock from the first attempt.
 *
 * Two Router deadline windows, and that is the whole derivation. A
 * `deadline_exceeded` `504` arrives AT Comfy's own bound — ten minutes — so a
 * budget of one window is already spent by the time the answer that starts a
 * collect lands, and the collect attempt it was sized for never begins. One
 * window to reach the `504`, one to collect what it left running.
 *
 * Nothing else pays for it: a refused connection or a plain 5xx still gives up
 * at {@link DEFAULT_RETRY_BUDGET_MS}, because the two classes are budgeted
 * separately. Same sizing and same rationale as the Python SDK's
 * `RetryPolicy.collect_max_elapsed`.
 */
export const DEFAULT_COLLECT_BUDGET_MS = 1_200_000;

/** A fully resolved policy — every field settled, nothing left to default. */
export interface RetryPolicy {
  budgetMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  collectBudgetMs: number;
}

/** The policy a caller gets from `retry: false`: one attempt, no more. */
export const NO_RETRY: RetryPolicy = Object.freeze({
  budgetMs: 0,
  baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
  maxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
  // Zero here as well as in `budgetMs`, though either one alone would do it:
  // `nextCollectDelayMs` refuses on a spent `budgetMs` first, so `retry: false`
  // is one attempt whatever this said. Stating it makes the policy object read
  // as what it is rather than as a collect budget that happens to be unreachable.
  collectBudgetMs: 0,
});

/**
 * Failure buckets a replay cannot change.
 *
 * These are verdicts about the caller or the request itself, not about the
 * server's health: the same bytes sent again get the same answer, so retrying
 * only spends time and risks a second charge. They are checked against
 * `X-Comfy-Error-Type` because the router can answer with one of them under a
 * 5xx (a policy verdict reached inside a provider call, say), and status
 * alone would then read as "transient".
 *
 * `not_enabled` is here for that reason and not because of its status. It
 * arrives on a `403`, which the `status < 500` rule already refuses to retry,
 * so this entry changes nothing for a well-formed response — but the contract
 * calls the bucket TERMINAL and says not to treat it as an outage, and a
 * caller off the rollout ramp is the one who would otherwise spend a full
 * retry budget on an answer that cannot change within it.
 *
 * The bucket that is deliberately NOT here is `service_unavailable`: it is
 * the one answer whose condition clears on its own, so it stays retryable and
 * a `503` carrying it climbs out through the ordinary backoff below, replayed
 * under the call's own `Idempotency-Key`.
 */
export const TERMINAL_ERROR_TYPES: ReadonlySet<string> = new Set([
  "content_policy_violation",
  "invalid_input",
  "model_not_found",
  "not_enabled",
]);

function nonNegative(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `retry.${label} must be a finite number of milliseconds >= 0, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Settle a caller's `retry` option into a policy. */
export function resolveRetry(options: RetryOptions | false | undefined): RetryPolicy {
  if (options === false) return NO_RETRY;
  return {
    budgetMs: nonNegative(options?.budgetMs, DEFAULT_RETRY_BUDGET_MS, "budgetMs"),
    baseDelayMs: nonNegative(options?.baseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS, "baseDelayMs"),
    maxDelayMs: nonNegative(options?.maxDelayMs, DEFAULT_RETRY_MAX_DELAY_MS, "maxDelayMs"),
    collectBudgetMs: nonNegative(
      options?.collectBudgetMs,
      DEFAULT_COLLECT_BUDGET_MS,
      "collectBudgetMs",
    ),
  };
}

/**
 * Is a response worth another attempt?
 *
 * Only 5xx — the server failed to answer for reasons that may not repeat.
 * Everything below 500 is the server's considered answer about this request
 * (`404`, `422`, a `content_policy_violation`, a `not_enabled`), and resending
 * it just spends the same money on the same verdict. A 5xx that names a
 * terminal bucket in `X-Comfy-Error-Type` is treated as that verdict too —
 * and, in the other direction, a `503` naming `service_unavailable` is exactly
 * what this is for.
 *
 * A `409` is NOT on that list any more, and the omission is the point: the
 * status covers two opposite answers. Router's in-flight `409` — the one
 * naming `concurrency_limit_exceeded` with a `Retry-After` — is an invitation
 * to ask again under the same key, and it is {@link isCollectable}, not this
 * predicate, that recognizes it. Every OTHER `409` (header-less, an
 * `invalid_input` key refusal) is still a verdict and still terminal here,
 * because this function keeps answering `false` for anything under 500.
 */
export function isRetryableStatus(status: number, errorType: string | null): boolean {
  if (status < 500) return false;
  return errorType === null || !TERMINAL_ERROR_TYPES.has(errorType);
}

/**
 * Did the server say the work THIS KEY already names is still running, and name
 * the interval to ask for it again at?
 *
 * That is a different question from {@link isRetryableStatus}, and the answer
 * is a different action: not "the request may work this time" but "the
 * generation your `Idempotency-Key` is holding has not finished — re-send the
 * same key and collect it". Exactly two answers mean it, and each is gated on
 * BOTH its bucket and its pace:
 *
 * - a `504` naming `deadline_exceeded` — Comfy stopped holding the connection
 *   at its own bound while the generation ran on. The bucket is required
 *   because `504` is shared with `provider_timeout`, where nothing blesses a
 *   same-key resend, and a header-less `504` from an intermediary says nothing
 *   at all about what Comfy is holding.
 * - a `409` naming `concurrency_limit_exceeded` — another call is already in
 *   flight for this very key. The bucket is required because the other `409`s
 *   this route answers with are DETERMINISTIC refusals a pace does not soften:
 *   a header-less conflict from a proxy, and the contract's `invalid_input`
 *   key refusals (the key names a different request, or its answer cannot be
 *   replayed), whose answer is a NEW key rather than a wait.
 *
 * `retryAfter` must be present for either. Router sends it only when it holds
 * a handle to a generation the provider is still running, so its absence is
 * the server saying there is nothing to collect — and a resend then dispatches
 * NEW work rather than gathering old.
 *
 * A `429` naming `concurrency_limit_exceeded` is deliberately NOT collectable:
 * that one is plain workspace throttling with nothing running under this key,
 * and it stays outside `models.run`'s retry surface altogether via the
 * `status < 500` rule above.
 *
 * The Python SDK's `is_collectable` keys on exactly these gates.
 */
export function isCollectable(
  status: number,
  errorType: string | null,
  retryAfter: number | null,
): boolean {
  if (retryAfter === null) return false;
  if (status === 409) return errorType === "concurrency_limit_exceeded";
  return status === 504 && errorType === "deadline_exceeded";
}

/**
 * Backoff for retry number `attempt` (0-based), exponential with equal
 * jitter: `base * 2^attempt`, capped at `maxDelayMs`, then half fixed and
 * half random. `random` is injectable so a test can pin the jitter.
 */
export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs);
  return Math.round(exponential / 2 + random() * (exponential / 2));
}

/**
 * How long to wait before attempt `attempt + 1`, or `null` to stop trying.
 *
 * `elapsedMs` is the wall clock since the first attempt started and
 * `remainingMs` is what is left of the call's own deadline (`null` when it
 * has none). Both are hard stops, and both are checked against the *end* of
 * the backoff: scheduling an attempt that can only start after the budget is
 * spent, or after the deadline has already fired, buys nothing but a slower
 * failure.
 */
export function nextAttemptDelayMs(
  attempt: number,
  policy: RetryPolicy,
  clock: { elapsedMs: number; remainingMs: number | null },
  random: () => number = Math.random,
): number | null {
  if (policy.budgetMs <= 0) return null;
  const delay = backoffDelayMs(attempt, policy, random);
  if (clock.elapsedMs + delay >= policy.budgetMs) return null;
  if (clock.remainingMs !== null && delay >= clock.remainingMs) return null;
  return delay;
}

/**
 * How long to wait before re-asking for a collectable failure's own result, or
 * `null` to stop and raise it.
 *
 * The pace is the SERVER's, not this module's: a `Retry-After` of a second or
 * more is honoured verbatim, because it is the interval Router itself would
 * wait before asking again and it knows more about the generation than any
 * schedule here does. A `Retry-After: 0` names no pace — the contract pins the
 * header to `minimum: 1`, so a zero can only come from something confused, and
 * taking it literally would turn it into a spin of full model-run POSTs — so
 * that one falls back to the ordinary jittered backoff.
 *
 * Three bounds, in the order they are applied:
 *
 * - `budgetMs` at zero (`retry: false`) disables this too. One attempt means
 *   one attempt, whatever `collectBudgetMs` says.
 * - `collectBudgetMs` bounds the collect loop from the first attempt. A delay
 *   that would overshoot what is left of it is CLAMPED rather than refused —
 *   with jitter, one unlucky draw would otherwise end a call that still had
 *   seconds of budget, making identical calls take a randomly varying number
 *   of attempts — but a budget that is already spent returns `null`.
 * - the call's own deadline (`clock.remainingMs`) is the hard cap over every
 *   attempt and is never clamped against. A caller who asked for `timeoutMs`
 *   gets it; a collect that cannot even start inside what is left buys nothing
 *   but a slower failure.
 *
 * `clock.elapsedMs` is the wall clock since the first attempt — the same
 * origin {@link nextAttemptDelayMs} measures against, so the two budgets are
 * laid over one timeline rather than each starting when its class first fires.
 */
export function nextCollectDelayMs(
  retryAfter: number,
  attempt: number,
  policy: RetryPolicy,
  clock: { elapsedMs: number; remainingMs: number | null },
  random: () => number = Math.random,
): number | null {
  if (policy.budgetMs <= 0) return null;
  const remainingBudget = policy.collectBudgetMs - clock.elapsedMs;
  if (remainingBudget <= 0) return null;
  const paced = retryAfter >= 1 ? retryAfter * 1000 : backoffDelayMs(attempt, policy, random);
  const delay = Math.min(paced, remainingBudget);
  if (clock.remainingMs !== null && delay >= clock.remainingMs) return null;
  return delay;
}
