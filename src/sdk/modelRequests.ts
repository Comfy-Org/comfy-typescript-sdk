/**
 * `comfy.models.submit` / `subscribe` / `handle` — the QUEUED form of a model
 * request, and the {@link RequestHandle} the three of them hand back.
 *
 * ```ts
 * import { comfy } from "@comfyorg/sdk";
 *
 * comfy.config({ credentials: "comfyui-..." });
 *
 * const handle = await comfy.models.submit("bfl/flux-2-pro", { prompt: "a cat" });
 * handle.requestId;                 // all another process needs, with the model id
 * const { data } = await handle.get();
 * ```
 *
 * `models.run` holds one connection open until the generation is finished.
 * `models.submit` returns the moment the server has ACCEPTED the request, and
 * the generation is collected later — from another task, another process or
 * another machine, since a handle is rebuildable from nothing but the model id
 * and the request id (`comfy.models.handle`).
 *
 * # The server owns the queue
 *
 * Ordering, admission, retries, timeouts, billing and expiry are all decided
 * server side; this module adds polling and ergonomics and nothing else.
 * Anything here that looked like queue *behaviour* — a local position
 * estimate, a client-side retry of a rejected submit, an expiry clock — would
 * be a second, disagreeing implementation of a decision that has already been
 * made somewhere authoritative.
 *
 * Two consequences of the surface, rather than of taste:
 *
 * - **Terminal means `COMPLETED`, and a failure is a completion.** The server
 *   reports a failed or cancelled request as `COMPLETED` carrying an
 *   `error_type`, so a `200` is not the same thing as a success. Every path
 *   that reads a completion runs it through `toRouterError` and rejects with
 *   the typed {@link RouterError} subclass, which is what keeps a failed
 *   generation from being handed back as a result. A status this release has
 *   never heard of is treated as NOT yet terminal — the set grows on the
 *   server's release cycle, and guessing that an unknown state is finished
 *   would collect a result that does not exist yet.
 *
 * - **There is no event stream.** {@link RequestHandle.events} is the poll
 *   loop with its updates exposed, not SSE — the queue's streaming surfaces
 *   are not part of this release. Polls are paced by the server's own
 *   `Retry-After` when it names one and by an adaptive backoff when it does
 *   not.
 *
 * # Which exception hierarchy this raises
 *
 * The queued surface raises `routerErrors.*` ({@link RouterError} and its
 * subclasses), NOT the `ComfyError` family `models.run` maps its failures
 * into. That is a deliberate difference inside this SDK, and it is the Python
 * SDK's shape: the queue's failures are reported as an `error_type` in a `200`
 * body, where there is no HTTP status to classify and the bucket is the only
 * thing there is — so the class keyed by that bucket is the only honest
 * answer, and `catch (err) { if (err instanceof routerErrors.NotEnabled) ... }`
 * is the same branch whether the bucket arrived on a `403` header or inside a
 * completion. `models.run` keeps its own mapping unchanged; see `./models.ts`.
 */

import { clampTimerMs, withInactivityLimits } from "../low/dispatcher.js";
import { buildUserAgent } from "../low/index.js";
import { abortableSleep } from "./abortable-sleep.js";
import { backoffSchedule, newIdempotencyKey } from "./core.js";
import { requireCredentials, resolveBaseUrl } from "./credentials.js";
import { ComfyError, stamping } from "./exceptions.js";
import { fillRoute, parseModelId, parseRequestId } from "./modelRoutes.js";
import {
  DROPPED_PARAMS_HEADER,
  FALLBACK_PROVIDER_HEADER,
  parseDroppedParams,
  type RunResult,
} from "./models.js";
import {
  ERROR_TYPE_HEADER,
  errorFromCompletion,
  REQUEST_ID_HEADER,
  toRouterError,
} from "./routerErrors.js";
import { isRetryableStatus, nextAttemptDelayMs, resolveRetry, type RetryOptions } from "./retry.js";

/**
 * The queue's one terminal status.
 *
 * Deliberately a single value rather than a set: the server does not express a
 * cancel or a failure as its own status, it expresses them as this status plus
 * an `error_type`. Adding a `"CANCELED"` here on the assumption it exists would
 * strand a caller whose request really did reach `COMPLETED`.
 */
export const COMPLETED = "COMPLETED";

/**
 * Ceiling, in milliseconds, on a server-named `Retry-After` between two polls.
 *
 * The header is honoured because the server knows its own pace, but it is a
 * hint and not a bound: taking it verbatim would let one `Retry-After: 86400`
 * park a caller for a day. A minute is long enough that a request told to wait
 * longer is still polled rarely, and short enough that nothing is parked.
 */
export const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Default deadline for one {@link Models.submit} call, in milliseconds.
 *
 * A minute rather than `DEFAULT_RUN_TIMEOUT_MS`'s ten, because nothing here
 * waits on a generation: the call returns as soon as the request is accepted,
 * so a deadline sized for a model run would only ever be a deadline for a
 * broken connection.
 */
export const DEFAULT_SUBMIT_TIMEOUT_MS = 60_000;

/**
 * Deadline, in milliseconds, for the best-effort cancel `subscribe` issues
 * after its own timeout or an abort.
 *
 * Short, and under {@link RetryOptions} of `false`, because it runs inside the
 * handling of a failure the caller is about to see: a cancel that rode the
 * call's full retry budget would hold that caller for the whole of it after
 * they had already stopped waiting.
 */
export const CANCEL_TIMEOUT_MS = 10_000;

/**
 * Floor, in milliseconds, on the per-request deadline derived from what is
 * left of a caller's own.
 *
 * A sub-second bound cannot complete a TLS handshake, so without the floor the
 * last poll before a deadline would be a certain transport failure rather than
 * an answer — and `timeoutMs: 0`, which is documented as "look once", would
 * make no readable request at all. The loop is still bounded: past the
 * deadline no FURTHER request is started, so a wait overruns by at most one
 * request of this length. Matches the Python SDK's `_MIN_HTTP_TIMEOUT`.
 */
export const MIN_REQUEST_TIMEOUT_MS = 1_000;

/**
 * Routes for the queued form of a model request — submit, poll, collect,
 * cancel. They extend the run route with a `requests` collection under the
 * same model-ID-addressed prefix, because a queued request is the same
 * operation on the same model, reached without holding the connection open.
 *
 * **These four are not in the vendored contract yet.** The queue operations
 * are authored upstream but held, and the one-way sync into
 * `spec/router-openapi.yaml` strips a held operation — so unlike
 * `RUN_ROUTE_TEMPLATE`, which `router-spec-contract.test.ts` pins against the
 * vendored file, these are hand-bound with nothing in the spec to pin them to.
 * What pins them meanwhile is their RELATION to the run route, asserted in
 * that same test: each is `RUN_ROUTE_TEMPLATE` plus a fixed suffix, so a sync
 * that moves the run route reddens these too. That test also fails the moment
 * the vendored spec DOES declare them, which is the signal to replace the
 * relation assertion with a comparison against the spec.
 *
 * They are spelled as literals rather than derived from `RUN_ROUTE_TEMPLATE`
 * on purpose. `./models.ts` imports THIS module (to assemble the frozen
 * `models` namespace) and this module imports nothing from it at run time —
 * only `RunResult` as a type, which is erased. Reading `RUN_ROUTE_TEMPLATE`
 * here would turn that one-way dependency into a cycle whose safety would then
 * rest on evaluation order, and `RUN_ROUTE_TEMPLATE` cannot move out of
 * `./models.ts` because `scripts/router-route-contract.mjs` reads it out of
 * that file's source text. So the run path is spelled twice, and the test is
 * what keeps the two spellings honest.
 */
export const MODEL_REQUESTS_ROUTE_TEMPLATE = "/v2/models/{provider}/{model}/requests";
/** One queued request — the route its RESULT is collected from. */
export const MODEL_REQUEST_ROUTE_TEMPLATE = "/v2/models/{provider}/{model}/requests/{request_id}";
/** The authoritative status read for one queued request. */
export const MODEL_REQUEST_STATUS_ROUTE_TEMPLATE =
  "/v2/models/{provider}/{model}/requests/{request_id}/status";
/** The cancel request for one queued request. Sent as `PUT`. */
export const MODEL_REQUEST_CANCEL_ROUTE_TEMPLATE =
  "/v2/models/{provider}/{model}/requests/{request_id}/cancel";

/**
 * One observation of a queued request's place in the queue.
 *
 * What {@link RequestHandle.status} resolves to, what
 * {@link RequestHandle.events} yields, and what `subscribe`'s `onQueueUpdate`
 * callback is handed.
 */
export interface QueueUpdate {
  /**
   * The request id this update is about — the same id `comfy.models.handle`
   * rebuilds from. It is the id the call was ADDRESSED by, never the body's
   * own copy: that one is server-controlled and unvalidated, and an update
   * that named a different request from the one it was asked about would be
   * wrong in exactly the place a caller pastes into a support ticket.
   */
  requestId: string;
  /**
   * The server's status for the request, verbatim — `"IN_QUEUE"`,
   * `"IN_PROGRESS"`, `"COMPLETED"`, or whatever a newer server sends.
   *
   * An OPEN string, not a union: a status added server side has to reach the
   * caller as itself rather than as a decoding failure. Compare it against
   * {@link COMPLETED}, or read {@link completed}. `""` only when the response
   * named none at all, which a `204` answer to a cancel legitimately does.
   */
  status: string;
  /** Whether the request has reached the queue's one terminal status. */
  completed: boolean;
  /**
   * Position in the queue when the server reported one, else `null`. It is
   * the server's number, never computed here.
   */
  queuePosition: number | null;
  /**
   * The failure bucket a completion carries, when it carries one. Present here
   * as DATA; the raising is done by the methods that collect a result
   * ({@link RequestHandle.get} and `subscribe`), so that a caller who is only
   * looking can look.
   */
  errorType: string | null;
  /**
   * Milliseconds the server asked the caller to wait before polling again,
   * from `Retry-After` (which names seconds). `null` when it named no pace, in
   * which case the adaptive backoff decides. Reported UNCAPPED — the
   * {@link MAX_RETRY_AFTER_MS} ceiling is applied to what is slept on, not to
   * what the server is reported as having said.
   */
  retryAfterMs: number | null;
  /**
   * The decoded response body, unmodified — the escape hatch for a field this
   * interface does not model yet.
   */
  raw: Record<string, unknown>;
}

/** Options accepted by {@link Models.submit}. */
export interface SubmitOptions {
  /**
   * Abort the submit. Composed with the deadline below, so whichever fires
   * first wins, and honoured between attempts as well as during one.
   */
  signal?: AbortSignal;
  /**
   * Deadline in milliseconds for the SUBMIT call, retries included. Omit for
   * {@link DEFAULT_SUBMIT_TIMEOUT_MS}; pass `null` to disable it. It does not
   * bound the generation — nothing about this call waits for one.
   */
  timeoutMs?: number | null;
  /**
   * `Idempotency-Key` for this submit. One is minted per CALL when omitted,
   * which is what makes two deliberate submits of the same input two requests
   * rather than one deduplicated request, while every retry inside this one
   * call reuses the one key and so replays the original rather than queueing a
   * second generation.
   *
   * Supply your own for the case that earns it: a lost response, where the
   * request may have been accepted and its id lost with the reply, and
   * resending under the same key is the only way back to it.
   */
  idempotencyKey?: string;
  /** Retry policy for the submit call. See `./retry.ts`; `false` for one attempt. */
  retry?: RetryOptions | false;
}

/** Options accepted by {@link RequestHandle.get} and {@link RequestHandle.events}. */
export interface WaitOptions {
  /**
   * Abort the wait. Bounds the poll requests, their retries, the pauses
   * between them and the result fetch — not only the pauses. Rejects with the
   * caller's own abort reason, untouched.
   */
  signal?: AbortSignal;
  /**
   * Client-side bound in milliseconds on the WHOLE wait: every poll, every
   * retry of one, every pause between them, and the result fetch. `null` (the
   * default) waits until the server says the request is done.
   *
   * The first poll is always made, so `timeoutMs: 0` reads "look once". Past
   * the bound no further poll is started, and the last one in flight is held
   * to what is left of it, so the wait overruns by at most one such request.
   * Exceeding it rejects and leaves the request RUNNING — the queue is the
   * server's, and a local clock running out says nothing about it. Cancelling
   * on the way out is `subscribe`'s behaviour, deliberately not this one's.
   */
  timeoutMs?: number | null;
  /** Retry policy for each individual poll and for the result fetch. */
  retry?: RetryOptions | false;
}

/** Options accepted by {@link Models.subscribe}. */
export interface SubscribeOptions extends SubmitOptions {
  /**
   * Called with a {@link QueueUpdate} each time the queue moves — the first
   * observation, every change of status or queue position, and the completion.
   *
   * It is awaited if it returns a promise, so an `async` callback finishes
   * before the next poll. An exception it raises (or rejects with) propagates
   * and abandons the wait; the request keeps running server side, and NO
   * cancel is issued, because a bug in a progress renderer is not a reason to
   * throw away a generation that is already paid for.
   */
  onQueueUpdate?: (update: QueueUpdate) => void | Promise<void>;
  /**
   * Client-side bound in milliseconds on the whole call — the submit, then
   * every poll, retry and pause, and the result fetch. `null` (the default)
   * waits until the server says the request is done.
   *
   * When it runs out, `subscribe` makes ONE best-effort
   * {@link RequestHandle.cancel} — so a caller who has stopped waiting is not
   * also still paying for a generation nobody will collect — and then rejects
   * with the timeout. Best-effort is literal: a cancel that itself fails is
   * swallowed, because the timeout is the failure worth reporting and a masked
   * one sends the caller looking in the wrong place. An abort via `signal` does
   * the same. Use {@link Models.submit} when the request should outlive the
   * caller's patience.
   */
  timeoutMs?: number | null;
}

// -- wire reading ------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `Retry-After` as a positive whole number of milliseconds, or `null`.
 *
 * Delta-seconds only: the HTTP-date form the RFC also permits is treated as
 * absent rather than parsed, matching the Python SDK so one header has one
 * reading across the two. A non-positive or unparseable value names no pace
 * and is dropped — honouring a zero would turn a server that keeps answering
 * it into a zero-delay poll loop. */
function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get("Retry-After");
  if (raw === null) return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds * 1_000;
}

/** A body field as a non-empty, trimmed string, or `null`. */
function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function invalidResponse(message: string, requestId: string | null, httpStatus?: number) {
  return new ComfyError(message, { code: "invalid_response", httpStatus, requestId });
}

/**
 * Build a {@link QueueUpdate} from one response.
 *
 * `requireStatus` is set by the authoritative status read, where a body naming
 * no status is not a state to poll again but a response this SDK cannot act
 * on — treating it as "not yet terminal" would poll a `200 {}` forever. It
 * stays off for the cancel, whose `204` legitimately names none.
 */
function updateFrom(
  body: unknown,
  response: QueueResponse,
  requestId: string,
  requireStatus: boolean,
): QueueUpdate {
  const httpRequestId = response.headers.get(REQUEST_ID_HEADER);
  if (!isRecord(body)) {
    throw invalidResponse(
      "the queue answered with a body that is not a JSON object, so the request's state " +
        "cannot be read from it",
      httpRequestId,
      response.status,
    );
  }
  const status = typeof body.status === "string" ? body.status : "";
  if (requireStatus && status.trim() === "") {
    throw invalidResponse(
      "the status read answered without naming a status, so the request's state is unknown",
      httpRequestId,
      response.status,
    );
  }
  const position = body.queue_position;
  return {
    requestId,
    status,
    completed: status === COMPLETED,
    queuePosition: typeof position === "number" && Number.isInteger(position) ? position : null,
    errorType: text(body.error_type),
    retryAfterMs: retryAfterMs(response.headers),
    raw: body,
  };
}

/**
 * The request id a submit response names, or a {@link ComfyError}.
 *
 * A submit whose response carries no usable id is unusable in the specific way
 * that matters here: the work may well have been accepted and billed, and the
 * caller has been left with no way to reach it. That is a failure of the call,
 * so it rejects rather than being papered over with a placeholder id that
 * would 404 on the first poll.
 */
function requestIdOf(body: unknown, response: QueueResponse): string {
  const httpRequestId = response.headers.get(REQUEST_ID_HEADER);
  if (!isRecord(body)) {
    throw invalidResponse(
      "the queue accepted the request but answered with a body that is not a JSON object, " +
        "so no request_id could be read from it",
      httpRequestId,
      response.status,
    );
  }
  const raw = body.request_id;
  if (typeof raw !== "string" || raw === "") {
    throw invalidResponse(
      "the queue accepted the request but its response named no request_id, so the request " +
        "cannot be polled, collected or cancelled",
      httpRequestId,
      response.status,
    );
  }
  try {
    // The id becomes a path segment on every later call, so it is held to the
    // same rule a caller-supplied one is. Failing here rather than on the
    // first poll keeps the failure next to the response that caused it — and
    // next to the `Idempotency-Key` that can recover the request.
    return parseRequestId(raw, "the request_id the queue named");
  } catch (exc) {
    throw invalidResponse(
      `the queue named a request_id that cannot address a route: ${String(exc)}`,
      httpRequestId,
      response.status,
    );
  }
}

/**
 * Throw the typed router exception a COMPLETED request reports, if it reports
 * one.
 *
 * The gate behind "a `200` with an error payload is never returned as
 * success". It runs on the terminal status read AND on the collected result,
 * because either can be the response that carries the `error_type`, and
 * checking only one leaves the other handing a failure back as data.
 *
 * `envelopeOnly` is for the result route, and it is a deliberate narrowing
 * rather than caution. That route's body is the PROVIDER'S OWN payload,
 * forwarded verbatim — a partner model is free to have a field called
 * `error_type` in its native output, and turning one of those into a rejection
 * would fail a generation that succeeded. So on that body an `error_type` only
 * counts when it arrives inside the queue's own envelope, which is what a
 * `COMPLETED` status alongside it identifies. The status read has no such
 * ambiguity and is checked unconditionally, so the failure the server reports
 * where it is authoritative is never the one that gets missed.
 */
function raiseForCompletion(body: unknown, requestId: string, envelopeOnly = false): void {
  // A partner's native output is whatever JSON document the partner answers
  // with — an array or a bare value is a result, not an envelope, and there is
  // nothing in it the queue could have reported.
  if (!isRecord(body)) return;
  if (envelopeOnly && body.status !== COMPLETED) return;
  const error = errorFromCompletion(body, requestId);
  if (error !== null) throw error;
}

/** Whether `current` is worth reporting given `previous`.
 *
 * The first observation always is. After that, only a change in the two fields
 * a caller renders — the status and the queue position — counts, so a progress
 * bar is not redrawn once a second for a request that has not moved. */
function changed(previous: QueueUpdate | null, current: QueueUpdate): boolean {
  if (previous === null) return true;
  return previous.status !== current.status || previous.queuePosition !== current.queuePosition;
}

/**
 * Milliseconds to wait before the next poll.
 *
 * A pace the server named beats the schedule guessed here — that is the whole
 * point of `Retry-After` — and the adaptive backoff carries the interval when
 * it named none. The backoff is advanced either way, so the schedule does not
 * restart from its floor the moment the server stops naming a pace. The named
 * pace is capped at {@link MAX_RETRY_AFTER_MS}: a hint, honoured, but not a
 * bound a single header can park the caller behind.
 */
function pace(update: QueueUpdate, backoff: Generator<number, never, void>): number {
  return nextPollDelayMs(update.retryAfterMs, backoff.next().value);
}

/**
 * The pacing decision itself, with the clock and the schedule taken out of it:
 * `retryAfterMs` is what the server named (`null` when it named nothing) and
 * `scheduledMs` is what the adaptive backoff would have chosen.
 *
 * Exported because the cap is the part worth asserting directly — proving that
 * a `Retry-After: 86400` is slept on as a minute needs either this or a test
 * that actually waits a day.
 */
export function nextPollDelayMs(retryAfterMs: number | null, scheduledMs: number): number {
  if (retryAfterMs === null) return scheduledMs;
  return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
}

// -- HTTP --------------------------------------------------------------------

interface QueueResponse {
  status: number;
  headers: Headers;
  text: string;
}

interface QueueCall {
  method: "GET" | "POST" | "PUT";
  url: string;
  body?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** What is left of the caller's deadline, or `null` for none. */
  budgetMs: number | null;
  retry: RetryOptions | false;
  /** Names the call in a deadline message: `submit`, `status`, ... */
  what: string;
}

/**
 * Compose the caller's signal with what is left of this call's budget.
 * `undefined` means "no deadline and no caller signal", which is the only case
 * where the request runs unbounded.
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

/**
 * Did `signal` abort because a deadline elapsed, rather than because the
 * caller aborted it?
 *
 * A caller's abort is theirs and is re-thrown untouched — swallowing it into
 * an SDK error would make `AbortController` behave differently here than
 * everywhere else in the language.
 */
function isTimeout(exc: unknown, callerSignal: AbortSignal | undefined): boolean {
  if (callerSignal?.aborted) return false;
  return exc instanceof Error && exc.name === "TimeoutError";
}

/**
 * Send one queue call, retrying transport failures and retryable statuses
 * inside the budget it was given.
 *
 * The budget covers the whole call — the request, its retries and the pauses
 * between them — which is what makes a caller's `timeoutMs` a bound on the
 * poll loop and not only on the pauses in it.
 */
async function send(call: QueueCall): Promise<QueueResponse> {
  const credentials = requireCredentials();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials}`,
    Accept: "application/json",
    "User-Agent": buildUserAgent(),
  };
  if (call.body !== undefined) headers["Content-Type"] = "application/json";
  if (call.idempotencyKey !== undefined) headers["Idempotency-Key"] = call.idempotencyKey;

  const retry = resolveRetry(call.retry);
  const startedAt = Date.now();
  const deadlineAt = call.budgetMs === null ? null : startedAt + call.budgetMs;
  const clock = () => ({
    elapsedMs: Date.now() - startedAt,
    remainingMs: deadlineAt === null ? null : deadlineAt - Date.now(),
  });

  let attempt = 0;
  for (;;) {
    const remainingMs = clock().remainingMs;
    // Floored for this ONE request; the loop's own bound is unfloored, so a
    // spent budget still stops the next attempt. See MIN_REQUEST_TIMEOUT_MS.
    const requestMs = remainingMs === null ? null : Math.max(remainingMs, MIN_REQUEST_TIMEOUT_MS);
    const signal = composeSignal(call.signal, requestMs);
    let response: Response;
    let bodyText: string;
    try {
      response = await fetch(
        call.url,
        withInactivityLimits({ method: call.method, headers, body: call.body, signal }, requestMs),
      );
      // Inside the same `try` as the fetch on purpose: the deadline covers
      // body consumption too, so a signal that fires while the body is still
      // streaming rejects HERE, and translating it in only one of the two
      // places would leak a bare DOMException out of the other.
      bodyText = await response.text();
    } catch (exc) {
      // A caller's abort is theirs: never retried, never re-dressed.
      if (call.signal?.aborted) throw exc;
      if (isTimeout(exc, call.signal)) {
        throw new ComfyError(
          `the model queue's ${call.what} call exceeded the deadline left for it`,
          { code: "request_timeout", cause: exc, idempotencyKey: call.idempotencyKey ?? null },
        );
      }
      const delay = nextAttemptDelayMs(attempt, retry, clock());
      if (delay === null) throw exc;
      await abortableSleep(delay, call.signal);
      attempt += 1;
      continue;
    }

    if (isRetryableStatus(response.status, response.headers.get(ERROR_TYPE_HEADER))) {
      const delay = nextAttemptDelayMs(attempt, retry, clock());
      if (delay !== null) {
        await abortableSleep(delay, call.signal);
        attempt += 1;
        continue;
      }
      // Out of budget — fall through and raise the failure the server actually
      // gave, rather than a synthetic "retries exhausted".
    }
    return { status: response.status, headers: response.headers, text: bodyText };
  }
}

/** Decode a queue response, raising the typed router error for a non-2xx. */
function decode(response: QueueResponse, accepted: readonly number[]): unknown {
  let body: unknown;
  let parsed = true;
  if (response.text === "") {
    // A `204` (and a `202` with no body) is a legitimate answer to a cancel.
    body = {};
  } else {
    try {
      body = JSON.parse(response.text);
    } catch {
      parsed = false;
      body = null;
    }
  }

  if (response.status < 200 || response.status >= 300) {
    throw toRouterError(response.status, response.headers, body);
  }
  if (!parsed) {
    throw invalidResponse(
      `the queue answered ${String(response.status)} with a body that is not JSON`,
      response.headers.get(REQUEST_ID_HEADER),
      response.status,
    );
  }
  if (!accepted.includes(response.status)) {
    throw invalidResponse(
      `the queue answered ${String(response.status)} where one of ` +
        `${accepted.join(", ")} was expected`,
      response.headers.get(REQUEST_ID_HEADER),
      response.status,
    );
  }
  return body;
}

function queueUrl(
  template: string,
  model: string,
  requestId: string | null,
  method: string,
): string {
  const id = parseModelId(model, method);
  const values: Record<string, string> = { ...id };
  if (requestId !== null) values.request_id = requestId;
  return `${resolveBaseUrl()}${fillRoute(template, values)}`;
}

function remainingMs(deadlineAt: number | null): number | null {
  return deadlineAt === null ? null : deadlineAt - Date.now();
}

function timedOut(requestId: string, timeoutMs: number, update: QueueUpdate | null): ComfyError {
  const status = update === null ? "unknown" : update.status;
  return new ComfyError(
    `model request ${requestId} was not complete after ${String(timeoutMs)}ms ` +
      `(status: ${status}); it is still running — raise timeoutMs, or use ` +
      "comfy.models.handle() to collect it later",
    { code: "request_timeout", requestId: null },
  );
}

// -- the handle --------------------------------------------------------------

/**
 * A queued model request.
 *
 * Built by `comfy.models.submit` and by `comfy.models.handle`; there is
 * nothing to construct by hand, and nothing in it a second process cannot
 * rebuild from {@link model} and {@link requestId}.
 *
 * `TData` is the provider's payload shape, as on `run` — supply the type you
 * have (`comfy.models.submit<FluxOutput>(...)`) and {@link get} resolves to
 * `RunResult<FluxOutput>`; supply nothing and the compiler makes you narrow it
 * before use.
 */
export class RequestHandle<TData = unknown> {
  /**
   * The canonical `{provider}/{model}` id this request was submitted to.
   *
   * Part of the handle's identity rather than a convenience: every route in
   * this family is addressed by the model id AND the request id, which is why
   * `comfy.models.handle` takes both.
   */
  readonly model: string;

  /**
   * The server-minted id for this queued request — all a rehydration needs.
   *
   * Distinct from `RunResult.requestId`, which is the per-HTTP-call
   * `X-Comfy-Request-Id` of whichever request produced that result. This one
   * identifies the QUEUED REQUEST across every call made about it.
   */
  readonly requestId: string;

  readonly #retry: RetryOptions | false;

  /** @internal — built by `comfy.models.submit` / `comfy.models.handle`. */
  constructor(model: string, requestId: string, retry: RetryOptions | false = {}) {
    this.model = model;
    this.requestId = requestId;
    this.#retry = retry;
    Object.freeze(this);
  }

  /**
   * Poll the queue once and resolve to what it said.
   *
   * One request, no waiting. It reports a completion carrying an `error_type`
   * as data on {@link QueueUpdate.errorType} rather than rejecting: this is
   * the read a caller uses to LOOK, and the raising belongs to {@link get},
   * which is the one that hands back a result.
   */
  async status(
    options: { signal?: AbortSignal; timeoutMs?: number | null; retry?: RetryOptions | false } = {},
  ) {
    return await this.#poll({
      signal: options.signal,
      budgetMs: options.timeoutMs === undefined ? null : options.timeoutMs,
      retry: options.retry ?? this.#retry,
    });
  }

  async #poll(options: {
    signal?: AbortSignal;
    budgetMs: number | null;
    retry: RetryOptions | false;
  }): Promise<QueueUpdate> {
    const response = await send({
      method: "GET",
      url: queueUrl(MODEL_REQUEST_STATUS_ROUTE_TEMPLATE, this.model, this.requestId, "handle"),
      signal: options.signal,
      budgetMs: options.budgetMs,
      retry: options.retry,
      what: "status",
    });
    return updateFrom(decode(response, [200]), response, this.requestId, true);
  }

  /**
   * Poll to completion, yielding an update whenever the queue moves.
   *
   * The first observation is always yielded; after that only a change in
   * status or queue position is. The final yield is the completion itself,
   * after which the iterator stops — it does NOT reject for a completion
   * carrying an `error_type`, because this is a view of the queue's progress
   * and a caller who wants the result calls {@link get}, which does.
   *
   * The TypeScript spelling of the Python SDK's `iter_events`.
   *
   * ```ts
   * for await (const update of handle.events()) {
   *   console.log(update.status, update.queuePosition);
   * }
   * ```
   *
   * See {@link WaitOptions.timeoutMs} for what the bound covers. Breaking out
   * of the loop stops the polling and leaves the request running: an iterator
   * that cancelled the work it was iterating would make a `break` destructive.
   */
  async *events(options: WaitOptions = {}): AsyncGenerator<QueueUpdate, void, void> {
    const timeoutMs = options.timeoutMs ?? null;
    const retry = options.retry ?? this.#retry;
    const deadlineAt = timeoutMs === null ? null : Date.now() + timeoutMs;
    const backoff = backoffSchedule();
    let previous: QueueUpdate | null = null;
    for (;;) {
      let left = remainingMs(deadlineAt);
      // `previous !== null` is what makes the FIRST poll unconditional, so
      // `timeoutMs: 0` reads "look once" rather than "do nothing".
      if (previous !== null && left !== null && left <= 0) {
        throw timedOut(this.requestId, timeoutMs ?? 0, previous);
      }
      const update = await this.#poll({ signal: options.signal, budgetMs: left, retry });
      if (changed(previous, update)) yield update;
      previous = update;
      if (update.completed) return;
      left = remainingMs(deadlineAt);
      if (left !== null && left <= 0) throw timedOut(this.requestId, timeoutMs ?? 0, update);
      const delay = pace(update, backoff);
      await abortableSleep(left === null ? delay : Math.min(delay, left), options.signal);
    }
  }

  /**
   * Wait for the request to complete and resolve to the provider's payload.
   *
   * The result is `{ data, requestId }` exactly as `comfy.models.run` returns
   * it for the same model and input — `data` is the partner model's own
   * output, forwarded unchanged, and `requestId` is the `X-Comfy-Request-Id`
   * of the fetch that collected it (not {@link RequestHandle.requestId}, which
   * identifies the queued request itself).
   *
   * Rejects with the typed exception from `routerErrors` when the completion
   * carries an `error_type`, which is how the server reports a failed OR
   * cancelled request. `timeoutMs` bounds the wait exactly as it does on
   * {@link events}, the result fetch included, and rejects WITHOUT cancelling.
   *
   * Calling it on a request that has already completed is one status poll and
   * one fetch, so collecting a result twice — or from a second process — costs
   * no more than the first time.
   */
  async get(options: WaitOptions = {}): Promise<RunResult<TData>> {
    const timeoutMs = options.timeoutMs ?? null;
    const deadlineAt = timeoutMs === null ? null : Date.now() + timeoutMs;
    let completion: QueueUpdate | null = null;
    for await (const update of this.events(options)) completion = update;
    return await this.collect(completion, {
      signal: options.signal,
      budgetMs: remainingMs(deadlineAt),
      retry: options.retry ?? this.#retry,
    });
  }

  /**
   * Turn an observed completion into a result, or into the typed error.
   *
   * Split out of {@link get} so `subscribe` — which has already polled its way
   * to the completion — can collect from the update it is holding instead of
   * spending one more status request rediscovering it.
   *
   * @internal
   */
  async collect(
    completion: QueueUpdate | null,
    options: { signal?: AbortSignal; budgetMs: number | null; retry: RetryOptions | false },
  ): Promise<RunResult<TData>> {
    if (completion === null) {
      // Unreachable while `events` always yields the completion it stops on;
      // checked anyway, because the alternative is a null dereference in the
      // middle of collecting a result if that ever stops being true.
      throw invalidResponse("the poll loop ended without observing a completion", null);
    }
    raiseForCompletion(completion.raw, this.requestId);
    const response = await send({
      method: "GET",
      url: queueUrl(MODEL_REQUEST_ROUTE_TEMPLATE, this.model, this.requestId, "handle"),
      signal: options.signal,
      budgetMs: options.budgetMs,
      retry: options.retry,
      what: "result",
    });
    if (response.status === 202) {
      // The status read said COMPLETED and the result route says otherwise.
      // Reporting it is the point: returning the 202's status body typed as a
      // result would be a silent failure a caller only discovers downstream.
      throw invalidResponse(
        `the queue reported request ${this.requestId} as ${COMPLETED} but its result route ` +
          "answered 202 (accepted, not finished)",
        response.headers.get(REQUEST_ID_HEADER),
        202,
      );
    }
    const body = decode(response, [200]);
    // Checked again on the result body: which of the two responses carries the
    // `error_type` is the server's choice, and reading only one of them is how
    // a failure gets returned as a result.
    raiseForCompletion(body, this.requestId, true);
    // A body that is not a JSON object is returned UNCHANGED: the payload is
    // the partner's, and a model whose native output is an array or a bare
    // value is not a malformed response.
    //
    // Always `"json"`: the result route is read through `decode`, which parses
    // the body as a document, so the queued path has no binary branch to reach
    // — `RunResult`'s other arm is produced only by the SYNCHRONOUS route
    // (`finish` in models.ts), which reads `Content-Type` off the generation
    // itself. The discriminant is still written rather than inferred so a
    // caller can narrow one union across both paths.
    //
    // The two alt-provider disclosure headers are read here for the same
    // reason the discriminant is written rather than inferred: one union, both
    // paths, narrowed the same way. They are expected to be absent on this
    // route — the queued `/requests` path takes no `model_provider` parameter,
    // so a queued run cannot address an alternate provider and has nothing to
    // disclose — but reading them keeps the two result shapes identical and
    // means this path needs no edit on the day that route does gain them.
    return {
      kind: "json",
      data: body as TData,
      requestId: response.headers.get(REQUEST_ID_HEADER),
      servingProvider: response.headers.get(FALLBACK_PROVIDER_HEADER),
      droppedParams: parseDroppedParams(response.headers.get(DROPPED_PARAMS_HEADER)),
    };
  }

  /**
   * Ask the server to cancel this request. Sent as `PUT`.
   *
   * A request, not a guarantee. A request that has already completed stays
   * completed, so read the returned update's {@link QueueUpdate.status}, or
   * poll {@link status}, rather than assuming the work stopped. A deployment
   * that answers with no body gives an update whose `status` is `""`; the
   * authoritative state is the next {@link status}.
   */
  async cancel(
    options: { signal?: AbortSignal; timeoutMs?: number | null; retry?: RetryOptions | false } = {},
  ) {
    const response = await send({
      method: "PUT",
      url: queueUrl(MODEL_REQUEST_CANCEL_ROUTE_TEMPLATE, this.model, this.requestId, "handle"),
      signal: options.signal,
      budgetMs: options.timeoutMs === undefined ? null : options.timeoutMs,
      retry: options.retry ?? this.#retry,
      what: "cancel",
    });
    return updateFrom(decode(response, [200, 202, 204]), response, this.requestId, false);
  }

  /**
   * The cleanup cancel `subscribe` issues after its own timeout or an abort.
   *
   * One attempt, no retries, a short bound of its own, and NOT the caller's
   * signal — which is already aborted on the abort path, and would make this
   * cancel fail before it was sent. Every failure is swallowed: the timeout or
   * abort is the failure worth reporting, and a masked one sends the caller
   * looking in the wrong place.
   *
   * @internal
   */
  async cancelBestEffort(): Promise<void> {
    try {
      // `retry: false` is the "one attempt" half and CANCEL_TIMEOUT_MS the
      // short bound; without the first, a cancel answered 500 would climb the
      // caller's whole retry budget after they had stopped waiting.
      await this.cancel({ timeoutMs: CANCEL_TIMEOUT_MS, retry: false, signal: undefined });
    } catch {
      // Deliberately swallowed — see the doc comment.
    }
  }
}

// -- the namespace methods ---------------------------------------------------

/**
 * Queue `model` with `input` and resolve to a handle on the request.
 *
 * Declared as a hoisted `function` rather than a `const`, like its two
 * siblings below. `./models.ts` reads these three at module-EVALUATION time to
 * assemble the frozen `models` namespace, so the form matters the moment
 * anything reintroduces an import cycle between the two files: a hoisted
 * function is initialized at instantiation and readable from either order,
 * where a `const` would be in its temporal dead zone in one of them.
 *
 * See {@link Models.submit} in `./models.ts` for the documented surface.
 */
export async function submit<TData = unknown>(
  model: string,
  input: Record<string, unknown>,
  options: SubmitOptions = {},
): Promise<RequestHandle<TData>> {
  // Credentials first: the whole point of this gate is that a process with
  // none fails at the call site rather than on a round trip.
  requireCredentials();
  parseModelId(model, "submit");
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(
      `models.submit(model, input): input must be the model's native JSON input object, got ${
        Array.isArray(input) ? "array" : String(input === null ? "null" : typeof input)
      }`,
    );
  }
  // Minted once, OUTSIDE the retry loop inside `send`: every attempt of this
  // one logical call sends the SAME key, so a retry after a lost or 5xx-ed
  // response replays the original acceptance rather than queueing — and
  // billing — a second generation. A fresh `submit` mints a fresh key.
  const idempotencyKey = options.idempotencyKey ?? newIdempotencyKey();
  // Everything from here leaves stamped with the key: `send`'s raw transport
  // re-throw carries no request id (comfy-api never minted one for a call that
  // never landed), and the `RouterError` `decode` raises on a non-2xx is a bare
  // `Error` subclass with no `idempotencyKey` of its own — the key is the only
  // value that correlates either failure to the server-side record. `subscribe`
  // reaches this through its own `submit` call and inherits the stamp.
  return stamping(
    idempotencyKey,
    async () => {
      const response = await send({
        method: "POST",
        url: queueUrl(MODEL_REQUESTS_ROUTE_TEMPLATE, model, null, "submit"),
        body: JSON.stringify(input),
        idempotencyKey,
        signal: options.signal,
        budgetMs: options.timeoutMs === undefined ? DEFAULT_SUBMIT_TIMEOUT_MS : options.timeoutMs,
        retry: options.retry ?? {},
        what: "submit",
      });
      const body = decode(response, [200, 201, 202]);
      return new RequestHandle<TData>(model, requestIdOf(body, response), options.retry ?? {});
    },
    {
      // See `models.run`: one `AbortController` shared across concurrent calls
      // rejects every one of them with the SAME `signal.reason`, so the stamp
      // gives this call a private stand-in rather than writing our key onto it.
      callerSignal: options.signal,
    },
  );
}

/**
 * Submit, follow the queue to completion, and resolve to the result.
 *
 * See {@link Models.subscribe} in `./models.ts` for the documented surface.
 */
export async function subscribe<TData = unknown>(
  model: string,
  input: Record<string, unknown>,
  options: SubscribeOptions = {},
): Promise<RunResult<TData>> {
  const timeoutMs = options.timeoutMs ?? null;
  // The clock starts HERE, before the submit, so `timeoutMs` bounds the whole
  // call as documented and not only the polling after it.
  const deadlineAt = timeoutMs === null ? null : Date.now() + timeoutMs;
  const handle = await submit<TData>(model, input, {
    signal: options.signal,
    idempotencyKey: options.idempotencyKey,
    retry: options.retry,
    // `undefined` rather than `null` when this call has no deadline of its
    // own, so the submit keeps DEFAULT_SUBMIT_TIMEOUT_MS: `subscribe` with no
    // `timeoutMs` waits as long as the queue takes, but a submit that never
    // gets an answer at all is still a broken connection, not a slow queue.
    timeoutMs: deadlineAt === null ? undefined : remainingMs(deadlineAt),
  });

  const iterator = handle.events({
    signal: options.signal,
    timeoutMs: remainingMs(deadlineAt),
    retry: options.retry,
  });
  let completion: QueueUpdate | null = null;
  try {
    for (;;) {
      let step: IteratorResult<QueueUpdate, void>;
      // ONLY the iteration is inside this `catch`. A callback is the caller's
      // own code and may fail for reasons that have nothing to do with the
      // wait; cancelling a healthy request on the strength of one would be
      // destructive.
      try {
        step = await iterator.next();
      } catch (exc) {
        if (isWaitEnded(exc, options.signal)) await handle.cancelBestEffort();
        throw exc;
      }
      if (step.done === true) break;
      completion = step.value;
      await options.onQueueUpdate?.(completion);
    }
  } finally {
    // Finalise the generator on every exit — above all the one where the
    // callback threw, which otherwise leaves it suspended. Swallowed for the
    // same reason the cleanup cancel is: this runs while an exception is
    // already on its way out, and a failure here would replace the one the
    // caller needs to see.
    try {
      await iterator.return(undefined);
    } catch {
      // Deliberately ignored — see above.
    }
  }

  return await handle.collect(completion, {
    signal: options.signal,
    budgetMs: remainingMs(deadlineAt),
    retry: options.retry ?? {},
  });
}

/**
 * Did the wait end because `subscribe`'s own deadline ran out, or because the
 * caller aborted it? Those are the two exits that earn a best-effort cancel —
 * a transport failure or a typed router error is not one, since the request
 * may be perfectly healthy and the caller can still reach it by its id.
 */
function isWaitEnded(exc: unknown, callerSignal: AbortSignal | undefined): boolean {
  if (callerSignal?.aborted) return true;
  if (exc instanceof ComfyError && exc.code === "request_timeout") return true;
  return exc instanceof Error && (exc.name === "AbortError" || exc.name === "TimeoutError");
}

/**
 * Rebuild the handle for a request submitted anywhere. Makes NO request.
 *
 * See {@link Models.handle} in `./models.ts` for the documented surface.
 */
export function handle<TData = unknown>(model: string, requestId: string): RequestHandle<TData> {
  parseModelId(model, "handle");
  parseRequestId(requestId, "handle");
  return new RequestHandle<TData>(model, requestId);
}
