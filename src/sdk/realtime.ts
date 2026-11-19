/**
 * `comfy.realtime` — open a Comfy Router realtime session over a WebSocket.
 *
 * ```ts
 * import { comfy } from "@comfyorg/sdk";
 * import { encode, decode } from "@msgpack/msgpack";
 *
 * comfy.config({ credentials: "comfyui-..." });
 * const session = await comfy.realtime.connect("xai/grok-voice/realtime");
 * session.socket.binaryType = "arraybuffer";
 * session.socket.addEventListener("message", (event) => {
 *   if (event.data instanceof ArrayBuffer) console.log(decode(event.data));
 * });
 * session.socket.send(encode(message)); // the model's own message shape
 * ```
 *
 * Router serves its realtime models as a WebSocket upgrade at
 * `GET /v2/realtime/{serving}/{model}`. This module does the three things an
 * integrator otherwise hand-rolls — build that URL, authenticate the upgrade
 * the way Router expects, and turn a refused upgrade into the typed
 * `routerErrors` class — and then hands back the raw socket. It is deliberately
 * thin: no codec is bundled and there is no unified event model. A session on
 * the `fal` serving leg speaks MessagePack binary frames (bring an encoder such
 * as `@msgpack/msgpack`); a session on the `google` leg speaks JSON text frames
 * (`JSON.stringify` / `JSON.parse`). {@link RealtimeSession.wireFormat} says
 * which.
 *
 * # Auth
 *
 * In Node the upgrade carries `X-API-Key` (the same credential `comfy.models`
 * resolves) and the SDK `User-Agent`. A browser cannot set headers on a
 * WebSocket upgrade, so there a signed-in user's ID token travels as a
 * `comfy-bearer.<token>` subprotocol entry instead ({@link
 * RealtimeConnectOptions.idToken}). Router lifts that entry only when the
 * upgrade carries no `Authorization`/`X-API-Key`, and refuses it unless
 * `comfy-realtime.v1` is offered beside it — which this module always does. A
 * credential is never put in the URL.
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
 * A session is billed per second from the `101`, and Router allows one live
 * WebSocket session per workspace, so close a session you are done with. After
 * the `101` the broker ends a session only with the codes in
 * {@link REALTIME_CLOSE_CODES}.
 *
 * `realtime` lives on the module-level `comfy` namespace only, not on the
 * `Comfy` class, for the reason `comfy.models` does — see `./models.ts`.
 */

import { clampTimerMs } from "../low/dispatcher.js";
import { buildUserAgent } from "../low/index.js";
import { CREDENTIALS_ENV_VAR, requireCredentials, resolveBaseUrl } from "./credentials.js";
import { ComfyError, MissingCredentials, RealtimeUpgradeFailed } from "./exceptions.js";
import { fillRoute } from "./modelRoutes.js";
import { type HeadersLike, REQUEST_ID_HEADER, toRouterError } from "./routerErrors.js";

/** The subprotocol every realtime upgrade must offer; Router selects it on the `101`. */
export const REALTIME_SUBPROTOCOL = "comfy-realtime.v1";

/** Prefix of the subprotocol entry that carries a browser's ID token. */
export const REALTIME_BEARER_SUBPROTOCOL_PREFIX = "comfy-bearer.";

/**
 * The realtime route. `{model}` is the WHOLE catalog id, slashes included, so
 * `xai/grok-voice/realtime` on the `fal` leg is
 * `/v2/realtime/fal/xai/grok-voice/realtime`.
 */
export const REALTIME_ROUTE_TEMPLATE = "/v2/realtime/{provider}/{model}";

/**
 * Close codes the broker sends after the `101`. Any other code a client sees —
 * notably `1006` — is a bare close with no close frame (a dropped connection).
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

/** The serving legs the WebSocket broker relays to. */
export type RealtimeProvider = "fal" | "google";

/**
 * Catalog ids served on a leg other than the default `fal` one. A model not
 * listed here is addressed on `fal`; {@link RealtimeConnectOptions.provider}
 * overrides the lookup for a model this release does not know about yet.
 */
export const REALTIME_SERVING_PROVIDERS: Readonly<Record<string, RealtimeProvider>> = Object.freeze(
  {
    "google/genie-4": "google",
  },
);

const DEFAULT_SERVING_PROVIDER: RealtimeProvider = "fal";

/**
 * Realtime catalog ids that are NOT served by the WebSocket broker, and where
 * each one is served instead. Refused before any socket opens, because the
 * broker's answer for them would be a refusal that does not say where to go.
 */
const NOT_ON_THE_BROKER: Readonly<Record<string, string>> = Object.freeze({
  "fal-ai/lingbot-world-2":
    "served over WebRTC signalling, POST /v2/realtime/wma/fal, not the WebSocket broker",
  "fal-ai/abot-world-0":
    "served over WebRTC signalling, POST /v2/realtime/wma/fal, not the WebSocket broker",
  "fish/live-3":
    "served as a LiveKit session minted by POST /v2/realtime/fish/sessions, not the WebSocket broker",
});

/**
 * Default deadline for the upgrade, in milliseconds: from opening the socket
 * to the `101` (or to reading a refusal's body). It bounds the handshake only,
 * never the session. Override it per call with `timeoutMs`, or disable it with
 * `null`.
 */
export const DEFAULT_REALTIME_CONNECT_TIMEOUT_MS = 30_000;

/** Largest refusal body read off a failed upgrade; the rest is discarded. */
const MAX_REFUSAL_BODY_BYTES = 64 * 1024;

const MODEL_SEGMENT = /^[a-z0-9._-]+$/;

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

export interface RealtimeConnectOptions {
  /**
   * Browser mode: a signed-in user's Firebase ID token, offered as the
   * `comfy-bearer.<token>` subprotocol entry. When set, no `X-API-Key` is
   * sent — Router ignores the token if a credential header is present.
   */
  idToken?: string;
  /** Override the serving leg; by default it is looked up in {@link REALTIME_SERVING_PROVIDERS}. */
  provider?: RealtimeProvider;
  /**
   * Extra subprotocols to offer after `comfy-realtime.v1`. Each must be a
   * distinct non-empty string, and none may be `comfy-realtime.v1` itself or
   * a `comfy-bearer.` entry — pass the token as `idToken` instead. They are
   * offered only: the server must still select `comfy-realtime.v1`.
   */
  protocols?: string[];
  /**
   * Aborts a pending connect (the socket is closed and the promise rejects
   * with the abort reason) and, once open, closes the session with `1000`.
   */
  signal?: AbortSignal;
  /**
   * Deadline for the upgrade, in milliseconds; default
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
   * The open socket. Send and receive on it directly; frames are
   * MessagePack binary on a `fal` session and JSON text on a `google` one
   * (see {@link wireFormat}). No codec is bundled.
   */
  socket: RealtimeSocket;
  /** The `ws(s)://` URL the session was opened on. Never carries a credential. */
  url: string;
  provider: RealtimeProvider;
  /** The catalog id, as passed to `connect`. */
  model: string;
  /** `"json"` on the `google` leg, `"msgpack"` on the `fal` leg. */
  wireFormat: "msgpack" | "json";
  /**
   * The subprotocol the `101` selected: always `comfy-realtime.v1`, which is
   * what Router selects — `connect` closes and rejects a session on which
   * the server selected anything else.
   */
  subprotocol: string;
  /**
   * `X-Comfy-Request-Id` off the `101` — the value to quote in a support
   * request — when the transport exposes upgrade response headers (`ws`
   * does); `null` on the WHATWG `WebSocket`, which does not.
   */
  requestId: string | null;
  /** Close the session. Defaults to `1000`. */
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
  return (
    typeof ctor === "function" &&
    typeof (ctor as { prototype?: { on?: unknown } }).prototype?.on === "function"
  );
}

/**
 * Split and check a realtime catalog id: two or more `/`-separated segments
 * of `[a-z0-9._-]`, none empty, `.` or `..`. Stricter than `parseModelId`
 * because the id is pasted into the path whole, slashes and all — every
 * segment must be safe to place there unencoded.
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

/** Check `options.protocols`: distinct non-empty strings that do not shadow ours. */
function extraProtocols(protocols: unknown): string[] {
  if (protocols === undefined) return [];
  if (!Array.isArray(protocols) || !protocols.every((p) => typeof p === "string" && p !== "")) {
    throw new TypeError(
      "realtime.connect: options.protocols must be an array of non-empty strings",
    );
  }
  const extra = protocols as string[];
  for (const p of extra) {
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
  return extra;
}

function refuseUnservedModel(model: string): void {
  const where = Object.hasOwn(NOT_ON_THE_BROKER, model)
    ? NOT_ON_THE_BROKER[model]
    : model.startsWith("reactor/")
      ? "not served by Comfy Router's realtime surface"
      : undefined;
  if (where !== undefined) {
    throw new ComfyError(`realtime.connect: "${model}" is ${where}`, {
      code: "realtime_unsupported_model",
    });
  }
}

function servingProvider(model: string, override: RealtimeProvider | undefined): RealtimeProvider {
  if (override !== undefined) {
    if (override !== "fal" && override !== "google") {
      throw new TypeError(
        `realtime.connect: options.provider must be "fal" or "google", got ${JSON.stringify(override)}`,
      );
    }
    return override;
  }
  return Object.hasOwn(REALTIME_SERVING_PROVIDERS, model)
    ? REALTIME_SERVING_PROVIDERS[model]
    : DEFAULT_SERVING_PROVIDER;
}

/** The `ws(s)://` URL for `model` on `provider`, against the configured Router host. */
function realtimeUrl(provider: RealtimeProvider, segments: readonly string[]): string {
  // `fillRoute` encodes a `/` inside a value, so the model's own slashes are
  // spliced in first; each segment is already restricted to characters that
  // need no encoding.
  const path = fillRoute(REALTIME_ROUTE_TEMPLATE.replace("{model}", segments.join("/")), {
    provider,
  });
  return resolveBaseUrl().replace(/^http(s?):/i, "ws$1:") + path;
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
      // Imported here, never at the top level, so a browser bundle does not
      // pull `ws` in; it is an optional peer dependency.
      const mod = (await import("ws")) as unknown as { WebSocket?: unknown; default?: unknown };
      const ctor = mod.WebSocket ?? mod.default;
      if (isWsConstructor(ctor)) return { kind: "ws", ctor };
    } catch {
      // Not installed: fall through to the global WebSocket.
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

/** Buffer a refused upgrade's body (up to the cap) and parse it as JSON, or `null`. */
function readRefusalBody(res: UpgradeResponse): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const text = new TextDecoder().decode(Buffer.concat(chunks));
      try {
        resolve(text.trim() === "" ? null : JSON.parse(text));
      } catch {
        resolve(null);
      }
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
  protocols: string[],
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<{ socket: WsSocket; requestId: string | null }> {
  return new Promise((resolve, reject) => {
    const socket = new ctor(url, protocols, { headers });
    let requestId: string | null = null;
    let refusal: UpgradeResponse | undefined;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () =>
      settle(() => {
        // A refusal whose body stalls is not torn down by `terminate()`.
        refusal?.destroy();
        socket.terminate();
        reject(abortReason(signal as AbortSignal));
      });

    socket.once("upgrade", (res: UpgradeResponse) => {
      requestId = headersOf(res).get(REQUEST_ID_HEADER);
    });
    socket.once("unexpected-response", (_req: unknown, res: UpgradeResponse) => {
      refusal = res;
      void readRefusalBody(res).then((body) =>
        settle(() => {
          reject(toRouterError(res.statusCode ?? 0, headersOf(res), body));
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
      settle(() => reject(upgradeFailed(url, `failed: ${err.message}`, err))),
    );
    socket.once("close", (code: number) =>
      settle(() => reject(upgradeFailed(url, `closed (${String(code)}) before it opened`))),
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
  if (headers === null) return new ctor(url, protocols);
  try {
    return new ctor(url, { protocols, headers });
  } catch (err) {
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
    const onError = () => settle(() => reject(upgradeFailed(url, unreadable)));
    const onClose = () => settle(() => reject(upgradeFailed(url, unreadable)));
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
 * `"google/genie-4"` or `"xai/grok-voice/realtime"`).
 *
 * Resolves once the `101` is in and the socket is open. Rejects with:
 * - a `routerErrors` class (with {@link RouterError.refusalCode}) when Router
 *   refused the upgrade and the transport could read why (`ws`);
 * - {@link RealtimeUpgradeFailed} when the upgrade failed and it could not;
 * - a `ComfyError` with `code: "realtime_unsupported_model"`, before any
 *   socket opens, for a realtime model served somewhere other than the
 *   WebSocket broker — the message names where (skipped when
 *   `options.provider` names the leg explicitly);
 * - {@link RealtimeUpgradeFailed} too when the socket opened but the server
 *   selected a subprotocol other than `comfy-realtime.v1`;
 * - a `ComfyError` with `code: "request_timeout"` when the upgrade outlasts
 *   `options.timeoutMs`;
 * - {@link MissingCredentials} when no credential is available for the
 *   transport in use;
 * - the abort reason when `options.signal` fires first.
 */
export async function connect(
  model: string,
  options: RealtimeConnectOptions = {},
): Promise<RealtimeSession> {
  const segments = parseRealtimeModelId(model);
  // An explicit serving leg is trusted as-is: it is the escape hatch for the
  // day the broker starts serving one of those models.
  if (options.provider === undefined) refuseUnservedModel(model);
  const provider = servingProvider(model, options.provider);
  const extra = extraProtocols(options.protocols);
  const { signal, idToken } = options;
  const timeoutMs =
    options.timeoutMs === undefined ? DEFAULT_REALTIME_CONNECT_TIMEOUT_MS : options.timeoutMs;
  if (timeoutMs !== null && !(typeof timeoutMs === "number" && timeoutMs > 0)) {
    throw new TypeError("realtime.connect: options.timeoutMs must be a positive number or null");
  }
  if (idToken !== undefined && (typeof idToken !== "string" || idToken === "")) {
    throw new TypeError("realtime.connect: options.idToken must be a non-empty string");
  }
  if (signal?.aborted) throw abortReason(signal);

  // The host and the credential are read together, before the `await` below
  // yields: a `comfy.config` landing in between must not send the newly
  // configured credential to the previously configured host.
  const url = realtimeUrl(provider, segments);
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

  let protocols: string[];
  let headers: Record<string, string> | null;
  if (idToken !== undefined) {
    protocols = [REALTIME_SUBPROTOCOL, REALTIME_BEARER_SUBPROTOCOL_PREFIX + idToken, ...extra];
    headers = canSendHeaders ? { "User-Agent": buildUserAgent() } : null;
  } else {
    if (!canSendHeaders) {
      throw new MissingCredentials(
        "realtime.connect: a browser must pass options.idToken — a WebSocket upgrade from a " +
          `browser cannot carry the X-API-Key header that comfy.config / ${CREDENTIALS_ENV_VAR} supplies`,
        { code: "missing_credentials" },
      );
    }
    if (apiKey === undefined) throw noApiKey;
    protocols = [REALTIME_SUBPROTOCOL, ...extra];
    headers = { "X-API-Key": apiKey, "User-Agent": buildUserAgent() };
  }
  if (signal?.aborted) throw abortReason(signal);

  // Clamped, as in `models.ts`: past ~25 days `AbortSignal.timeout` would fire at once.
  const deadline = timeoutMs === null ? undefined : AbortSignal.timeout(clampTimerMs(timeoutMs));
  const handshakeSignal =
    deadline === undefined ? signal : signal ? AbortSignal.any([signal, deadline]) : deadline;
  let socket: RealtimeSocket;
  let requestId: string | null = null;
  try {
    if (transport.kind === "ws") {
      const opened = await openWithWs(
        transport.ctor,
        url,
        protocols,
        headers ?? {},
        handshakeSignal,
      );
      socket = opened.socket;
      requestId = opened.requestId;
    } else {
      socket = await openWithWhatwg(transport.ctor, url, protocols, headers, handshakeSignal);
    }
  } catch (err) {
    if (deadline?.aborted && !signal?.aborted) {
      throw new ComfyError(
        `realtime.connect: the WebSocket upgrade to ${url} exceeded its ${String(timeoutMs)}ms ` +
          "deadline; raise it with timeoutMs, or pass timeoutMs: null and your own signal",
        { code: "request_timeout", cause: err },
      );
    }
    throw err;
  }

  // The server must select ours. Anything else is not the framing `wireFormat`
  // promises — and if it echoed the `comfy-bearer.` entry, `subprotocol` would
  // carry the caller's ID token to whatever logs the session.
  if (socket.protocol !== REALTIME_SUBPROTOCOL) {
    socket.close(REALTIME_CLOSE_CODES.normal);
    const selected = socket.protocol.startsWith(REALTIME_BEARER_SUBPROTOCOL_PREFIX)
      ? "the comfy-bearer entry"
      : socket.protocol === ""
        ? "no subprotocol"
        : JSON.stringify(socket.protocol);
    throw upgradeFailed(
      url,
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
    url,
    provider,
    model,
    wireFormat: provider === "google" ? "json" : "msgpack",
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
