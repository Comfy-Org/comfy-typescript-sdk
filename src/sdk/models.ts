/**
 * `comfy.models` — run a partner model by its canonical `{provider}/{model}`
 * ID and get its own native output back.
 *
 * ```ts
 * import { comfy } from "@comfyorg/sdk";
 *
 * comfy.config({ credentials: "comfyui-..." });
 * const { data, requestId } = await comfy.models.run("bfl/flux-2-pro", {
 *   prompt: "a cat",
 * });
 * ```
 *
 * One call, one finished result. `run` resolves only when the generation is
 * complete: the request/response pair IS the whole contract, and for a
 * provider whose own API is submit-then-poll the server does that polling
 * inside the call rather than handing back a task handle. Nothing here polls,
 * and there is no progress or streaming surface — the promise resolves with
 * the final result or rejects.
 *
 * # Why the `{ data, requestId }` wrapper
 *
 * `data` is the provider's native payload, forwarded unchanged — no Comfy
 * envelope, no renamed fields — so an integration already written against the
 * provider keeps its own response handling. `requestId` is the server's
 * `X-Comfy-Request-Id` for the call, lifted out of the headers because it is
 * the value a support request needs and asking a user to re-run with header
 * logging on to get it is a bad afternoon.
 *
 * This is a DELIBERATE asymmetry with the Python SDK, which returns the
 * payload directly. The target reader of this file is someone porting a
 * TypeScript integration from a comparable hosted-inference client, whose
 * result is wrapped the same way; matching that is worth more here than
 * matching the sibling SDK. It is an intentional difference, not a parity gap.
 *
 * # Retry, idempotency and cancellation
 *
 * These three are one design, not three features. Because the connection is
 * held for the whole generation, a call can fail after the model already ran:
 * a dropped socket, a 503 in front of a finished result, a client that gave
 * up. Retrying that blindly would run — and bill — the model twice, so every
 * attempt of one `run` replays that call's single `Idempotency-Key` and the
 * server answers the repeat with the original response. Retries are bounded
 * by wall clock rather than by an attempt count (see `./retry.ts`), and only
 * a transport failure or a 5xx is retried at all.
 *
 * On top of that sits a second, narrower loop the SERVER asks for. Router
 * answers two failures with a `Retry-After` that means "the generation your
 * key already names is still running — ask again for it": a `409` naming
 * `concurrency_limit_exceeded` (an earlier attempt of this same call is still
 * in flight, which is what a re-send after a dropped connection meets) and a
 * `504` naming `deadline_exceeded` (Comfy stopped holding the connection at
 * its own bound while the provider carried on). `run` COLLECTS those rather
 * than raising them: it waits the interval the server named and re-asks under
 * the same key, on its own longer budget, because a collect has to outlast the
 * server-side deadline that produced it. When that budget runs out, the last
 * answer the server actually gave is what raises — never a synthetic one.
 *
 * Cancellation is the other end of the same shape: minutes-long calls make
 * "stop this" an ordinary request rather than an edge case, so `signal`
 * aborts the socket — the server sees a disconnect, which is also the exit
 * that is not billed — and stops the retry loop between attempts as well as
 * during one.
 *
 * # The response body is buffered, and the buffer is capped
 *
 * One call resolves with one finished result, so the whole body is held in
 * memory; there is no streaming surface to hand a caller instead. `maxBytes`
 * is the ceiling on that — {@link DEFAULT_MAX_RESPONSE_BYTES} unless the
 * caller says otherwise, `null` to disable — checked against `Content-Length`
 * before the body is read and against the bytes as they are read, since a
 * chunked response declares no length and a declared one is a claim rather
 * than a bound. A breach is the one failure here that is deliberately kept out
 * of the retry loop: re-asking would re-download the same oversized body on
 * every attempt.
 */

import { clampTimerMs, withInactivityLimits } from "../low/dispatcher.js";
import { buildUserAgent } from "../low/index.js";
import { abortableSleep } from "./abortable-sleep.js";
import { newIdempotencyKey } from "./core.js";
import { resolveBaseUrl, resolveCredentials } from "./credentials.js";
import {
  ComfyError,
  type ComfyErrorOptions,
  Forbidden,
  InsufficientCredits,
  MissingCredentials,
  NotFound,
  Unauthorized,
} from "./exceptions.js";
import { parseRetryAfter } from "./routerErrors.js";
import {
  isCollectable,
  isRetryableStatus,
  nextAttemptDelayMs,
  nextCollectDelayMs,
  resolveRetry,
  type RetryOptions,
} from "./retry.js";

/**
 * Default deadline for one {@link Models.run} call, in milliseconds.
 *
 * Minutes rather than the tens of seconds a plain API call gets, because a
 * finished image or video IS the response: the server holds the connection
 * for the whole generation, including the polling it does internally on
 * behalf of a submit-then-poll provider. A 30s default would abort ordinary
 * successful work that had already been metered upstream, which is the
 * expensive kind of timeout.
 *
 * TWENTY minutes rather than ten, which is what it takes for the default to
 * cover a collect. Router's own deadline is ten minutes, so a
 * `deadline_exceeded` `504` arrives with a ten-minute deadline already spent
 * and the same-key collect that answer invites could never start under it —
 * the deadline covers every attempt of a call, not each one afresh. One window
 * to reach the `504` and one to collect what it left running, which is the same
 * derivation as `DEFAULT_COLLECT_BUDGET_MS` in `./retry.ts`.
 *
 * Override it per call with `timeoutMs`, or disable it with `null` — and
 * prefer passing a `signal` to disabling it, since a request with no deadline
 * at all can hang until the process exits.
 */
export const DEFAULT_RUN_TIMEOUT_MS = 1_200_000;

/**
 * Default ceiling on the response body one {@link Models.run} call will
 * buffer, in bytes.
 *
 * The whole body is held in memory — the call resolves with a finished result,
 * so there is no streaming surface to hand a caller instead — and without a
 * ceiling a pathological or mis-routed response allocates without bound in the
 * caller's process. Sixty-four MiB is comfortably above what the catalog
 * actually returns today (a JSON document is kilobytes; an ElevenLabs mp3 is
 * about a megabyte a minute) and far below the size at which buffering is the
 * process's problem rather than the response's.
 *
 * It is a per-call knob rather than a guess this package has to get right for
 * everyone: a model whose generation is genuinely larger — video, once the
 * catalog has it — raises it with `maxBytes`, and `maxBytes: null` disables
 * the cap entirely for a caller who would rather have the allocation than the
 * error.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 67_108_864;

/**
 * `code` on the {@link ComfyError} a body over the cap raises. Its own bucket
 * rather than `unexpected_response`, because it is the one failure here a
 * caller can act on mechanically — raise `maxBytes`, or stop asking this model
 * for something this big.
 *
 * Not exported: the string is the contract (it is documented in the README and
 * on {@link RunOptions.maxBytes}), and every other code this module raises is
 * a string literal too.
 */
const RESPONSE_TOO_LARGE = "response_too_large";

/** Response header carrying the server-generated id for a call. */
export const REQUEST_ID_HEADER = "X-Comfy-Request-Id";

/** Response header carrying the coarse, machine-readable failure bucket. */
export const ERROR_TYPE_HEADER = "X-Comfy-Error-Type";

/**
 * The result of a completed {@link Models.run}.
 *
 * @typeParam TData - the provider's payload shape. It defaults to `unknown`,
 * NOT `any`: the per-model input/output schemas are published by the server
 * per model rather than baked into this package, so nothing here can know
 * statically what a given model returns, and `any` would silently disable
 * type-checking on every field access downstream. Supply the type you have —
 * `run<FluxOutput>(...)` — and `data` is that type; supply nothing and the
 * compiler makes you narrow it before use.
 */
export interface RunResult<TData = unknown> {
  /** The provider's native payload, exactly as it came off the wire. */
  data: TData;
  /**
   * The server's `X-Comfy-Request-Id` for this call — quote it in a support
   * request. `null` only if the response carried no such header, which a
   * proxy or load-balancer response generated before the request reached
   * Comfy genuinely does not.
   */
  requestId: string | null;
}

export interface RunOptions {
  /**
   * Abort the call. Composed with the deadline below, so whichever fires
   * first wins, and honoured between attempts as well as during one: an
   * abort mid-backoff stops the retry loop instead of letting the next
   * attempt go out.
   *
   * The abort reaches the socket, so the server sees a disconnect rather
   * than a client that stopped listening — which on this route is also the
   * cheap exit, since a disconnected call is not billed.
   */
  signal?: AbortSignal;
  /**
   * Per-call deadline in milliseconds, covering **every** attempt rather
   * than each one separately — a retry eats into the same budget, so the
   * call cannot outlive the deadline by retrying. Omit for
   * {@link DEFAULT_RUN_TIMEOUT_MS}; pass `null` to disable the deadline
   * entirely.
   *
   * Because it spans every attempt, it is also the hard cap on the collect
   * loop below, ahead of `retry.collectBudgetMs`: a `timeoutMs` SHORTER than
   * Router's own ten-minute deadline forfeits the `504` collect outright,
   * since the `504` cannot arrive before the deadline it is raised at has
   * already fired the call's own. That is a deliberate ordering — the number
   * a caller asked for wins — and it costs only that one case: the `409`
   * collect after a dropped connection re-asks perfectly well inside a short
   * deadline, because that answer arrives in milliseconds rather than at a
   * ten-minute bound.
   */
  timeoutMs?: number | null;
  /**
   * `Idempotency-Key` for this call. One is minted per call when omitted,
   * which is what makes each `run` its own logical call; supply your own to
   * make a retry of a call whose response you lost replay the original
   * instead of running (and billing) the model a second time.
   *
   * Every attempt within one call — the first and each retry — sends the
   * same key, whichever way it was obtained.
   */
  idempotencyKey?: string;
  /**
   * Largest response body this call will buffer, in bytes. Omit for
   * {@link DEFAULT_MAX_RESPONSE_BYTES} (64 MiB); pass `null` to disable the
   * cap entirely.
   *
   * Enforced twice, because the two checks catch different responses. A
   * `Content-Length` over the cap is refused **before the body is read at
   * all** and the connection is dropped — the cheap exit, and the one that
   * avoids the download rather than merely the allocation. The bytes actually
   * read are then counted against the same cap, since `Content-Length` is
   * absent on a chunked response and is not a promise on any of them.
   *
   * A breach raises a {@link ComfyError} with `code: "response_too_large"`,
   * carrying `maxBytes` and the offending size on `details`. It is NOT
   * retried: it is a verdict about this response rather than a transport
   * failure, and re-asking would re-download the same oversized body on every
   * attempt until the budget ran out — multiplying the cost of the one thing
   * that already went wrong.
   *
   * The cap covers an error response's body as well as a result's. An error
   * body is kilobytes in every ordinary case, so this only bites where
   * something ahead of the route is answering with something that is not the
   * contract at all.
   */
  maxBytes?: number | null;
  /**
   * Retry policy for this call. Omit for the defaults in `./retry.ts`
   * (`DEFAULT_RETRY_BUDGET_MS` of wall clock, jittered exponential backoff
   * from `DEFAULT_RETRY_BASE_DELAY_MS`), or pass `false` to make the call a
   * single attempt.
   *
   * Two different resends live behind this one option, on two budgets:
   *
   * - **Retry** — a transport failure or a 5xx, on `budgetMs` and this
   *   module's own jittered backoff. A `4xx` is the server's answer about
   *   this request — `content_policy_violation`, `invalid_input`,
   *   `model_not_found`, a `404`, a `422` — and sending it again would buy
   *   the same verdict twice.
   * - **Collect** — the two answers Router pairs with a `Retry-After` to say
   *   "the generation your key already names is still running, ask again":
   *   a `409` naming `concurrency_limit_exceeded` and a `504` naming
   *   `deadline_exceeded`. Those are paced by that header rather than by the
   *   backoff, and bounded by `collectBudgetMs` (twenty minutes by default)
   *   rather than by `budgetMs`, because a collect has to outlast Router's
   *   own deadline. Set `collectBudgetMs: 0` to switch the collect loop off
   *   and have those answers raised instead. The one thing `budgetMs` still
   *   says about a collect is zero: `budgetMs: 0` is one attempt, collect
   *   included, exactly like `retry: false`.
   *
   * A `409` with no `Retry-After` is not collectable and is not retried: that
   * is the contract's deterministic key refusal, and the answer is a new key.
   * `retry: false` is one attempt, collect included.
   */
  retry?: RetryOptions | false;
}

/**
 * The `comfy.models` surface.
 *
 * `input` is the model's own native input document, forwarded to the provider
 * unchanged. It is typed as an open object rather than a per-model shape for
 * the reason given on {@link RunResult}: the schemas are the server's to
 * publish, per model, and this package does not carry a copy of them.
 */
export interface Models {
  run<TData = unknown>(
    model: string,
    input: Record<string, unknown>,
    options?: RunOptions,
  ): Promise<RunResult<TData>>;
}

/**
 * A canonical model ID split into the two path segments that address it.
 *
 * A `type` rather than an `interface` so it carries an implicit index
 * signature and can be passed to {@link fillRoute}, which looks its values up
 * by the placeholder name it read out of the template. The two field names
 * ARE the two path parameters `RUN_ROUTE_TEMPLATE` names, and the contract
 * test asserts that agreement against the vendored spec.
 */
type ModelId = {
  provider: string;
  model: string;
};

/**
 * Split `{provider}/{model}` into its segments.
 *
 * Exactly two, both non-empty: that is the shape of the route this calls, and
 * of every ID the model catalog lists. A third `variant` segment is a real
 * part of the wider model-ID grammar but is NOT addressable on this route —
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
 */
function parseModelId(model: string): ModelId {
  const shape = 'expected a canonical "{provider}/{model}" model ID';
  if (typeof model !== "string") {
    throw new TypeError(`models.run(model): ${shape}, got ${typeof model}`);
  }
  const segments = model.split("/");
  if (segments.length !== 2 || segments.some((segment) => segment === "")) {
    const detail =
      segments.length > 2 ? " (a third, variant segment is not addressable on this route yet)" : "";
    throw new TypeError(`models.run(model): ${shape}, got ${JSON.stringify(model)}${detail}`);
  }
  // `.`/`..` would resolve away when the URL is parsed and address a
  // different route than the one written, so they are refused rather than
  // encoded. Every other character is left to `encodeURIComponent`.
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new TypeError(
      `models.run(model): ${shape}, got ${JSON.stringify(model)} (a "." or ".." segment cannot name a model)`,
    );
  }
  return { provider: segments[0], model: segments[1] };
}

/**
 * The Router route {@link Models.run} posts to, written as the OpenAPI path
 * template rather than as an interpolated string.
 *
 * It is a named constant so that it can be compared, character for character,
 * against the path the vendored Router contract declares for
 * `operationId: runRouterModel` — `src/sdk/router-spec-contract.test.ts` and
 * `scripts/check-spec-drift.mjs` both make that comparison. Before this,
 * `spec/router-openapi.yaml` moving this route (a version bump, a rename) was
 * a change no gate in this repo could see: the sync would land green and
 * `models.run` would start 404ing against a route the SDK still spelled the
 * old way. The template is the SDK's copy of the contract, so it is the thing
 * worth pinning.
 *
 * Deliberately NOT re-exported from `./index.js`: it is the anchor for that
 * drift gate, not a knob a caller configures — the route a call goes to is
 * the SDK's business, and `comfy.config({ baseUrl })` is how a caller retargets
 * the host. Publishing it would make an internal coupling point semver-
 * relevant and would add a TypeScript-only name to the cross-SDK surface.
 */
export const RUN_ROUTE_TEMPLATE = "/v2/models/{provider}/{model}";

/**
 * Substitute `{placeholder}` segments in an OpenAPI path template, percent-
 * encoding each value.
 *
 * `encodeURIComponent` per segment, not on the assembled path: a `/` inside a
 * value has to stay encoded, or a value could add a path segment of its own.
 * An unknown placeholder throws rather than being left in the path — a URL
 * with a literal `{...}` in it is a request that goes out and fails
 * confusingly at the server, and the only way to get one here is for
 * {@link RUN_ROUTE_TEMPLATE} and this call site to have drifted apart.
 */
function fillRoute(template: string, values: Readonly<Record<string, string>>): string {
  return template.replaceAll(/\{(\w+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (typeof value !== "string") {
      throw new Error(`route template "${template}" has no value for {${name}}`);
    }
    return encodeURIComponent(value);
  });
}

function runUrl(baseUrl: string, id: ModelId): string {
  return `${baseUrl}${fillRoute(RUN_ROUTE_TEMPLATE, id)}`;
}

/**
 * Compose the caller's signal with what is left of this call's deadline.
 * `undefined` means "no deadline and no caller signal", which is the only
 * case where the request runs unbounded.
 *
 * `remainingMs` is what remains of the *call's* deadline, not a fresh one per
 * attempt: handing each retry a full `timeoutMs` would let a retrying call
 * run for a multiple of the deadline its caller asked for.
 */
function composeSignal(
  callerSignal: AbortSignal | undefined,
  remainingMs: number | null,
): AbortSignal | undefined {
  if (remainingMs === null) return callerSignal;
  // Clamped, not just floored at 0: past ~25 days `AbortSignal.timeout`
  // schedules a delay `setTimeout` folds to 1 ms, aborting at once.
  const timeoutSignal = AbortSignal.timeout(clampTimerMs(remainingMs));
  return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
}

/** Error `error_type` -> the idiomatic exception, where one already exists.
 * Everything else stays a {@link ComfyError} carrying the bucket as its
 * `code`, which is the value to branch on. */
const BY_ERROR_TYPE: Record<
  string,
  new (message: string, options: ComfyErrorOptions) => ComfyError
> = {
  unauthorized: Unauthorized,
  forbidden: Forbidden,
  insufficient_credits: InsufficientCredits,
  model_not_found: NotFound,
};

/** Body of a request-level failure. */
interface ErrorBody {
  detail?: unknown;
  error_type?: unknown;
}

function describeValidationFailures(detail: readonly unknown[]): string {
  const described = detail.map((entry) => {
    const item = (entry ?? {}) as { loc?: unknown; msg?: unknown; type?: unknown };
    const loc = Array.isArray(item.loc) ? item.loc.join(".") : "";
    const msg = typeof item.msg === "string" ? item.msg : String(item.type ?? "invalid");
    return loc ? `${loc}: ${msg}` : msg;
  });
  const count =
    described.length === 1 ? "1 validation error" : `${described.length} validation errors`;
  return described.length > 0 ? `${count}: ${described.join("; ")}` : count;
}

/**
 * Build the exception for a non-2xx response.
 *
 * Two body shapes reach here and the coarse bucket is read the same way from
 * both: a request-level failure carries `{ detail, error_type }`, while a
 * model-level validation failure carries a `detail[]` array and NO
 * `error_type` of its own — for that one the header is the only machine-
 * readable bucket, which is why the header is consulted before the body is
 * classified. A body that is neither (a proxy's HTML error page, say) still
 * produces a typed error, from the header and the status.
 *
 * A richer exception hierarchy per bucket is a separate piece of work; what
 * this owes a caller today is a `code` to branch on, the status, the details
 * intact, and the request id.
 */
function errorFromResponse(
  response: Response,
  bodyText: string,
  idempotencyKey: string,
): ComfyError {
  const status = response.status;
  const requestId = response.headers.get(REQUEST_ID_HEADER);
  const headerType = response.headers.get(ERROR_TYPE_HEADER);
  let body: ErrorBody | undefined;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed !== null && typeof parsed === "object") body = parsed as ErrorBody;
  } catch {
    body = undefined;
  }

  const validationFailures = Array.isArray(body?.detail) ? body.detail : undefined;
  const bodyType = typeof body?.error_type === "string" ? body.error_type : undefined;
  // Header first: it is set on every error response, and on the validation
  // shape it is the only place the bucket appears at all.
  const code = headerType ?? bodyType ?? `http_${String(status)}`;

  let message: string;
  if (validationFailures) {
    message = describeValidationFailures(validationFailures);
  } else if (typeof body?.detail === "string" && body.detail !== "") {
    message = body.detail;
  } else {
    message = `HTTP ${String(status)}`;
  }

  const cls = BY_ERROR_TYPE[code] ?? ComfyError;
  return new cls(message, {
    code,
    httpStatus: status,
    // The per-field failures survive verbatim: the specific reason and the
    // violated bound live in there, and the coarse `code` cannot express them.
    details: validationFailures ? { detail: validationFailures } : null,
    requestId,
    // Both of these are what a caller needs to re-ask by hand once `run`'s own
    // collect budget is spent: the key names the generation Router is still
    // holding, and `Retry-After` is the pace it asked to be asked at. Reading
    // them off a header in application code is exactly the afternoon
    // `requestId` is already on the error to avoid.
    retryAfter: parseRetryAfter(response.headers),
    idempotencyKey,
  });
}

/**
 * Resolve `options.maxBytes` to a cap, or to `null` for "no cap".
 *
 * Validated at the call site rather than in the read, for the reason the
 * credentials check is: a process that asked for a cap it cannot have should
 * find out before a model runs and is billed. `NaN` is the case worth the
 * explicit check — every comparison against it is false, so it would read as
 * "no cap" and silently undo the ceiling the caller thought they set.
 */
function resolveMaxBytes(maxBytes: number | null | undefined): number | null {
  if (maxBytes === undefined) return DEFAULT_MAX_RESPONSE_BYTES;
  if (maxBytes === null) return null;
  if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new TypeError(
      "models.run(options.maxBytes): expected a non-negative number of bytes, " +
        `or null to disable the cap, got ${JSON.stringify(maxBytes)}`,
    );
  }
  return maxBytes;
}

/**
 * The response's declared body length, or `null` when it declared none this
 * can act on.
 *
 * A header the response carried twice reaches `Headers.get` as `"n, n"`, and a
 * proxy can send something that is not a number at all. Neither is a length to
 * refuse a response over, and neither needs to be: an undeclared length is
 * exactly what the read-side count below exists for.
 */
function declaredLength(response: Response): number | null {
  const raw = response.headers.get("Content-Length");
  if (raw === null) return null;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return null;
  return Number(value);
}

function tooLarge(
  model: string,
  response: Response,
  idempotencyKey: string,
  maxBytes: number,
  measured: { readonly contentLength: number } | { readonly bytesRead: number },
): ComfyError {
  const how =
    "contentLength" in measured
      ? `declares a Content-Length of ${String(measured.contentLength)} bytes`
      : `is over ${String(measured.bytesRead)} bytes`;
  return new ComfyError(
    `models.run("${model}") response body ${how}, past the ${String(maxBytes)}-byte maxBytes cap; ` +
      "raise maxBytes for this call, or pass maxBytes: null to disable the cap",
    {
      code: RESPONSE_TOO_LARGE,
      httpStatus: response.status,
      details: { maxBytes, ...measured },
      requestId: response.headers.get(REQUEST_ID_HEADER),
      idempotencyKey,
    },
  );
}

/** Is `exc` this module's own cap breach, as opposed to anything else the
 * fetch-and-read can throw? Only this module raises that code, and only from
 * {@link readBodyWithin}, which is what makes the check exact. */
function isTooLarge(exc: unknown): boolean {
  return exc instanceof ComfyError && exc.code === RESPONSE_TOO_LARGE;
}

/**
 * Buffer the response body as text, refusing one over `maxBytes`.
 *
 * Two checks rather than one, because they catch different responses and the
 * cheap one cannot stand alone:
 *
 * - **`Content-Length`**, before a byte is read. This is the exit worth
 *   having: it costs one header read, and cancelling the body here means the
 *   oversized response is never downloaded rather than downloaded and thrown
 *   away.
 * - **the bytes actually read**, chunk by chunk. `Content-Length` is absent on
 *   a chunked response, is the *encoded* length when a body arrives
 *   compressed, and is in any case a claim by the sender rather than a bound
 *   on it — so the read is where the cap is actually enforced.
 *
 * With no cap the runtime's own `text()` does the buffering, which is what
 * this route did before the cap existed.
 */
async function readBodyWithin(
  response: Response,
  maxBytes: number | null,
  model: string,
  idempotencyKey: string,
): Promise<string> {
  if (maxBytes === null) return response.text();

  const declared = declaredLength(response);
  if (declared !== null && declared > maxBytes) {
    // Drop the connection rather than leave a body nothing will ever read
    // streaming into the buffer — not downloading it is the whole point of
    // checking the header first.
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge(model, response, idempotencyKey, maxBytes, { contentLength: declared });
  }

  const body = response.body;
  // No stream to read — a body-less status, or a runtime that exposes none.
  // `text()` is the empty string there and cannot breach a cap.
  if (body === null) return response.text();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw tooLarge(model, response, idempotencyKey, maxBytes, { bytesRead: total });
      }
      chunks.push(value);
    }
  } catch (exc) {
    // Stop the transfer on the way out, for the breach and for an abort
    // alike: without this the rest of an oversized body keeps arriving on a
    // socket nothing is reading from.
    await reader.cancel().catch(() => undefined);
    throw exc;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // The same decode `Response.text()` does: UTF-8, BOM stripped, invalid
  // sequences replaced rather than thrown on.
  return new TextDecoder().decode(bytes);
}

/**
 * Did `signal` abort because this call's own deadline elapsed, rather than
 * because the caller aborted it?
 *
 * A caller's abort is theirs and is re-thrown untouched — swallowing it into
 * an SDK error would make `AbortController` behave differently here than
 * everywhere else in the language. A deadline, by contrast, is this SDK's
 * doing and deserves a message that says which knob to turn.
 */
function isTimeout(exc: unknown, callerSignal: AbortSignal | undefined): boolean {
  if (callerSignal?.aborted) return false;
  return exc instanceof Error && exc.name === "TimeoutError";
}

async function run<TData = unknown>(
  model: string,
  input: Record<string, unknown>,
  options: RunOptions = {},
): Promise<RunResult<TData>> {
  // Credentials first: the whole point of this gate is that a process with
  // none fails at the call site rather than on a round trip.
  const credentials = resolveCredentials();
  if (credentials === undefined) {
    throw new MissingCredentials(
      'no credentials configured — call comfy.config({ credentials: "comfyui-..." }) ' +
        "or set COMFY_API_KEY in the environment",
      { code: "missing_credentials" },
    );
  }
  const id = parseModelId(model);
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(
      `models.run(model, input): input must be the model's native JSON input object, got ${
        Array.isArray(input) ? "array" : String(input === null ? "null" : typeof input)
      }`,
    );
  }

  const url = runUrl(resolveBaseUrl(), id);
  // Minted once, outside the retry loop: every attempt of this one logical
  // call sends the SAME key. The server records the first response against
  // it and replays that for a repeat, so a retry after a lost or 5xx-ed
  // response cannot run the model — or bill for it — a second time. A fresh
  // `run` mints a fresh key and is a new logical call.
  const idempotencyKey = options.idempotencyKey ?? newIdempotencyKey();
  const headers = {
    Authorization: `Bearer ${credentials}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Idempotency-Key": idempotencyKey,
    "User-Agent": buildUserAgent(),
  };
  const body = JSON.stringify(input);

  const retry = resolveRetry(options.retry);
  const maxBytes = resolveMaxBytes(options.maxBytes);
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_RUN_TIMEOUT_MS : options.timeoutMs;
  const startedAt = Date.now();
  const deadlineAt = timeoutMs === null ? null : startedAt + timeoutMs;
  /** What the retry policy needs off the clock, read fresh after a failure. */
  const clock = () => ({
    elapsedMs: Date.now() - startedAt,
    remainingMs: deadlineAt === null ? null : deadlineAt - Date.now(),
  });

  let retryAttempt = 0;
  let collectAttempt = 0;
  /**
   * The pace of the last collectable answer, once one has arrived. Set, it
   * means this call is COLLECTING: Router holds a generation under this key,
   * so every failure from here — a dropped socket, a proxy's 5xx — is a
   * failure to collect it, re-asked at that pace and budgeted against
   * `collectBudgetMs`, not an ordinary retry against a `budgetMs` that a
   * ten-minute `504` has long since spent. It also rides onto the deadline
   * error, so a caller whose clock runs out mid-collect still holds the pace
   * and the key a manual re-ask needs.
   */
  let collectingAt: number | null = null;
  /** The two schedules are counted apart: N paced re-asks must not inflate
   * the backoff exponent of an ordinary retry that follows them, or vice
   * versa. */
  const nextDelayMs = (): number | null =>
    collectingAt === null
      ? nextAttemptDelayMs(retryAttempt, retry, clock())
      : nextCollectDelayMs(collectingAt, collectAttempt, retry, clock());
  const countAttempt = (): void => {
    if (collectingAt === null) retryAttempt += 1;
    else collectAttempt += 1;
  };
  for (;;) {
    const remainingMs = clock().remainingMs;
    const signal = composeSignal(options.signal, remainingMs);
    let response: Response;
    let text: string;
    try {
      // `withInactivityLimits` derives undici's own headers/body timers from
      // the same remaining budget as `signal`. Without it this call is capped
      // at undici's 300s default however long the deadline says, which is
      // fatal here specifically: the server holds this one request open for
      // the whole generation, so nothing arrives on it — not even response
      // headers — until the model has finished.
      response = await fetch(
        url,
        withInactivityLimits({ method: "POST", headers, body, signal }, remainingMs),
      );
      // Inside the same `try` as the fetch on purpose: the deadline covers
      // body consumption too, so a signal that fires while the result is
      // still streaming rejects HERE, and translating it in only one of the
      // two places would leak a bare DOMException out of the other.
      text = await readBodyWithin(response, maxBytes, model, idempotencyKey);
    } catch (exc) {
      // A body past the cap leaves the loop immediately. It is a verdict about
      // THIS response, not a transport failure, and the retry loop sitting
      // around the read is exactly what would make it expensive: every attempt
      // would re-download the same oversized body until the budget expired,
      // multiplying the cost of the one thing that already failed.
      if (isTooLarge(exc)) throw exc;
      if (isTimeout(exc, options.signal)) {
        throw new ComfyError(
          `models.run("${model}") exceeded its ${String(timeoutMs)}ms deadline before the model finished; ` +
            "raise it with timeoutMs, or pass timeoutMs: null and your own signal",
          { code: "request_timeout", cause: exc, idempotencyKey, retryAfter: collectingAt },
        );
      }
      // A caller's abort is theirs: never retried, never re-dressed.
      if (options.signal?.aborted) throw exc;
      const delay = nextDelayMs();
      if (delay === null) throw exc;
      // Abortable, so an abort during the backoff stops the loop here rather
      // than sleeping out the delay and sending one more attempt.
      await abortableSleep(delay, options.signal);
      countAttempt();
      continue;
    }

    const errorType = response.headers.get(ERROR_TYPE_HEADER);
    const retryAfter = parseRetryAfter(response.headers);

    // Collect first, and EXCLUSIVELY: a `deadline_exceeded` 504 is a 5xx too,
    // so both branches would take it — but they are different actions on
    // different budgets, and the server's own verdict about what it is holding
    // wins over this module's guess. Which also means a collect that runs out
    // of `collectBudgetMs` raises rather than falling back into the ordinary
    // backoff: the class is decided per failure, not retried in both.
    // `retryAfter !== null` is redundant with `isCollectable`, which refuses a
    // missing pace — it is written out so the call below needs no cast.
    if (retryAfter !== null && isCollectable(response.status, errorType, retryAfter)) {
      collectingAt = retryAfter;
      const delay = nextDelayMs();
      if (delay !== null) {
        await abortableSleep(delay, options.signal);
        countAttempt();
        continue;
      }
      // Out of collect budget (or past the deadline) — fall through to the
      // 409/504 the server last gave, which carries its own `Retry-After` for
      // a caller who wants to re-ask by hand.
    } else if (isRetryableStatus(response.status, errorType)) {
      // Mid-collect this is still a collect: the 5xx is the re-ask failing to
      // land, not a verdict on the generation, so it is paced and budgeted as
      // one (`nextDelayMs` reads `collectingAt`).
      const delay = nextDelayMs();
      if (delay !== null) {
        await abortableSleep(delay, options.signal);
        countAttempt();
        continue;
      }
      // Out of budget — fall through and raise the last failure the server
      // actually gave, rather than a synthetic "retries exhausted".
    }
    return finish<TData>(model, response, text, idempotencyKey);
  }
}

/** Turn the attempt that ended the retry loop into a result or an error. */
function finish<TData>(
  model: string,
  response: Response,
  text: string,
  idempotencyKey: string,
): RunResult<TData> {
  const requestId = response.headers.get(REQUEST_ID_HEADER);
  if (!response.ok) throw errorFromResponse(response, text, idempotencyKey);

  // A 202 is a task handle, not a result. This route is the synchronous one,
  // so a 202 here means the response is not the finished generation the
  // return type promises — surfacing that is the point, since handing back a
  // handle typed as a result is a silent failure a caller would only discover
  // in production.
  if (response.status === 202) {
    throw new ComfyError(
      `models.run("${model}") received a 202 (accepted, not finished) where a completed result was expected`,
      { code: "unexpected_response", httpStatus: 202, requestId, idempotencyKey },
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (exc) {
    throw new ComfyError(
      `models.run("${model}") returned a ${String(response.status)} whose body is not JSON`,
      {
        code: "unexpected_response",
        httpStatus: response.status,
        requestId,
        idempotencyKey,
        cause: exc,
      },
    );
  }
  return { data: data as TData, requestId };
}

/** The `comfy.models` namespace. Frozen — it is shared process-wide. */
export const models: Models = Object.freeze({ run });
