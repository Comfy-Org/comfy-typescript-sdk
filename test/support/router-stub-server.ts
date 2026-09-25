/**
 * A Node `http`-only stub of the model-router surface (`/v2/models/...`).
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

/**
 * One fixture page of the model catalog, keyed by the cursor that selects it.
 *
 * `has_more` and `next_cursor` are stated rather than derived from the array
 * of pages on purpose: a walk that stops early, or one whose server names no
 * next cursor while claiming another page exists, are both real answers a
 * client has to survive, and a derived fixture could not express either.
 */
export interface RouterCatalogPage {
  /** The `?cursor=` value that selects this page; `null` for the first one. */
  cursor: string | null;
  /** The `data` array to serve. */
  data: unknown[];
  /** The `has_more` flag to serve. */
  has_more: boolean;
  /** The `next_cursor` to serve, or `null`/omitted to send none. */
  next_cursor?: string | null;
  /** The `limit` to echo back, or omitted to send none. */
  limit?: number;
}

/** One request the stub saw, in the order it saw them. */
export interface RecordedRequest {
  method: string;
  path: string;
  body: string;
  idempotencyKey: string | null;
}

/** A scripted answer from {@link RouterServerState.respond}. */
export interface ScriptedResponse {
  status: number;
  /** A string is sent verbatim (for non-JSON fixtures); anything else is
   * JSON-encoded. Omitted sends an empty body. */
  body?: unknown;
  /** `X-Comfy-Request-Id`; omitted keeps {@link RouterServerState.requestId}. */
  requestId?: string | null;
  /** `X-Comfy-Error-Type`; omitted keeps {@link RouterServerState.errorType}. */
  errorType?: string | null;
  /** Extra response headers — `Retry-After` is the one the queue needs. */
  headers?: Record<string, string>;
}

export interface RouterServerState {
  /** HTTP status to answer with. */
  status: number;
  /** Response body. A `Buffer`/`Uint8Array` is sent byte for byte (for a
   * binary fixture — a partner's own audio or image bytes), a string verbatim
   * (for non-JSON text fixtures); anything else is JSON-encoded. `null` sends
   * an empty body. */
  body: unknown;
  /** `Content-Type` of the response, or `null` to omit the header entirely —
   * which a partner's response forwarded without one genuinely does, and
   * which the client has to treat as its own case. */
  contentType: string | null;
  /** `X-Comfy-Request-Id` to send, or `null` to omit the header — which a
   * proxy error page ahead of the router genuinely does. */
  requestId: string | null;
  /** `X-Comfy-Error-Type` to send, or `null` to omit it. */
  errorType: string | null;
  /**
   * `Retry-After` to send on the ordinary response, or `null` to omit it.
   * {@link failRetryAfter} is the equivalent for a {@link failTimes} response.
   */
  retryAfter: string | null;
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
  /**
   * `Content-Length` a {@link stallBody} response declares. The body never
   * reaches it, which is what makes it the fixture for a client that acts on
   * the DECLARED length: a client that waits for the bytes instead waits
   * forever.
   */
  stallBodyContentLength: number;
  /**
   * Send the body as N chunks of `chunkBytes` each with NO `Content-Length`,
   * so the response is chunked and its size cannot be known before it is
   * read. Writes respect backpressure, so a client that stops reading part
   * way stops the transfer — {@link chunkedChunksSent} and
   * {@link chunkedBodyCompleted} are how a test proves that happened.
   */
  chunkedBody: { chunkBytes: number; chunks: number } | null;
  /** Chunks of a {@link chunkedBody} response actually flushed to the socket. */
  chunkedChunksSent: number;
  /** Whether a {@link chunkedBody} response wrote every chunk and ended. */
  chunkedBodyCompleted: boolean;
  /**
   * Answer the first N requests with {@link failStatus} (and
   * {@link failErrorType}) before falling through to the normal response —
   * the shape a client retry has to climb out of.
   */
  failTimes: number;
  /** Status used by {@link failTimes}. */
  failStatus: number;
  /** `X-Comfy-Error-Type` sent with a {@link failTimes} response, or `null`. */
  failErrorType: string | null;
  /**
   * `Retry-After` sent with a {@link failTimes} response, or `null` to omit
   * the header entirely. Present-and-absent are different fixture shapes here,
   * not a detail: the client reads the header's PRESENCE as Router saying it
   * still holds a generation the same key can collect, so a `504` with one and
   * a `504` without take different paths.
   */
  failRetryAfter: string | null;
  /**
   * When true, the response that finally succeeds carries
   * `Idempotent-Replayed: true` — what a real Router sends when the answer came
   * off the record held against the `Idempotency-Key` rather than from running
   * the model again. Nothing in the SDK branches on it; it is here so a collect
   * test can assert the fixture really is the replay it claims to be.
   */
  idempotentReplayed: boolean;
  /**
   * `X-Comfy-Credits-Used` on the ordinary response, or `null` to omit the
   * header entirely. Present-and-absent are different fixture shapes, not a
   * detail: the client reads ABSENCE as "Router reported no cost" and a
   * present `"0"` as a reported cost of zero, so a stub that defaulted this
   * to `"0"` could not tell the two apart.
   */
  creditsUsed: string | null;
  /**
   * Destroy the socket of the first N requests without answering at all — a
   * transport failure rather than an HTTP one, which the client sees as a
   * fetch rejection and not a status.
   */
  resetTimes: number;
  /**
   * Answer per request, for a surface whose routes differ — the queued
   * model-request family, where one call sequence hits submit, status, result
   * and cancel in turn and a single `body` cannot describe all four.
   *
   * Consulted LAST, after `resetTimes`, `hang`, `delayMs`, `failTimes`,
   * `stallBody` and `chunkedBody`, so every one of those scenarios still
   * composes with it.
   * Returning `null` falls through to the plain `status`/`body` answer.
   */
  respond: ((request: RecordedRequest, index: number) => ScriptedResponse | null) | null;
  /**
   * Order {@link resetTimes} AFTER {@link failTimes} instead of before: the
   * fail responses go out first, then the socket resets, then the ordinary
   * response. That is the shape of a transport failure landing mid-collect —
   * Router answered a paced `409`/`504`, and the re-ask never got an answer.
   */
  resetAfterFail: boolean;

  /**
   * Fixture pages for the catalog route (`GET /v2/models`), selected by the
   * request's `?cursor=`. `null` leaves that route answering exactly like
   * every other one, which is what the error fixtures want.
   */
  catalogPages: RouterCatalogPage[] | null;
  /**
   * `ETag` to send on the ordinary response, or `null` to omit it. When it is
   * set, a request whose `If-None-Match` matches it is answered `304` with no
   * body — the revalidation the per-model schema route ships these headers
   * for.
   */
  etag: string | null;
  /** `Cache-Control` to send on the ordinary response, or `null` to omit it. */
  cacheControl: string | null;

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
   * did not share one, and that two attempts of one call did. */
  idempotencyKeys: string[];
  /**
   * Requests whose connection the client closed before a response was
   * finished. This is what a server-side `client_disconnected` is measured
   * from, so it is how a test proves an abort reached the wire rather than
   * merely abandoning a promise.
   */
  clientDisconnects: number;
  /** `If-None-Match` on the last request, or `null`. */
  lastIfNoneMatch: string | null;
  /** The `?cursor=` of every request that carried the catalog route, in order;
   * `null` for a request that named none. */
  catalogCursors: (string | null)[];
  /** The `?limit=` of the last catalog request, or `null`. */
  lastCatalogLimit: string | null;
  /** Every request, in order — what a multi-route call sequence is asserted on. */
  requests: RecordedRequest[];
}

function defaultState(): RouterServerState {
  return {
    status: 200,
    body: { images: [{ url: "https://example.invalid/out.png" }] },
    contentType: "application/json",
    requestId: "6f1a1a6e-6a53-4a5f-9d3a-2b3b0a1f9c21",
    errorType: null,
    retryAfter: null,
    delayMs: 0,
    hang: false,
    stallBody: false,
    stallBodyContentLength: 4096,
    chunkedBody: null,
    chunkedChunksSent: 0,
    chunkedBodyCompleted: false,
    failTimes: 0,
    failStatus: 503,
    failErrorType: null,
    failRetryAfter: null,
    idempotentReplayed: false,
    creditsUsed: null,
    resetTimes: 0,
    respond: null,
    resetAfterFail: false,
    catalogPages: null,
    etag: null,
    cacheControl: null,
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
    clientDisconnects: 0,
    lastIfNoneMatch: null,
    catalogCursors: [],
    lastCatalogLimit: null,
    requests: [],
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

/**
 * Write one chunk and wait for it to reach the socket, resolving `false` if
 * the connection went away first.
 *
 * Waiting for the flush rather than firing writes into Node's buffer is what
 * makes a large chunked body actually stall against a client that stopped
 * reading — which is the scenario a size cap has to be proven against.
 */
function writeChunk(res: ServerResponse, chunk: Buffer): Promise<boolean> {
  return new Promise((resolve) => {
    if (res.destroyed || res.writableEnded) {
      resolve(false);
      return;
    }
    const onClose = () => resolve(false);
    res.once("close", onClose);
    res.write(chunk, () => {
      res.off("close", onClose);
      resolve(!res.destroyed);
    });
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
    // Registered before anything can answer: `close` without
    // `writableFinished` is the socket going away mid-request, which is
    // exactly what an aborted client looks like from here.
    res.on("close", () => {
      if (!res.writableFinished) state.clientDisconnects += 1;
    });
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
    state.lastIfNoneMatch = header(req, "if-none-match");
    if (state.lastIdempotencyKey !== null) state.idempotencyKeys.push(state.lastIdempotencyKey);
    const recorded: RecordedRequest = {
      method: state.lastMethod ?? "",
      path: state.lastPath ?? "",
      body: raw,
      idempotencyKey: state.lastIdempotencyKey,
    };
    state.requests.push(recorded);

    if (state.resetTimes > 0 && !(state.resetAfterFail && state.failTimes > 0)) {
      state.resetTimes -= 1;
      req.socket.destroy(); // no status line at all — a transport failure
      return;
    }

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

    const headers: Record<string, string> = {};
    if (state.contentType !== null) headers["Content-Type"] = state.contentType;
    if (state.requestId !== null) headers["X-Comfy-Request-Id"] = state.requestId;
    if (state.errorType !== null) headers["X-Comfy-Error-Type"] = state.errorType;

    // The catalog route, when a test has supplied pages for it. Gated on the
    // fixture rather than on the path alone so the error fixtures (a 401 on
    // the catalog, say) still reach the ordinary response below.
    const target = new URL(req.url ?? "/", "http://stub.invalid");
    if (state.catalogPages !== null && target.pathname === "/v2/models") {
      const cursor = target.searchParams.get("cursor");
      state.catalogCursors.push(cursor);
      state.lastCatalogLimit = target.searchParams.get("limit");
      const page = state.catalogPages.find((candidate) => (candidate.cursor ?? null) === cursor);
      if (page === undefined) {
        // A cursor no fixture page claims: the stub says so loudly rather than
        // serving page one, which would make a broken walk look like a
        // correct one.
        const body = JSON.stringify({
          detail: `no fixture page for cursor ${JSON.stringify(cursor)}`,
          error_type: "invalid_input",
        });
        res.writeHead(400, { ...headers, "X-Comfy-Error-Type": "invalid_input" });
        res.end(body);
        return;
      }
      const body = JSON.stringify({
        data: page.data,
        has_more: page.has_more,
        ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }),
        ...(page.limit === undefined ? {} : { limit: page.limit }),
      });
      headers["Content-Length"] = String(Buffer.byteLength(body));
      res.writeHead(state.status, headers);
      res.end(body);
      return;
    }

    if (state.cacheControl !== null) headers["Cache-Control"] = state.cacheControl;
    if (state.etag !== null) {
      headers.ETag = state.etag;
      // The revalidation half: a matching `If-None-Match` gets the headers and
      // no body, which is what a client that cached the document must handle
      // as "still current" rather than as an empty one.
      if (state.lastIfNoneMatch === state.etag || state.lastIfNoneMatch === "*") {
        res.writeHead(304, headers);
        res.end();
        return;
      }
    }

    if (state.failTimes > 0) {
      state.failTimes -= 1;
      if (state.failErrorType !== null) headers["X-Comfy-Error-Type"] = state.failErrorType;
      if (state.failRetryAfter !== null) headers["Retry-After"] = state.failRetryAfter;
      const failBody = JSON.stringify({ detail: "try again", error_type: state.failErrorType });
      headers["Content-Length"] = String(Buffer.byteLength(failBody));
      res.writeHead(state.failStatus, headers);
      res.end(failBody);
      return;
    }

    // Below the `failTimes` branch on purpose: these two describe the ordinary
    // response only. A fail response gets its pace from `failRetryAfter` (so
    // `null` there really does omit the header), and is not a replay of
    // anything.
    if (state.retryAfter !== null) headers["Retry-After"] = state.retryAfter;
    if (state.idempotentReplayed) headers["Idempotent-Replayed"] = "true";
    if (state.creditsUsed !== null) headers["X-Comfy-Credits-Used"] = state.creditsUsed;

    if (state.stallBody) {
      // A Content-Length the body never reaches, so the client keeps reading.
      res.writeHead(state.status, {
        ...headers,
        "Content-Length": String(state.stallBodyContentLength),
      });
      res.write('{"images":');
      return;
    }

    if (state.chunkedBody !== null) {
      // No Content-Length: Node falls back to chunked transfer-encoding, so
      // the client learns the size only by reading it.
      res.writeHead(state.status, headers);
      const chunk = Buffer.alloc(state.chunkedBody.chunkBytes, 0x61);
      for (let i = 0; i < state.chunkedBody.chunks; i += 1) {
        if (!(await writeChunk(res, chunk))) return;
        state.chunkedChunksSent += 1;
      }
      res.end();
      state.chunkedBodyCompleted = true;
      return;
    }

    const scripted = state.respond?.(recorded, state.requests.length - 1) ?? null;
    if (scripted !== null) {
      const scriptedHeaders = { ...headers, ...scripted.headers };
      if (scripted.requestId !== undefined) {
        if (scripted.requestId === null) delete scriptedHeaders["X-Comfy-Request-Id"];
        else scriptedHeaders["X-Comfy-Request-Id"] = scripted.requestId;
      }
      if (scripted.errorType !== undefined) {
        if (scripted.errorType === null) delete scriptedHeaders["X-Comfy-Error-Type"];
        else scriptedHeaders["X-Comfy-Error-Type"] = scripted.errorType;
      }
      if (scripted.body === undefined) {
        res.writeHead(scripted.status, scriptedHeaders);
        res.end();
        return;
      }
      const scriptedBody =
        typeof scripted.body === "string" ? scripted.body : JSON.stringify(scripted.body);
      scriptedHeaders["Content-Length"] = String(Buffer.byteLength(scriptedBody));
      res.writeHead(scripted.status, scriptedHeaders);
      res.end(scriptedBody);
      return;
    }

    if (state.body === null) {
      res.writeHead(state.status, headers);
      res.end();
      return;
    }
    // A `Uint8Array` (which a `Buffer` is) goes out byte for byte: a binary
    // fixture only proves anything if nothing re-encodes it on the way.
    const payload =
      state.body instanceof Uint8Array
        ? Buffer.from(state.body.buffer, state.body.byteOffset, state.body.byteLength)
        : typeof state.body === "string"
          ? state.body
          : JSON.stringify(state.body);
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
