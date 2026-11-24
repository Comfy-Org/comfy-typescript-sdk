/**
 * `comfy.realtime` — open a Comfy Router realtime session over a WebSocket.
 *
 * ```ts
 * import { comfy } from "@comfyorg/sdk";
 * import { encode, decode } from "@msgpack/msgpack";
 *
 * comfy.config({ credentials: "comfyui-..." });
 * const session = await comfy.realtime.connect("xai/grok-voice");
 * session.socket.binaryType = "arraybuffer";
 * session.socket.addEventListener("message", (event) => {
 *   if (event.data instanceof ArrayBuffer) console.log(decode(event.data));
 * });
 * session.socket.send(encode(message)); // the model's own message shape
 * ```
 *
 * # Where a session goes
 *
 * Nothing about the route is hardcoded here. Router publishes each realtime
 * model's connection details on its catalog entry, as an optional `realtime`
 * block (absent on HTTP-only models), the same way an HTTP model publishes
 * its contract at `GET /v2/models/{provider}/{model}/openapi.json`:
 *
 * ```json
 * { "connect_url": "/v2/realtime/google/google/genie-4", "method": "GET",
 *   "transport": "websocket", "wire_format": "json",
 *   "auth": ["x-api-key", "comfy-realtime.v1", "comfy-bearer"],
 *   "billing_unit": "per_second", "max_session_seconds": 120 }
 * ```
 *
 * `connect` reads the model's entry, takes `connect_url` as a path on the same
 * host `comfy.models` uses (`http(s)` becomes `ws(s)`), and opens it with the
 * block's `wire_format` and `auth`. Comfy picks the serving leg; a caller never
 * names one, and this module keeps no table of them. A model with no block, or
 * one whose `method`/`transport` is not a WebSocket upgrade this helper can
 * open (a `POST` `session_post` mint, a `webrtc` session), is refused with a
 * typed `ComfyError` built from the catalog data before any socket opens.
 *
 * It is deliberately thin after that: no codec is bundled and there is no
 * unified event model. {@link RealtimeSession.wireFormat} says whether frames
 * are MessagePack binary (bring an encoder such as `@msgpack/msgpack`) or JSON
 * text (`JSON.stringify` / `JSON.parse`).
 *
 * # Auth
 *
 * In Node the upgrade carries `X-API-Key` (the same credential `comfy.models`
 * resolves) and the SDK `User-Agent`. A browser cannot set headers on a
 * WebSocket upgrade, so there a signed-in user's ID token travels as a
 * `comfy-bearer.<token>` subprotocol entry instead ({@link
 * RealtimeConnectOptions.idToken}). Router lifts that entry only when the
 * upgrade carries no `Authorization`/`X-API-Key`, and refuses it unless
 * `comfy-realtime.v1` is offered beside it. Only methods the block's `auth`
 * list names are used, and `comfy-realtime.v1` is offered only when it is
 * listed. A credential is never put in the URL. The catalog read itself sends
 * the same credential as `Authorization: Bearer`, as `comfy.models.list` does.
 *
 * # Refusals
 *
 * A refused upgrade carries the ordinary Router error envelope (`detail`,
 * `error_type`, the `X-Comfy-Error-Type` / `X-Comfy-Request-Id` headers) plus a
 * finer `code`, surfaced as {@link RouterError.refusalCode}. The statuses and
 * codes Router answers an upgrade with (each `code` is prefixed
 * `router.realtime.`):
 *
 * - `426` `upgrade_required` — a plain GET reached the route.
 * - `400` `subprotocol_required` — `comfy-realtime.v1` was not offered.
 * - `401` `unauthorized`.
 * - `402` `insufficient_credits`, `spend_denied`.
 * - `403` `model_unavailable`, `account_blocked`, `insufficient_scope`,
 *   `provider_disabled`.
 * - `404` `model_not_allowed`.
 * - `429` `session_already_live` (one live WebSocket session per workspace),
 *   `concurrency_limit`, `rate_limited` — with `Retry-After`.
 * - `502` `token_mint_failed`, `upstream_refused`.
 * - `503` `shutting_down`, `unpriced`, and `*_unavailable`.
 *
 * Reading that refusal needs a transport that exposes the upgrade response.
 * The `ws` package does, and is used in Node when it is installed (it is an
 * optional peer dependency, imported lazily so a browser bundle never sees
 * it). The WHATWG `WebSocket` does not — a refused upgrade there is a bare
 * `error` and a `1006` close — so on that transport a refusal rejects with
 * {@link RealtimeUpgradeFailed} instead of a typed Router class.
 *
 * # Billing and closes
 *
 * A session is billed in the block's `billing_unit` (per second in v1) up to
 * its `max_session_seconds`; when billing starts depends on the model (Router
 * may wait for the model's first frame rather than the `101`). Router allows
 * one live WebSocket session per workspace, so close a session you are done
 * with — and expect a retryable `429` `session_already_live` for a short while
 * after a close, until Router has released the first session. The codes the
 * broker itself closes with after the `101` are in {@link REALTIME_CLOSE_CODES}.
 *
 * `realtime` lives on the module-level `comfy` namespace only, not on the
 * `Comfy` class, for the reason `comfy.models` does — see `./models.ts`.
 */

import { clampTimerMs } from "../low/dispatcher.js";
import { buildUserAgent } from "../low/index.js";
import { CREDENTIALS_ENV_VAR, requireCredentials, resolveBaseUrl } from "./credentials.js";
import { ComfyError, MissingCredentials, NotFound, RealtimeUpgradeFailed } from "./exceptions.js";
import { fillRoute } from "./modelRoutes.js";
import { CATALOG_ROUTE_TEMPLATE, errorFromResponse, RUN_ROUTE_TEMPLATE } from "./models.js";
import { type HeadersLike, REQUEST_ID_HEADER, RouterError, toRouterError } from "./routerErrors.js";

/** The subprotocol every realtime upgrade must offer; Router selects it on the `101`. */
export const REALTIME_SUBPROTOCOL = "comfy-realtime.v1";

/** Prefix of the subprotocol entry that carries a browser's ID token. */
export const REALTIME_BEARER_SUBPROTOCOL_PREFIX = "comfy-bearer.";

/**
 * Selected close codes the broker sends after the `101`; the list is not
 * exhaustive, since Router passes a valid upstream close code (such as `1001`)
 * through. `1006` is a bare close with no close frame (a dropped connection).
 * They are for reading a close, not for sending one: a WHATWG `WebSocket`
 * throws if the application closes with anything but `1000` or `3000`–`4999`.
 */
export const REALTIME_CLOSE_CODES = Object.freeze({
  /** The model finished, or the Google session reached its cap. */
  normal: 1000,
  /** A client message broke the model's rules; the session is over. */
  policyViolation: 1008,
  /** The model reported an error; the reason text is always "upstream closed the session". */
  upstreamError: 1011,
  /** The server is restarting; open a new session. */
  serviceRestart: 1012,
});

/**
 * Default deadline for a connect, in milliseconds: from the catalog read
 * through the `101` (or to reading a refusal's body). It bounds the handshake
 * only, never the session. Override it per call with `timeoutMs`, or disable it with
 * `null`.
 */
export const DEFAULT_REALTIME_CONNECT_TIMEOUT_MS = 30_000;

/** Largest refusal body read off a failed upgrade; the rest is discarded. */
const MAX_REFUSAL_BODY_BYTES = 64 * 1024;

const MODEL_SEGMENT = /^[a-z0-9._-]+$/;

/**
 * A subprotocol entry is an RFC 6455 token (RFC 7230 `tchar`s). Anything else
 * either throws an opaque `SyntaxError` in the transport or — a comma — splits
 * into two entries on the wire.
 */
const SUBPROTOCOL_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * The `ws` module specifier, held in a variable so a bundler does not try to
 * resolve this optional peer dependency for a browser build that never runs it.
 */
const WS_MODULE = "ws";

/** What every event a {@link RealtimeSocket} dispatches carries, on both transports. */
export interface RealtimeEvent {
  readonly type: string;
}

/**
 * A received frame. A text frame is a `string`. A binary frame depends on
 * `binaryType` and the transport: set `binaryType = "arraybuffer"` and it is
 * an `ArrayBuffer` on both; otherwise the WHATWG `WebSocket` hands back a
 * `Blob` and `ws` a `Buffer` (or `Buffer[]` for `"fragments"`).
 */
export interface RealtimeMessageEvent extends RealtimeEvent {
  readonly data: string | ArrayBuffer | Blob | Uint8Array | Uint8Array[];
}

/** The session ended; {@link REALTIME_CLOSE_CODES} lists the codes the broker sends. */
export interface RealtimeCloseEvent extends RealtimeEvent {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

/**
 * The part of a WebSocket both the `ws` package and the WHATWG `WebSocket`
 * implement — enough to send, receive and close without importing either
 * one's types into this package's public declarations.
 */
export interface RealtimeSocket {
  /** The subprotocol the server selected, or `""`. */
  readonly protocol: string;
  readonly readyState: number;
  binaryType: string;
  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: RealtimeMessageEvent) => void): void;
  addEventListener(type: "close", listener: (event: RealtimeCloseEvent) => void): void;
  addEventListener(type: string, listener: (event: RealtimeEvent) => void): void;
  removeEventListener(type: "message", listener: (event: RealtimeMessageEvent) => void): void;
  removeEventListener(type: "close", listener: (event: RealtimeCloseEvent) => void): void;
  removeEventListener(type: string, listener: (event: RealtimeEvent) => void): void;
}

/** How a realtime session is carried, as the catalog block's `transport` names it. */
export type RealtimeTransport = "websocket" | "websocket_media_frames" | "webrtc" | "session_post";

/** An auth method the catalog block's `auth` list can name. */
export type RealtimeAuthMethod = "x-api-key" | "comfy-realtime.v1" | "comfy-bearer";

/**
 * A model's realtime connection details: the `realtime` block of its Router
 * catalog entry, read by {@link readRealtimeBlock}. Field values are passed
 * through as the server published them — a value this release does not know
 * (a new `transport`, say) is kept, and `connect` refuses it rather than the
 * reader, so the error can name it.
 */
export interface RealtimeConnection {
  /** A path on the Router host (`/v2/realtime/...`), never a full URL. */
  connectUrl: string;
  /** `"GET"` for a WebSocket upgrade, `"POST"` for a session mint. */
  method: "GET" | "POST" | (string & {});
  transport: RealtimeTransport | (string & {});
  /** Frame encoding: MessagePack binary or JSON text. */
  wireFormat: "json" | "msgpack" | (string & {});
  /** The auth methods the route accepts. */
  auth: readonly (RealtimeAuthMethod | (string & {}))[];
  /** Informational: how the session is billed (`"per_second"` in v1). `null` if unnamed. */
  billingUnit: string | null;
  /** Informational: the effective session cap, in seconds. `null` if unnamed. */
  maxSessionSeconds: number | null;
}

export interface RealtimeConnectOptions {
  /**
   * Browser mode: a signed-in user's Firebase ID token, offered as the
   * `comfy-bearer.<token>` subprotocol entry. When set, no `X-API-Key` is
   * sent — Router ignores the token if a credential header is present.
   */
  idToken?: string;
  /**
   * Extra subprotocols to offer after the ones `connect` offers itself. Each must be a
   * distinct non-empty string, and none may be `comfy-realtime.v1` itself or
   * a `comfy-bearer.` entry — pass the token as `idToken` instead. They are
   * offered only: the server must still select `comfy-realtime.v1`.
   */
  protocols?: string[];
  /**
   * Aborts a pending connect (the catalog read or the socket is abandoned and the promise rejects
   * with the abort reason) and, once open, closes the session with `1000`.
   */
  signal?: AbortSignal;
  /**
   * Deadline for the catalog read plus the upgrade, in milliseconds; default
   * {@link DEFAULT_REALTIME_CONNECT_TIMEOUT_MS}. Past it the socket is closed
   * and `connect` rejects with a `ComfyError` whose `code` is
   * `"request_timeout"`. `null` disables it. It never bounds an open session.
   */
  timeoutMs?: number | null;
  /**
   * The WebSocket implementation to use: the `ws` package's class, or any
   * WHATWG `WebSocket` constructor. Default: `ws` when it resolves in Node,
   * else `globalThis.WebSocket`.
   */
  WebSocket?: unknown;
}

export interface RealtimeSession {
  /**
   * The open socket. Send and receive on it directly, in the encoding
   * {@link wireFormat} names. No codec is bundled.
   */
  socket: RealtimeSocket;
  /**
   * The `ws(s)://` URL the session was opened on: the catalog's `connect_url`
   * on the configured Router host. Never carries a credential.
   */
  url: string;
  /** The catalog id, as passed to `connect`. */
  model: string;
  /** From the catalog block: `"msgpack"` (binary frames) or `"json"` (text frames). */
  wireFormat: "msgpack" | "json";
  /** From the catalog block: `"websocket"` or `"websocket_media_frames"`. */
  transport: "websocket" | "websocket_media_frames";
  /** The catalog block the session was opened from, including its informational fields. */
  realtime: RealtimeConnection;
  /**
   * The subprotocol the `101` selected. `comfy-realtime.v1` whenever the
   * block lists it (Router's realtime routes all do today) — `connect` then
   * closes and rejects a session on which the server selected anything else.
   */
  subprotocol: string;
  /**
   * `X-Comfy-Request-Id` off the `101` — the value to quote in a support
   * request — when the transport exposes upgrade response headers (`ws`
   * does); `null` on the WHATWG `WebSocket`, which does not.
   */
  requestId: string | null;
  /**
   * Close the session. Defaults to `1000`. A WHATWG `WebSocket` (a browser's,
   * or Node's built-in one) accepts only `1000` or `3000`–`4999` from the
   * application and throws on anything else, so pass one of those to stay
   * portable: `REALTIME_CLOSE_CODES` other than `normal` are codes the broker
   * sends, not codes to close with.
   */
  close(code?: number, reason?: string): void;
}

/** The `ws` package's class, as far as this module drives it. */
interface WsSocket extends RealtimeSocket {
  on(event: string, listener: (...args: never[]) => void): unknown;
  once(event: string, listener: (...args: never[]) => void): unknown;
  terminate(): void;
}

type WsConstructor = new (
  url: string,
  protocols: string[],
  options: { headers: Record<string, string> },
) => WsSocket;

type WhatwgConstructor = new (url: string, init: unknown) => RealtimeSocket;

/** Just enough of `http.IncomingMessage` to read a refusal off it. */
interface UpgradeResponse {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  destroy(): void;
}

type Transport = { kind: "ws"; ctor: WsConstructor } | { kind: "whatwg"; ctor: WhatwgConstructor };

function isNode(): boolean {
  return typeof process !== "undefined" && typeof process.versions?.node === "string";
}

function isWsConstructor(ctor: unknown): ctor is WsConstructor {
  // `ws` is an EventEmitter; neither a browser's nor undici's WebSocket has `on`.
  // `once` and `terminate` are checked too because the ws path drives both.
  if (typeof ctor !== "function") return false;
  const proto = (ctor as { prototype?: Record<string, unknown> }).prototype;
  return (
    typeof proto?.on === "function" &&
    typeof proto.once === "function" &&
    typeof proto.terminate === "function"
  );
}

/**
 * Split and check a realtime catalog id: two or more `/`-separated segments
 * of `[a-z0-9._-]`, none empty, `.` or `..`. Looser than `parseModelId` in
 * allowing a variant segment, which the catalog lookup then finds by walking
 * the catalog rather than through the two-segment detail route.
 */
function parseRealtimeModelId(model: string): string[] {
  const shape = 'expected a catalog model ID such as "google/genie-4"';
  if (typeof model !== "string") {
    throw new TypeError(`realtime.connect(model): ${shape}, got ${typeof model}`);
  }
  const segments = model.split("/");
  const valid =
    segments.length >= 2 && segments.every((s) => MODEL_SEGMENT.test(s) && s !== "." && s !== "..");
  if (!valid) {
    throw new TypeError(
      `realtime.connect(model): ${shape} — two or more "/"-separated segments of ` +
        `[a-z0-9._-], none "." or ".." — got ${JSON.stringify(model)}`,
    );
  }
  return segments;
}

/** Check `options.protocols`: distinct subprotocol tokens that do not shadow ours. */
function extraProtocols(protocols: unknown): string[] {
  if (protocols === undefined) return [];
  // Copied before it is checked, and the copy is what goes on the wire: the
  // caller's array can still change across the `await` in `connect`.
  const extra: unknown[] = Array.isArray(protocols) ? [...protocols] : [];
  if (
    !Array.isArray(protocols) ||
    !extra.every((p) => typeof p === "string" && SUBPROTOCOL_TOKEN.test(p))
  ) {
    throw new TypeError(
      "realtime.connect: options.protocols must be an array of subprotocol tokens " +
        "(non-empty, no spaces, commas, quotes or other separators)",
    );
  }
  for (const p of extra as string[]) {
    if (p === REALTIME_SUBPROTOCOL || p.startsWith(REALTIME_BEARER_SUBPROTOCOL_PREFIX)) {
      throw new TypeError(
        `realtime.connect: options.protocols must not include "${REALTIME_SUBPROTOCOL}" or a ` +
          `"${REALTIME_BEARER_SUBPROTOCOL_PREFIX}" entry — connect offers the first itself, and ` +
          "the second is options.idToken",
      );
    }
  }
  if (new Set(extra).size !== extra.length) {
    throw new TypeError("realtime.connect: options.protocols must not repeat an entry");
  }
  return extra as string[];
}

const TRANSPORTS_THIS_HELPER_OPENS: ReadonlySet<string> = new Set([
  "websocket",
  "websocket_media_frames",
]);

const WIRE_FORMATS: ReadonlySet<string> = new Set(["json", "msgpack"]);

/** A path on the Router host: one leading `/`; no scheme, host, whitespace, backslash or fragment. */
const CONNECT_PATH = /^\/(?!\/)[^\s\\#]*$/;

function malformedBlock(model: string, what: string, requestId: string | null): ComfyError {
  return new ComfyError(
    `realtime.connect: the catalog entry for "${model}" has a \`realtime\` block ${what}`,
    { code: "unexpected_response", requestId },
  );
}

/**
 * Read the `realtime` block off a Router catalog entry (a `GET /v2/models`
 * item, or a `GET /v2/models/{provider}/{model}` body): `null` when the entry
 * has none — an HTTP-only model — and a {@link RealtimeConnection} otherwise.
 *
 * Checks the block's SHAPE (every field the right JSON type, `connect_url` a
 * path on the Router host) and throws a `ComfyError` with
 * `code: "unexpected_response"` when it is wrong. It does not judge VALUES: a
 * `transport` this release cannot open is returned as-is, for `connect` to
 * refuse by name.
 */
export function readRealtimeBlock(
  entry: unknown,
  model = "this model",
  requestId: string | null = null,
): RealtimeConnection | null {
  if (entry === null || typeof entry !== "object") return null;
  const raw = (entry as { realtime?: unknown }).realtime;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw malformedBlock(model, "that is not an object", requestId);
  }
  const block = raw as Record<string, unknown>;
  for (const field of ["connect_url", "method", "transport", "wire_format"] as const) {
    if (typeof block[field] !== "string" || block[field] === "") {
      throw malformedBlock(model, `without a string \`${field}\``, requestId);
    }
  }
  const connectUrl = block.connect_url as string;
  if (!CONNECT_PATH.test(connectUrl)) {
    throw malformedBlock(
      model,
      `whose \`connect_url\` is not a path on the Router host: ${JSON.stringify(connectUrl)}`,
      requestId,
    );
  }
  const auth = block.auth;
  if (!Array.isArray(auth) || !auth.every((m) => typeof m === "string")) {
    throw malformedBlock(model, "whose `auth` is not an array of strings", requestId);
  }
  const maxSeconds = block.max_session_seconds;
  return {
    connectUrl,
    method: (block.method as string).toUpperCase(),
    transport: block.transport as string,
    wireFormat: block.wire_format as string,
    auth: Object.freeze([...(auth as string[])]),
    billingUnit: typeof block.billing_unit === "string" ? block.billing_unit : null,
    maxSessionSeconds:
      typeof maxSeconds === "number" && Number.isFinite(maxSeconds) ? maxSeconds : null,
  };
}

/** A model whose catalog data says this helper cannot open it. */
function unsupported(
  model: string,
  why: string,
  code: string,
  realtime: RealtimeConnection | null,
  requestId: string | null,
): ComfyError {
  return new ComfyError(`realtime.connect: "${model}" ${why}`, {
    code,
    requestId,
    details: realtime === null ? null : { realtime },
  });
}

/** Where and how the catalog read goes, resolved once per connect. */
interface CatalogEndpoint {
  baseUrl: string;
  authorization: string;
}

async function getJson(
  url: string,
  endpoint: CatalogEndpoint,
  signal: AbortSignal | undefined,
): Promise<{ body: unknown; requestId: string | null }> {
  // `fetch` refuses a URL carrying `user:password@`; the credential travels
  // as the `Authorization` header instead.
  const response = await fetch(withoutUserinfo(url), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${endpoint.authorization}`,
      Accept: "application/json",
      "User-Agent": buildUserAgent(),
    },
    signal,
  });
  const text = await response.text();
  const requestId = response.headers.get(REQUEST_ID_HEADER);
  if (!response.ok) throw errorFromResponse(response, text, null);
  try {
    return { body: JSON.parse(text), requestId };
  } catch (err) {
    throw new ComfyError(
      `realtime.connect: the catalog read returned a ${String(response.status)} whose body is not JSON`,
      { code: "unexpected_response", httpStatus: response.status, requestId, cause: err },
    );
  }
}

/**
 * Fetch `model`'s catalog entry. A two-segment id is one
 * `GET /v2/models/{provider}/{model}`; an id with a variant segment, which
 * that route cannot address, is found by walking `GET /v2/models`.
 */
async function fetchCatalogEntry(
  model: string,
  segments: readonly string[],
  endpoint: CatalogEndpoint,
  signal: AbortSignal | undefined,
): Promise<{ entry: unknown; requestId: string | null }> {
  if (segments.length === 2) {
    const path = fillRoute(RUN_ROUTE_TEMPLATE, { provider: segments[0], model: segments[1] });
    const { body, requestId } = await getJson(endpoint.baseUrl + path, endpoint, signal);
    return { entry: body, requestId };
  }
  const asked = new Set<string>();
  let cursor: string | null = null;
  let requestId: string | null = null;
  for (;;) {
    const url = new URL(endpoint.baseUrl + CATALOG_ROUTE_TEMPLATE);
    if (cursor !== null) url.searchParams.set("cursor", cursor);
    const page = await getJson(url.toString(), endpoint, signal);
    requestId = page.requestId;
    const body = page.body as { data?: unknown; has_more?: unknown; next_cursor?: unknown } | null;
    const data = Array.isArray(body?.data) ? (body.data as unknown[]) : [];
    const found = data.find(
      (item) =>
        item !== null && typeof item === "object" && (item as { id?: unknown }).id === model,
    );
    if (found !== undefined) return { entry: found, requestId };
    const next = typeof body?.next_cursor === "string" ? body.next_cursor : "";
    if (body?.has_more !== true || next === "" || asked.has(next)) break;
    asked.add(next);
    cursor = next;
  }
  throw new NotFound(`realtime.connect: "${model}" is not in the Router model catalog`, {
    code: "model_not_found",
    requestId,
  });
}

/** `connect_url` on the configured Router host, as a `ws(s)://` URL. */
function realtimeUrl(baseUrl: string, connectUrl: string): string {
  return baseUrl.replace(/^http(s?):/i, "ws$1:") + connectUrl;
}

/** `url` without any `user:password@` part. */
function withoutUserinfo(url: string): string {
  const parsed = new URL(url);
  if (parsed.username === "" && parsed.password === "") return url;
  parsed.username = "";
  parsed.password = "";
  return parsed.href;
}

async function selectTransport(injected: unknown): Promise<Transport> {
  if (injected !== undefined) {
    if (typeof injected !== "function") {
      throw new TypeError("realtime.connect: options.WebSocket must be a WebSocket constructor");
    }
    return isWsConstructor(injected)
      ? { kind: "ws", ctor: injected }
      : { kind: "whatwg", ctor: injected as WhatwgConstructor };
  }
  if (isNode()) {
    try {
      // Imported here, never at the top level, and through a variable, so a
      // browser bundle does not pull `ws` in; it is an optional peer dependency.
      const mod = (await import(/* webpackIgnore: true */ /* @vite-ignore */ WS_MODULE)) as {
        WebSocket?: unknown;
        default?: unknown;
      };
      const ctor = mod.WebSocket ?? mod.default;
      if (isWsConstructor(ctor)) return { kind: "ws", ctor };
    } catch (err) {
      // Not installed: fall through to the global WebSocket. An installed `ws`
      // that fails to load is a real fault, not a reason to quietly lose the
      // typed refusals only `ws` can read.
      const code = (err as { code?: unknown } | null)?.code;
      if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") throw err;
    }
  }
  const global = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof global !== "function") {
    throw new ComfyError(
      "realtime.connect: no WebSocket implementation found — install the `ws` package, " +
        "or pass options.WebSocket",
      { code: "realtime_upgrade_failed" },
    );
  }
  return { kind: "whatwg", ctor: global as WhatwgConstructor };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

function headersOf(res: UpgradeResponse): HeadersLike {
  return {
    get(name) {
      const value = res.headers[name.toLowerCase()];
      if (Array.isArray(value)) return value[0] ?? null;
      return value ?? null;
    },
  };
}

/**
 * Buffer a refused upgrade's body (up to the cap) and parse it as JSON, or
 * `null`. `buffered()` parses what has arrived so far, for a body that stalls:
 * a server that wrote the whole envelope but never ended the stream still
 * names its `detail` and `refusalCode`.
 */
function readRefusalBody(res: UpgradeResponse): { body: Promise<unknown>; buffered(): unknown } {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const parse = (): unknown => {
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    try {
      return text.trim() === "" ? null : JSON.parse(text);
    } catch {
      return null;
    }
  };
  const body = new Promise<unknown>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(parse());
    };
    res.on("data", (chunk: Uint8Array) => {
      if (done) return;
      const room = MAX_REFUSAL_BODY_BYTES - size;
      chunks.push(chunk.byteLength > room ? chunk.subarray(0, room) : chunk);
      size += Math.min(chunk.byteLength, room);
      if (size >= MAX_REFUSAL_BODY_BYTES) {
        finish();
        res.destroy();
      }
    });
    res.on("end", finish);
    res.on("close", finish);
    res.on("error", finish);
  });
  return { body, buffered: parse };
}

function upgradeFailed(url: string, detail: string, cause?: unknown): RealtimeUpgradeFailed {
  return new RealtimeUpgradeFailed(`realtime.connect: the WebSocket upgrade to ${url} ${detail}`, {
    code: "realtime_upgrade_failed",
    cause,
  });
}

/** Open on `ws`, which exposes both the `101` and a refusal's status, headers and body. */
function openWithWs(
  ctor: WsConstructor,
  url: string,
  label: string,
  protocols: string[],
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<{ socket: WsSocket; requestId: string | null }> {
  return new Promise((resolve, reject) => {
    const socket = new ctor(url, protocols, { headers });
    let requestId: string | null = null;
    let refusal: UpgradeResponse | undefined;
    let refusalBody: ReturnType<typeof readRefusalBody> | undefined;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    // Once a refusal's status line is in, its status and headers already name
    // the typed class; a body that never finishes only loses the `detail`.
    const refused = (res: UpgradeResponse, body: unknown) =>
      toRouterError(res.statusCode ?? 0, headersOf(res), body);
    // A refusal settled before its body finished keeps whatever had arrived.
    const refusedSoFar = (res: UpgradeResponse) => refused(res, refusalBody?.buffered() ?? null);
    const onAbort = () =>
      settle(() => {
        // A refusal whose body stalls is not torn down by `terminate()`.
        refusal?.destroy();
        socket.terminate();
        reject(refusal ? refusedSoFar(refusal) : abortReason(signal as AbortSignal));
      });

    socket.once("upgrade", (res: UpgradeResponse) => {
      requestId = headersOf(res).get(REQUEST_ID_HEADER);
    });
    socket.once("unexpected-response", (_req: unknown, res: UpgradeResponse) => {
      refusal = res;
      refusalBody = readRefusalBody(res);
      void refusalBody.body.then((body) =>
        settle(() => {
          reject(refused(res, body));
          socket.terminate();
        }),
      );
    });
    socket.once("open", () => settle(() => resolve({ socket, requestId })));
    // Kept attached for the socket's whole life, and a no-op once settled: an
    // EventEmitter with no `error` listener throws, which would crash the
    // process on `terminate()` above, or on a malformed frame after open from
    // a caller that listens only for `close` (which `ws` emits after `error`).
    socket.on("error", (err: Error) =>
      settle(() =>
        reject(
          refusal ? refusedSoFar(refusal) : upgradeFailed(label, `failed: ${err.message}`, err),
        ),
      ),
    );
    socket.once("close", (code: number) =>
      settle(() =>
        reject(
          refusal
            ? refusedSoFar(refusal)
            : upgradeFailed(label, `closed (${String(code)}) before it opened`),
        ),
      ),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Construct a WHATWG `WebSocket`. Node's (undici's) takes a
 * `{ protocols, headers }` init; a standards-only one (a browser's, and the
 * global in Deno, jsdom or an Electron renderer, all of which still define
 * `process.versions.node`) stringifies that object into an invalid protocol
 * token and throws. Such a constructor gets the protocol list instead — which
 * is enough on the `idToken` path, whose only header is the `User-Agent`, but
 * not on the key path, where dropping `X-API-Key` would only buy a `401`.
 */
function constructWhatwg(
  ctor: WhatwgConstructor,
  url: string,
  protocols: string[],
  headers: Record<string, string> | null,
): RealtimeSocket {
  // The standard constructor throws a `SyntaxError` on a URL carrying
  // credentials, which the fallback below would misread as a refused init.
  const parsed = new URL(url);
  if (parsed.username !== "" || parsed.password !== "") {
    throw new TypeError(
      "realtime.connect: this runtime's WebSocket refuses a URL carrying credentials — " +
        "remove the user:password part from the configured Comfy Router base URL",
    );
  }
  if (headers === null) return new ctor(url, protocols);
  try {
    return new ctor(url, { protocols, headers });
  } catch (err) {
    // `connect` has already checked every protocol entry is a valid token, so
    // a `SyntaxError` here is the init object itself being refused. Anything
    // else (a `SecurityError` under a CSP, say) is not about headers at all.
    if ((err as { name?: unknown } | null)?.name !== "SyntaxError") throw err;
    if (!Object.hasOwn(headers, "X-API-Key")) return new ctor(url, protocols);
    throw new MissingCredentials(
      "realtime.connect: this runtime's WebSocket cannot carry the X-API-Key header — " +
        "pass options.idToken, or install the `ws` package (or pass it as options.WebSocket)",
      { code: "missing_credentials", cause: err },
    );
  }
}

/**
 * Open on a WHATWG `WebSocket`. A refused upgrade is indistinguishable from
 * any other failure here — the status is not exposed to script.
 */
function openWithWhatwg(
  ctor: WhatwgConstructor,
  url: string,
  label: string,
  protocols: string[],
  headers: Record<string, string> | null,
  signal: AbortSignal | undefined,
): Promise<RealtimeSocket> {
  return new Promise((resolve, reject) => {
    const socket = constructWhatwg(ctor, url, protocols, headers);
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onOpen = () => settle(() => resolve(socket));
    const unreadable =
      "failed, and this WebSocket transport does not expose the refusal's status" +
      (isNode() ? " — install the `ws` package to get the typed Router error" : "");
    const onError = () => settle(() => reject(upgradeFailed(label, unreadable)));
    const onClose = () => settle(() => reject(upgradeFailed(label, unreadable)));
    const onAbort = () =>
      settle(() => {
        socket.close();
        reject(abortReason(signal as AbortSignal));
      });
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Open a realtime session on `model` (its full catalog id, e.g.
 * `"google/genie-4"` or `"xai/grok-voice"`).
 *
 * Reads the model's catalog entry first and connects to the `connect_url` its
 * `realtime` block names, with that block's `wire_format` and `auth`. Resolves
 * once the `101` is in and the socket is open. Rejects with:
 * - a `ComfyError` with `code: "realtime_unsupported_model"`, before any
 *   socket opens, when the catalog entry has no `realtime` block;
 * - a `ComfyError` with `code: "realtime_unsupported_transport"`, before any
 *   socket opens, when the block's `method`/`transport`/`wire_format` is not
 *   a WebSocket upgrade this helper opens — a `POST` `session_post` mint or a
 *   `webrtc` session; `details.realtime` carries the block;
 * - a `ComfyError` with `code: "realtime_unsupported_auth"` when the block
 *   does not accept the credential in hand (`X-API-Key`, or `idToken`);
 * - the catalog read's own error (a {@link NotFound} for an unknown model, a
 *   `401`, ...), mapped as `comfy.models` maps one;
 * - a `routerErrors` class (with {@link RouterError.refusalCode}) when Router
 *   refused the upgrade and the transport could read why (`ws`);
 * - {@link RealtimeUpgradeFailed} when the upgrade failed and it could not, or
 *   when the socket opened but the server selected a subprotocol other than
 *   `comfy-realtime.v1`;
 * - a `ComfyError` with `code: "request_timeout"` when the catalog read plus
 *   the upgrade outlast `options.timeoutMs` (on `ws`, a refusal whose status
 *   arrived in time but whose body did not still rejects with its typed class);
 * - {@link MissingCredentials} when no credential is available for the
 *   transport in use;
 * - the abort reason when `options.signal` fires first.
 */
export async function connect(
  model: string,
  options: RealtimeConnectOptions = {},
): Promise<RealtimeSession> {
  const segments = parseRealtimeModelId(model);
  if ((options as { provider?: unknown }).provider !== undefined) {
    throw new TypeError(
      "realtime.connect: options.provider is gone — Comfy picks the serving leg, and connect " +
        "reads the route from the model's catalog entry",
    );
  }
  const extra = extraProtocols(options.protocols);
  const { signal, idToken } = options;
  const timeoutMs =
    options.timeoutMs === undefined ? DEFAULT_REALTIME_CONNECT_TIMEOUT_MS : options.timeoutMs;
  if (timeoutMs !== null && !(typeof timeoutMs === "number" && timeoutMs > 0)) {
    throw new TypeError("realtime.connect: options.timeoutMs must be a positive number or null");
  }
  if (
    idToken !== undefined &&
    (typeof idToken !== "string" ||
      idToken === "" ||
      !SUBPROTOCOL_TOKEN.test(REALTIME_BEARER_SUBPROTOCOL_PREFIX + idToken))
  ) {
    throw new TypeError(
      "realtime.connect: options.idToken must be a non-empty string that is valid in a " +
        "subprotocol entry (no whitespace — trim a token read from a file)",
    );
  }
  if (
    signal !== undefined &&
    (typeof signal !== "object" ||
      signal === null ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")
  ) {
    throw new TypeError("realtime.connect: options.signal must be an AbortSignal");
  }
  if (signal?.aborted) throw abortReason(signal);

  // The host and the credential are read together, before the first `await`
  // yields: a `comfy.config` landing in between must not send the newly
  // configured credential to the previously configured host. Both the catalog
  // read and the upgrade go to this pair.
  const baseUrl = resolveBaseUrl();
  let apiKey: string | undefined;
  let noApiKey: unknown;
  if (idToken === undefined) {
    try {
      apiKey = requireCredentials();
    } catch (err) {
      noApiKey = err;
    }
  }
  const transport = await selectTransport(options.WebSocket);
  // Headers reach the server on `ws`, and on Node's own WebSocket; a browser's
  // drops them, which is why it has to authenticate with `idToken`.
  const canSendHeaders = transport.kind === "ws" || isNode();
  if (idToken === undefined) {
    if (!canSendHeaders) {
      throw new MissingCredentials(
        "realtime.connect: a browser must pass options.idToken — a WebSocket upgrade from a " +
          `browser cannot carry the X-API-Key header that comfy.config / ${CREDENTIALS_ENV_VAR} supplies`,
        { code: "missing_credentials" },
      );
    }
    if (apiKey === undefined) throw noApiKey;
  }
  if (signal?.aborted) throw abortReason(signal);

  // Clamped, as in `models.ts`: past ~25 days `AbortSignal.timeout` would fire at once.
  // Rounded up because it also throws a RangeError on a fractional delay.
  const deadline =
    timeoutMs === null ? undefined : AbortSignal.timeout(Math.ceil(clampTimerMs(timeoutMs)));
  const handshakeSignal =
    deadline === undefined ? signal : signal ? AbortSignal.any([signal, deadline]) : deadline;

  let socket: RealtimeSocket;
  let requestId: string | null = null;
  let block: RealtimeConnection;
  let shownUrl = "";
  let offersRealtimeSubprotocol: boolean;
  try {
    const catalog = await fetchCatalogEntry(
      model,
      segments,
      { baseUrl, authorization: idToken ?? (apiKey as string) },
      handshakeSignal,
    );
    const read = readRealtimeBlock(catalog.entry, model, catalog.requestId);
    if (read === null) {
      throw unsupported(
        model,
        "has no `realtime` block in its catalog entry, so Router does not serve it as a " +
          "realtime session",
        "realtime_unsupported_model",
        null,
        catalog.requestId,
      );
    }
    block = read;
    if (
      block.method !== "GET" ||
      !TRANSPORTS_THIS_HELPER_OPENS.has(block.transport) ||
      !WIRE_FORMATS.has(block.wireFormat)
    ) {
      throw unsupported(
        model,
        `is served as ${block.method} ${block.connectUrl} (transport ${JSON.stringify(block.transport)}, ` +
          `wire format ${JSON.stringify(block.wireFormat)}), which is not a WebSocket upgrade ` +
          "realtime.connect can open; use the catalog block in this error's details.realtime",
        "realtime_unsupported_transport",
        block,
        catalog.requestId,
      );
    }

    // Only the methods the block lists are used. Router refuses a bearer entry
    // offered without `comfy-realtime.v1`, so the token path needs both.
    offersRealtimeSubprotocol = block.auth.includes(REALTIME_SUBPROTOCOL);
    let protocols: string[];
    let headers: Record<string, string> | null;
    if (idToken !== undefined) {
      if (!block.auth.includes("comfy-bearer") || !offersRealtimeSubprotocol) {
        throw unsupported(
          model,
          `does not accept an ID token (its catalog auth is ${JSON.stringify(block.auth)}) — ` +
            "connect with an API key instead",
          "realtime_unsupported_auth",
          block,
          catalog.requestId,
        );
      }
      protocols = [REALTIME_SUBPROTOCOL, REALTIME_BEARER_SUBPROTOCOL_PREFIX + idToken, ...extra];
      headers = canSendHeaders ? { "User-Agent": buildUserAgent() } : null;
    } else {
      if (!block.auth.includes("x-api-key")) {
        throw unsupported(
          model,
          `does not accept X-API-Key (its catalog auth is ${JSON.stringify(block.auth)}) — ` +
            "pass options.idToken instead",
          "realtime_unsupported_auth",
          block,
          catalog.requestId,
        );
      }
      protocols = [...(offersRealtimeSubprotocol ? [REALTIME_SUBPROTOCOL] : []), ...extra];
      headers = { "X-API-Key": apiKey as string, "User-Agent": buildUserAgent() };
    }

    const url = realtimeUrl(baseUrl, block.connectUrl);
    // What the session and every error message show: a base URL's
    // `user:password@` part is a credential, and stays off both.
    shownUrl = withoutUserinfo(url);
    if (transport.kind === "ws") {
      const opened = await openWithWs(
        transport.ctor,
        url,
        shownUrl,
        protocols,
        headers ?? {},
        handshakeSignal,
      );
      socket = opened.socket;
      requestId = opened.requestId;
    } else {
      socket = await openWithWhatwg(
        transport.ctor,
        url,
        shownUrl,
        protocols,
        headers,
        handshakeSignal,
      );
    }
  } catch (err) {
    // The caller's abort wins; then a refusal already read as a typed class.
    if (signal?.aborted) throw abortReason(signal);
    if (deadline?.aborted && !(err instanceof RouterError)) {
      const what = shownUrl === "" ? "catalog read" : `WebSocket upgrade to ${shownUrl}`;
      throw new ComfyError(
        `realtime.connect: the ${what} for "${model}" exceeded its ${String(timeoutMs)}ms ` +
          "deadline; raise it with timeoutMs, or pass timeoutMs: null and your own signal",
        { code: "request_timeout", cause: err },
      );
    }
    throw err;
  }

  // The server must select ours when it was offered. Anything else is not the
  // framing `wireFormat` promises — and if it echoed the `comfy-bearer.` entry,
  // `subprotocol` would carry the caller's ID token to whatever logs the session.
  const selectedBearer = socket.protocol.startsWith(REALTIME_BEARER_SUBPROTOCOL_PREFIX);
  if (selectedBearer || (offersRealtimeSubprotocol && socket.protocol !== REALTIME_SUBPROTOCOL)) {
    socket.close(REALTIME_CLOSE_CODES.normal);
    const selected = selectedBearer
      ? "the comfy-bearer entry"
      : socket.protocol === ""
        ? "no subprotocol"
        : JSON.stringify(socket.protocol);
    throw upgradeFailed(
      shownUrl,
      `opened, but the server selected ${selected}, not ${REALTIME_SUBPROTOCOL}`,
    );
  }

  const onAbort = () => socket.close(REALTIME_CLOSE_CODES.normal);
  if (signal !== undefined) {
    signal.addEventListener("abort", onAbort, { once: true });
    socket.addEventListener("close", () => signal.removeEventListener("abort", onAbort));
    // The handshake's own abort listener is gone by now, so an abort that
    // landed while the open promise was settling would otherwise be missed.
    if (signal.aborted) {
      onAbort();
      throw abortReason(signal);
    }
  }

  return {
    socket,
    url: shownUrl,
    model,
    wireFormat: block.wireFormat as "msgpack" | "json",
    transport: block.transport as "websocket" | "websocket_media_frames",
    realtime: block,
    subprotocol: socket.protocol,
    requestId,
    close(code = REALTIME_CLOSE_CODES.normal, reason?: string) {
      // Closed first: `close` throws on a reserved code or an over-long
      // reason, and the caller's signal must still be able to end the session then.
      socket.close(code, reason);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** The `comfy.realtime` namespace. Frozen — it is shared process-wide. */
export const realtime = Object.freeze({ connect });
