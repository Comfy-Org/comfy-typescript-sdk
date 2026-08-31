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

/** A fully resolved policy — every field settled, nothing left to default. */
export interface RetryPolicy {
  budgetMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/** The policy a caller gets from `retry: false`: one attempt, no more. */
export const NO_RETRY: RetryPolicy = Object.freeze({
  budgetMs: 0,
  baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
  maxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
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
  };
}

/**
 * Is a response worth another attempt?
 *
 * Only 5xx — the server failed to answer for reasons that may not repeat.
 * Everything below 500 is the server's considered answer about this request
 * (`404`, `409`, `422`, a `content_policy_violation`, a `not_enabled`), and
 * resending it just spends the same money on the same verdict. A 5xx that
 * names a terminal bucket in `X-Comfy-Error-Type` is treated as that verdict
 * too — and, in the other direction, a `503` naming `service_unavailable` is
 * exactly what this is for.
 */
export function isRetryableStatus(status: number, errorType: string | null): boolean {
  if (status < 500) return false;
  return errorType === null || !TERMINAL_ERROR_TYPES.has(errorType);
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
