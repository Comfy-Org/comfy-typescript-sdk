/** The sans-IO half of the retry policy: what is worth another attempt, how
 * long to wait, and when the wall clock says stop. */
import { describe, expect, it } from "vitest";

import {
  backoffDelayMs,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_BUDGET_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  isRetryableStatus,
  nextAttemptDelayMs,
  NO_RETRY,
  resolveRetry,
  TERMINAL_ERROR_TYPES,
  type RetryPolicy,
} from "./retry.js";

const POLICY: RetryPolicy = { budgetMs: 10_000, baseDelayMs: 100, maxDelayMs: 800 };

describe("resolveRetry", () => {
  it("fills in the documented defaults when nothing is supplied", () => {
    expect(resolveRetry(undefined)).toEqual({
      budgetMs: DEFAULT_RETRY_BUDGET_MS,
      baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
      maxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
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
    });
  });

  it("names the offending field rather than silently clamping it", () => {
    expect(() => resolveRetry({ budgetMs: -1 })).toThrow(/retry\.budgetMs/);
    expect(() => resolveRetry({ baseDelayMs: Number.NaN })).toThrow(/retry\.baseDelayMs/);
    expect(() => resolveRetry({ maxDelayMs: "1" as unknown as number })).toThrow(
      /retry\.maxDelayMs/,
    );
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
