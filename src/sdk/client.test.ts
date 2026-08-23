import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StubServer } from "../../test/support/stub-server.js";
import { abortableSleep } from "./abortable-sleep.js";
import { BASE_URL_ENV_VAR, Comfy } from "./client.js";
import { IdempotencyKeyReuse, QueueFull, WorkflowFormatUi } from "./exceptions.js";

// Spies on (not replaces) abortableSleep by default, so every other test
// here still sleeps for real; only the clamp test below overrides a single
// call to avoid actually waiting out a 24h Retry-After.
vi.mock("./abortable-sleep.js", { spy: true });

describe("Comfy", () => {
  let server: StubServer;
  let client: Comfy;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
    // Clients read their target from the environment, so pointing them at the
    // stub is part of standing it up.
    vi.stubEnv(BASE_URL_ENV_VAR, server.baseUrl);
    client = new Comfy();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await server.stop();
    vi.mocked(abortableSleep).mockClear();
  });

  it("rejects a UI-format workflow before any network call", async () => {
    const wf = client.workflows.fromJson({ nodes: [], links: [], last_node_id: 0 });
    await expect(client.submit(wf)).rejects.toBeInstanceOf(WorkflowFormatUi);
    expect(server.state.submitCount).toBe(0);
  });

  it("substitutes an asset handle into a core/ASSET reference on submit", async () => {
    const wf = client.workflows.fromJson({ "1": { inputs: {} } });
    const asset = client.assets.fromBytes(new Uint8Array([1, 2, 3]), { filename: "in.png" });
    wf.setInput("1", "image", asset);

    await client.submit(wf);

    const submitted = server.state.lastWorkflow as Record<string, { inputs: { image: unknown } }>;
    expect(submitted["1"].inputs.image).toEqual({
      __type: "core/ASSET",
      info: { id: asset.id, hash: expect.any(String), file_path: "in.png" },
    });
  });

  it("submit() with apiKey sends extra_data.api_key_comfy_org alongside workflow", async () => {
    const wf = client.workflows.fromJson({ "1": {} });
    await client.submit(wf, { apiKey: "comfyui-test-key" });

    expect(server.state.lastPostJobsBody).toMatchObject({
      extra_data: { api_key_comfy_org: "comfyui-test-key" },
    });
  });

  it("submit() without apiKey sends no extra_data key at all", async () => {
    const wf = client.workflows.fromJson({ "1": {} });
    await client.submit(wf);

    expect(server.state.lastPostJobsBody).not.toBeNull();
    expect(server.state.lastPostJobsBody).not.toHaveProperty("extra_data");
  });

  it("submit() with an empty-string apiKey sends no extra_data (matches the Python SDK)", async () => {
    const wf = client.workflows.fromJson({ "1": {} });
    await client.submit(wf, { apiKey: "" });

    expect(server.state.lastPostJobsBody).not.toBeNull();
    expect(server.state.lastPostJobsBody).not.toHaveProperty("extra_data");
  });

  it("run() submits and polls to completion end-to-end", async () => {
    server.state.pollsToSucceed = 2;
    const wf = client.workflows.fromJson({ "1": {} });
    const job = await client.run(wf);
    expect(job.status).toBe("succeeded");
    const outputs = job.getOutputs("13");
    expect(outputs).toHaveLength(1);
  });

  it("submit() retries a queue_full response using Retry-After, transparently", async () => {
    server.state.queueFullTimes = 2;
    const wf = client.workflows.fromJson({ "1": {} });
    const job = await client.submit(wf);
    expect(job.status).toBe("queued");
    expect(server.state.submitCount).toBe(3); // 2 queue_full + 1 success
  });

  it("submit() retries a queue_full response with no Retry-After header at all, using the default pause", async () => {
    server.state.queueFullTimes = 1;
    server.state.omitQueueFullRetryAfter = true; // header truly absent, not empty
    const wf = client.workflows.fromJson({ "1": {} });
    const start = Date.now();
    const job = await client.submit(wf);
    expect(job.status).toBe("queued");
    expect(server.state.submitCount).toBe(2); // 1 queue_full (no Retry-After) + 1 success
    // DEFAULT_RETRY_AFTER_S (2s) fallback must actually run, not be skipped —
    // this is the regression a dropped fallback (retryDelayS = exc.retryAfter
    // ?? null, with no QueueFull special-case) would produce: submit() would
    // throw on the first attempt instead of retrying at all.
    expect(Date.now() - start).toBeGreaterThanOrEqual(1900);
  }, 4000);

  it("submit() retries any 429 with Retry-After, not just queue_full (e.g. a serverless deployment_not_ready cold start)", async () => {
    server.state.queueFullTimes = 2;
    server.state.queueFullCode = "deployment_not_ready";
    const wf = client.workflows.fromJson({ "1": {} });
    const job = await client.submit(wf);
    expect(job.status).toBe("queued");
    expect(server.state.submitCount).toBe(3); // 2 x deployment_not_ready + 1 success
  });

  it.each(["-1", "NaN"])(
    "submit() uses the default pause for invalid Retry-After %s",
    async (value) => {
      server.state.queueFullTimes = 1;
      server.state.retryAfterHeader = value;
      vi.mocked(abortableSleep).mockImplementationOnce(() => Promise.resolve());
      const wf = client.workflows.fromJson({ "1": {} });

      await client.submit(wf);

      expect(abortableSleep).toHaveBeenCalledWith(2_000, undefined);
      expect(server.state.submitCount).toBe(2);
    },
  );

  it("submit() clamps a 429 Retry-After far larger than the retry budget, instead of sleeping past it", async () => {
    server.state.queueFullTimes = 1;
    server.state.retryAfterHeader = "86400"; // 24h — a malicious/misbehaving server value
    // Only this one call is overridden to resolve instantly; the mock still
    // records the ms it was asked to sleep, which is what's under test —
    // actually waiting out the clamp (up to 60s) would make this test slow
    // without adding coverage the captured value doesn't already give us.
    vi.mocked(abortableSleep).mockImplementationOnce(() => Promise.resolve());
    const wf = client.workflows.fromJson({ "1": {} });
    const job = await client.submit(wf);
    expect(job.status).toBe("queued");
    expect(abortableSleep).toHaveBeenCalledTimes(1);
    const [ms] = vi.mocked(abortableSleep).mock.calls[0];
    // QUEUE_RETRY_BUDGET_MS is 60_000ms; retryDelayS * 1000 would be
    // 86_400_000ms unclamped — the regression this guards against.
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(60_000);
  });

  it("submit() rejects a reused idempotency key (single-use, no replay)", async () => {
    const wf = client.workflows.fromJson({ "1": {} });
    const key = "same-key-please";
    const first = await client.submit(wf, { idempotencyKey: key });
    expect(first.id).toMatch(/^job_/);
    await expect(client.submit(wf, { idempotencyKey: key })).rejects.toBeInstanceOf(
      IdempotencyKeyReuse,
    );
  });

  it("propagates job_error as a typed, non-QueueFull error immediately", async () => {
    server.state.jobError = { status: 422, code: "invalid_workflow" };
    const wf = client.workflows.fromJson({ "1": {} });
    await expect(client.submit(wf)).rejects.not.toBeInstanceOf(QueueFull);
    expect(server.state.submitCount).toBe(1); // no retry loop for a non-queue_full error
  });

  it("run() with a timeoutMs that elapses before completion rejects with the raw wait() timeout, not JobFailed", async () => {
    server.state.pollsToSucceed = 1_000_000; // never terminal within the test
    const wf = client.workflows.fromJson({ "1": {} });
    // A deadline shorter than the first poll backoff step (500ms) so it
    // trips on the very first check, keeping the test fast.
    await expect(client.run(wf, { timeoutMs: 50 })).rejects.toThrow(/not terminal after 50ms/);
  });

  it("downloads a byte range of an output", async () => {
    server.state.contentBytes = Buffer.from("abcdefghij");
    server.state.pollsToSucceed = 1;
    const wf = client.workflows.fromJson({ "1": {} });
    const job = await client.run(wf);
    const bytes = await job.getOutputs("13")[0].toBytes({ range: [0, 3] });
    expect(Buffer.from(bytes).toString()).toBe("abcd");
  });
});
