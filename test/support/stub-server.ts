/**
 * A Node `http`-only stub of the Comfy API v2 server.
 *
 * Keeps the SDK's own test suite independent of a real v2 server or proxy.
 * Each test configures `server.state` to drive a specific scenario (dedup
 * hit, hash mismatch, queue-full-then-ok, SSE reconnect, ...), then points
 * a `ComfyLow`/`Comfy` client at `server.baseUrl`. Mirrors the Python SDK's
 * `tests/conftest.py` stub server scenario-for-scenario.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface ServerState {
  /** Blobs the platform "already has" (for the dedup fast-path). */
  knownHashes: Set<string>;
  /** The authoritative server-side hash returned for uploads. */
  serverHash: string;
  /** If true, POST /assets rejects with 409 hash_mismatch. */
  rejectHashMismatch: boolean;
  /** Bytes served by GET /assets/{id}/content. */
  contentBytes: Buffer;
  /** Require an Authorization header (Cloud/serverless). */
  requireAuth: boolean;
  /**
   * When set, `urls.self`/`events`/`cancel` in job payloads are absolute
   * URLs prefixed with this origin instead of the default relative path —
   * lets a test simulate a job whose links point at a different host (e.g.
   * a CDN/relay), to verify the client does not leak its bearer token
   * there.
   */
  jobUrlsOrigin: string | null;
  /** POST /jobs returns 429 queue_full this many times before succeeding. */
  queueFullTimes: number;
  /**
   * The `Retry-After` header value sent with a `queue_full` response.
   * Defaults to the delay-seconds form ("0"); set to an HTTP-date string to
   * exercise the client's fallback for a form it does not parse.
   */
  retryAfterHeader: string;
  /** POST /jobs returns this error envelope instead of 201. */
  jobError: { status: number; code: string } | null;
  /** Number of GET /jobs/{id} polls before the job reports terminal. */
  pollsToSucceed: number;
  /** Terminal status the job reaches. */
  terminalStatus: string;
  /** SSE behavior: "reconnect" drops the first stream before terminal. */
  sseMode: "normal" | "reconnect";
  /** Progress value the first (dropped) reconnect stream emits. */
  firstReconnectProgress: number;
  /** Progress value the normal / reconnected stream emits. */
  progressValue: number;
  /**
   * When set, `GET /assets/{id}/content` responds with a 302 redirecting to
   * this origin (same path) instead of serving `contentBytes` directly —
   * lets a test simulate a redirect to a different host (e.g. a signed CDN
   * URL) and check what does/doesn't follow the client there.
   */
  contentRedirectOrigin: string | null;
  /**
   * When set, `GET /assets/{id}/content` redirects to this exact URL
   * (verbatim, including any query string) instead of appending `path` to
   * `contentRedirectOrigin` — lets a test simulate a GCS-style signed URL
   * complete with `X-Goog-Date`/`X-Goog-Expires` query params. Takes
   * precedence over `contentRedirectOrigin` when both are set.
   */
  contentRedirectLocation: string | null;
  /**
   * Overrides the `hash` field returned by `GET /assets/{id}`. `undefined`
   * (the default) uses `serverHash` as before; an explicit `null` simulates
   * a server model with no hash on record.
   */
  getAssetHashOverride: string | null | undefined;
  /** When true, `GET /jobs/{id}` never responds — simulates a hung backend
   * so a test can assert an aborted caller signal cancels the in-flight
   * request instead of waiting it out. */
  hangJobPoll: boolean;
  /**
   * `GET /jobs/{id}/workflow` response body. `null` (the default) makes the
   * stub 404 with `job_not_found`, matching a job that has no workflow on
   * record.
   */
  jobWorkflow: { workflow: Record<string, unknown>; format: "save" | "api" } | null;
  /** Asset ids already deleted — GET/DELETE for these 404 asset_not_found,
   * matching the real server treating a repeat delete as "gone". */
  deletedAssets: Set<string>;
  /** When set, DELETE for this asset id responds 409 asset_in_use instead
   * of deleting it (simulates an asset still referenced by a workflow). */
  deleteInUseAssetId: string | null;

  // --- counters tests assert on ---
  uploadCount: number;
  uploadDataEvents: number;
  fromHashCount: number;
  headCount: number;
  deleteCount: number;
  jobPollCount: number;
  eventsConnectCount: number;
  submitCount: number;
  lastWorkflow: Record<string, unknown> | null;
  /**
   * The full parsed JSON body of the most recent `POST /jobs`, so a test can
   * assert on `extra_data` — both its value when sent, and that the key is
   * genuinely absent (not just `undefined`) when no `apiKey` was supplied.
   */
  lastPostJobsBody: Record<string, unknown> | null;
  lastUploadContentLength: number | null;
  idempotency: Map<string, string>;
  /** The raw `Authorization` header value of the most recent request, or
   * `null` if that request carried none — lets a test prove a bearer token
   * was (or was not) attached/received. */
  lastAuthorizationHeader: string | null;
  /** The raw `User-Agent` header value of the most recent request, or
   * `null` if that request carried none. */
  lastUserAgentHeader: string | null;
}

function defaultState(): ServerState {
  return {
    knownHashes: new Set(),
    serverHash: `blake3:${"ab".repeat(32)}`,
    rejectHashMismatch: false,
    contentBytes: Buffer.from("\x89PNG-stub-output-bytes-0123456789"),
    requireAuth: false,
    jobUrlsOrigin: null,
    queueFullTimes: 0,
    retryAfterHeader: "0",
    jobError: null,
    pollsToSucceed: 1,
    terminalStatus: "succeeded",
    sseMode: "normal",
    firstReconnectProgress: 0.4,
    progressValue: 0.5,
    contentRedirectOrigin: null,
    contentRedirectLocation: null,
    getAssetHashOverride: undefined,
    hangJobPoll: false,
    jobWorkflow: null,
    deletedAssets: new Set(),
    deleteInUseAssetId: null,
    uploadCount: 0,
    uploadDataEvents: 0,
    fromHashCount: 0,
    headCount: 0,
    deleteCount: 0,
    jobPollCount: 0,
    eventsConnectCount: 0,
    submitCount: 0,
    lastWorkflow: null,
    lastPostJobsBody: null,
    lastUploadContentLength: null,
    idempotency: new Map(),
    lastAuthorizationHeader: null,
    lastUserAgentHeader: null,
  };
}

function assetJson(id: string, hash: string | null, createdNew: boolean, size: number) {
  return {
    id,
    hash,
    size_bytes: size,
    content_type: "image/png",
    file_path: "photo.png",
    created_new: createdNew,
    created_at: "2026-07-10T18:00:00Z",
    url: "http://example.invalid/blob",
    url_expires_at: "2026-07-10T19:00:00Z",
  };
}

function jobJson(
  id: string,
  status: string,
  outputs: unknown[] = [],
  urlsOrigin: string | null = null,
) {
  const prefix = urlsOrigin ?? "";
  return {
    id,
    status,
    created_at: "2026-07-10T18:20:00Z",
    started_at: null,
    completed_at: null,
    expires_at: "2026-07-11T18:20:00Z",
    queue_position: 0,
    progress: null,
    outputs,
    error: null,
    metrics: { queue_ms: 9000, execution_ms: null },
    urls: {
      self: `${prefix}/api/v2/jobs/${id}`,
      events: `${prefix}/api/v2/jobs/${id}/events`,
      cancel: `${prefix}/api/v2/jobs/${id}/cancel`,
    },
  };
}

const OUTPUT = {
  node_id: "13",
  name: "out.png",
  type: "image",
  content_type: "image/png",
  size_bytes: 33,
  id: "asset_out_01",
  hash: null,
  url: "http://example.invalid/out",
  url_expires_at: "2026-07-10T19:20:00Z",
};

function readBody(req: IncomingMessage, onData?: () => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      onData?.();
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
    ...headers,
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, code: string, message = "err") {
  sendJson(res, status, { error: { code, message } });
}

export class StubServer {
  readonly state: ServerState;
  private readonly server: Server;
  baseUrl = "";

  constructor() {
    this.state = defaultState();
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) sendError(res, 500, "internal", String(err));
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const addr = this.server.address();
    if (addr === null || typeof addr === "string") throw new Error("failed to bind stub server");
    this.baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  private authOk(req: IncomingMessage): boolean {
    return !this.state.requireAuth || Boolean(req.headers.authorization);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://stub.invalid");
    const path = url.pathname;
    const state = this.state;
    state.lastAuthorizationHeader = (req.headers.authorization as string | undefined) ?? null;
    state.lastUserAgentHeader = (req.headers["user-agent"] as string | undefined) ?? null;

    if (!this.authOk(req)) {
      await readBody(req);
      sendError(res, 401, "unauthorized", "no key");
      return;
    }

    if (req.method === "HEAD") {
      const m = /^\/api\/v2\/assets\/by-hash\/(.+)$/.exec(path);
      if (m) {
        state.headCount += 1;
        res.writeHead(state.knownHashes.has(decodeURIComponent(m[1])) ? 200 : 404);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
      return;
    }

    if (req.method === "GET") {
      let m = /^\/api\/v2\/assets\/([^/]+)\/content$/.exec(path);
      if (m) {
        if (state.deletedAssets.has(m[1])) {
          sendError(res, 404, "asset_not_found", "asset not found");
          return;
        }
        this.serveContent(req, res, path);
        return;
      }
      m = /^\/api\/v2\/assets\/([^/]+)$/.exec(path);
      if (m) {
        if (state.deletedAssets.has(m[1])) {
          sendError(res, 404, "asset_not_found", "asset not found");
          return;
        }
        const hash =
          state.getAssetHashOverride !== undefined ? state.getAssetHashOverride : state.serverHash;
        sendJson(res, 200, assetJson(m[1], hash, false, 33));
        return;
      }
      m = /^\/api\/v2\/jobs\/([^/]+)\/events$/.exec(path);
      if (m) {
        this.serveEvents(res);
        return;
      }
      m = /^\/api\/v2\/jobs\/([^/]+)\/workflow$/.exec(path);
      if (m) {
        this.serveJobWorkflow(res);
        return;
      }
      m = /^\/api\/v2\/jobs\/([^/]+)$/.exec(path);
      if (m) {
        this.serveJob(m[1], res);
        return;
      }
      sendError(res, 404, "not_found");
      return;
    }

    if (req.method === "POST") {
      if (path === "/api/v2/assets") {
        await this.postAssets(req, res);
        return;
      }
      if (path === "/api/v2/assets/from-hash") {
        await this.postFromHash(req, res);
        return;
      }
      if (path === "/api/v2/jobs") {
        await this.postJobs(req, res);
        return;
      }
      const m = /^\/api\/v2\/jobs\/([^/]+)\/cancel$/.exec(path);
      if (m) {
        sendJson(res, 200, jobJson(m[1], "canceling", [], state.jobUrlsOrigin));
        return;
      }
      await readBody(req);
      sendError(res, 404, "not_found");
      return;
    }

    if (req.method === "DELETE") {
      const m = /^\/api\/v2\/assets\/([^/]+)$/.exec(path);
      if (m) {
        const id = decodeURIComponent(m[1]);
        state.deleteCount += 1;
        if (state.deleteInUseAssetId === id) {
          sendError(res, 409, "asset_in_use", "asset is referenced by another resource");
          return;
        }
        if (state.deletedAssets.has(id)) {
          sendError(res, 404, "asset_not_found", "asset not found");
          return;
        }
        state.deletedAssets.add(id);
        res.writeHead(204);
        res.end();
        return;
      }
      sendError(res, 404, "not_found");
      return;
    }

    sendError(res, 404, "not_found");
  }

  private serveContent(req: IncomingMessage, res: ServerResponse, path: string): void {
    if (this.state.contentRedirectLocation) {
      res.writeHead(302, { Location: this.state.contentRedirectLocation });
      res.end();
      return;
    }
    if (this.state.contentRedirectOrigin) {
      res.writeHead(302, { Location: `${this.state.contentRedirectOrigin}${path}` });
      res.end();
      return;
    }
    const data = this.state.contentBytes;
    const range = req.headers.range;
    if (typeof range === "string") {
      const m = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (m) {
        const start = Number(m[1]);
        const end = Number(m[2]);
        const chunk = data.subarray(start, end + 1);
        res.writeHead(206, {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(chunk.length),
          "Content-Range": `bytes ${start}-${end}/${data.length}`,
        });
        res.end(chunk);
        return;
      }
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(data.length),
    });
    res.end(data);
  }

  private serveJob(jobId: string, res: ServerResponse): void {
    const state = this.state;
    if (state.hangJobPoll) return; // never respond; the caller must abort client-side
    state.jobPollCount += 1;
    const terminal = state.jobPollCount >= state.pollsToSucceed;
    const status = terminal ? state.terminalStatus : "running";
    const outputs = status === "succeeded" ? [OUTPUT] : [];
    sendJson(res, 200, jobJson(jobId, status, outputs, state.jobUrlsOrigin));
  }

  private serveJobWorkflow(res: ServerResponse): void {
    const { jobWorkflow } = this.state;
    if (jobWorkflow === null) {
      sendError(res, 404, "job_not_found", "no workflow recorded for this job");
      return;
    }
    sendJson(res, 200, jobWorkflow);
  }

  private serveEvents(res: ServerResponse): void {
    const state = this.state;
    state.eventsConnectCount += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });

    const frame = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    if (state.sseMode === "reconnect" && state.eventsConnectCount === 1) {
      frame("progress", { value: state.firstReconnectProgress, nodes_done: 4, nodes_total: 10 });
      res.end();
      return;
    }
    frame("status", { status: "running" });
    frame("progress", { value: state.progressValue, nodes_done: 5, nodes_total: 10 });
    frame("output", OUTPUT);
    frame("status", { status: state.terminalStatus });
    res.end();
  }

  private async postAssets(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const state = this.state;
    state.uploadCount += 1;
    const body = await readBody(req, () => {
      state.uploadDataEvents += 1;
    });
    state.lastUploadContentLength = Number(req.headers["content-length"] ?? body.length);
    // Mirror public-api: the multipart is streamed, so `content_type` MUST
    // arrive before the `file` part or the server rejects.
    const parts = body.toString("latin1");
    const ctIdx = parts.indexOf('name="content_type"');
    const fileIdx = parts.indexOf('name="file"');
    if (fileIdx !== -1 && (ctIdx === -1 || fileIdx < ctIdx)) {
      sendError(
        res,
        422,
        "invalid_body",
        "content_type is required and must be sent before the file field",
      );
      return;
    }
    if (state.rejectHashMismatch) {
      sendError(res, 409, "hash_mismatch", "bytes do not match expected_hash");
      return;
    }
    sendJson(res, 201, assetJson("asset_uploaded_01", state.serverHash, true, body.length));
  }

  private async postFromHash(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const state = this.state;
    state.fromHashCount += 1;
    const body = JSON.parse((await readBody(req)).toString("utf-8") || "{}") as { hash?: string };
    if (body.hash && state.knownHashes.has(body.hash)) {
      sendJson(res, 201, assetJson("asset_dedup_01", body.hash, false, 33));
    } else {
      sendError(res, 404, "blob_not_found", "no such blob");
    }
  }

  private async postJobs(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const state = this.state;
    state.submitCount += 1;
    const raw = (await readBody(req)).toString("utf-8");
    const body: Record<string, unknown> = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    state.lastWorkflow = (body.workflow as Record<string, unknown> | undefined) ?? null;
    state.lastPostJobsBody = body;
    const key = req.headers["idempotency-key"];

    if (typeof key === "string" && state.idempotency.has(key)) {
      // Reject-on-duplicate (single-use keys, no replay): any reuse of an
      // already-claimed key is 422 idempotency_key_reuse.
      sendError(res, 422, "idempotency_key_reuse", "Idempotency-Key already used");
      return;
    }

    if (state.queueFullTimes > 0) {
      state.queueFullTimes -= 1;
      sendJson(
        res,
        429,
        { error: { code: "queue_full", message: "full" } },
        { "Retry-After": state.retryAfterHeader },
      );
      return;
    }

    if (state.jobError !== null) {
      sendError(
        res,
        state.jobError.status,
        state.jobError.code,
        `job error ${state.jobError.code}`,
      );
      return;
    }

    const jobId = `job_${String(state.submitCount).padStart(2, "0")}`;
    if (typeof key === "string") state.idempotency.set(key, jobId);
    sendJson(res, 201, jobJson(jobId, "queued", [], state.jobUrlsOrigin));
  }
}

export async function withStubServer<T>(fn: (server: StubServer) => Promise<T>): Promise<T> {
  const server = new StubServer();
  await server.start();
  try {
    return await fn(server);
  } finally {
    await server.stop();
  }
}
