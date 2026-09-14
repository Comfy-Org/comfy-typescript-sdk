/**
 * The ids and path templates every `comfy.models` call is addressed by.
 *
 * A leaf module on purpose. `./models.ts` (the awaited `run`) and
 * `./modelRequests.ts` (the queued `submit` family) both need to turn a
 * `{provider}/{model}` id — and, for the queue, a `request_id` — into path
 * segments, and `./models.ts` already imports the queue methods to assemble
 * the frozen `models` namespace. Leaving these helpers in `./models.ts` would
 * make the queue module import it back, and that runtime cycle is safe only
 * for as long as nobody on either side adds a `const` read at
 * module-evaluation time. Splitting them out removes the hazard rather than
 * documenting it.
 *
 * Everything here is sans-IO: validation and string building, no network and
 * no configuration. The one rule it exists to enforce is that a caller-supplied
 * or server-supplied id which cannot address a route fails HERE, next to the
 * value that is wrong, rather than being pasted into a URL and answered by
 * whatever route it happens to land on.
 */

/**
 * A canonical model ID split into the two path segments that address it.
 *
 * A `type` rather than an `interface` so it carries an implicit index
 * signature and can be passed to {@link fillRoute}, which looks its values up
 * by the placeholder name it read out of the template. The two field names
 * ARE the two path parameters `RUN_ROUTE_TEMPLATE` names, and the contract
 * test asserts that agreement against the vendored spec.
 */
export type ModelId = {
  provider: string;
  model: string;
};

/**
 * Split `{provider}/{model}` into its segments.
 *
 * Exactly two, both non-empty: that is the shape of the routes this addresses,
 * and of every ID the model catalog lists. A third `variant` segment is a real
 * part of the wider model-ID grammar but is NOT addressable on these routes —
 * how it is spelled over HTTP is not settled — so it is refused here, with a
 * message that says which part is missing rather than letting the call go out
 * as an unresolvable path.
 *
 * Beyond the segment count this is deliberately NOT a full validation of the
 * ID alphabet. The server resolves IDs against the catalog and answers a
 * miss with `model_not_found` plus close-match suggestions; re-implementing a
 * narrower version of that check on the client would turn a helpful round
 * trip into a local rejection, and would go stale the first time the alphabet
 * widens. What is refused here is only what cannot address the route at all.
 *
 * `method` names the caller in the message (`run`, `submit`, `handle`, ...),
 * so an integrator reading the failure sees the call they actually made.
 */
export function parseModelId(model: string, method = "run"): ModelId {
  const shape = 'expected a canonical "{provider}/{model}" model ID';
  if (typeof model !== "string") {
    throw new TypeError(`models.${method}(model): ${shape}, got ${typeof model}`);
  }
  const segments = model.split("/");
  if (segments.length !== 2 || segments.some((segment) => segment === "")) {
    const detail =
      segments.length > 2 ? " (a third, variant segment is not addressable on this route yet)" : "";
    throw new TypeError(`models.${method}(model): ${shape}, got ${JSON.stringify(model)}${detail}`);
  }
  // `.`/`..` would resolve away when the URL is parsed and address a
  // different route than the one written, so they are refused rather than
  // encoded. Every other character is left to `encodeURIComponent`.
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new TypeError(
      `models.${method}(model): ${shape}, got ${JSON.stringify(model)} (a "." or ".." segment cannot name a model)`,
    );
  }
  return { provider: segments[0], model: segments[1] };
}

/**
 * Longest `request_id` accepted into a path.
 *
 * The contract mints UUIDs (36 characters); the bound exists so that a
 * SERVER-controlled value which is not one cannot reach the public handle, a
 * log line or an exception message unbounded. Matches the Python SDK's
 * `_MAX_REQUEST_ID_LENGTH`.
 */
export const MAX_REQUEST_ID_LENGTH = 256;

/**
 * Python's `str.isprintable()`, which the Python SDK's `parse_request_id`
 * applies to the same value: no Unicode "Other" (`\p{C}`) or "Separator"
 * (`\p{Z}`) character, with the ASCII space excepted.
 *
 * The space is stripped before the test rather than carved out of the class
 * because the `v`-flag set-subtraction syntax that would express it directly
 * is newer than this package's `ES2022` target.
 */
function isPrintable(value: string): boolean {
  return !/[\p{C}\p{Z}]/u.test(value.replaceAll(" ", ""));
}

/**
 * `requestId` unchanged, or a `TypeError` for one that cannot address a route.
 *
 * A queued request's id is the last segment of
 * `/v2/models/{provider}/{model}/requests/{request_id}`, so it is held to
 * exactly the discipline {@link parseModelId} applies to the two segments
 * before it. It is checked on BOTH sides of the wire: on the id a caller hands
 * to `comfy.models.handle`, and on the id the server names in a submit
 * response — that one is just as unvalidated, and it is what every later call
 * on the handle is addressed by.
 *
 * `where` labels the offending value in every message, so the same check reads
 * as the caller's own argument on `comfy.models.handle` and as the server's
 * response on the submit path.
 *
 * `.`/`..` are refused rather than encoded for the reason they are refused in
 * a model-ID segment: `encodeURIComponent` leaves `.` alone, so a dot segment
 * would survive into the path and walk the route on any intermediary that
 * normalizes it. Control characters are refused because the id is interpolated
 * into exception messages and logs as well as into a URL.
 */
export function parseRequestId(
  requestId: string,
  where = "models.handle(model, requestId): requestId",
): string {
  if (typeof requestId !== "string") {
    throw new TypeError(`${where} must be a string, got ${typeof requestId}`);
  }
  if (requestId === "") {
    throw new TypeError(`${where} must not be empty`);
  }
  if (requestId.includes("/")) {
    throw new TypeError(
      `${where} must be a single path segment — it addresses ` +
        `/v2/models/{provider}/{model}/requests/{request_id}; got ${JSON.stringify(requestId)}`,
    );
  }
  if (requestId === "." || requestId === "..") {
    throw new TypeError(
      `${where} must not be "." or ".." — it would traverse the request path rather than ` +
        `name a request; got ${JSON.stringify(requestId)}`,
    );
  }
  if (requestId.length > MAX_REQUEST_ID_LENGTH) {
    throw new TypeError(
      `${where} must be at most ${String(MAX_REQUEST_ID_LENGTH)} characters; got ${String(requestId.length)}`,
    );
  }
  if (!isPrintable(requestId)) {
    throw new TypeError(`${where} must not contain control characters`);
  }
  return requestId;
}

/**
 * Substitute `{placeholder}` segments in an OpenAPI path template, percent-
 * encoding each value.
 *
 * `encodeURIComponent` per segment, not on the assembled path: a `/` inside a
 * value has to stay encoded, or a value could add a path segment of its own.
 * An unknown placeholder throws rather than being left in the path — a URL
 * with a literal `{...}` in it is a request that goes out and fails
 * confusingly at the server, and the only way to get one here is for a route
 * template and its call site to have drifted apart.
 */
export function fillRoute(template: string, values: Readonly<Record<string, string>>): string {
  return template.replaceAll(/\{(\w+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (typeof value !== "string") {
      throw new Error(`route template "${template}" has no value for {${name}}`);
    }
    return encodeURIComponent(value);
  });
}
