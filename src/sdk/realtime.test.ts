import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket as WsWebSocket, WebSocketServer } from "ws";

import { buildUserAgent } from "../low/index.js";
import { comfy } from "./comfy.js";
import { config } from "./credentials.js";
import { ComfyError, MissingCredentials, RealtimeUpgradeFailed } from "./exceptions.js";
import {
  connect,
  DEFAULT_REALTIME_CONNECT_TIMEOUT_MS,
  realtime,
  REALTIME_BEARER_SUBPROTOCOL_PREFIX,
  REALTIME_CLOSE_CODES,
  REALTIME_ROUTE_TEMPLATE,
  REALTIME_SERVING_PROVIDERS,
  REALTIME_SUBPROTOCOL,
  type RealtimeSession,
} from "./realtime.js";
import * as routerErrors from "./routerErrors.js";

const CREDENTIAL = "comfyui-realtime-test-key";

interface Upgrade {
  url: string;
  headers: IncomingMessage["headers"];
}

/** A loopback `ws` server that accepts every upgrade and records it. */
async function startAcceptingServer(): Promise<{
  baseUrl: string;
  upgrades: Upgrade[];
  closes: number[];
  close(): Promise<void>;
}> {
  const upgrades: Upgrade[] = [];
  const closes: number[] = [];
  const wss = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    handleProtocols: (offered) =>
      offered.has(REALTIME_SUBPROTOCOL) ? REALTIME_SUBPROTOCOL : false,
  });
  wss.on("headers", (headers) => headers.push("X-Comfy-Request-Id: req-101"));
  wss.on("connection", (socket, req) => {
    upgrades.push({ url: req.url ?? "", headers: req.headers });
    socket.on("close", (code) => closes.push(code));
  });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const { port } = wss.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    upgrades,
    closes,
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}

/** A plain HTTP server that answers every upgrade with one scripted refusal. */
async function startRefusingServer(
  status: number,
  headers: Record<string, string>,
  body: string,
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server: Server = createServer();
  server.on("upgrade", (_req: IncomingMessage, socket: Duplex) => {
    const lines = [
      `HTTP/1.1 ${String(status)} Refused`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      `Content-Length: ${String(Buffer.byteLength(body))}`,
      "Connection: close",
      "",
      body,
    ];
    socket.end(lines.join("\r\n"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

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

async function accepting() {
  const server = await startAcceptingServer();
  cleanups.push(server.close);
  config({ baseUrl: server.baseUrl });
  return server;
}

async function refusing(status: number, headers: Record<string, string>, body: string) {
  const server = await startRefusingServer(status, headers, body);
  cleanups.push(server.close);
  config({ baseUrl: server.baseUrl });
  return server;
}

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
  it("pins the broker's close codes and the route", () => {
    expect(REALTIME_CLOSE_CODES).toEqual({
      normal: 1000,
      policyViolation: 1008,
      upstreamError: 1011,
      serviceRestart: 1012,
    });
    expect(Object.isFrozen(REALTIME_CLOSE_CODES)).toBe(true);
    expect(REALTIME_ROUTE_TEMPLATE).toBe("/v2/realtime/{provider}/{model}");
    expect(REALTIME_SUBPROTOCOL).toBe("comfy-realtime.v1");
    expect(REALTIME_BEARER_SUBPROTOCOL_PREFIX).toBe("comfy-bearer.");
  });

  it("serves genie-4 on the google leg and nothing else off the default", () => {
    expect(REALTIME_SERVING_PROVIDERS).toEqual({ "google/genie-4": "google" });
    expect(Object.isFrozen(REALTIME_SERVING_PROVIDERS)).toBe(true);
  });

  it("is reachable as comfy.realtime", () => {
    expect(comfy.realtime).toBe(realtime);
    expect(realtime.connect).toBe(connect);
    expect(Object.isFrozen(realtime)).toBe(true);
  });
});

describe("the session URL", () => {
  it("interpolates genie-4 whole after the google serving segment", async () => {
    const server = await accepting();
    const session = await open("google/genie-4");
    expect(server.upgrades[0].url).toBe("/v2/realtime/google/google/genie-4");
    expect(session.url).toBe(
      `${server.baseUrl.replace("http:", "ws:")}/v2/realtime/google/google/genie-4`,
    );
    expect(session.provider).toBe("google");
    expect(session.wireFormat).toBe("json");
    expect(session.model).toBe("google/genie-4");
  });

  it("puts a three-segment id on the default fal leg", async () => {
    const server = await accepting();
    const session = await open("xai/grok-voice/realtime");
    expect(server.upgrades[0].url).toBe("/v2/realtime/fal/xai/grok-voice/realtime");
    expect(session.provider).toBe("fal");
    expect(session.wireFormat).toBe("msgpack");
  });

  it("lets options.provider override the serving table", async () => {
    const server = await accepting();
    const session = await open("acme/new-voice", { provider: "google" });
    expect(server.upgrades[0].url).toBe("/v2/realtime/google/acme/new-voice");
    expect(session.wireFormat).toBe("json");
  });

  it.each([
    ["fal-ai/lingbot-world-2", "POST /v2/realtime/wma/fal"],
    ["fal-ai/abot-world-0", "POST /v2/realtime/wma/fal"],
    ["fish/live-3", "POST /v2/realtime/fish/sessions"],
    ["reactor/anything", "not served"],
  ])("refuses %s client-side, naming where it is served", async (model, where) => {
    FailingWhatwgSocket.constructed = 0;
    const err = await connect(model, { WebSocket: FailingWhatwgSocket }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComfyError);
    expect((err as ComfyError).code).toBe("realtime_unsupported_model");
    expect((err as Error).message).toContain(where);
    expect(FailingWhatwgSocket.constructed).toBe(0);
  });

  it("lets an explicit provider reach a model the table refuses", async () => {
    const server = await accepting();
    await open("fish/live-3", { provider: "fal" });
    expect(server.upgrades[0].url).toBe("/v2/realtime/fal/fish/live-3");
  });

  it.each(["genie-4", "google/", "Google/genie-4", "a/../b", "a/./b", "a//b", "a/b?c", 42])(
    "rejects the invalid id %j before any socket opens",
    async (model) => {
      FailingWhatwgSocket.constructed = 0;
      await expect(
        connect(model as string, { WebSocket: FailingWhatwgSocket }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(FailingWhatwgSocket.constructed).toBe(0);
    },
  );

  it("refuses an unknown provider override", async () => {
    await expect(
      connect("google/genie-4", { provider: "aws" as "fal", WebSocket: FailingWhatwgSocket }),
    ).rejects.toBeInstanceOf(TypeError);
  });
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
    ]) {
      await expect(
        connect("google/genie-4", {
          protocols: protocols as unknown as string[],
          WebSocket: FailingWhatwgSocket,
        }),
      ).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("sends the credential configured when connect was called, to that call's host", async () => {
    const server = await accepting();
    // The dynamic `import("ws")` yields; reconfiguring in that window must not
    // pair the new credential with the old host.
    const pending = connect("google/genie-4");
    config({ credentials: "comfyui-reconfigured", baseUrl: "http://127.0.0.1:1" });
    sessions.push(await pending);
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

  it("raises MissingCredentials on a standards-only constructor in key mode", async () => {
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
    const err = (await connect("xai/grok-voice/realtime", { WebSocket: WsWebSocket }).catch(
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
    const wss = new WebSocketServer({
      port: 0,
      host: "127.0.0.1",
      handleProtocols: (offered) =>
        [...offered].find((p) => p.startsWith("comfy-bearer.")) ?? false,
    });
    const closes: number[] = [];
    wss.on("connection", (socket) => socket.on("close", (code) => closes.push(code)));
    cleanups.push(() => new Promise((resolve) => wss.close(() => resolve())));
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    config({ baseUrl: `http://127.0.0.1:${String((wss.address() as AddressInfo).port)}` });

    const err = await connect("google/genie-4", {
      idToken: "secret-token",
      WebSocket: WsWebSocket,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RealtimeUpgradeFailed);
    expect((err as Error).message).not.toContain("secret-token");
    await expect.poll(() => closes).toEqual([1000]);
  });
});

describe("timeout", () => {
  /** A plain HTTP server that takes every upgrade and never answers it. */
  async function stalling(): Promise<Duplex[]> {
    const server = createServer();
    const held: Duplex[] = [];
    server.on("upgrade", (_req: IncomingMessage, socket: Duplex) => held.push(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(
      () =>
        new Promise((resolve) => {
          for (const socket of held) socket.destroy();
          server.close(() => resolve());
        }),
    );
    config({ baseUrl: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` });
    return held;
  }

  it("applies the 30s default deadline when timeoutMs is omitted", async () => {
    expect(DEFAULT_REALTIME_CONNECT_TIMEOUT_MS).toBe(30_000);
    const held = await stalling();
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
    const server = createServer();
    const held: Duplex[] = [];
    server.on("upgrade", (_req: IncomingMessage, socket: Duplex) => held.push(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(
      () =>
        new Promise((resolve) => {
          for (const socket of held) socket.destroy();
          server.close(() => resolve());
        }),
    );
    config({ baseUrl: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` });
    const err = await connect("google/genie-4", { timeoutMs: 50, WebSocket: WsWebSocket }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ComfyError);
    expect((err as ComfyError).code).toBe("request_timeout");
  });

  it("rejects with request_timeout when a refusal's body stalls", async () => {
    const server = createServer();
    const held: Duplex[] = [];
    server.on("upgrade", (_req: IncomingMessage, socket: Duplex) => {
      held.push(socket);
      socket.write("HTTP/1.1 402 Refused\r\nContent-Length: 100\r\n\r\n{");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(
      () =>
        new Promise((resolve) => {
          for (const socket of held) socket.destroy();
          server.close(() => resolve());
        }),
    );
    config({ baseUrl: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` });
    const err = await connect("google/genie-4", { timeoutMs: 50, WebSocket: WsWebSocket }).catch(
      (e: unknown) => e,
    );
    expect((err as ComfyError).code).toBe("request_timeout");
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
    const server = createServer();
    const held: Duplex[] = [];
    server.on("upgrade", (_req: IncomingMessage, socket: Duplex) => held.push(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(
      () =>
        new Promise((resolve) => {
          for (const socket of held) socket.destroy();
          server.close(() => resolve());
        }),
    );
    config({ baseUrl: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` });
    const controller = new AbortController();
    const pending = connect("google/genie-4", {
      signal: controller.signal,
      WebSocket: WsWebSocket,
    });
    setTimeout(() => controller.abort(new Error("gave up")), 20);
    await expect(pending).rejects.toThrow("gave up");
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
    const wss = new WebSocketServer({
      port: 0,
      host: "127.0.0.1",
      handleProtocols: () => REALTIME_SUBPROTOCOL,
    });
    cleanups.push(() => new Promise((resolve) => wss.close(() => resolve())));
    // A frame with every reserved bit set, which `ws` rejects with `error` then `close`.
    wss.on("connection", (_socket, req) => req.socket.write(Buffer.from([0xf1, 0x00])));
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    config({ baseUrl: `http://127.0.0.1:${String((wss.address() as AddressInfo).port)}` });

    const session = await open("google/genie-4");
    const closed = new Promise<number>((resolve) =>
      session.socket.addEventListener("close", (event) => resolve(event.code)),
    );
    // No close frame arrives, so the close is a bare 1006 — but it arrives
    // instead of an unhandled `error` taking the process down.
    expect(await closed).toBe(1006);
  });

  it("types a message event's data for the caller", async () => {
    const wss = new WebSocketServer({
      port: 0,
      host: "127.0.0.1",
      handleProtocols: () => REALTIME_SUBPROTOCOL,
    });
    cleanups.push(() => new Promise((resolve) => wss.close(() => resolve())));
    wss.on("connection", (socket) => socket.on("message", (data) => socket.send(String(data))));
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    config({ baseUrl: `http://127.0.0.1:${String((wss.address() as AddressInfo).port)}` });

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
