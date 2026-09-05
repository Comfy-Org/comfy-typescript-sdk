/** The sans-IO half of the retry policy: what is worth another attempt, how
 * long to wait, and when the wall clock says stop. */
import { describe, expect, it } from "vitest";

import {
  backoffDelayMs,
  DEFAULT_COLLECT_BUDGET_MS,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_BUDGET_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  isCollectable,
  isRetryableStatus,
  nextAttemptDelayMs,
  nextCollectDelayMs,
  NO_RETRY,
  resolveRetry,
  TERMINAL_ERROR_TYPES,
  type RetryPolicy,
} from "./retry.js";

const POLICY: RetryPolicy = {
  budgetMs: 10_000,
  baseDelayMs: 100,
  maxDelayMs: 800,
  collectBudgetMs: 60_000,
};

describe("resolveRetry", () => {
  it("fills in the documented defaults when nothing is supplied", () => {
    expect(resolveRetry(undefined)).toEqual({
      budgetMs: DEFAULT_RETRY_BUDGET_MS,
      baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
      maxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
      collectBudgetMs: DEFAULT_COLLECT_BUDGET_MS,
    });
  });

  it("turns retries off for `false`, and for a zero budget", () => {
    expect(resolveRetry(false)).toBe(NO_RETRY);
    expect(
      nextAttemptDelayMs(0, resolveRetry({ budgetMs: 0 }), { elapsedMs: 0, remainingMs: null }),
    ).toBeNull();
  });

  it("keeps the fields the caller did supply, defaulting only the rest", () => {
    expect(resolveRetry({ budgetMs: 5_000 })).toEqual({
      budgetMs: 5_000,
      baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
      maxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
      collectBudgetMs: DEFAULT_COLLECT_BUDGET_MS,
    });
  });

  it("names the offending field rather than silently clamping it", () => {
    expect(() => resolveRetry({ budgetMs: -1 })).toThrow(/retry\.budgetMs/);
    expect(() => resolveRetry({ baseDelayMs: Number.NaN })).toThrow(/retry\.baseDelayMs/);
    expect(() => resolveRetry({ maxDelayMs: "1" as unknown as number })).toThrow(
      /retry\.maxDelayMs/,
    );
    expect(() => resolveRetry({ collectBudgetMs: -1 })).toThrow(/retry\.collectBudgetMs/);
  });
});

describe("isRetryableStatus", () => {
  it("retries a 5xx — the server failed to answer, and that may not repeat", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(isRetryableStatus(status, null), String(status)).toBe(true);
    }
  });

  it("never retries a verdict about the request itself", () => {
    // The list the acceptance criteria name, plus the neighbours that would
    // be just as wrong to replay.
    for (const status of [400, 404, 409, 422, 429, 200, 202]) {
      expect(isRetryableStatus(status, null), String(status)).toBe(false);
    }
  });

  it("does not retry a terminal bucket even when it arrives under a 5xx", () => {
    expect(isRetryableStatus(503, "content_policy_violation")).toBe(false);
    expect(isRetryableStatus(500, "invalid_input")).toBe(false);
    expect(isRetryableStatus(500, "model_not_found")).toBe(false);
    // The rollout gate is a verdict too: nothing about the request is wrong,
    // and nothing a replay does turns the flag on.
    expect(isRetryableStatus(503, "not_enabled")).toBe(false);
    // An unfamiliar bucket is not assumed terminal — a 5xx stays retryable.
    expect(isRetryableStatus(503, "provider_timeout")).toBe(true);
  });

  it("retries service_unavailable, the one bucket whose condition clears on its own", () => {
    // The contract says to retry it with backoff, so it must NOT be terminal:
    // a 503 naming it is precisely what the 5xx rule is for.
    expect(isRetryableStatus(503, "service_unavailable")).toBe(true);
    expect(TERMINAL_ERROR_TYPES.has("service_unavailable")).toBe(false);
    expect(TERMINAL_ERROR_TYPES.has("not_enabled")).toBe(true);
  });

  it("leaves a 403 unretried whichever bucket names it", () => {
    // `not_enabled` and `forbidden` share the status; neither is retryable,
    // so the terminal-bucket entry above changes nothing for a 403.
    expect(isRetryableStatus(403, "not_enabled")).toBe(false);
    expect(isRetryableStatus(403, "forbidden")).toBe(false);
  });
});

describe("backoffDelayMs", () => {
  it("doubles per attempt and holds at the cap", () => {
    // random() === 1 gives the top of the jitter band, i.e. the full delay.
    const full = (attempt: number) => backoffDelayMs(attempt, POLICY, () => 1);
    expect([full(0), full(1), full(2), full(3), full(4)]).toEqual([100, 200, 400, 800, 800]);
  });

  it("jitters: half the delay is fixed, half is random", () => {
    expect(backoffDelayMs(0, POLICY, () => 0)).toBe(50);
    expect(backoffDelayMs(0, POLICY, () => 1)).toBe(100);
    expect(backoffDelayMs(0, POLICY, () => 0.5)).toBe(75);
  });

  it("actually varies, so a fleet that failed together does not re-land together", () => {
    const delays = new Set(
      Array.from({ length: 50 }, () => backoffDelayMs(3, { ...POLICY, maxDelayMs: 60_000 })),
    );
    expect(delays.size).toBeGreaterThan(1);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(400);
      expect(delay).toBeLessThanOrEqual(800);
    }
  });
});

describe("nextAttemptDelayMs", () => {
  it("bounds by total elapsed time, not by an attempt count", () => {
    // Attempt 40 is still allowed with the clock barely moved...
    expect(nextAttemptDelayMs(40, POLICY, { elapsedMs: 10, remainingMs: null })).not.toBeNull();
    // ...and attempt 0 is refused once the budget is nearly spent, even
    // though no retry has happened yet.
    expect(nextAttemptDelayMs(0, POLICY, { elapsedMs: 9_990, remainingMs: null })).toBeNull();
  });

  it("refuses an attempt whose backoff would outlast the call's own deadline", () => {
    expect(nextAttemptDelayMs(3, POLICY, { elapsedMs: 0, remainingMs: 10 })).toBeNull();
    expect(nextAttemptDelayMs(3, POLICY, { elapsedMs: 0, remainingMs: 5_000 })).not.toBeNull();
  });

  it("returns a delay inside the jitter band when both bounds allow it", () => {
    const delay = nextAttemptDelayMs(0, POLICY, { elapsedMs: 0, remainingMs: null });
    expect(delay).toBeGreaterThanOrEqual(50);
    expect(delay).toBeLessThanOrEqual(100);
  });
});

describe("isCollectable", () => {
  it("recognizes the two answers Router pairs with a pace to say the work is still running", () => {
    // The 409: an earlier attempt of this same call is still in flight, which
    // is what a re-send after a dropped connection meets.
    expect(isCollectable(409, "concurrency_limit_exceeded", 2)).toBe(true);
    // The 504: Comfy stopped holding the connection at its own bound while
    // the provider carried on.
    expect(isCollectable(504, "deadline_exceeded", 5)).toBe(true);
  });

  it("requires the pace — without it the server is holding nothing to collect", () => {
    // `Retry-After` is sent only when Router holds a handle to a running
    // generation, so its absence is a statement, not an omission: a resend
    // would dispatch NEW work rather than gather old.
    expect(isCollectable(409, "concurrency_limit_exceeded", null)).toBe(false);
    expect(isCollectable(504, "deadline_exceeded", null)).toBe(false);
  });

  it("requires the bucket, because both statuses are shared with a refusal", () => {
    // 409 `invalid_input` is the contract's deterministic key refusal — the
    // key names a different request, or its answer cannot be replayed — and
    // the answer is a NEW key, which no amount of waiting produces.
    expect(isCollectable(409, "invalid_input", 2)).toBe(false);
    // A header-less 409 (a proxy's conflict) carries no evidence at all.
    expect(isCollectable(409, null, 2)).toBe(false);
    // 504 `provider_timeout` is the partner running out of time; nothing
    // blesses a same-key resend there.
    expect(isCollectable(504, "provider_timeout", 5)).toBe(false);
    expect(isCollectable(504, null, 5)).toBe(false);
  });

  it("leaves the 429 concurrency bucket alone — nothing is running under this key", () => {
    // Same bucket, different condition: at 429 the workspace slot pool is
    // full and this request never started. It stays outside `models.run`'s
    // retry surface entirely.
    expect(isCollectable(429, "concurrency_limit_exceeded", 2)).toBe(false);
    expect(isRetryableStatus(429, "concurrency_limit_exceeded")).toBe(false);
  });
});

describe("nextCollectDelayMs", () => {
  const idle = { elapsedMs: 0, remainingMs: null };

  it("honours Retry-After verbatim — the server's pace beats the schedule here", () => {
    // No jitter, no doubling: 2 seconds means 2 seconds, however many
    // attempts have already gone out.
    expect(nextCollectDelayMs(2, 0, POLICY, idle)).toBe(2_000);
    expect(nextCollectDelayMs(2, 7, POLICY, idle)).toBe(2_000);
  });

  it("falls back to the backoff for a Retry-After of 0, which names no pace", () => {
    // The contract pins the header to `minimum: 1`, so a zero can only come
    // from something confused — and taking it literally would spin full
    // model-run POSTs at the server for the whole budget.
    const delay = nextCollectDelayMs(0, 0, POLICY, idle, () => 1);
    expect(delay).toBe(100);
    expect(nextCollectDelayMs(0, 3, POLICY, idle, () => 1)).toBe(800);
  });

  it("clamps to what is left of the collect budget rather than refusing", () => {
    // One unlucky pace must not end a call that still has budget: the last
    // attempt may START at the budget, inclusive.
    expect(nextCollectDelayMs(5, 0, POLICY, { elapsedMs: 58_500, remainingMs: null })).toBe(1_500);
  });

  it("gives up once the collect budget is spent", () => {
    expect(nextCollectDelayMs(5, 0, POLICY, { elapsedMs: 60_000, remainingMs: null })).toBeNull();
    expect(nextCollectDelayMs(5, 0, POLICY, { elapsedMs: 60_001, remainingMs: null })).toBeNull();
  });

  it("budgets the collect separately from the ordinary retries", () => {
    // Past `budgetMs` (10s) but well inside `collectBudgetMs` (60s): the
    // ordinary retry is done and the collect is not. That split is the point
    // of the second budget — a 504 arrives AT a server-side deadline the
    // ordinary budget is deliberately too short to survive.
    const clock = { elapsedMs: 30_000, remainingMs: null };
    expect(nextAttemptDelayMs(0, POLICY, clock)).toBeNull();
    expect(nextCollectDelayMs(2, 0, POLICY, clock)).toBe(2_000);
  });

  it("refuses a collect that cannot start inside the call's own deadline", () => {
    // The deadline is the hard cap over every attempt and is never clamped
    // against — a caller who asked for `timeoutMs` gets it.
    expect(nextCollectDelayMs(2, 0, POLICY, { elapsedMs: 0, remainingMs: 1_500 })).toBeNull();
    expect(nextCollectDelayMs(2, 0, POLICY, { elapsedMs: 0, remainingMs: 5_000 })).toBe(2_000);
  });

  it("is off under NO_RETRY, and under any zero budgetMs", () => {
    // One attempt means one attempt: `retry: false` disables the collect too.
    expect(nextCollectDelayMs(2, 0, NO_RETRY, idle)).toBeNull();
    expect(nextCollectDelayMs(2, 0, { ...POLICY, budgetMs: 0 }, idle)).toBeNull();
    // And the collect can be switched off on its own, leaving retries alone.
    expect(nextCollectDelayMs(2, 0, { ...POLICY, collectBudgetMs: 0 }, idle)).toBeNull();
    expect(nextAttemptDelayMs(0, { ...POLICY, collectBudgetMs: 0 }, idle)).not.toBeNull();
  });

  it("sizes the default collect budget at two Router deadline windows", () => {
    // Router's own deadline is ten minutes, so one window is already spent by
    // the time the 504 that starts a collect arrives.
    expect(DEFAULT_COLLECT_BUDGET_MS).toBe(2 * 600_000);
    expect(DEFAULT_COLLECT_BUDGET_MS).toBeGreaterThan(DEFAULT_RETRY_BUDGET_MS);
  });
});
