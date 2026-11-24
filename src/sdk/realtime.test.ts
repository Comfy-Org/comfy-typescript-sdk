import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket as WsWebSocket, WebSocketServer } from "ws";

import { buildUserAgent } from "../low/index.js";
import { comfy } from "./comfy.js";
import { config } from "./credentials.js";
import { ComfyError, MissingCredentials, NotFound, RealtimeUpgradeFailed } from "./exceptions.js";
import {
  connect,
  DEFAULT_REALTIME_CONNECT_TIMEOUT_MS,
  readRealtimeBlock,
  realtime,
  REALTIME_BEARER_SUBPROTOCOL_PREFIX,
  REALTIME_CLOSE_CODES,
  REALTIME_SUBPROTOCOL,
  type RealtimeSession,
} from "./realtime.js";
import * as routerErrors from "./routerErrors.js";

const CREDENTIAL = "comfyui-realtime-test-key";

const ALL_AUTH = ["x-api-key", "comfy-realtime.v1", "comfy-bearer"];

function entry(id: string, realtimeBlock?: Record<string, unknown>): Record<string, unknown> {
  const [provider, ...rest] = id.split("/");
  return {
    id,
    provider,
    model: rest.join("/"),
    billing: {},
    ...(realtimeBlock === undefined ? {} : { realtime: realtimeBlock }),
  };
}

/**
 * The catalog the stub Router serves: one entry per shape `connect` has to
 * handle. Nothing about a route is known to the client but what is here.
 */
const CATALOG: Record<string, Record<string, unknown>> = Object.fromEntries(
  [
    entry("google/genie-4", {
      connect_url: "/v2/realtime/google/google/genie-4",
      method: "GET",
      transport: "websocket",
      wire_format: "json",
      auth: ALL_AUTH,
      billing_unit: "per_second",
      max_session_seconds: 120,
    }),
    entry("fal-ai/live-avatar", {
      connect_url: "/v2/realtime/fal/fal-ai/live-avatar",
      method: "GET",
      transport: "websocket_media_frames",
      wire_format: "msgpack",
      auth: ALL_AUTH,
      billing_unit: "per_second",
      max_session_seconds: 300,
    }),
    // A variant id: not addressable on the two-segment detail route, so it
    // is found by walking the catalog.
    entry("acme/voice/realtime", {
      connect_url: "/v2/realtime/fal/acme/voice/realtime",
      method: "GET",
      transport: "websocket",
      wire_format: "msgpack",
      auth: ALL_AUTH,
      billing_unit: "per_second",
      max_session_seconds: 600,
    }),
    entry("fish/live-3", {
      connect_url: "/v2/realtime/fish/sessions",
      method: "POST",
      transport: "session_post",
      wire_format: "json",
      auth: ["x-api-key", "comfy-bearer"],
      billing_unit: "per_second",
      max_session_seconds: 900,
    }),
    entry("fal-ai/lingbot-world-2", {
      connect_url: "/v2/realtime/wma/fal",
      method: "POST",
      transport: "webrtc",
      wire_format: "json",
      auth: ["x-api-key"],
      billing_unit: "per_second",
      max_session_seconds: 120,
    }),
    entry("acme/key-only", {
      connect_url: "/v2/realtime/acme/acme/key-only",
      method: "GET",
      transport: "websocket",
      wire_format: "json",
      auth: ["x-api-key"],
    }),
    entry("bfl/flux-2-pro"),
    // Router's catalog id is two segments; `connect_url` keeps the longer
    // live endpoint path.
    entry("xai/grok-voice", {
      connect_url: "/v2/realtime/fal/xai/grok-voice/realtime",
      method: "GET",
      transport: "websocket",
      wire_format: "msgpack",
      auth: ALL_AUTH,
      billing_unit: "per_second",
      max_session_seconds: 600,
    }),
  ].map((e) => [e.id as string, e]),
);

/** Entries per `GET /v2/models` page, small so the walk crosses pages. */
const PAGE_SIZE = 2;

interface Upgrade {
  url: string;
  headers: IncomingMessage["headers"];
}

interface CatalogRequest {
  url: string;
  authorization: string | undefined;
}

interface RouterOptions {
  catalog?: Record<string, Record<string, unknown>>;
  /** Never answer a catalog read. */
  stallCatalog?: boolean;
  /** Take over the upgrade; by default every upgrade is accepted over `ws`. */
  upgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  handleProtocols?: (offered: Set<string>) => string | false;
  onConnection?: (socket: WsWebSocket, req: IncomingMessage) => void;
}

/**
 * A loopback stub Router: serves the catalog (`GET /v2/models` and
 * `GET /v2/models/{provider}/{model}`) and, by default, accepts every
 * WebSocket upgrade over `ws`, recording all of it.
 */
async function startRouter(options: RouterOptions = {}): Promise<{
  baseUrl: string;
  upgrades: Upgrade[];
  closes: number[];
  catalogRequests: CatalogRequest[];
  held: Duplex[];
  close(): Promise<void>;
}> {
  const catalog = options.catalog ?? CATALOG;
  const upgrades: Upgrade[] = [];
  const closes: number[] = [];
  const catalogRequests: CatalogRequest[] = [];
  const held: Duplex[] = [];
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols:
      options.handleProtocols ??
      ((offered) => (offered.has(REALTIME_SUBPROTOCOL) ? REALTIME_SUBPROTOCOL : false)),
  });
  wss.on("headers", (headers) => headers.push("X-Comfy-Request-Id: req-101"));
  wss.on("connection", (socket: WsWebSocket, req: IncomingMessage) => {
    upgrades.push({ url: req.url ?? "", headers: req.headers });
    socket.on("close", (code) => closes.push(code));
    options.onConnection?.(socket, req);
  });

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    catalogRequests.push({ url: req.url ?? "", authorization: req.headers.authorization });
    if (options.stallCatalog) return;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "X-Comfy-Request-Id": "req-catalog",
        ...headers,
      });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://stub");
    if (url.pathname === "/v2/models") {
      const all = Object.values(catalog);
      const start = Number(url.searchParams.get("cursor") ?? "0");
      const data = all.slice(start, start + PAGE_SIZE);
      const more = start + PAGE_SIZE < all.length;
      json(200, {
        data,
        has_more: more,
        next_cursor: more ? String(start + PAGE_SIZE) : null,
        limit: PAGE_SIZE,
      });
      return;
    }
    const match = /^\/v2\/models\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    const found = match ? catalog[`${match[1]}/${match[2]}`] : undefined;
    if (found !== undefined) {
      json(200, found);
      return;
    }
    json(
      404,
      { detail: "Model not found.", error_type: "model_not_found" },
      { "X-Comfy-Error-Type": "model_not_found" },
    );
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    held.push(socket);
    if (options.upgrade) {
      options.upgrade(req, socket, head);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    upgrades,
    closes,
    catalogRequests,
    held,
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        for (const socket of held) socket.destroy();
        server.closeAllConnections();
        wss.close();
        server.close(() => resolve());
      }),
  };
}

/** An upgrade handler that answers with one scripted refusal. */
function refusal(status: number, headers: Record<string, string>, body: string) {
  return (_req: IncomingMessage, socket: Duplex) => {
    const lines = [
      `HTTP/1.1 ${String(status)} Refused`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      `Content-Length: ${String(Buffer.byteLength(body))}`,
      "Connection: close",
      "",
      body,
    ];
    socket.end(lines.join("\r\n"));
  };
}

/** An upgrade handler that takes the upgrade and never answers it. */
const stall = () => {};

const sessions: RealtimeSession[] = [];
const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
  config({ credentials: CREDENTIAL });
});

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  config({ credentials: undefined, baseUrl: undefined });
});

async function router(options?: RouterOptions) {
  const server = await startRouter(options);
  cleanups.push(server.close);
  config({ baseUrl: server.baseUrl });
  return server;
}

const accepting = () => router();

const refusing = (status: number, headers: Record<string, string>, body: string) =>
  router({ upgrade: refusal(status, headers, body) });

const stalling = () => router({ upgrade: stall });

async function open(model: string, options?: Parameters<typeof connect>[1]) {
  const session = await connect(model, { WebSocket: WsWebSocket, ...options });
  sessions.push(session);
  return session;
}

/** A WHATWG-shaped constructor whose handshake always fails, the way a refused upgrade looks there. */
class FailingWhatwgSocket extends EventTarget {
  static constructed = 0;
  readonly protocol = "";
  readonly readyState = 0;
  binaryType = "blob";
  constructor(
    readonly url: string,
    readonly init: unknown,
  ) {
    super();
    FailingWhatwgSocket.constructed += 1;
    setTimeout(() => {
      this.dispatchEvent(new Event("error"));
      this.dispatchEvent(new Event("close"));
    }, 0);
  }
  send(): void {}
  close(): void {}
}

describe("constants", () => {
  it("pins the broker's close codes and the subprotocols", () => {
    expect(REALTIME_CLOSE_CODES).toEqual({
      normal: 1000,
      policyViolation: 1008,
      upstreamError: 1011,
      serviceRestart: 1012,
    });
    expect(Object.isFrozen(REALTIME_CLOSE_CODES)).toBe(true);
    expect(REALTIME_SUBPROTOCOL).toBe("comfy-realtime.v1");
    expect(REALTIME_BEARER_SUBPROTOCOL_PREFIX).toBe("comfy-bearer.");
  });

  it("keeps no client-side serving table", async () => {
    const mod: Record<string, unknown> = await import("./realtime.js");
    expect(mod.REALTIME_SERVING_PROVIDERS).toBeUndefined();
    expect(mod.REALTIME_ROUTE_TEMPLATE).toBeUndefined();
  });

  it("is reachable as comfy.realtime", () => {
    expect(comfy.realtime).toBe(realtime);
    expect(realtime.connect).toBe(connect);
    expect(Object.isFrozen(realtime)).toBe(true);
  });
});

describe("readRealtimeBlock", () => {
  it("reads the documented block", () => {
    expect(readRealtimeBlock(CATALOG["google/genie-4"])).toEqual({
      connectUrl: "/v2/realtime/google/google/genie-4",
      method: "GET",
      transport: "websocket",
      wireFormat: "json",
      auth: ALL_AUTH,
      billingUnit: "per_second",
      maxSessionSeconds: 120,
    });
  });

  it("answers null for an entry without a block", () => {
    expect(readRealtimeBlock(CATALOG["bfl/flux-2-pro"])).toBeNull();
    expect(readRealtimeBlock({ ...CATALOG["bfl/flux-2-pro"], realtime: null })).toBeNull();
    expect(readRealtimeBlock(null)).toBeNull();
  });

  it("keeps a value this release does not know, for connect to refuse by name", () => {
    const block = readRealtimeBlock({
      realtime: {
        connect_url: "/v2/realtime/x",
        method: "GET",
        transport: "carrier_pigeon",
        wire_format: "json",
        auth: [],
      },
    });
    expect(block?.transport).toBe("carrier_pigeon");
    expect(block?.billingUnit).toBeNull();
    expect(block?.maxSessionSeconds).toBeNull();
  });

  it.each([
    ["not an object", "ws"],
    ["no connect_url", { method: "GET", transport: "websocket", wire_format: "json", auth: [] }],
    [
      "a full URL",
      {
        connect_url: "wss://elsewhere.example/v2/realtime/x",
        method: "GET",
        transport: "websocket",
        wire_format: "json",
        auth: [],
      },
    ],
    [
      "a protocol-relative URL",
      {
        connect_url: "//elsewhere.example/x",
        method: "GET",
        transport: "websocket",
        wire_format: "json",
        auth: [],
      },
    ],
    [
      "auth that is not a string array",
      {
        connect_url: "/v2/realtime/x",
        method: "GET",
        transport: "websocket",
        wire_format: "json",
        auth: "x-api-key",
      },
    ],
  ])("refuses a block with %s", (_what, block) => {
    let err: unknown;
    try {
      readRealtimeBlock({ realtime: block }, "acme/x");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ComfyError);
    expect((err as ComfyError).code).toBe("unexpected_response");
  });
});

describe("catalog-driven connect", () => {
  it("opens google/genie-4 on the connect_url its catalog entry names, as JSON", async () => {
    const server = await accepting();
    const session = await open("google/genie-4");
    expect(server.catalogRequests.map((r) => r.url)).toEqual(["/v2/models/google/genie-4"]);
    expect(server.catalogRequests[0].authorization).toBe(`Bearer ${CREDENTIAL}`);
    expect(server.upgrades[0].url).toBe("/v2/realtime/google/google/genie-4");
    expect(session.url).toBe(
      `${server.baseUrl.replace("http:", "ws:")}/v2/realtime/google/google/genie-4`,
    );
    expect(session.wireFormat).toBe("json");
    expect(session.transport).toBe("websocket");
    expect(session.model).toBe("google/genie-4");
    expect(session.realtime.maxSessionSeconds).toBe(120);
    expect(session.realtime.billingUnit).toBe("per_second");
    expect(session).not.toHaveProperty("provider");
  });

  it("opens a fal msgpack model at its connect_url, not its catalog id", async () => {
    const server = await accepting();
    const session = await open("xai/grok-voice");
    expect(server.catalogRequests.map((r) => r.url)).toEqual(["/v2/models/xai/grok-voice"]);
    expect(server.upgrades[0].url).toBe("/v2/realtime/fal/xai/grok-voice/realtime");
    expect(session.wireFormat).toBe("msgpack");
  });

  it("finds a variant id by walking the catalog", async () => {
    const server = await accepting();
    const session = await open("acme/voice/realtime");
    // A variant id is not addressable on the detail route, so the pages are walked.
    expect(server.catalogRequests.map((r) => r.url)).toEqual(["/v2/models", "/v2/models?cursor=2"]);
    expect(server.upgrades[0].url).toBe("/v2/realtime/fal/acme/voice/realtime");
    expect(session.wireFormat).toBe("msgpack");
  });

  it("opens a websocket_media_frames transport as a WebSocket too", async () => {
    const server = await accepting();
    const session = await open("fal-ai/live-avatar");
    expect(server.upgrades[0].url).toBe("/v2/realtime/fal/fal-ai/live-avatar");
    expect(session.transport).toBe("websocket_media_frames");
    expect(session.wireFormat).toBe("msgpack");
  });

  it("follows the catalog when the route moves, with nothing to update client-side", async () => {
    const moved = {
      ...CATALOG,
      "google/genie-4": entry("google/genie-4", {
        connect_url: "/v2/realtime/comfy/google/genie-4",
        method: "GET",
        transport: "websocket",
        wire_format: "json",
        auth: ALL_AUTH,
      }),
    };
    const server = await router({ catalog: moved });
    await open("google/genie-4");
    expect(server.upgrades[0].url).toBe("/v2/realtime/comfy/google/genie-4");
  });

  it.each([
    ["fish/live-3", "POST /v2/realtime/fish/sessions", "session_post"],
    ["fal-ai/lingbot-world-2", "POST /v2/realtime/wma/fal", "webrtc"],
  ])(
    "refuses %s from its catalog block, before any socket opens",
    async (model, where, transport) => {
      const server = await accepting();
      FailingWhatwgSocket.constructed = 0;
      const err = await connect(model, { WebSocket: FailingWhatwgSocket }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ComfyError);
      expect((err as ComfyError).code).toBe("realtime_unsupported_transport");
      expect((err as Error).message).toContain(where);
      expect((err as Error).message).toContain(transport);
      expect((err as ComfyError).details?.realtime).toMatchObject({ transport });
      expect(FailingWhatwgSocket.constructed).toBe(0);
      expect(server.upgrades).toEqual([]);
    },
  );

  it("refuses a model whose catalog entry has no realtime block", async () => {
    const server = await accepting();
    const err = await connect("bfl/flux-2-pro", { WebSocket: WsWebSocket }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ComfyError);
    expect((err as ComfyError).code).toBe("realtime_unsupported_model");
    expect((err as Error).message).toContain("no `realtime` block");
    expect((err as ComfyError).requestId).toBe("req-catalog");
    expect(server.upgrades).toEqual([]);
  });

  it("raises NotFound for a model the catalog does not have", async () => {
    await accepting();
    const err = await connect("acme/nope", { WebSocket: WsWebSocket }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFound);
    expect((err as ComfyError).code).toBe("model_not_found");
  });

  it("raises NotFound for a variant id the catalog walk does not find", async () => {
    await accepting();
    const err = await connect("acme/nope/realtime", { WebSocket: WsWebSocket }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NotFound);
  });

  it("does not offer comfy-realtime.v1 when the block does not list it", async () => {
    const server = await accepting();
    const session = await open("acme/key-only");
    expect(server.upgrades[0].headers["sec-websocket-protocol"]).toBeUndefined();
    expect(server.upgrades[0].headers["x-api-key"]).toBe(CREDENTIAL);
    expect(session.subprotocol).toBe("");
  });

  it("refuses an idToken on a block that does not accept comfy-bearer", async () => {
    const server = await accepting();
    const err = await connect("acme/key-only", { idToken: "tok", WebSocket: WsWebSocket }).catch(
      (e: unknown) => e,
    );
    expect((err as ComfyError).code).toBe("realtime_unsupported_auth");
    expect((err as Error).message).not.toContain("comfy-bearer.tok");
    expect(server.upgrades).toEqual([]);
  });

  it("refuses an API key on a block that does not accept x-api-key", async () => {
    const server = await router({
      catalog: {
        "acme/token-only": entry("acme/token-only", {
          connect_url: "/v2/realtime/acme/acme/token-only",
          method: "GET",
          transport: "websocket",
          wire_format: "json",
          auth: ["comfy-realtime.v1", "comfy-bearer"],
        }),
      },
    });
    const err = await connect("acme/token-only", { WebSocket: WsWebSocket }).catch(
      (e: unknown) => e,
    );
    expect((err as ComfyError).code).toBe("realtime_unsupported_auth");
    expect(server.upgrades).toEqual([]);
  });

  it("refuses options.provider: callers never name a serving leg", async () => {
    await expect(
      connect("google/genie-4", {
        provider: "google",
        WebSocket: FailingWhatwgSocket,
      } as Parameters<typeof connect>[1]),
    ).rejects.toThrow("options.provider");
  });

  it.each(["genie-4", "google/", "Google/genie-4", "a/../b", "a/./b", "a//b", "a/b?c", 42])(
    "rejects the invalid id %j before any request",
    async (model) => {
      FailingWhatwgSocket.constructed = 0;
      await expect(
        connect(model as string, { WebSocket: FailingWhatwgSocket }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(FailingWhatwgSocket.constructed).toBe(0);
    },
  );
});

describe("auth", () => {
  it("sends X-API-Key and the SDK User-Agent, offering only comfy-realtime.v1", async () => {
    const server = await accepting();
    const session = await open("google/genie-4");
    const { headers } = server.upgrades[0];
    expect(headers["x-api-key"]).toBe(CREDENTIAL);
    expect(headers["user-agent"]).toBe(buildUserAgent());
    expect(headers["sec-websocket-protocol"]).toBe("comfy-realtime.v1");
    expect(headers.authorization).toBeUndefined();
    expect(session.url).not.toContain(CREDENTIAL);
    expect(session.subprotocol).toBe("comfy-realtime.v1");
    expect(session.requestId).toBe("req-101");
  });

  it("offers extra protocols after comfy-realtime.v1", async () => {
    const server = await accepting();
    await open("google/genie-4", { protocols: ["x-extra"] });
    expect(server.upgrades[0].headers["sec-websocket-protocol"]).toBe("comfy-realtime.v1,x-extra");
  });

  it("refuses protocols that are not distinct strings, or that shadow ours", async () => {
    for (const protocols of [
      "x-extra",
      [""],
      [1],
      ["x", "x"],
      [REALTIME_SUBPROTOCOL],
      [`${REALTIME_BEARER_SUBPROTOCOL_PREFIX}tok`],
      // A comma would split into a second entry on the wire, shadowing ours.
      [`x, ${REALTIME_BEARER_SUBPROTOCOL_PREFIX}tok`],
      ["my app v1"],
    ]) {
      await expect(
        connect("google/genie-4", {
          protocols: protocols as unknown as string[],
          WebSocket: FailingWhatwgSocket,
        }),
      ).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("sends the protocols as they were when connect was called", async () => {
    const server = await accepting();
    const protocols = ["x-extra"];
    const pending = connect("google/genie-4", { protocols, WebSocket: WsWebSocket });
    // Pushed across the `await` in connect, after the entries were checked.
    protocols.push(`${REALTIME_BEARER_SUBPROTOCOL_PREFIX}tok`);
    sessions.push(await pending);
    expect(server.upgrades[0].headers["sec-websocket-protocol"]).toBe("comfy-realtime.v1,x-extra");
  });

  it("refuses a signal that is not an AbortSignal, before any socket is constructed", async () => {
    FailingWhatwgSocket.constructed = 0;
    await expect(
      connect("google/genie-4", {
        signal: { aborted: false } as unknown as AbortSignal,
        timeoutMs: null,
        WebSocket: FailingWhatwgSocket,
      }),
    ).rejects.toThrow("options.signal must be an AbortSignal");
    expect(FailingWhatwgSocket.constructed).toBe(0);
  });

  it("keeps a base URL's user:password out of the session URL", async () => {
    const server = await accepting();
    config({ baseUrl: server.baseUrl.replace("http://", "http://user:secret@") });
    const session = await open("google/genie-4");
    expect(session.url).not.toContain("secret");
    expect(session.url).toBe(
      `${server.baseUrl.replace("http", "ws")}/v2/realtime/google/google/genie-4`,
    );
  });

  it("names a base URL's credentials on a WHATWG constructor, not MissingCredentials", async () => {
    const server = await accepting();
    config({ baseUrl: server.baseUrl.replace("http://", "http://user:secret@") });
    const err = await connect("google/genie-4", { WebSocket: FailingWhatwgSocket }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toContain("carrying credentials");
    expect((err as Error).message).not.toContain("secret");
  });

  it("sends the credential configured when connect was called, to that call's host", async () => {
    const server = await accepting();
    // The dynamic `import("ws")` yields; reconfiguring in that window must not
    // pair the new credential with the old host.
    const pending = connect("google/genie-4");
    config({ credentials: "comfyui-reconfigured", baseUrl: "http://127.0.0.1:1" });
    sessions.push(await pending);
    expect(server.catalogRequests[0].authorization).toBe(`Bearer ${CREDENTIAL}`);
    expect(server.upgrades[0].headers["x-api-key"]).toBe(CREDENTIAL);
  });

  it("falls back to the protocol list on a standards-only constructor with an idToken", async () => {
    const server = await accepting();
    let attempts = 0;
    // A standards-only WebSocket in a runtime that still defines process.versions.node.
    class StrictWebSocket extends globalThis.WebSocket {
      constructor(url: string, init: unknown) {
        attempts += 1;
        if (!Array.isArray(init)) throw new SyntaxError("invalid subprotocol");
        super(url, init);
      }
    }
    const session = await connect("google/genie-4", { idToken: "tok", WebSocket: StrictWebSocket });
    sessions.push(session);
    expect(attempts).toBe(2);
    expect(server.upgrades[0].headers["sec-websocket-protocol"]).toBe(
      "comfy-realtime.v1, comfy-bearer.tok",
    );
  });

  it("refuses an idToken that is not valid in a subprotocol entry", async () => {
    for (const idToken of ["", "tok\n", "a b", "a,b"]) {
      await expect(
        connect("google/genie-4", { idToken, WebSocket: FailingWhatwgSocket }),
      ).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("rethrows a constructor failure that is not about the init shape", async () => {
    await accepting();
    function CspWebSocket(): never {
      throw new DOMException("blocked by CSP", "SecurityError");
    }
    const err = await connect("google/genie-4", { WebSocket: CspWebSocket }).catch(
      (e: unknown) => e,
    );
    expect(err).not.toBeInstanceOf(MissingCredentials);
    expect((err as DOMException).name).toBe("SecurityError");
  });

  it("raises MissingCredentials on a standards-only constructor in key mode", async () => {
    await accepting();
    class StrictWebSocket extends FailingWhatwgSocket {
      constructor(url: string, init: unknown) {
        if (!Array.isArray(init)) throw new SyntaxError("invalid subprotocol");
        super(url, init);
      }
    }
    await expect(connect("google/genie-4", { WebSocket: StrictWebSocket })).rejects.toBeInstanceOf(
      MissingCredentials,
    );
  });

  it("sends an idToken as the comfy-bearer subprotocol and no credential header", async () => {
    const server = await accepting();
    const session = await open("google/genie-4", { idToken: "tok123" });
    expect(server.catalogRequests[0].authorization).toBe("Bearer tok123");
    const { headers } = server.upgrades[0];
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers["sec-websocket-protocol"]).toBe("comfy-realtime.v1,comfy-bearer.tok123");
    expect(session.subprotocol).toBe("comfy-realtime.v1");
  });

  it("raises MissingCredentials in key mode with nothing configured", async () => {
    config({ credentials: undefined });
    const previous = process.env.COMFY_API_KEY;
    delete process.env.COMFY_API_KEY;
    try {
      await expect(connect("google/genie-4", { WebSocket: WsWebSocket })).rejects.toBeInstanceOf(
        MissingCredentials,
      );
    } finally {
      if (previous !== undefined) process.env.COMFY_API_KEY = previous;
    }
  });

  it("authenticates through Node's global WebSocket too", async () => {
    const server = await accepting();
    const session = await connect("google/genie-4", { WebSocket: globalThis.WebSocket });
    sessions.push(session);
    expect(server.upgrades[0].headers["x-api-key"]).toBe(CREDENTIAL);
    expect(session.subprotocol).toBe("comfy-realtime.v1");
    expect(session.requestId).toBeNull();
  });
});

describe("refusals", () => {
  it("raises the typed InsufficientCredits for a 402, with its refusalCode", async () => {
    await refusing(
      402,
      {
        "Content-Type": "application/json",
        "X-Comfy-Error-Type": "insufficient_credits",
        "X-Comfy-Request-Id": "req-402",
      },
      JSON.stringify({
        detail: "Your workspace is out of credits.",
        error_type: "insufficient_credits",
        code: "router.realtime.insufficient_credits",
      }),
    );
    const err = await connect("google/genie-4").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(routerErrors.InsufficientCredits);
    const routerError = err as routerErrors.RouterError;
    expect(routerError.httpStatus).toBe(402);
    expect(routerError.refusalCode).toBe("router.realtime.insufficient_credits");
    expect(routerError.requestId).toBe("req-402");
    expect(routerError.message).toBe("Your workspace is out of credits.");
  });

  it("raises ConcurrencyLimitExceeded with retryAfter for a 429", async () => {
    await refusing(
      429,
      {
        "Content-Type": "application/json",
        "X-Comfy-Error-Type": "concurrency_limit_exceeded",
        "Retry-After": "7",
      },
      JSON.stringify({
        detail: "A realtime session is already live for this workspace.",
        error_type: "concurrency_limit_exceeded",
        code: "router.realtime.session_already_live",
      }),
    );
    const err = (await connect("xai/grok-voice", { WebSocket: WsWebSocket }).catch(
      (e: unknown) => e,
    )) as routerErrors.RouterError;
    expect(err).toBeInstanceOf(routerErrors.ConcurrencyLimitExceeded);
    expect(err.retryAfter).toBe(7);
    expect(err.refusalCode).toBe("router.realtime.session_already_live");
  });

  it("raises ServiceUnavailable for a bodiless 503 carrying the bucket header", async () => {
    await refusing(503, { "X-Comfy-Error-Type": "service_unavailable" }, "");
    const err = (await connect("google/genie-4", { WebSocket: WsWebSocket }).catch(
      (e: unknown) => e,
    )) as routerErrors.RouterError;
    expect(err).toBeInstanceOf(routerErrors.ServiceUnavailable);
    expect(err.httpStatus).toBe(503);
    expect(err.refusalCode).toBeNull();
  });

  it("raises RealtimeUpgradeFailed from a WHATWG transport that cannot read the refusal", async () => {
    await accepting();
    const err = await connect("google/genie-4", { WebSocket: FailingWhatwgSocket }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RealtimeUpgradeFailed);
    expect((err as ComfyError).code).toBe("realtime_upgrade_failed");
    expect((err as Error).message).toContain("ws");
  });

  it("raises RealtimeUpgradeFailed from Node's global WebSocket on a real refusal", async () => {
    await refusing(402, { "X-Comfy-Error-Type": "insufficient_credits" }, "{}");
    await expect(
      connect("google/genie-4", { WebSocket: globalThis.WebSocket }),
    ).rejects.toBeInstanceOf(RealtimeUpgradeFailed);
  });
});

describe("subprotocol", () => {
  it("closes and rejects a 101 that selected the bearer entry, without echoing the token", async () => {
    const server = await router({
      handleProtocols: (offered) =>
        [...offered].find((p) => p.startsWith("comfy-bearer.")) ?? false,
    });
    const err = await connect("google/genie-4", {
      idToken: "secret-token",
      WebSocket: WsWebSocket,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RealtimeUpgradeFailed);
    expect((err as Error).message).not.toContain("secret-token");
    await expect.poll(() => server.closes).toEqual([1000]);
  });
});

describe("timeout", () => {
  it("applies the 30s default deadline when timeoutMs is omitted", async () => {
    expect(DEFAULT_REALTIME_CONNECT_TIMEOUT_MS).toBe(30_000);
    const { held } = await stalling();
    // Stand in for the 30s clock so the test does not wait it out.
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const requested: number[] = [];
    const deadline = new AbortController();
    AbortSignal.timeout = (ms: number) => {
      requested.push(ms);
      return deadline.signal;
    };
    try {
      const pending = connect("google/genie-4", { WebSocket: WsWebSocket }).catch(
        (e: unknown) => e,
      );
      await expect.poll(() => held.length).toBe(1);
      expect(requested).toEqual([DEFAULT_REALTIME_CONNECT_TIMEOUT_MS]);
      deadline.abort(new DOMException("timed out", "TimeoutError"));
      const err = await pending;
      expect(err).toBeInstanceOf(ComfyError);
      expect((err as ComfyError).code).toBe("request_timeout");
    } finally {
      AbortSignal.timeout = realTimeout;
    }
  });

  it("rounds a fractional timeoutMs up instead of throwing a RangeError", async () => {
    await stalling();
    const err = await connect("google/genie-4", { timeoutMs: 50.5, WebSocket: WsWebSocket }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ComfyError);
    expect((err as ComfyError).code).toBe("request_timeout");
  });

  it("rejects with request_timeout when the server never answers the upgrade", async () => {
    await stalling();
    const err = await connect("google/genie-4", { timeoutMs: 50, WebSocket: WsWebSocket }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ComfyError);
    expect((err as ComfyError).code).toBe("request_timeout");
    expect((err as Error).message).toContain("WebSocket upgrade");
  });

  it("bounds a catalog read that never answers by the same deadline", async () => {
    const server = await router({ stallCatalog: true });
    const err = await connect("google/genie-4", { timeoutMs: 50, WebSocket: WsWebSocket }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ComfyError);
    expect((err as ComfyError).code).toBe("request_timeout");
    expect((err as Error).message).toContain("catalog read");
    expect(server.upgrades).toEqual([]);
  });

  it("rejects with the typed class when a refusal's body stalls past the deadline", async () => {
    await router({
      upgrade: (_req, socket) =>
        socket.write("HTTP/1.1 402 Refused\r\nContent-Length: 100\r\n\r\n{"),
    });
    const started = Date.now();
    const err = await connect("google/genie-4", { timeoutMs: 200, WebSocket: WsWebSocket }).catch(
      (e: unknown) => e,
    );
    // Still bounded by the deadline, but the status line already named the bucket.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(err).toBeInstanceOf(routerErrors.InsufficientCredits);
    expect((err as routerErrors.RouterError).httpStatus).toBe(402);
  });

  it("keeps the refusalCode a stalled refusal had already sent", async () => {
    const body = JSON.stringify({
      detail: "A session is already live.",
      error_type: "concurrency_limit_exceeded",
      code: "router.realtime.session_already_live",
    });
    await router({
      // The whole envelope, under a Content-Length that promises more.
      upgrade: (_req, socket) =>
        socket.write(
          `HTTP/1.1 429 Refused\r\nContent-Length: ${String(body.length + 100)}\r\n\r\n${body}`,
        ),
    });
    const err = await connect("google/genie-4", { timeoutMs: 300, WebSocket: WsWebSocket }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(routerErrors.ConcurrencyLimitExceeded);
    expect((err as routerErrors.RouterError).refusalCode).toBe(
      "router.realtime.session_already_live",
    );
    expect((err as routerErrors.RouterError).message).toBe("A session is already live.");
  });

  it("rejects with the abort reason when the caller aborts during a stalled refusal", async () => {
    await router({
      upgrade: (_req, socket) =>
        socket.write("HTTP/1.1 402 Refused\r\nContent-Length: 100\r\n\r\n{"),
    });
    const controller = new AbortController();
    const pending = connect("google/genie-4", {
      signal: controller.signal,
      timeoutMs: null,
      WebSocket: WsWebSocket,
    });
    setTimeout(() => controller.abort(new Error("gave up")), 100);
    await expect(pending).rejects.toThrow("gave up");
  });

  it("refuses a non-positive timeoutMs", async () => {
    await expect(
      connect("google/genie-4", { timeoutMs: 0, WebSocket: FailingWhatwgSocket }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("abort", () => {
  it("rejects with the abort reason when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      connect("google/genie-4", { signal: controller.signal, WebSocket: FailingWhatwgSocket }),
    ).rejects.toThrow("stop");
  });

  it("rejects a pending connect with the abort reason", async () => {
    // A server that never answers the upgrade keeps the connect pending.
    const { held } = await stalling();
    const controller = new AbortController();
    const pending = connect("google/genie-4", {
      signal: controller.signal,
      WebSocket: WsWebSocket,
    });
    await expect.poll(() => held.length).toBe(1);
    controller.abort(new Error("gave up"));
    await expect(pending).rejects.toThrow("gave up");
  });

  it("rejects with the abort reason during the catalog read", async () => {
    await router({ stallCatalog: true });
    const controller = new AbortController();
    const pending = connect("google/genie-4", {
      signal: controller.signal,
      WebSocket: WsWebSocket,
    });
    setTimeout(() => controller.abort(new Error("gave up early")), 20);
    await expect(pending).rejects.toThrow("gave up early");
  });

  it("closes an open session with 1000", async () => {
    const server = await accepting();
    const controller = new AbortController();
    await open("google/genie-4", { signal: controller.signal });
    controller.abort();
    await expect.poll(() => server.closes).toEqual([1000]);
  });

  it("rejects and closes when the abort lands while the open is settling", async () => {
    const server = await accepting();
    const controller = new AbortController();
    // Registered after connect's own `open` listener, so the abort lands
    // once the handshake has settled but before connect has returned.
    class AbortOnOpen extends WsWebSocket {
      constructor(...args: ConstructorParameters<typeof WsWebSocket>) {
        super(...args);
        queueMicrotask(() => this.once("open", () => controller.abort(new Error("late"))));
      }
    }
    await expect(
      connect("google/genie-4", { signal: controller.signal, WebSocket: AbortOnOpen }),
    ).rejects.toThrow("late");
    await expect.poll(() => server.closes).toEqual([1000]);
  });

  it("leaves the signal able to close the session when close() throws", async () => {
    const server = await accepting();
    const controller = new AbortController();
    const session = await open("google/genie-4", { signal: controller.signal });
    expect(() => session.close(1005)).toThrow();
    controller.abort();
    await expect.poll(() => server.closes).toEqual([1000]);
  });
});

describe("after open", () => {
  it("survives a malformed frame on ws when the caller listens only for close", async () => {
    // A frame with every reserved bit set, which `ws` rejects with `error` then `close`.
    await router({
      onConnection: (_socket, req) => req.socket.write(Buffer.from([0xf1, 0x00])),
    });
    const session = await open("google/genie-4");
    const closed = new Promise<number>((resolve) =>
      session.socket.addEventListener("close", (event) => resolve(event.code)),
    );
    // No close frame arrives, so the close is a bare 1006 — but it arrives
    // instead of an unhandled `error` taking the process down.
    expect(await closed).toBe(1006);
  });

  it("delivers frames that arrived in the same packet as the 101", async () => {
    await router({
      upgrade: (req, socket) => {
        const key = `${String(req.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`;
        const accept = createHash("sha1").update(key).digest("base64");
        const text = (s: string) => Buffer.concat([Buffer.from([0x81, s.length]), Buffer.from(s)]);
        socket.write(
          Buffer.concat([
            Buffer.from(
              "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                `Sec-WebSocket-Accept: ${accept}\r\n` +
                `Sec-WebSocket-Protocol: ${REALTIME_SUBPROTOCOL}\r\n\r\n`,
            ),
            text("greeting"),
            text("second"),
          ]),
        );
      },
    });
    const session = await open("google/genie-4");
    const received: unknown[] = [];
    session.socket.addEventListener("message", (event) => received.push(event.data));
    await expect.poll(() => received).toEqual(["greeting", "second"]);
  });

  it("types a message event's data for the caller", async () => {
    await router({
      onConnection: (socket) => socket.on("message", (data) => socket.send(String(data))),
    });
    const session = await open("google/genie-4");
    const received = new Promise<unknown>((resolve) =>
      session.socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") resolve(JSON.parse(event.data));
      }),
    );
    session.socket.send(JSON.stringify({ hello: "world" }));
    expect(await received).toEqual({ hello: "world" });
  });
});
