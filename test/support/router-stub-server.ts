/**
 * A Node `http`-only stub of the model-router surface (`/v1/models/...`).
 *
 * Separate from `stub-server.ts` on purpose: that one stubs the Comfy API v2
 * job/asset surface, which is a different host, a different path prefix and a
 * different error envelope. Folding both into one server would mean every
 * router test carried the v2 fixture state it never touches.
 *
 * Each test sets `server.state` for the scenario it wants and points
 * `comfy.config({ baseUrl: server.baseUrl })` at it.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface RouterServerState {
  /** HTTP status to answer with. */
  status: number;
  /** Response body. A string is sent verbatim (for non-JSON fixtures);
   * anything else is JSON-encoded. `null` sends an empty body. */
  body: unknown;
  /** `Content-Type` of the response. */
  contentType: string;
  /** `X-Comfy-Request-Id` to send, or `null` to omit the header — which a
   * proxy error page ahead of the router genuinely does. */
  requestId: string | null;
  /** `X-Comfy-Error-Type` to send, or `null` to omit it. */
  errorType: string | null;
  /**
   * Wait this long before answering — a model that took a while, which is
   * the ordinary case for this route rather than an edge one.
   */
  delayMs: number;
  /**
   * Hold the request open without ever answering, so a test can exercise a
   * deadline against a server that is still working. Held sockets are
   * destroyed by {@link RouterStubServer.stop}.
   */
  hang: boolean;
  /**
   * Send the status line and headers, then stall mid-body forever. A
   * deadline covers body consumption too, so this is the shape that proves
   * it — `hang` never gets as far as a `Response` object at all.
   */
  stallBody: boolean;

  // --- what the last request carried, for tests to assert on ---
  requestCount: number;
  lastMethod: string | null;
  lastPath: string | null;
  lastRawBody: string | null;
  lastAuthorization: string | null;
  lastIdempotencyKey: string | null;
  lastContentType: string | null;
  lastAccept: string | null;
  lastUserAgent: string | null;
  /** Every `Idempotency-Key` seen, in order — so a test can prove two calls
   * did not share one. */
  idempotencyKeys: string[];
}

function defaultState(): RouterServerState {
  return {
    status: 200,
    body: { images: [{ url: "https://example.invalid/out.png" }] },
    contentType: "application/json",
    requestId: "6f1a1a6e-6a53-4a5f-9d3a-2b3b0a1f9c21",
    errorType: null,
    delayMs: 0,
    hang: false,
    stallBody: false,
    requestCount: 0,
    lastMethod: null,
    lastPath: null,
    lastRawBody: null,
    lastAuthorization: null,
    lastIdempotencyKey: null,
    lastContentType: null,
    lastAccept: null,
    lastUserAgent: null,
    idempotencyKeys: [],
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (typeof value === "string") return value;
  return Array.isArray(value) ? (value[0] ?? null) : null;
}

export class RouterStubServer {
  readonly state: RouterServerState;
  private readonly server: Server;
  /** Pending `delayMs` timers, cleared by {@link stop} so a test that ends
   * mid-delay does not leave the event loop holding one. */
  private readonly timers = new Set<NodeJS.Timeout>();
  baseUrl = "";

  constructor() {
    this.state = defaultState();
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ detail: String(err), error_type: "internal_error" }));
        }
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const addr = this.server.address();
    if (addr === null || typeof addr === "string") throw new Error("failed to bind stub server");
    this.baseUrl = `http://127.0.0.1:${String(addr.port)}`;
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    // A `hang` scenario leaves a socket open with no response on it, and
    // `close()` alone waits for it forever.
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const state = this.state;
    const raw = await readBody(req);
    state.requestCount += 1;
    state.lastMethod = req.method ?? null;
    state.lastPath = req.url ?? null;
    state.lastRawBody = raw;
    state.lastAuthorization = header(req, "authorization");
    state.lastIdempotencyKey = header(req, "idempotency-key");
    state.lastContentType = header(req, "content-type");
    state.lastAccept = header(req, "accept");
    state.lastUserAgent = header(req, "user-agent");
    if (state.lastIdempotencyKey !== null) state.idempotencyKeys.push(state.lastIdempotencyKey);

    if (state.hang) return; // never answer; the client must give up on its own

    if (state.delayMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          resolve();
        }, state.delayMs);
        this.timers.add(timer);
      });
      if (res.writableEnded || res.destroyed) return;
    }

    const headers: Record<string, string> = { "Content-Type": state.contentType };
    if (state.requestId !== null) headers["X-Comfy-Request-Id"] = state.requestId;
    if (state.errorType !== null) headers["X-Comfy-Error-Type"] = state.errorType;

    if (state.stallBody) {
      // A Content-Length the body never reaches, so the client keeps reading.
      res.writeHead(state.status, { ...headers, "Content-Length": "4096" });
      res.write('{"images":');
      return;
    }

    if (state.body === null) {
      res.writeHead(state.status, headers);
      res.end();
      return;
    }
    const payload = typeof state.body === "string" ? state.body : JSON.stringify(state.body);
    headers["Content-Length"] = String(Buffer.byteLength(payload));
    res.writeHead(state.status, headers);
    res.end(payload);
  }
}

export async function withRouterStub<T>(fn: (server: RouterStubServer) => Promise<T>): Promise<T> {
  const server = new RouterStubServer();
  await server.start();
  try {
    return await fn(server);
  } finally {
    await server.stop();
  }
}
