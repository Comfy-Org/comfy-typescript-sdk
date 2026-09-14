/**
 * `comfy.models` — run a partner model by its canonical `{provider}/{model}`
 * ID and get its own native output back.
 *
 * ```ts
 * import { comfy } from "@comfyorg/sdk";
 *
 * comfy.config({ credentials: "comfyui-..." });
 * const { kind, data, requestId } = await comfy.models.run("bfl/flux-2-pro", {
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
 * # Why the `{ kind, data, requestId }` wrapper
 *
 * `data` is the provider's native payload, forwarded unchanged — no Comfy
 * envelope, no renamed fields — so an integration already written against the
 * provider keeps its own response handling. `requestId` is the server's
 * `X-Comfy-Request-Id` for the call, lifted out of the headers because it is
 * the value a support request needs and asking a user to re-run with header
 * logging on to get it is a bad afternoon.
 *
 * `kind` is there because "the provider's native payload" is not always a
 * document. Most of the catalog answers with JSON, but a partner whose
 * generation IS the response body answers with bytes under its own media type
 * — the run route's `200` declares both branches — so `kind` narrows the two
 * apart and `contentType` rides along on the binary one. See
 * {@link RunResult}.
 *
 * The wrapper is a DELIBERATE asymmetry with the Python SDK, which returns the
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

/** Response header carrying the server-generated id for a call. */
export const REQUEST_ID_HEADER = "X-Comfy-Request-Id";

/** Response header carrying the coarse, machine-readable failure bucket. */
export const ERROR_TYPE_HEADER = "X-Comfy-Error-Type";

/** Response header naming the media type of the body. */
export const CONTENT_TYPE_HEADER = "Content-Type";

/**
 * A completed {@link Models.run} whose result was a JSON document.
 *
 * @typeParam TData - the provider's payload shape. It defaults to `unknown`,
 * NOT `any`: the per-model input/output schemas are published by the server
 * per model rather than baked into this package, so nothing here can know
 * statically what a given model returns, and `any` would silently disable
 * type-checking on every field access downstream. Supply the type you have —
 * `run<FluxOutput>(...)` — and `data` is that type; supply nothing and the
 * compiler makes you narrow it before use.
 */
export interface RunJsonResult<TData = unknown> {
  /** Discriminant: this result's `data` is the parsed JSON document. */
  kind: "json";
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

/**
 * A completed {@link Models.run} whose result was the generation itself, as
 * bytes — an ElevenLabs `audio/mpeg` body is the first of these in the
 * catalog.
 *
 * The bytes are handed back verbatim: not base64, not wrapped in a
 * JSON-shaped object, not decoded. Write them to a file, or wrap them in a
 * `Blob` with {@link contentType} to hand to something that plays them.
 */
export interface RunBinaryResult {
  /** Discriminant: this result's `data` is the raw response body. */
  kind: "binary";
  /** The response body, byte for byte. */
  data: Uint8Array;
  /**
   * The response's `Content-Type`, verbatim — the partner's own media type,
   * forwarded by Router. `""` when the response declared none at all, which
   * is why it is a string rather than `string | null`: it is the value you
   * pass to `new Blob([data], { type: contentType })`, where an empty string
   * is already the "unknown type" spelling.
   */
  contentType: string;
  /** As {@link RunJsonResult.requestId}. */
  requestId: string | null;
}

/**
 * The result of a completed {@link Models.run}.
 *
 * A union rather than one shape, because the route returns two: a partner
 * that answers with a JSON document (a URL to fetch, a structured result) and
 * a partner that answers with the generated bytes directly under its own
 * media type. The server contract says so explicitly — `runRouterModel`'s
 * `200` declares both an `application/json` and a `*\/*` `format: binary`
 * branch — so a caller has to branch too. {@link RunJsonResult.kind} is what
 * to branch on:
 *
 * ```ts
 * const result = await comfy.models.run("elevenlabs/eleven_v3", { text: "hi" });
 * if (result.kind === "binary") {
 *   await writeFile("out.mp3", result.data); // Uint8Array, e.g. audio/mpeg
 * } else {
 *   console.log(result.data); // the provider's JSON document
 * }
 * ```
 */
export type RunResult<TData = unknown> = RunJsonResult<TData> | RunBinaryResult;

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
    // JSON still ranked first — it is what most of the catalog answers with —
    // but no longer the ONLY thing this client says it takes, because it is no
    // longer true: the run route's `200` declares a `*/*` `format: binary`
    // branch alongside the JSON one, and `finish` now handles both. A bare
    // `Accept: application/json` is a client asking a binary model for
    // something it cannot produce, which is a 406 waiting to happen the day
    // anything in front of Router honours the header.
    Accept: "application/json, */*;q=0.9",
    "Idempotency-Key": idempotencyKey,
    "User-Agent": buildUserAgent(),
  };
  const body = JSON.stringify(input);

  const retry = resolveRetry(options.retry);
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
    let responseBody: Uint8Array;
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
      //
      // Bytes rather than `response.text()`, because this route's 200 is not
      // always a text document: a partner whose generation IS the response
      // body answers with its own media type, and `text()` would UTF-8-decode
      // those bytes lossily and irreversibly before anything got to look at
      // the `Content-Type`. Decoding is deferred to the one branch that wants
      // a string ({@link decodeUtf8}), which is what `text()` would have done
      // anyway.
      responseBody = new Uint8Array(await response.arrayBuffer());
    } catch (exc) {
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
    return finish<TData>(model, response, responseBody, idempotencyKey);
  }
}

/** UTF-8, non-fatal, BOM-stripping — the same decode `Response.text()` does. */
const UTF8 = new TextDecoder();

/**
 * The same decode, but refusing invalid UTF-8 instead of papering over it
 * with U+FFFD. Only the headerless probe below wants this: a body that the
 * lenient decoder mangles into replacement characters can go on to parse as
 * JSON (`22 FF 22` becomes the document `"\uFFFD"`), which would hand a
 * caller a corrupted string where the bytes of their generation should be.
 */
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8(bytes: Uint8Array): string {
  return UTF8.decode(bytes);
}

/**
 * The media type from a `Content-Type`, lowercased and without its
 * parameters: `audio/mpeg; charset=binary` -> `audio/mpeg`. `""` when the
 * header was absent or blank.
 *
 * The comma matters as much as the semicolon: `Headers.get` joins a header
 * sent twice into one `", "`-separated value, so a response carrying
 * `Content-Type` twice arrives here as `application/json, application/json`
 * — which matches neither the exact type nor the `+json` suffix, and would
 * send an ordinary JSON result down the binary branch.
 */
function mediaTypeOf(contentType: string): string {
  return contentType.split(";")[0].split(",")[0].trim().toLowerCase();
}

/**
 * Does this media type name a JSON document?
 *
 * A `json` subtype (`application/json`, and the `text/json` some providers
 * still send) or the structured `+json` suffix (`application/
 * vnd.something+json`), which is the set the run route's `200` declares
 * against `RouterModelOutput`. Everything else is the contract's `*\/*`
 * branch — bytes — and is not sniffed any further: the response carries
 * `X-Content-Type-Options: nosniff`, so the partner's media type is taken at
 * its word rather than guessed at from the body.
 *
 * The test is on the subtype rather than the whole string, so a malformed
 * value with no `type/subtype` at all (`garbage+json`) is not read as a
 * document on the strength of its last five characters.
 */
function isJsonMediaType(mediaType: string): boolean {
  const slash = mediaType.indexOf("/");
  if (slash === -1) return false;
  const subtype = mediaType.slice(slash + 1);
  return subtype === "json" || subtype.endsWith("+json");
}

/** Turn the attempt that ended the retry loop into a result or an error. */
function finish<TData>(
  model: string,
  response: Response,
  responseBody: Uint8Array,
  idempotencyKey: string,
): RunResult<TData> {
  const requestId = response.headers.get(REQUEST_ID_HEADER);
  if (!response.ok) throw errorFromResponse(response, decodeUtf8(responseBody), idempotencyKey);

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

  // Every other 2xx is not a finished result either, and used to say so: a
  // 204/205 has no content to be one, a 206 is a fragment of one, and before
  // this route grew a binary branch all three reached `JSON.parse("")` and
  // raised. An empty body is the same case arriving under a 200 — a
  // `Content-Length: 0` or a truncated response — and silently handing back
  // `Uint8Array(0)` writes a caller a zero-byte file for a generation the
  // server already billed them for.
  if (response.status !== 200) {
    throw new ComfyError(
      `models.run("${model}") returned a ${String(response.status)} where the contract's completed result is a 200`,
      { code: "unexpected_response", httpStatus: response.status, requestId, idempotencyKey },
    );
  }
  if (responseBody.byteLength === 0) {
    throw new ComfyError(
      `models.run("${model}") returned a 200 with an empty body where a completed result was expected`,
      { code: "unexpected_response", httpStatus: 200, requestId, idempotencyKey },
    );
  }

  // The `Content-Type` decides which of the two documented 200 shapes this
  // is, and it is read BEFORE anything interprets the body. A partner whose
  // generation is the response — ElevenLabs audio is the first in the catalog
  // — sends its own media type, and the bytes are the result; JSON-parsing
  // them would fail after the server had already run and billed the model,
  // and the lossy UTF-8 decode on the way would destroy them for good.
  const contentType = response.headers.get(CONTENT_TYPE_HEADER)?.trim() ?? "";
  const mediaType = mediaTypeOf(contentType);
  if (mediaType !== "" && !isJsonMediaType(mediaType)) {
    return { kind: "binary", data: responseBody, contentType, requestId };
  }

  let data: unknown;
  try {
    // Strictly when nothing declared a type: invalid UTF-8 is then a fact
    // about the body rather than a field of U+FFFDs, and JSON has to be
    // valid UTF-8 anyway, so refusing it costs no document that would have
    // parsed.
    data = JSON.parse(
      mediaType === "" ? UTF8_STRICT.decode(responseBody) : decodeUtf8(responseBody),
    );
  } catch (exc) {
    // No `Content-Type` at all and a body that is not JSON: nothing claimed
    // this was a document, so it is the binary branch with no media type to
    // report rather than a failure. A response that DID say JSON and then
    // wasn't is still the error it always was — that is the server
    // contradicting its own header, which no caller can do anything useful
    // with a `Uint8Array` of.
    if (mediaType === "") {
      return { kind: "binary", data: responseBody, contentType: "", requestId };
    }
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
  return { kind: "json", data: data as TData, requestId };
}

/** The `comfy.models` namespace. Frozen — it is shared process-wide. */
export const models: Models = Object.freeze({ run });
