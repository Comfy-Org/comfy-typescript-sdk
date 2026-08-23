/**
 * `comfy.models` — run a partner model by its canonical `{provider}/{model}`
 * ID and get its own native output back.
 *
 * ```ts
 * import { comfy } from "@comfyorg/sdk";
 *
 * comfy.config({ credentials: "comfyui-..." });
 * const { data, requestId } = await comfy.models.run("fal-ai/flux-pro", {
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
 */

import { buildUserAgent } from "../low/index.js";
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
 * Override it per call with `timeoutMs`, or disable it with `null` — and
 * prefer passing a `signal` to disabling it, since a request with no deadline
 * at all can hang until the process exits.
 */
export const DEFAULT_RUN_TIMEOUT_MS = 600_000;

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
  /** Abort the call. Composed with the timeout below, so whichever fires
   * first wins. */
  signal?: AbortSignal;
  /**
   * Per-call deadline in milliseconds. Omit for
   * {@link DEFAULT_RUN_TIMEOUT_MS}; pass `null` to disable the deadline
   * entirely.
   */
  timeoutMs?: number | null;
  /**
   * `Idempotency-Key` for this call. One is minted per call when omitted,
   * which is what makes each `run` its own logical call; supply your own to
   * make a retry of a call whose response you lost replay the original
   * instead of running (and billing) the model a second time.
   */
  idempotencyKey?: string;
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

/** A canonical model ID split into the two path segments that address it. */
interface ModelId {
  provider: string;
  model: string;
}

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

function runUrl(baseUrl: string, id: ModelId): string {
  return `${baseUrl}/v1/models/${encodeURIComponent(id.provider)}/${encodeURIComponent(id.model)}`;
}

/**
 * Compose the caller's signal with this call's deadline. `undefined` means
 * "no deadline and no caller signal", which is the only case where the
 * request runs unbounded.
 */
function resolveSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | null | undefined,
): AbortSignal | undefined {
  const effective = timeoutMs === undefined ? DEFAULT_RUN_TIMEOUT_MS : timeoutMs;
  if (effective === null) return callerSignal;
  const timeoutSignal = AbortSignal.timeout(effective);
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
function errorFromResponse(response: Response, bodyText: string): ComfyError {
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
  const signal = resolveSignal(options.signal, options.timeoutMs);
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        // Sent on every call. The server records the first response against
        // this key and replays it for a repeat, so a retry of a call whose
        // response was lost cannot run the model — or bill for it — twice.
        "Idempotency-Key": options.idempotencyKey ?? newIdempotencyKey(),
        "User-Agent": buildUserAgent(),
      },
      body: JSON.stringify(input),
      signal,
    });
    // Inside the same `try` as the fetch on purpose: the deadline covers body
    // consumption too, so a signal that fires while the result is still
    // streaming rejects HERE, and translating it in only one of the two
    // places would leak a bare DOMException out of the other.
    text = await response.text();
  } catch (exc) {
    if (isTimeout(exc, options.signal)) {
      const budget = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
      throw new ComfyError(
        `models.run("${model}") exceeded its ${String(budget)}ms deadline before the model finished; ` +
          "raise it with timeoutMs, or pass timeoutMs: null and your own signal",
        { code: "request_timeout", cause: exc },
      );
    }
    throw exc;
  }

  const requestId = response.headers.get(REQUEST_ID_HEADER);
  if (!response.ok) throw errorFromResponse(response, text);

  // A 202 is a task handle, not a result. This route is the synchronous one,
  // so a 202 here means the response is not the finished generation the
  // return type promises — surfacing that is the point, since handing back a
  // handle typed as a result is a silent failure a caller would only discover
  // in production.
  if (response.status === 202) {
    throw new ComfyError(
      `models.run("${model}") received a 202 (accepted, not finished) where a completed result was expected`,
      { code: "unexpected_response", httpStatus: 202, requestId },
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (exc) {
    throw new ComfyError(
      `models.run("${model}") returned a ${String(response.status)} whose body is not JSON`,
      { code: "unexpected_response", httpStatus: response.status, requestId, cause: exc },
    );
  }
  return { data: data as TData, requestId };
}

/** The `comfy.models` namespace. Frozen — it is shared process-wide. */
export const models: Models = Object.freeze({ run });
