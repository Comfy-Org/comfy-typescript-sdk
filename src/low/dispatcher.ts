/**
 * Per-request inactivity limits for undici, the transport behind `fetch` on
 * Node (the only runtime this package supports).
 *
 * # The defect this exists to fix
 *
 * `AbortSignal.timeout(ms)` is not the only clock on a `fetch`. undici keeps
 * two of its own, both on the *dispatcher* rather than on the request, and
 * neither can be raised by any signal the caller composes:
 *
 * - `headersTimeout` — how long it waits for the response headers. Default
 *   300 s.
 * - `bodyTimeout` — the gap it tolerates between response body chunks, so it
 *   governs inter-chunk inactivity rather than total transfer time. Default
 *   300 s as well.
 *
 * So a caller asking for a longer deadline used to be silently capped at
 * 300 s, and the failure carried nothing to act on: `TypeError: fetch failed`
 * with `cause.code = UND_ERR_HEADERS_TIMEOUT`, no HTTP status, no server
 * request id. That bites every call that holds one long request open for a
 * whole generation instead of polling — `comfy.models.run`, whose own default
 * deadline is already 600 s, is entirely made of those.
 *
 * # Why a delegate rather than an `Agent`
 *
 * Moving those timers means handing `fetch` a dispatcher, and there are two
 * ways not to do it. `setGlobalDispatcher` changes behaviour for the host
 * application's own unrelated fetches, which a library must never do. A fresh
 * `Agent` per request (or per distinct timeout) is a fresh connection pool per
 * request, and it also discards whatever dispatcher the host installed — a
 * proxy agent, say.
 *
 * Instead every request gets a small delegate that forwards to the dispatcher
 * the process is already using, adding the two limits to the per-request
 * dispatch options (undici reads them there, taking precedence over the
 * dispatcher's own defaults). Nothing is pooled, cached or torn down here: the
 * host's connections and its proxy configuration are reused untouched, and the
 * delegate is a closure that dies with the request.
 */

/**
 * Where Node parks the process-wide undici dispatcher. Undocumented, but it is
 * the key undici itself reads in `getGlobalDispatcher()`, which is what lets a
 * separately-installed undici share Node's built-in one; it resolves on Node
 * 22, 24 and 26. A runtime that does not have it gets no delegate at all and
 * keeps the stock behaviour rather than failing.
 */
const GLOBAL_DISPATCHER_KEY = Symbol.for("undici.globalDispatcher.1");

/**
 * How far past the caller's own deadline the inactivity limits are set. The
 * `AbortSignal` is the authoritative clock — this margin only has to be wide
 * enough that undici's timer never wins the race and turns a caller's
 * `TimeoutError` back into the opaque `UND_ERR_HEADERS_TIMEOUT` this module
 * exists to remove. undici's timers are coarse (~1 s granularity), so the
 * margin is seconds, not milliseconds.
 */
const INACTIVITY_GRACE_MS = 30_000;

/**
 * Both limits end up in a timer, and a delay past this wraps around and fires
 * immediately — the exact failure being fixed, one ceiling higher. Reaching it
 * needs a ~25-day deadline, past which no limit is expressible, so no limit is
 * imposed.
 */
const MAX_TIMER_MS = 2_147_483_647;

/** The slice of undici's `Dispatcher` this module needs. */
interface UndiciDispatcher {
  dispatch(options: Record<string, unknown>, handler: unknown): boolean;
}

/**
 * The delegate handed to `fetch`. Its limits are readable so a test (or a
 * debugger) can see what a request was actually given, since the value is
 * otherwise invisible until it fires.
 */
export interface InactivityDispatcher extends UndiciDispatcher {
  readonly headersTimeout: number;
  readonly bodyTimeout: number;
}

/**
 * The inactivity limit for a request whose effective deadline is
 * `effectiveTimeoutMs`, in the same shape that field already has on the
 * transport: a number of milliseconds, or `null` for "no deadline at all".
 *
 * Derived from the deadline rather than set to a bigger constant, because a
 * fixed ceiling only moves the wall. `0` disables undici's timer entirely,
 * which is what a caller passing `timeoutMs: null` asked for — an SSE stream
 * or a long download must not die on its own while idle mid-job.
 */
export function inactivityLimitMs(effectiveTimeoutMs: number | null): number {
  if (effectiveTimeoutMs === null || !Number.isFinite(effectiveTimeoutMs)) return 0;
  const limit = Math.ceil(Math.max(0, effectiveTimeoutMs)) + INACTIVITY_GRACE_MS;
  // Clamping instead would leave a limit BELOW the deadline, which is the
  // defect again; disabling keeps the signal the only clock.
  return limit > MAX_TIMER_MS ? 0 : limit;
}

/**
 * `inner` with `headersTimeout`/`bodyTimeout` forced to `limitMs` on every
 * request it dispatches. `0` disables both.
 */
export function delegateWithLimits(inner: UndiciDispatcher, limitMs: number): InactivityDispatcher {
  return {
    headersTimeout: limitMs,
    bodyTimeout: limitMs,
    dispatch: (options, handler) =>
      inner.dispatch({ ...options, headersTimeout: limitMs, bodyTimeout: limitMs }, handler),
  };
}

/** The process-wide undici dispatcher, or `undefined` off Node. */
function globalDispatcher(): UndiciDispatcher | undefined {
  const candidate = (globalThis as unknown as Record<symbol, UndiciDispatcher | undefined>)[
    GLOBAL_DISPATCHER_KEY
  ];
  return typeof candidate?.dispatch === "function" ? candidate : undefined;
}

/**
 * `init` with a dispatcher whose inactivity limits match `effectiveTimeoutMs`,
 * so undici's 300 s defaults can no longer cut the request short of the
 * deadline its caller asked for. Returns `init` unchanged where there is no
 * undici dispatcher to delegate to.
 *
 * `dispatcher` is undici's own non-standard `fetch` init key, so this applies
 * to a caller-injected `fetch` as well: one that does not understand the key
 * ignores it, and one that wraps the platform `fetch` gets the fix rather than
 * silently losing it. The exception is a `fetch` from a *separately installed*
 * undici, which speaks its own package's handler protocol and cannot be handed
 * a delegate for the copy Node ships; such a caller wants
 * `setGlobalDispatcher` on their own undici instead, which this delegates to
 * untouched.
 */
export function withInactivityLimits(
  init: RequestInit,
  effectiveTimeoutMs: number | null,
): RequestInit {
  const inner = globalDispatcher();
  if (inner === undefined) return init;
  const delegate = delegateWithLimits(inner, inactivityLimitMs(effectiveTimeoutMs));
  // undici types `dispatcher` as its own `Dispatcher` class, which this
  // delegate deliberately does not extend — undici only ever calls
  // `.dispatch()` on it, and extending the class would mean depending on
  // undici as a package rather than on the copy Node already ships.
  return { ...init, dispatcher: delegate as unknown as RequestInit["dispatcher"] };
}
