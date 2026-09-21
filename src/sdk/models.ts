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
 *
 * The cap never decides what a response MEANS, though. A response is
 * classified from its status line and headers first, and a body is read only
 * for the response this call is going to hand back — a retryable or
 * collectable one is dropped unread — while an error response is truncated at
 * the cap rather than refused, so the bucket it carries survives.
 */

import { clampTimerMs, withInactivityLimits } from "../low/dispatcher.js";
import { buildUserAgent } from "../low/index.js";
import { abortableSleep } from "./abortable-sleep.js";
import { newIdempotencyKey } from "./core.js";
import { requireCredentials, resolveBaseUrl } from "./credentials.js";
import {
  ComfyError,
  type ComfyErrorOptions,
  Forbidden,
  InsufficientCredits,
  NotFound,
  Unauthorized,
} from "./exceptions.js";
import {
  handle,
  type RequestHandle,
  submit,
  subscribe,
  type SubmitOptions,
  type SubscribeOptions,
} from "./modelRequests.js";
import { fillRoute, type ModelId, parseModelId, routerRunQuery } from "./modelRoutes.js";
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
 *
 * The code is not unique to this module, though the breach is: `code` on a
 * response-derived error is whatever {@link ERROR_TYPE_HEADER} said, so an
 * upstream can answer with this value too. `details.maxBytes` is what tells a
 * local cap breach from a remote-declared one — see {@link tooLarge}.
 */
const RESPONSE_TOO_LARGE = "response_too_large";

/**
 * Buffer the capped read starts with when the response declares no length it
 * can size from. Large enough that an ordinary JSON result never grows it,
 * small enough that a tiny body does not reserve a megabyte to sit in.
 */
const INITIAL_BODY_CAPACITY = 65_536;

/**
 * Stand-in for the body of a response this call never read, so the one
 * variable `finish` reads is always assigned. Never reaches `finish`: the
 * loop repeats instead.
 */
const EMPTY_BODY = new Uint8Array(0);

/** Response header carrying the server-generated id for a call. */
export const REQUEST_ID_HEADER = "X-Comfy-Request-Id";

/** Response header carrying the coarse, machine-readable failure bucket. */
export const ERROR_TYPE_HEADER = "X-Comfy-Error-Type";

/** Response header naming the media type of the body. */
export const CONTENT_TYPE_HEADER = "Content-Type";

/**
 * `X-Comfy-Router-Fallback-Provider` — the provider that actually served a call
 * that fell back. See {@link RunJsonResult.servingProvider}.
 */
export const FALLBACK_PROVIDER_HEADER = "X-Comfy-Router-Fallback-Provider";

/**
 * `X-Comfy-Router-Dropped-Params` — native fields an alt-provider translation
 * could not carry. See {@link RunJsonResult.droppedParams}.
 */
export const DROPPED_PARAMS_HEADER = "X-Comfy-Router-Dropped-Params";

/**
 * Parse the `X-Comfy-Router-Dropped-Params` header value.
 *
 * The spec (`spec/router-openapi.yaml`, `RouterDroppedParamsHeader`) declares
 * this header as `type: string`: ONE JSON-encoded string holding an array of
 * strings. It says to decode it with a JSON parser rather than splitting it on
 * commas, because each entry is a sentence that carries commas of its own —
 * the spec's own example entry reads `moderation (fal applies its own,
 * non-configurable safety filtering)`, which a comma split would tear into two
 * meaningless fragments.
 *
 * So: `JSON.parse`, and accept the result only when it is an array of strings.
 * On anything that is not JSON — or is JSON but not an array of strings — keep
 * the raw value as ONE entry rather than guessing at delimiters: a single entry
 * a human can read beats two confident fragments.
 */
export function parseDroppedParams(raw: string | null): readonly string[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x): x is string => typeof x === "string")) {
      return parsed;
    }
  } catch {
    // Not JSON — fall through to the single-entry reading below.
  }
  return [raw];
}

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
  /**
   * `X-Comfy-Router-Fallback-Provider`: the provider that ultimately served this
   * call, when `fallbackProvider` retried against a second one and that retry
   * succeeded — never a provider that was attempted and also failed.
   *
   * `null` means the provider that was asked for served it, which is the common
   * case; it does not mean "unknown". This is the ONLY disclosure of the
   * difference: an alt-provider response is translated back to the model's own
   * native contract, so `data` alone is identical either way.
   */
  servingProvider: string | null;
  /**
   * `X-Comfy-Router-Dropped-Params`: native fields the translation that produced
   * this call's request body could not express exactly on the provider that
   * served it. Each entry normally names the field and why — but not
   * guaranteed: {@link parseDroppedParams} keeps a header that is not a JSON
   * array of strings as ONE entry holding the raw wire value, so an entry can
   * be that raw value rather than a field-plus-reason disclosure.
   *
   * TWO things produce such a translation: an explicit
   * {@link RunOptions.modelProvider} under the default `strictMode: false`, and
   * an automatic `fallback_provider` retry — which is ON by default and
   * independent of `modelProvider` (see {@link RunOptions.fallbackProvider}).
   * So a call that never set `modelProvider` can still come back with a
   * non-null value here: the primary attempt failed, and the retry translated
   * the native body into the other provider's schema to re-send it.
   *
   * On a fallback retry the list names what THAT retry's translation dropped,
   * never the primary attempt's — pair it with
   * {@link RunJsonResult.servingProvider} to see which provider it refers to.
   *
   * `null` when no translation ran, and when one ran and dropped nothing — the
   * server omits the header in both cases. `strictMode: true` is NOT on its own
   * a guarantee of `null`: the spec scopes `strict_mode` to `modelProvider`
   * ("only meaningful together with `model_provider`"), so it suppresses that
   * translation only and does not govern the automatic fallback retry. Turn
   * {@link RunOptions.fallbackProvider} off too if you need that guarantee.
   *
   * Prefer an explicit `!== null` check over a truthiness test: the server
   * omitting the header gives `null`, but a present-but-empty header (`"[]"`)
   * parses to an empty array, which is a non-null empty disclosure.
   */
  droppedParams: readonly string[] | null;
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
  /** As {@link RunJsonResult.servingProvider}. */
  servingProvider: string | null;
  /** As {@link RunJsonResult.droppedParams}. */
  droppedParams: readonly string[] | null;
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
   *
   * **Resend the alt-provider controls with it.** A key's identity covers the
   * QUERY as well as the method and body, and {@link modelProvider},
   * {@link strictMode} and {@link fallbackProvider} are query parameters — so a
   * recovery call that supplies the key but drops them presents the same key
   * under a different query, is refused, and leaves the very generation it was
   * meant to collect uncollectable. This bites at the server default too:
   * `strictMode: false` is sent as `strict_mode=false`, which is a different
   * query from omitting it. Replay the call exactly as it was made.
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
   * that already went wrong. `details.maxBytes` is how a caller knows the
   * breach was local: `code` on a response-derived error is whatever the
   * server's `X-Comfy-Error-Type` said, so an upstream can answer with the
   * same string, and only a cap breach raised here carries `maxBytes`.
   *
   * What the cap never does is change what a response means. A response this
   * call is going to retry or collect is decided from its status and headers,
   * and its body is dropped unread rather than counted — so an oversized
   * error page cannot make a retryable 502 fatal, or abandon a generation the
   * server is still holding behind a collectable 409/504. An error response
   * this call DOES hand back is truncated at the cap instead of refused: the
   * bucket a caller branches on comes from the status and the header, and
   * losing `Unauthorized` or `InsufficientCredits` to a cap breach would cost
   * more than the body was worth. Only a RESULT past the cap raises.
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
  /**
   * Select an alternate serving provider for this model — Comfy Router's
   * `model_provider` query param (e.g. `"fal"`). Omitted, the model runs on its
   * default provider and the request is byte-for-byte what it always was.
   *
   * Under the default `strictMode` (`false`) the `input` you pass stays this
   * model's own native shape and Router translates it to the alternate
   * provider's schema on the way in and the response back to native on the way
   * out. See {@link strictMode} and {@link fallbackProvider} for the two knobs
   * that ride with it — all three are sent ONLY when set, so a call that names
   * none of them is unchanged.
   */
  modelProvider?: string;
  /**
   * `strict_mode` — only meaningful alongside {@link modelProvider}. `false`
   * (the default) has Router translate between this model's native shape and the
   * alternate provider's own schema in both directions; `true` sends and returns
   * that provider's raw shape unchanged, so `input` must already BE that
   * provider's schema and no translation happens either way. Rendered on the
   * wire as `true`/`false`.
   */
  strictMode?: boolean;
  /**
   * `fallback_provider` — pass `false` to opt out of Router retrying a failed
   * call against the model's other registered provider. Any other value, or
   * omitting it, leaves provider-fallback on (the default).
   *
   * Prefer the boolean. The spec turns fallback on for ANY value that is not
   * exactly `false`, so `"False"`, `"0"`, `"no"` and `"off"` all type-check and
   * then do the opposite of what they read as — a `boolean` cannot be spelled
   * wrong, and is normalised to the wire spelling for you.
   */
  fallbackProvider?: boolean | string;
}

/**
 * The `comfy.models` surface: discover what is runnable, read one model's
 * published schemas, then run it.
 *
 * `input` is the model's own native input document, forwarded to the provider
 * unchanged. It is typed as an open object rather than a per-model shape for
 * the reason given on {@link RunResult}: the schemas are the server's to
 * publish, per model, and this package does not carry a copy of them.
 *
 * Where it gets them instead is {@link Models.schema}, which fetches the
 * document Router publishes for one model at
 * `GET /v2/models/{provider}/{model}/openapi.json`, and {@link Models.list},
 * which walks the catalog those model IDs come from. Neither bundles a copy
 * and neither validates against one — the document is handed back as data, so
 * the choice of validator (and of whether to validate at all) stays the
 * caller's. See {@link SchemaResult} for why that is not just a scope call.
 */
export interface Models {
  run<TData = unknown>(
    model: string,
    input: Record<string, unknown>,
    options?: RunOptions,
  ): Promise<RunResult<TData>>;
  schema<TDocument = unknown>(
    model: string,
    options?: SchemaOptions,
  ): Promise<SchemaResult<TDocument>>;
  list(options?: ListOptions): ModelList;

  /**
   * Queue `model` with `input` and resolve to a {@link RequestHandle} on the
   * request — the QUEUED counterpart of {@link Models.run}.
   *
   * The same request either way: the same canonical `{provider}/{model}` id
   * and the same native JSON input, forwarded unchanged. The difference is
   * when the server answers — here, as soon as the request is ACCEPTED, with
   * the generation collected later through the returned handle.
   *
   * Reach for it over `run` when the caller cannot hold a connection for the
   * length of a generation: a web request that has to return now, a worker
   * that submits in one process and collects in another, or a batch whose
   * submits should all be in flight at once.
   *
   * ```ts
   * const handle = await comfy.models.submit("bfl/flux-2-pro", { prompt: "a cat" });
   * const { data } = await handle.get();
   * ```
   *
   * A FRESH `Idempotency-Key` is minted per call, which is what makes two
   * deliberate submits of the same input two requests rather than one
   * deduplicated request, while every retry inside this one call reuses the one
   * key and so replays the original acceptance rather than queueing a second
   * generation. `options.idempotencyKey` overrides it — the case that earns
   * that is a lost response, where the request may have been accepted and its
   * id lost with the reply.
   *
   * The surface is gated SERVER SIDE: a caller the queue is not switched on for
   * is answered `403 not_enabled`, which arrives here as
   * `routerErrors.NotEnabled`. Nothing about the request is wrong in that case,
   * and it is terminal — it is not retried.
   */
  submit<TData = unknown>(
    model: string,
    input: Record<string, unknown>,
    options?: SubmitOptions,
  ): Promise<RequestHandle<TData>>;

  /**
   * Queue a request, follow it to completion, and resolve to its result —
   * {@link Models.submit} plus polling plus {@link RequestHandle.get}, in one
   * call.
   *
   * The ergonomic form for a caller who does want to wait but also wants to
   * show progress while waiting. It resolves to `RunResult<TData>`, identical
   * to what {@link Models.run} would have returned for the same model and
   * input.
   *
   * ```ts
   * const { data } = await comfy.models.subscribe(
   *   "bfl/flux-2-pro",
   *   { prompt: "a cat" },
   *   { onQueueUpdate: (u) => console.log(u.status, u.queuePosition), timeoutMs: 300_000 },
   * );
   * ```
   *
   * `timeoutMs` is a CLIENT-SIDE bound with no server-side meaning — the
   * queue's own timeouts are the server's. It bounds the submit, the polls
   * and the result fetch, but NOT time spent inside `onQueueUpdate`: the
   * deadline and `signal` are enforced by the poll loop, and the callback is
   * awaited between polls, so one that never settles parks this call and
   * neither the timeout nor an abort fires. Deliberate — it is the caller's
   * own code, the same reason a callback that throws does not cancel the
   * request — but an `async` callback should carry its own bound. When it runs out, or
   * when `signal` aborts, this makes one best-effort
   * {@link RequestHandle.cancel} — so a caller who has stopped waiting is not
   * also still paying for a generation nobody will collect — and then rejects.
   *
   * That cancel is only possible ONCE THE SUBMIT HAS RETURNED A HANDLE. This
   * submits before it has anything to cancel, so a deadline that expires
   * during the submit — or a submit the server accepted whose response was
   * lost — leaves a queued request running with no handle to address it. Pass
   * `idempotencyKey` to cover that window: re-submitting under the same key
   * replays the original acceptance and yields the same request, which is the
   * only route back to an id lost with its reply.
   *
   * Use {@link Models.submit} when the request should outlive the caller's
   * patience.
   *
   * A completion carrying an `error_type` — which is how the server reports a
   * failure AND a cancellation — rejects with the typed exception from
   * `routerErrors` rather than resolving, so a `200` never comes back as a
   * successful result.
   */
  subscribe<TData = unknown>(
    model: string,
    input: Record<string, unknown>,
    options?: SubscribeOptions,
  ): Promise<RunResult<TData>>;

  /**
   * Rebuild the handle for a request submitted anywhere. Makes NO request.
   *
   * Takes no state beyond the two ids that address the request, so a process
   * that never made the submit — a worker draining a queue of ids, a retry
   * after a restart — reaches the same {@link RequestHandle} the submitting
   * process held. An id that names nothing surfaces on the first
   * {@link RequestHandle.status} or {@link RequestHandle.get}, as the server's
   * own answer rather than as a guess made here.
   *
   * ```ts
   * const handle = comfy.models.handle("bfl/flux-2-pro", requestId);
   * const { data } = await handle.get();
   * ```
   *
   * Both ids are validated LOCALLY rather than pasted into a URL: a malformed
   * `{provider}/{model}` id, or a `requestId` that is not one printable path
   * segment of at most 256 characters, throws a `TypeError`.
   */
  handle<TData = unknown>(model: string, requestId: string): RequestHandle<TData>;
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

function runUrl(baseUrl: string, id: ModelId, query: string): string {
  // `query` is already percent-encoded (`routerRunQuery`) and empty for a call
  // that named no alt-provider control, so nothing is appended and the URL is
  // byte-for-byte the one this route has always built.
  return `${baseUrl}${fillRoute(RUN_ROUTE_TEMPLATE, id)}${query === "" ? "" : `?${query}`}`;
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
  idempotencyKey: string | null,
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
        // A number renders raw and everything else keeps its quoting:
        // `JSON.stringify` writes `NaN` as `null`, which is the one value the
        // same sentence calls valid, so the rejection would name what it
        // accepts.
        `or null to disable the cap, got ${
          typeof maxBytes === "number" ? String(maxBytes) : JSON.stringify(maxBytes)
        }`,
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

/**
 * How a body came to be one this call would not hold: declared past the cap,
 * read past it, or small enough to want and still impossible to allocate.
 */
type CapBreach =
  | { readonly contentLength: number }
  | { readonly bytesRead: number }
  | { readonly bytesRead: number; readonly allocationFailedAt: number };

/**
 * The {@link ComfyError} a body this call will not buffer raises.
 *
 * `details.maxBytes` is the discriminator, not `code`. `errorFromResponse`
 * derives its `code` verbatim from the server-controlled
 * {@link ERROR_TYPE_HEADER}, so an upstream answering with
 * `response_too_large` mints an error carrying the identical string; only
 * this constructor puts `maxBytes` on `details`, and only for a body this
 * process declined to hold. {@link isTooLarge} tests for that, and
 * {@link RunOptions.maxBytes} documents it as the way a caller tells the two
 * apart.
 */
function tooLarge(
  model: string,
  response: Response,
  idempotencyKey: string,
  maxBytes: number,
  breach: CapBreach,
  cause?: unknown,
): ComfyError {
  const cap = `${String(maxBytes)}-byte maxBytes cap`;
  const advice =
    "allocationFailedAt" in breach
      ? "lower maxBytes, or ask this model for a smaller result"
      : "raise maxBytes for this call, or pass maxBytes: null to disable the cap";
  let what: string;
  if ("contentLength" in breach) {
    what = `declares a Content-Length of ${String(breach.contentLength)} bytes, past the ${cap}`;
  } else if ("allocationFailedAt" in breach) {
    // Not "too large for the cap" — too large for this process. Under the cap
    // and still unallocatable is a different verdict, and saying "raise
    // maxBytes" about it would send the caller the wrong way.
    what =
      `could not be buffered: allocating ${String(breach.allocationFailedAt)} bytes failed ` +
      `${String(breach.bytesRead)} bytes in, under the ${cap}`;
  } else {
    // The read was ABANDONED at this many bytes — roughly the cap plus the
    // chunk that crossed it — which is not the body's size. The body is never
    // fully received, so its size is not known here, and phrasing this as a
    // measurement would invite a caller to raise `maxBytes` to it and breach
    // again.
    what = `exceeds the ${cap} (abandoned after ${String(breach.bytesRead)} bytes)`;
  }
  return new ComfyError(`models.run("${model}") response body ${what}; ${advice}`, {
    code: RESPONSE_TOO_LARGE,
    httpStatus: response.status,
    details: { maxBytes, ...breach },
    requestId: response.headers.get(REQUEST_ID_HEADER),
    // Set on every other response-derived error, and documented as "any
    // failure that carried the header has it" — a cap breach on a paced
    // 409/504 leaves the caller an `idempotencyKey` to collect with, so it
    // owes them the interval to collect at too.
    retryAfter: parseRetryAfter(response.headers),
    idempotencyKey,
    cause,
  });
}

/**
 * Is `exc` a body THIS module declined to buffer, as opposed to anything else
 * the fetch-and-read can throw?
 *
 * The code alone is not the test, for the reason {@link tooLarge} gives: the
 * server controls `code`. `details.maxBytes` is set nowhere else.
 */
function isTooLarge(exc: unknown): boolean {
  return (
    exc instanceof ComfyError &&
    exc.code === RESPONSE_TOO_LARGE &&
    typeof exc.details?.maxBytes === "number"
  );
}

/**
 * Buffer the response body, within `maxBytes`.
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
 * An error response is TRUNCATED at the cap rather than refused. The bucket a
 * caller branches on comes from the status and {@link ERROR_TYPE_HEADER}, and
 * `errorFromResponse` reads the body only to enrich the message — so raising
 * a cap breach over an oversized error page would trade `Unauthorized` or
 * `InsufficientCredits` for a bare `ComfyError` and lose the one thing the
 * response was actually carrying. The cap still bounds the allocation; it
 * just no longer overrides the verdict.
 *
 * With no cap the runtime's own buffering does the work, which is what this
 * route did before the cap existed.
 */
async function readBodyWithin(
  response: Response,
  maxBytes: number | null,
  model: string,
  idempotencyKey: string,
): Promise<Uint8Array> {
  if (maxBytes === null) return new Uint8Array(await response.arrayBuffer());

  const truncate = !response.ok;
  const declared = declaredLength(response);
  if (!truncate && declared !== null && declared > maxBytes) {
    // Drop the connection rather than leave a body nothing will ever read
    // streaming into the buffer — not downloading it is the whole point of
    // checking the header first.
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge(model, response, idempotencyKey, maxBytes, { contentLength: declared });
  }

  const body = response.body;
  // No stream to read — a body-less status, or a runtime that exposes none.
  // The runtime's own buffering is bounded by the same absent body.
  if (body === null) return new Uint8Array(await response.arrayBuffer());

  /**
   * `new Uint8Array(n)`, but raising the cap error rather than a bare
   * `RangeError`. A failed allocation is not a transport failure and
   * re-asking cannot fix it, so it has to leave by the same door the cap
   * breach does — otherwise it lands in the retry branch and re-downloads the
   * same unbufferable body on every attempt, which is the amplification the
   * cap exists to prevent.
   */
  const allocate = (byteLength: number, bytesRead: number): Uint8Array => {
    try {
      return new Uint8Array(byteLength);
    } catch (exc) {
      throw tooLarge(
        model,
        response,
        idempotencyKey,
        maxBytes,
        { bytesRead, allocationFailedAt: byteLength },
        exc,
      );
    }
  };

  const reader = body.getReader();
  // One growable buffer rather than a list of chunks. A chunk list bounds the
  // payload bytes but not the per-chunk object overhead, nor the socket-read
  // buffer each view keeps alive — a body well under the cap delivered as a
  // million tiny chunks would cost the heap far more than the cap advertises,
  // which is the threat this cap is for — and concatenating at the end holds
  // every chunk AND the finished copy at once. Here each chunk is copied in
  // and dropped as it arrives, and the buffer is never larger than the cap.
  let buffer = allocate(Math.min(declared ?? INITIAL_BODY_CAPACITY, maxBytes), 0);
  let total = 0;
  /** Grow to hold `needed` bytes, keeping the `total` already written. */
  const reserve = (needed: number): void => {
    if (needed <= buffer.byteLength) return;
    let capacity = buffer.byteLength === 0 ? INITIAL_BODY_CAPACITY : buffer.byteLength;
    while (capacity < needed) capacity *= 2;
    // `needed` never exceeds the cap, so clamping here cannot undershoot it.
    const grown = allocate(Math.min(capacity, maxBytes), total);
    grown.set(buffer.subarray(0, total));
    buffer = grown;
  };

  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const received = total + value.byteLength;
      if (received > maxBytes) {
        if (!truncate) {
          throw tooLarge(model, response, idempotencyKey, maxBytes, { bytesRead: received });
        }
        const room = maxBytes - total;
        if (room > 0) {
          reserve(maxBytes);
          buffer.set(value.subarray(0, room), total);
          total = maxBytes;
        }
        truncated = true;
        break;
      }
      reserve(received);
      buffer.set(value, total);
      total = received;
    }
  } catch (exc) {
    // Stop the transfer on the way out, for the breach and for an abort
    // alike: without this the rest of an oversized body keeps arriving on a
    // socket nothing is reading from.
    await reader.cancel().catch(() => undefined);
    throw exc;
  }
  // Same reason, for the error body that was cut short rather than refused.
  if (truncated) await reader.cancel().catch(() => undefined);

  if (total === buffer.byteLength) return buffer;
  // A view keeps the whole grown buffer alive behind whatever the caller
  // holds — which for a binary result is their generation's bytes. Copy when
  // the slack is worth a transient second allocation (the buffer only ever
  // doubles, so the slack is under half except on the smallest bodies), and
  // hand back a view when it is not.
  return total * 2 >= buffer.byteLength ? buffer.subarray(0, total) : buffer.slice(0, total);
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
  const credentials = requireCredentials();
  const id = parseModelId(model);
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(
      `models.run(model, input): input must be the model's native JSON input object, got ${
        Array.isArray(input) ? "array" : String(input === null ? "null" : typeof input)
      }`,
    );
  }

  // The alt-provider controls, as a query string that is empty unless the
  // caller set one — so the URL, and the whole request, is unchanged for a run
  // that names none of them. Built once, outside the retry loop, since every
  // attempt of this one logical call goes to the same URL.
  const query = routerRunQuery({
    modelProvider: options.modelProvider,
    strictMode: options.strictMode,
    fallbackProvider: options.fallbackProvider,
  });
  const url = runUrl(resolveBaseUrl(), id, query);
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
    let responseBody: Uint8Array = EMPTY_BODY;
    // Non-null once this response has been classified as one to ask again
    // about, and is then the backoff before that re-ask.
    let repeatAfterMs: number | null = null;
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

      const errorType = response.headers.get(ERROR_TYPE_HEADER);
      const retryAfter = parseRetryAfter(response.headers);

      // Classified from the status line and the headers, BEFORE the body is
      // touched. What a response means is not something its body decides
      // here, and deciding it first is what keeps the cap from overruling it:
      // a retryable 502 behind an oversized CDN error page stays retryable,
      // and a collectable 409/504 stays collectable, instead of a cap breach
      // turning either into a fatal error with the budget unspent and a
      // generation still running.
      //
      // Collect first, and EXCLUSIVELY: a `deadline_exceeded` 504 is a 5xx
      // too, so both branches would take it — but they are different actions
      // on different budgets, and the server's own verdict about what it is
      // holding wins over this module's guess. Which also means a collect
      // that runs out of `collectBudgetMs` raises rather than falling back
      // into the ordinary backoff: the class is decided per failure, not
      // retried in both. `retryAfter !== null` is redundant with
      // `isCollectable`, which refuses a missing pace — it is written out so
      // the call below needs no cast.
      if (retryAfter !== null && isCollectable(response.status, errorType, retryAfter)) {
        collectingAt = retryAfter;
        // `null` here means out of collect budget (or past the deadline) —
        // fall through to the 409/504 the server last gave, which carries its
        // own `Retry-After` for a caller who wants to re-ask by hand.
        repeatAfterMs = nextDelayMs();
      } else if (isRetryableStatus(response.status, errorType)) {
        // Mid-collect this is still a collect: the 5xx is the re-ask failing
        // to land, not a verdict on the generation, so it is paced and
        // budgeted as one (`nextDelayMs` reads `collectingAt`). `null` is out
        // of budget — fall through and raise the last failure the server
        // actually gave, rather than a synthetic "retries exhausted".
        repeatAfterMs = nextDelayMs();
      }

      if (repeatAfterMs === null) {
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
        responseBody = await readBodyWithin(response, maxBytes, model, idempotencyKey);
      } else {
        // Never read: the whole content of a response this call is going to
        // ask again about is "ask again", which the status line already said.
        // Dropping it spends neither the download nor the cap on it.
        await response.body?.cancel().catch(() => undefined);
      }
    } catch (exc) {
      // A body this call would not buffer leaves the loop immediately. It is a
      // verdict about THIS response, not a transport failure, and the retry
      // loop sitting around the read is exactly what would make it expensive:
      // every attempt would re-download the same oversized body until the
      // budget expired, multiplying the cost of the one thing that already
      // failed.
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

    if (repeatAfterMs !== null) {
      await abortableSleep(repeatAfterMs, options.signal);
      countAttempt();
      continue;
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
  // Read before any branch returns: these disclose HOW the call ran (which
  // provider served it, what a translation dropped), and an alt-provider
  // response is translated back to the native contract, so the body alone
  // cannot tell an alt-provider run from a native one.
  const servingProvider = response.headers.get(FALLBACK_PROVIDER_HEADER);
  const droppedParams = parseDroppedParams(response.headers.get(DROPPED_PARAMS_HEADER));
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
    return {
      kind: "binary",
      data: responseBody,
      contentType,
      requestId,
      servingProvider,
      droppedParams,
    };
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
      return {
        kind: "binary",
        data: responseBody,
        contentType: "",
        requestId,
        servingProvider,
        droppedParams,
      };
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
  return { kind: "json", data: data as TData, requestId, servingProvider, droppedParams };
}

// -- discovery: the model catalog, and one model's published schemas ---------

/**
 * Default deadline for one {@link Models.schema} or {@link Models.list}
 * request, in milliseconds.
 *
 * Seconds rather than the minutes {@link DEFAULT_RUN_TIMEOUT_MS} allows,
 * because these two are ordinary API calls: nothing is generated behind them,
 * so a server that has not answered in half a minute is not "still working"
 * the way a `run` legitimately is. A `list()` walk applies this PER PAGE, not
 * to the whole walk — each page is its own request, and a shared budget would
 * make a large catalog fail halfway through for no reason but its size.
 *
 * Override it per call with `timeoutMs`, or disable it with `null`.
 */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 30_000;

/**
 * The Router route {@link Models.schema} reads a model's published OpenAPI
 * document from, as the OpenAPI path template.
 *
 * Pinned as a named constant for the same reason as
 * {@link RUN_ROUTE_TEMPLATE}: `src/sdk/router-spec-contract.test.ts` compares
 * it character for character against the path the vendored contract declares
 * for `operationId: getRouterModelInputSchema`, so a sync that moves the route
 * reddens CI instead of turning `schema()` into a 404 at runtime.
 */
export const SCHEMA_ROUTE_TEMPLATE = "/v2/models/{provider}/{model}/openapi.json";

/**
 * The Router route {@link Models.list} reads the model catalog from. Pinned
 * against `operationId: listRouterModels` in the vendored contract exactly as
 * the two templates above are.
 */
export const CATALOG_ROUTE_TEMPLATE = "/v2/models";

/** Response header carrying the entity tag of a served schema document. */
export const ETAG_HEADER = "ETag";

/** Request header carrying the entity tag a caller already holds. */
export const IF_NONE_MATCH_HEADER = "If-None-Match";

/** Query parameter naming the page to continue a catalog walk from. */
const CURSOR_PARAM = "cursor";

/** Query parameter asking for a page size. */
const LIMIT_PARAM = "limit";

/** What every discovery request takes, on top of what it addresses. */
export interface DiscoveryOptions {
  /**
   * Abort the request. On a {@link Models.list} walk it aborts the page in
   * flight and ends the iteration, rather than only the one request.
   */
  signal?: AbortSignal;
  /**
   * Per-request deadline in milliseconds — per PAGE on a `list()` walk. Omit
   * for {@link DEFAULT_DISCOVERY_TIMEOUT_MS}; pass `null` to disable it and
   * supply your own `signal`.
   */
  timeoutMs?: number | null;
}

export interface SchemaOptions extends DiscoveryOptions {
  /**
   * An `ETag` from an earlier {@link SchemaResult}, sent back as
   * `If-None-Match`.
   *
   * This is the whole reason the route ships `ETag` and `Cache-Control`: a
   * per-model document changes rarely and a client re-reads it often, so a
   * caller that stores the tag alongside its copy gets a bodyless `304` back
   * instead of the document. That `304` is NOT an error and NOT an empty
   * document — it resolves as {@link SchemaUnchanged}, which is why the result
   * is a union a caller has to narrow.
   */
  etag?: string | null;
}

export interface ListOptions extends DiscoveryOptions {
  /**
   * Continue from a cursor a previous {@link ModelPage} handed back, instead
   * of starting at the first page. Opaque: round-trip it, never parse it.
   */
  cursor?: string | null;
  /**
   * Page size to ask the server for. The server CLAMPS a value above its own
   * maximum rather than refusing it, so the size actually served is on
   * {@link ModelPage.limit} — read it there rather than assuming this one was
   * honoured. It changes how many requests a full walk takes and nothing
   * else; the walk still yields every model either way.
   */
  limit?: number;
}

/**
 * One entry in the Router model catalog.
 *
 * Only the identity is typed, which is deliberately the whole of what the
 * contract calls the minimum needed to invoke a model: `id` is the canonical
 * `{provider}/{model}` string {@link Models.run} and {@link Models.schema}
 * take, and the two segments are carried separately so a caller never has to
 * split it. Everything else an entry carries reaches the caller through the
 * index signature rather than being restated here — per the same rule that
 * keeps the schema documents out of this package, the catalog's fields are the
 * server's to publish and a hand-copied mirror of them is a thing that goes
 * stale silently.
 */
export interface CatalogModel {
  /** Canonical model ID: `provider` and `model` joined by `/`. */
  id: string;
  /** The partner the model belongs to — the first path segment. */
  provider: string;
  /** The model within that provider — the second path segment. */
  model: string;
  [field: string]: unknown;
}

/**
 * One page of the catalog, as {@link ModelList.page} returns it.
 *
 * This is the single-page form, for a caller driving its own pagination — a
 * "load more" button, say. Anything walking the whole catalog should iterate
 * {@link ModelList} instead, which is what makes the first-page-only bug
 * impossible rather than merely documented.
 */
export interface ModelPage {
  /** The models on this page. */
  data: CatalogModel[];
  /**
   * Whether another page exists. The end of the catalog is THIS being false —
   * never a short or empty `data`, which a page legitimately carries mid-walk.
   */
  hasMore: boolean;
  /** Cursor for the next page; `null` when the server named none. */
  nextCursor: string | null;
  /**
   * The page size the server actually served, which can be smaller than the
   * `limit` asked for — values above the maximum are clamped down rather than
   * refused. `null` if the response named none.
   */
  limit: number | null;
  /** The `X-Comfy-Request-Id` for the request that fetched this page. */
  requestId: string | null;
}

/**
 * A lazy handle on the catalog: iterate it for every model, or take one page.
 *
 * `list()` itself sends nothing — the first request goes out when the
 * iteration starts or {@link ModelPage} is awaited. Each iteration is a fresh
 * walk from the configured cursor, so the handle can be iterated more than
 * once.
 */
export interface ModelList extends AsyncIterable<CatalogModel> {
  /**
   * Fetch exactly ONE page, without walking. `overrides` are merged over the
   * options `list()` was given, which is how a caller pages by hand:
   * `list().page()`, then `list({ cursor: page.nextCursor }).page()`.
   */
  page(overrides?: ListOptions): Promise<ModelPage>;
}

/**
 * A model's published OpenAPI document, plus the `ETag` to revalidate it with.
 *
 * @typeParam TDocument - the document's shape, defaulting to `unknown` for the
 * same reason {@link RunResult}'s payload does: the schemas are the server's
 * to publish, per model, and this package carries no copy of them to type
 * against. Supply your own type — `schema<OpenAPIV3.Document>(...)` — and
 * `document` is that type.
 *
 * It is handed back as DATA and is not validated here, and no validator is a
 * dependency of this package. That is not only a scope call: these are OpenAPI
 * 3.0.2 documents, so they are JSON Schema draft-04 plus `nullable`, and stock
 * Ajv does not cover that combination — a caller validating against one wants
 * `ajv-draft-04` and its own decisions about it. Making that choice here would
 * impose a validator (and its bundle weight) on every caller, including the
 * browser ones.
 */
export interface SchemaDocument<TDocument = unknown> {
  /** `false` — this result carries a document. Narrow on it. */
  unchanged: false;
  /** The document, exactly as the server published it. */
  document: TDocument;
  /** The document's current `ETag`; pass it back as `options.etag` next time. */
  etag: string | null;
  /** The `X-Comfy-Request-Id` for this call. */
  requestId: string | null;
}

/**
 * The answer to a {@link SchemaOptions.etag} that still matches: the caller's
 * copy is current, and the server sent no body.
 *
 * `document` is `undefined` rather than absent so that narrowing on
 * `unchanged` is the only thing a caller has to do — and so that reading
 * `.document` on an unnarrowed result is a compile error rather than a silent
 * `undefined` treated as an empty schema.
 */
export interface SchemaUnchanged {
  /** `true` — the caller's own copy is still current. */
  unchanged: true;
  /** Always `undefined`: a `304` carries no body. */
  document: undefined;
  /** The `ETag` that still matches — the one sent, echoed by the server. */
  etag: string | null;
  /** The `X-Comfy-Request-Id` for this call. */
  requestId: string | null;
}

/**
 * What {@link Models.schema} resolves to: the document, or "unchanged".
 *
 * ```ts
 * const result = await comfy.models.schema("bfl/flux-2-pro", { etag: cached?.etag });
 * if (!result.unchanged) cached = { document: result.document, etag: result.etag };
 * ```
 */
export type SchemaResult<TDocument = unknown> = SchemaDocument<TDocument> | SchemaUnchanged;

/** The headers every discovery request sends. */
function discoveryHeaders(credentials: string): Record<string, string> {
  return {
    Authorization: `Bearer ${credentials}`,
    Accept: "application/json",
    "User-Agent": buildUserAgent(),
  };
}

/**
 * Send one discovery GET and read its body, under this request's deadline.
 *
 * Neither discovery method retries. A `run` retries because the connection is
 * held for a whole generation and losing it can cost a paid result; a catalog
 * page or a schema document costs nothing to ask for again, carries no
 * idempotency key, and a caller who wants a policy already has one. What IS
 * shared with `run` is everything the ticket for these methods is about: the
 * base URL, the credential, the `X-Comfy-Request-Id` capture and the
 * `X-Comfy-Error-Type` mapping.
 */
async function discoveryFetch(
  label: string,
  url: string,
  headers: Record<string, string>,
  options: DiscoveryOptions,
): Promise<{ response: Response; text: string }> {
  const timeoutMs =
    options.timeoutMs === undefined ? DEFAULT_DISCOVERY_TIMEOUT_MS : options.timeoutMs;
  const signal = composeSignal(options.signal, timeoutMs);
  try {
    const response = await fetch(
      url,
      withInactivityLimits({ method: "GET", headers, signal }, timeoutMs),
    );
    // Inside the same `try` as the fetch, for the same reason as in `run`:
    // the deadline covers reading the body too, and translating the abort in
    // only one of the two places would leak a bare DOMException out of the
    // other. A `304` has no body and `.text()` answers "" for it.
    const text = await response.text();
    return { response, text };
  } catch (exc) {
    if (isTimeout(exc, options.signal)) {
      throw new ComfyError(
        `${label} exceeded its ${String(timeoutMs)}ms deadline; raise it with timeoutMs, ` +
          "or pass timeoutMs: null and your own signal",
        { code: "request_timeout", cause: exc },
      );
    }
    throw exc;
  }
}

/** Parse a discovery response body, or say which call returned what instead. */
function parseDiscoveryJson(label: string, response: Response, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (exc) {
    throw new ComfyError(`${label} returned a ${String(response.status)} whose body is not JSON`, {
      code: "unexpected_response",
      httpStatus: response.status,
      requestId: response.headers.get(REQUEST_ID_HEADER),
      cause: exc,
    });
  }
}

async function schema<TDocument = unknown>(
  model: string,
  options: SchemaOptions = {},
): Promise<SchemaResult<TDocument>> {
  const credentials = requireCredentials();
  const id = parseModelId(model, "schema");
  const label = `models.schema("${model}")`;
  const url = `${resolveBaseUrl()}${fillRoute(SCHEMA_ROUTE_TEMPLATE, id)}`;
  const headers = discoveryHeaders(credentials);
  // An empty tag is not a tag: sending `If-None-Match: ` would ask the server
  // to compare against nothing, and the honest reading of "I hold no copy" is
  // to send no header at all.
  if (typeof options.etag === "string" && options.etag !== "") {
    headers[IF_NONE_MATCH_HEADER] = options.etag;
  }

  const { response, text } = await discoveryFetch(label, url, headers, options);
  const requestId = response.headers.get(REQUEST_ID_HEADER);
  const etag = response.headers.get(ETAG_HEADER);

  // Before the `ok` check, which a 304 fails: it is a successful
  // revalidation, not a failure, and raising it would defeat the only reason
  // the caller sent the tag. Only when a tag WAS sent, though: a 304 to a
  // request that carried no `If-None-Match` confirms a copy the caller does
  // not hold, and reading it as "unchanged" would hand back neither a document
  // nor an error — a cache that never fills.
  if (response.status === 304) {
    if (!(IF_NONE_MATCH_HEADER in headers)) {
      throw new ComfyError(
        `${label} received a 304 without having sent If-None-Match, so there is no held copy ` +
          "for it to confirm",
        { code: "unexpected_response", httpStatus: response.status, requestId },
      );
    }
    return { unchanged: true, document: undefined, etag: etag ?? options.etag ?? null, requestId };
  }
  // The same mapping `run` uses, so a `404` here is the `model_not_found`
  // bucket and the same exception class an unknown ID raises there. No
  // idempotency key: these are GETs and carry none.
  if (!response.ok) throw errorFromResponse(response, text, null);

  const document = parseDiscoveryJson(label, response, text);
  return { unchanged: false, document: document as TDocument, etag, requestId };
}

/** Where a discovery call goes and what it carries, resolved once per call. */
interface DiscoveryEndpoint {
  baseUrl: string;
  credentials: string;
}

/**
 * Resolve the credential and base URL together. `run` resolves both once per
 * call; a `list()` walk resolves them once per WALK (not per page), so a
 * `config()` change while the consumer is between yielded models cannot send
 * a cursor minted by one host to another under a different credential.
 */
function resolveDiscoveryEndpoint(): DiscoveryEndpoint {
  const credentials = requireCredentials();
  return { credentials, baseUrl: resolveBaseUrl() };
}

/** Whether a catalog entry carries the identity the contract promises. */
function isCatalogModel(value: unknown): value is CatalogModel {
  if (value === null || typeof value !== "object") return false;
  const { id, provider, model } = value as Record<string, unknown>;
  return typeof id === "string" && typeof provider === "string" && typeof model === "string";
}

/** The one refusal both consumers of a page need for `has_more` with no cursor. */
const HAS_MORE_WITHOUT_CURSOR =
  "reporting `has_more: true` with no `next_cursor`, so the rest of the catalog is unreachable";

/** A catalog page that cannot be read safely, saying which part could not. */
function catalogPageError(
  what: string,
  details: { httpStatus?: number; requestId: string | null },
): ComfyError {
  return new ComfyError(`models.list() received a catalog page ${what}`, {
    code: "unexpected_response",
    ...details,
  });
}

/** One page of the catalog, off the wire. */
async function fetchModelPage(
  options: ListOptions,
  endpoint: DiscoveryEndpoint = resolveDiscoveryEndpoint(),
): Promise<ModelPage> {
  const label = "models.list()";
  const url = new URL(`${endpoint.baseUrl}${CATALOG_ROUTE_TEMPLATE}`);
  if (typeof options.cursor === "string" && options.cursor !== "") {
    url.searchParams.set(CURSOR_PARAM, options.cursor);
  }
  if (options.limit !== undefined) url.searchParams.set(LIMIT_PARAM, String(options.limit));

  const { response, text } = await discoveryFetch(
    label,
    url.toString(),
    discoveryHeaders(endpoint.credentials),
    options,
  );
  const requestId = response.headers.get(REQUEST_ID_HEADER);
  if (!response.ok) throw errorFromResponse(response, text, null);

  const body = parseDiscoveryJson(label, response, text) as {
    data?: unknown;
    has_more?: unknown;
    next_cursor?: unknown;
    limit?: unknown;
  } | null;
  const details = { httpStatus: response.status, requestId };
  const entries = Array.isArray(body?.data) ? (body.data as unknown[]) : null;
  if (entries === null) throw catalogPageError("without a `data` array", details);
  // `has_more` is required by the contract and is the ONLY thing that says
  // the walk is over, so a response without it is refused rather than read as
  // a last page. Guessing `false` there is precisely the "first 20 models and
  // no error" failure these two methods exist to make impossible.
  const hasMore = typeof body?.has_more === "boolean" ? body.has_more : null;
  if (hasMore === null) {
    throw catalogPageError(
      "without a boolean `has_more`, so there is no way to tell a last page from a truncated walk",
      details,
    );
  }
  // Each entry has to be at least the identity the contract promises. A page
  // of `[null]` handed on as `CatalogModel[]` would crash a consumer at
  // `model.id`, far from the response that caused it.
  const data: CatalogModel[] = [];
  for (const [index, item] of entries.entries()) {
    if (!isCatalogModel(item)) {
      throw catalogPageError(
        `whose \`data[${String(index)}]\` lacks the string \`id\`, \`provider\` and \`model\` fields`,
        details,
      );
    }
    data.push(item);
  }
  const nextCursor =
    typeof body?.next_cursor === "string" && body.next_cursor !== "" ? body.next_cursor : null;
  // Refused HERE, not only in the walk, so a caller paging by hand —
  // `list({ cursor: page.nextCursor }).page()` — is never handed a `null`
  // cursor that silently re-serves page one to a `while (page.hasMore)` loop.
  if (hasMore && nextCursor === null) throw catalogPageError(HAS_MORE_WITHOUT_CURSOR, details);
  return {
    data,
    hasMore,
    nextCursor,
    limit: typeof body?.limit === "number" ? body.limit : null,
    requestId,
  };
}

/**
 * Walk the catalog, yielding models rather than pages.
 *
 * The page size is a server default (20 at the time of writing) and the
 * catalog is longer than that, so a method that handed back one page would
 * make "the first 20 models, with no error to say so" the default outcome for
 * anyone who did not read the response shape carefully. Iterating models is
 * what makes the common case correct.
 */
async function* walkCatalog(options: ListOptions): AsyncGenerator<CatalogModel> {
  const endpoint = resolveDiscoveryEndpoint();
  let cursor = typeof options.cursor === "string" && options.cursor !== "" ? options.cursor : null;
  // Every cursor this walk has already asked with. A server that answers
  // `has_more: true` with a cursor it already served would otherwise loop
  // forever, and an SDK that hangs is worse than one that raises.
  const asked = new Set<string>();
  if (cursor !== null) asked.add(cursor);
  for (;;) {
    const page = await fetchModelPage({ ...options, cursor }, endpoint);
    for (const entry of page.data) {
      // Observed between yields as well as by the page fetches, so an abort
      // after a model was yielded ends the iteration — as
      // `DiscoveryOptions.signal` says — instead of draining the rest of the
      // page first. Raised raw, as the fetch raises it: a caller's own abort
      // is theirs to recognise.
      options.signal?.throwIfAborted();
      yield entry;
    }
    if (!page.hasMore) return;
    const next = page.nextCursor;
    if (next === null) {
      // `fetchModelPage` already refuses this shape, so this cannot fire; it
      // narrows `next` and refuses the same way should that ever change.
      throw catalogPageError(HAS_MORE_WITHOUT_CURSOR, { requestId: page.requestId });
    }
    if (asked.has(next)) {
      throw new ComfyError(
        "models.list() was handed a `next_cursor` it had already followed, which would " +
          "walk the same pages forever",
        { code: "unexpected_response", requestId: page.requestId },
      );
    }
    asked.add(next);
    cursor = next;
  }
}

function list(options: ListOptions = {}): ModelList {
  return {
    page: (overrides: ListOptions = {}) => fetchModelPage({ ...options, ...overrides }),
    [Symbol.asyncIterator]: () => walkCatalog(options),
  };
}

/**
 * The `comfy.models` namespace. Frozen — it is shared process-wide.
 *
 * `submit`, `subscribe` and `handle` are imported from `./modelRequests.ts`
 * rather than declared here: the queued surface is a file's worth of polling,
 * pacing and completion handling, and folding it into this module would bury
 * `run` in it. The dependency runs ONE WAY — that module imports nothing from
 * this one at run time, only `RunResult` as an erased type — which is what
 * keeps reading these three at module-evaluation time safe.
 */
export const models: Models = Object.freeze({
  run,
  schema,
  list,
  submit,
  subscribe,
  handle,
});
