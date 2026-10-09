/**
 * The 429 pause floor shared by `Comfy.submit`/`listJobs` and `Job.events`.
 *
 * A leaf module so `jobs.ts` can use it without importing `client.ts`, which
 * already imports `jobs.ts`.
 */

// The shortest pause before re-sending a 429: a `Retry-After: 0` must not
// turn the retry into a tight loop.
export const MIN_RETRY_PAUSE_MS = 1_000;
