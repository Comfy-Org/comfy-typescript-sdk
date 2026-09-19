/**
 * Test helpers for the undici dispatcher delegate in `src/low/dispatcher.ts`.
 *
 * Two things every test of it needs and neither should assert by hand: reading
 * the delegate back off a `RequestInit` (undici types that key as its own
 * `Dispatcher` class, so a plain property read does not narrow), and standing a
 * recording dispatcher in for the process-wide one so a test can see what the
 * delegate actually forwarded — which is the only way to tell delegation apart
 * from a fresh `Agent` per request.
 */

/** The process-wide undici dispatcher, keyed exactly as `src/low/dispatcher.ts` reads it. */
const GLOBAL_DISPATCHER_KEY = Symbol.for("undici.globalDispatcher.1");

/** The slice of undici's `Dispatcher` this module needs to call. */
export interface Dispatchable {
  dispatch(options: Record<string, unknown>, handler: unknown): boolean;
}

/** A {@link Dispatchable} that also reports the limits it forces per request. */
export interface AttachedDispatcher extends Dispatchable {
  readonly headersTimeout: number;
  readonly bodyTimeout: number;
}

function isDispatchable(candidate: unknown): candidate is Dispatchable {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    "dispatch" in candidate &&
    typeof candidate.dispatch === "function"
  );
}

function isAttachedDispatcher(candidate: unknown): candidate is AttachedDispatcher {
  return (
    isDispatchable(candidate) &&
    "headersTimeout" in candidate &&
    typeof candidate.headersTimeout === "number" &&
    "bodyTimeout" in candidate &&
    typeof candidate.bodyTimeout === "number"
  );
}

/**
 * The delegate `withInactivityLimits` attached to `init`, or `undefined` when
 * it attached none. Narrowed at runtime rather than asserted, so a test that
 * expects a delegate and gets something else fails on the assertion instead of
 * reading `undefined.headersTimeout`.
 */
export function attachedDispatcher(init: RequestInit | undefined): AttachedDispatcher | undefined {
  if (init === undefined) return undefined;
  const candidate: unknown = Reflect.get(init, "dispatcher");
  return isAttachedDispatcher(candidate) ? candidate : undefined;
}

/** The real process-wide undici dispatcher, undelegated. */
export function rawGlobalDispatcher(): Dispatchable | undefined {
  const candidate: unknown = Reflect.get(globalThis, GLOBAL_DISPATCHER_KEY);
  return isDispatchable(candidate) ? candidate : undefined;
}

/**
 * `init` carrying `dispatcher`. undici types that key as its own `Dispatcher`
 * class, so putting a plain test double there needs one assertion; it lives
 * here rather than in every test that needs one.
 */
export function initWithDispatcher(dispatcher: Dispatchable, init: RequestInit = {}): RequestInit {
  return { ...init, dispatcher: dispatcher as unknown as RequestInit["dispatcher"] };
}

export interface RecordedDispatcher {
  /** Per-request dispatch options, in the order the delegate forwarded them. */
  readonly calls: Record<string, unknown>[];
  /** Puts the real process-wide dispatcher back. */
  restore(): void;
}

/**
 * Stands a recorder in for the process-wide undici dispatcher for the duration
 * of a test. `forward: true` passes each dispatch on to the real one, so a live
 * request still completes; the default records and stops, for unit tests that
 * never open a socket.
 */
export function recordGlobalDispatcher(options: { forward?: boolean } = {}): RecordedDispatcher {
  const real: unknown = Reflect.get(globalThis, GLOBAL_DISPATCHER_KEY);
  const calls: Record<string, unknown>[] = [];
  const recorder: Dispatchable = {
    dispatch(dispatchOptions, handler) {
      calls.push(dispatchOptions);
      if (options.forward !== true || !isDispatchable(real)) return true;
      return real.dispatch(dispatchOptions, handler);
    },
  };
  Reflect.set(globalThis, GLOBAL_DISPATCHER_KEY, recorder);
  return {
    calls,
    restore: () => {
      Reflect.set(globalThis, GLOBAL_DISPATCHER_KEY, real);
    },
  };
}
