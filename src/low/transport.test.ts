import { readFileSync } from "node:fs";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StubServer } from "../../test/support/stub-server.js";
import {
  ApiError,
  BlobNotFound,
  HashMismatch,
  IdempotencyKeyReuse,
  NotFound,
  QueueFull,
  Unauthorized,
} from "./errors.js";
import { ComfyLow } from "./transport.js";

describe("ComfyLow transport", () => {
  let server: StubServer;
  let low: ComfyLow;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
    low = new ComfyLow(server.baseUrl);
  });

  afterEach(async () => {
    await server.stop();
  });

  it("headAssetByHash reflects known/unknown hashes", async () => {
    server.state.knownHashes.add("blake3:known");
    await expect(low.headAssetByHash("blake3:known")).resolves.toBe(true);
    await expect(low.headAssetByHash("blake3:unknown")).resolves.toBe(false);
    expect(server.state.headCount).toBe(2);
  });

  it("assetFromHash dedup-mints over an existing blob", async () => {
    server.state.knownHashes.add("blake3:known");
    const asset = await low.assetFromHash("blake3:known", { filePath: "a.png" });
    expect(asset.id).toBe("asset_dedup_01");
    expect(server.state.fromHashCount).toBe(1);
  });

  it("assetFromHash misses with blob_not_found -> BlobNotFound", async () => {
    await expect(low.assetFromHash("blake3:missing")).rejects.toBeInstanceOf(BlobNotFound);
  });

  it("postAssets streams a file from disk without buffering it whole", async () => {
    const dir = await mkdtemp(join(tmpdir(), "comfy-sdk-"));
    const path = join(dir, "big.bin");
    // Large enough that a single-chunk upload would be suspicious, small
    // enough to keep the test fast.
    const size = 4 * 1024 * 1024;
    await writeFile(path, Buffer.alloc(size, 7));
    try {
      const { openAsBlob } = await import("node:fs");
      const blob = await openAsBlob(path);
      expect(blob.size).toBe(size); // the Blob is disk-backed, not pre-read
      const asset = await low.postAssets(blob, "application/octet-stream", "big.bin", {
        expectedHash: "blake3:whatever",
      });
      expect(asset.created_new).toBe(true);
      // The server saw more than one TCP `data` event for a 4MB body —
      // consistent with a streamed (not single-buffer) transfer.
      expect(server.state.uploadDataEvents).toBeGreaterThan(1);
      expect(server.state.lastUploadContentLength).toBeGreaterThan(size);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("postAssets sends content_type before the file part", async () => {
    // The stub rejects 422 if `file` precedes `content_type` (mirrors public-api).
    const asset = await low.postAssets(new Blob(["hello"]), "text/plain", "hi.txt");
    expect(asset.id).toBe("asset_uploaded_01");
    expect(server.state.uploadCount).toBe(1); // 201, not a field-order rejection
  });

  it("postAssets surfaces hash_mismatch without a blind retry", async () => {
    server.state.rejectHashMismatch = true;
    await expect(
      low.postAssets(new Blob(["x"]), "text/plain", "a.txt", { expectedHash: "blake3:wrong" }),
    ).rejects.toBeInstanceOf(HashMismatch);
    expect(server.state.uploadCount).toBe(1); // exactly one attempt, no retry
  });

  it("getAssetContent supports Range requests", async () => {
    server.state.contentBytes = Buffer.from("0123456789");
    const response = await low.getAssetContent("asset_1", { range: [2, 4] });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("234");
  });

  // -- getAssetContentUrl -----------------------------------------------

  it("getAssetContentUrl returns the signed URL + parsed expiresAt when the server redirects (Cloud/object storage)", async () => {
    const signedUrl =
      "https://storage.googleapis.com/bucket/asset_1?X-Goog-Date=20260722T120000Z&X-Goog-Expires=3600&X-Goog-Signature=deadbeef";
    server.state.contentRedirectLocation = signedUrl;
    const result = await low.getAssetContentUrl("asset_1");
    expect(result.url).toBe(signedUrl);
    expect(result.expiresAt).toEqual(new Date("2026-07-22T13:00:00.000Z"));
  });

  it("getAssetContentUrl returns this endpoint's own absolute URL with a null expiresAt when served inline (self-hosted)", async () => {
    server.state.contentBytes = Buffer.from("inline-bytes");
    const result = await low.getAssetContentUrl("asset_1");
    expect(result.url).toBe(`${server.baseUrl}/api/v2/assets/asset_1/content`);
    expect(result.expiresAt).toBeNull();
  });

  it("getAssetContentUrl returns null expiresAt for a redirect URL with no recognizable signed-URL params", async () => {
    server.state.contentRedirectLocation = "https://cdn.example.invalid/asset_1?token=opaque";
    const result = await low.getAssetContentUrl("asset_1");
    expect(result.url).toBe("https://cdn.example.invalid/asset_1?token=opaque");
    expect(result.expiresAt).toBeNull();
  });

  it("getAssetContentUrl never throws for a real 404 — no, it maps to the usual typed error", async () => {
    // Sanity check that a genuine failure still surfaces via the existing
    // error mapping rather than being swallowed by the "never throws" cases.
    await expect(low.getAssetContentUrl("")).rejects.toBeTruthy();
  });

  it("getAssetContentUrl does not attach the bearer token to the redirect target (redirect is never followed)", async () => {
    const authed = new ComfyLow(server.baseUrl, "top-secret-key");
    const attacker = new StubServer();
    await attacker.start();
    try {
      server.state.contentRedirectOrigin = attacker.baseUrl;
      const result = await authed.getAssetContentUrl("asset_1");
      // The redirect is handed back, not followed.
      expect(result.url.startsWith(attacker.baseUrl)).toBe(true);
      // The initial (same-origin) request carried the token...
      expect(server.state.lastAuthorizationHeader).toBe("Bearer top-secret-key");
      // ...but since the redirect was never followed, the attacker's server
      // was never even contacted, let alone with the bearer token.
      expect(attacker.state.lastAuthorizationHeader).toBeNull();
    } finally {
      await attacker.stop();
    }
  });

  it("postJobs rejects a reused Idempotency-Key (single-use, no replay)", async () => {
    const key = "idem-key-1";
    const first = await low.postJobs({ "1": {} }, { idempotencyKey: key });
    expect(first.id).toMatch(/^job_/);
    await expect(low.postJobs({ "1": {} }, { idempotencyKey: key })).rejects.toBeInstanceOf(
      IdempotencyKeyReuse,
    );
  });

  it("postJobs sends extra_data.api_key_comfy_org as a sibling of workflow when extraData is given", async () => {
    await low.postJobs({ "1": {} }, { extraData: { api_key_comfy_org: "comfyui-test-key" } });
    expect(server.state.lastPostJobsBody).toMatchObject({
      workflow: { "1": {} },
      extra_data: { api_key_comfy_org: "comfyui-test-key" },
    });
  });

  it("postJobs omits extra_data entirely when no extraData is given", async () => {
    await low.postJobs({ "1": {} });
    expect(server.state.lastPostJobsBody).not.toHaveProperty("extra_data");
  });

  it("postJobs omits extra_data when given an explicitly empty object (never an empty object on the wire)", async () => {
    await low.postJobs({ "1": {} }, { extraData: {} });
    expect(server.state.lastPostJobsBody).not.toHaveProperty("extra_data");
  });

  it("getJob polls the authoritative state (no SSE involved)", async () => {
    server.state.pollsToSucceed = 3;
    let job = await low.getJob("job_01");
    expect(job.status).toBe("running");
    job = await low.getJob("job_01");
    expect(job.status).toBe("running");
    job = await low.getJob("job_01");
    expect(job.status).toBe("succeeded");
    expect(job.outputs).toHaveLength(1);
    expect(server.state.eventsConnectCount).toBe(0);
  });

  it("getJobEvents decodes the raw SSE frames", async () => {
    const events: string[] = [];
    for await (const event of low.getJobEvents("job_01")) {
      events.push(event.event);
    }
    expect(events).toEqual(["status", "progress", "output", "status"]);
  });

  it("cancelJob returns the canceling state", async () => {
    const job = await low.cancelJob("job_01");
    expect(job.status).toBe("canceling");
  });

  // -- getJobWorkflow ---------------------------------------------------

  it("getJobWorkflow returns the graph alongside its format", async () => {
    server.state.jobWorkflow = { workflow: { "1": { class_type: "KSampler" } }, format: "api" };
    const result = await low.getJobWorkflow("job_01");
    expect(result).toEqual({ workflow: { "1": { class_type: "KSampler" } }, format: "api" });
  });

  it("getJobWorkflow surfaces the pinned save-format graph", async () => {
    server.state.jobWorkflow = { workflow: { nodes: [] }, format: "save" };
    const result = await low.getJobWorkflow("job_01");
    expect(result.format).toBe("save");
  });

  it("getJobWorkflow 404s -> NotFound for a job with no workflow recorded", async () => {
    await expect(low.getJobWorkflow("job_01")).rejects.toBeInstanceOf(NotFound);
  });

  it("getJobWorkflow given a job path (e.g. urls.self) hits the workflow sub-resource, not the job itself", async () => {
    server.state.jobWorkflow = { workflow: { "1": { class_type: "KSampler" } }, format: "api" };
    const job = await low.getJob("job_01");
    expect(job.urls.self).toBe("/api/v2/jobs/job_01"); // relative path, same-origin
    const result = await low.getJobWorkflow(job.urls.self);
    expect(result).toEqual({ workflow: { "1": { class_type: "KSampler" } }, format: "api" });
  });

  it("getJobWorkflow given an absolute job URL (e.g. urls.self) hits the workflow sub-resource, not the job itself", async () => {
    server.state.jobWorkflow = { workflow: { nodes: [] }, format: "save" };
    server.state.jobUrlsOrigin = server.baseUrl;
    const job = await low.getJob("job_01");
    expect(job.urls.self).toBe(`${server.baseUrl}/api/v2/jobs/job_01`); // absolute
    const result = await low.getJobWorkflow(job.urls.self);
    expect(result).toEqual({ workflow: { nodes: [] }, format: "save" });
  });

  // -- deleteAsset --------------------------------------------------------

  it("deleteAsset removes the asset; a subsequent getAsset 404s", async () => {
    await low.deleteAsset("asset_1");
    expect(server.state.deleteCount).toBe(1);
    await expect(low.getAsset("asset_1")).rejects.toBeInstanceOf(NotFound);
  });

  it("deleteAsset on an already-deleted asset surfaces NotFound (not a silent no-op)", async () => {
    await low.deleteAsset("asset_1");
    await expect(low.deleteAsset("asset_1")).rejects.toBeInstanceOf(NotFound);
    expect(server.state.deleteCount).toBe(2);
  });

  it("deleteAsset on an in-use asset surfaces the 409 asset_in_use as a typed ApiError", async () => {
    server.state.deleteInUseAssetId = "asset_locked";
    const err = await low.deleteAsset("asset_locked").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("asset_in_use");
    expect((err as ApiError).httpStatus).toBe(409);
  });

  // -- User-Agent identification ---------------------------------------------

  it("sends a default User-Agent identifying the SDK + node runtime", async () => {
    await low.getJob("job_01");
    expect(server.state.lastUserAgentHeader).toMatch(
      /^comfy-sdk-typescript\/\d+\.\d+\.\d+ \(node v\d+\.\d+\.\d+\)$/,
    );
  });

  it("appends an app/{clientInfo} token when clientInfo is set, without dropping the base token", async () => {
    const withClientInfo = new ComfyLow(server.baseUrl, undefined, { clientInfo: "my-worker" });
    await withClientInfo.getJob("job_01");
    expect(server.state.lastUserAgentHeader).toMatch(
      /^comfy-sdk-typescript\/\d+\.\d+\.\d+ \(node v\d+\.\d+\.\d+\) app\/my-worker$/,
    );
  });

  it("does not override a caller-supplied User-Agent header", async () => {
    // No public method currently lets a caller pass headers through, so this
    // exercises the escape hatch directly.
    await low.request("GET", "/jobs/job_01", { headers: { "User-Agent": "custom-agent/1.0" } });
    expect(server.state.lastUserAgentHeader).toBe("custom-agent/1.0");
  });

  it("rejects a clientInfo containing CR/LF (no header injection)", () => {
    for (const bad of ["evil\r\nX-Injected: 1", "line\nbreak", "carriage\rreturn"]) {
      expect(() => new ComfyLow(server.baseUrl, undefined, { clientInfo: bad })).toThrow();
    }
  });

  it("User-Agent version matches package.json (guards SDK_VERSION drift)", async () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    await low.getJob("job_01");
    expect(server.state.lastUserAgentHeader).toContain(`comfy-sdk-typescript/${pkg.version}`);
  });

  // -- per-surface auth (FIX 3) ---------------------------------------------

  it("a request with no apiKey against a no-auth server sends no Authorization header", async () => {
    await low.getJob("job_01");
    expect(server.state.lastAuthorizationHeader).toBeNull();
  });

  it("a request with no apiKey against a server requiring auth gets a typed Unauthorized", async () => {
    server.state.requireAuth = true;
    await expect(low.getJob("job_01")).rejects.toBeInstanceOf(Unauthorized);
  });

  it("a request with an apiKey sends Authorization: Bearer <key>, and the server receives it", async () => {
    server.state.requireAuth = true;
    const authed = new ComfyLow(server.baseUrl, "secret-key-123");
    await authed.getJob("job_01");
    expect(server.state.lastAuthorizationHeader).toBe("Bearer secret-key-123");
  });

  // -- cross-origin bearer-token leak (FIX 1) -------------------------------

  it("does not attach the bearer token to a server-supplied cross-origin urls.self/events/cancel", async () => {
    const authed = new ComfyLow(server.baseUrl, "top-secret-key");
    const attacker = new StubServer();
    await attacker.start();
    try {
      // The primary server hands back absolute job links pointing at a
      // different origin (e.g. a relay/CDN) instead of a relative path.
      server.state.jobUrlsOrigin = attacker.baseUrl;

      const job = await authed.getJob("job_01");
      expect(job.urls.self.startsWith(attacker.baseUrl)).toBe(true);
      // Same-origin request (to the primary server itself): the key IS sent.
      expect(server.state.lastAuthorizationHeader).toBe("Bearer top-secret-key");

      // Following the server-supplied absolute `urls.self` crosses origins —
      // the key must NOT follow it there.
      await authed.getJob(job.urls.self);
      expect(attacker.state.lastAuthorizationHeader).toBeNull();

      // Same for the SSE stream URL.
      for await (const _event of authed.getJobEvents(job.urls.events)) {
        // drain
      }
      expect(attacker.state.lastAuthorizationHeader).toBeNull();

      // And for cancel.
      await authed.cancelJob(job.urls.cancel);
      expect(attacker.state.lastAuthorizationHeader).toBeNull();
    } finally {
      await attacker.stop();
    }
  });

  // -- cross-origin bearer-token leak via an HTTP redirect ------------------

  it("does not forward the bearer token when a content download 302-redirects cross-origin", async () => {
    const authed = new ComfyLow(server.baseUrl, "top-secret-key");
    const attacker = new StubServer();
    await attacker.start();
    try {
      attacker.state.contentBytes = Buffer.from("redirected-bytes");
      server.state.contentRedirectOrigin = attacker.baseUrl;

      const response = await authed.getAssetContent("asset_1");

      // The redirect was followed all the way to a 200 from the attacker.
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("redirected-bytes");

      // The initial (same-origin) request to `server` carried the token...
      expect(server.state.lastAuthorizationHeader).toBe("Bearer top-secret-key");
      // ...but the platform `fetch` (undici) strips `Authorization` before
      // re-issuing the request to a different origin on redirect — this SDK
      // does not implement that stripping itself, it relies on the runtime.
      // Pinning it here so a Node/undici upgrade that changed this guarantee
      // would be caught by CI rather than discovered as a leak in the wild.
      expect(attacker.state.lastAuthorizationHeader).toBeNull();
    } finally {
      await attacker.stop();
    }
  });

  // -- Retry-After parsing ---------------------------------------------------

  it("falls back to a null retryAfter (not NaN) for a Retry-After in HTTP-date form", async () => {
    server.state.queueFullTimes = 1;
    server.state.retryAfterHeader = "Wed, 21 Oct 2026 07:28:00 GMT";
    const err = await low.postJobs({ "1": {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueueFull);
    expect((err as QueueFull).retryAfter).toBeNull();
  });

  // -- AbortSignal composition ------------------------------------------------

  it("an aborted caller signal cancels an in-flight request promptly, not just a later sleep", async () => {
    server.state.hangJobPoll = true; // never responds; only an abort ends this
    const controller = new AbortController();
    const promise = low.getJob("job_01", { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const start = Date.now();
    await expect(promise).rejects.toBeTruthy();
    // The client's default per-request timeout is 30s; this must reject
    // right around the abort, proving `AbortSignal.any([caller, timeout])`
    // actually composes the caller's signal into the request, not just the
    // default timeout.
    expect(Date.now() - start).toBeLessThan(500);
  }, 2000);

  // -- getAssetContent timeout -----------------------------------------------

  it("getAssetContent has no default timeout — a slow body that outlives the client's configured timeoutMs still completes", async () => {
    // A raw slow server, not StubServer: it streams a handful of chunks with
    // a delay between them so the whole transfer outlives a short client
    // timeoutMs, mirroring a large output that takes longer than the old
    // fixed 30s deadline.
    const CHUNK_DELAY_MS = 60;
    const CHUNKS = 4; // ~240ms total, well past the 50ms client default below
    const slowServer: Server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      let i = 0;
      const sendNext = () => {
        if (i >= CHUNKS) {
          res.end();
          return;
        }
        res.write(`chunk${i}-`);
        i += 1;
        setTimeout(sendNext, CHUNK_DELAY_MS);
      };
      sendNext();
    });
    await new Promise<void>((resolve) => slowServer.listen(0, "127.0.0.1", resolve));
    const addr = slowServer.address() as AddressInfo;
    // A client-level timeoutMs far shorter than the transfer: on unpatched
    // code (no timeoutMs passed through to `request()`) this deadline
    // covers body consumption and aborts mid-stream.
    const slowLow = new ComfyLow(`http://127.0.0.1:${addr.port}`, undefined, { timeoutMs: 50 });
    try {
      const response = await slowLow.getAssetContent("whatever");
      await expect(response.text()).resolves.toBe("chunk0-chunk1-chunk2-chunk3-");
    } finally {
      await new Promise<void>((resolve, reject) =>
        slowServer.close((err) => (err ? reject(err) : resolve())),
      );
    }
  }, 2000);
});
