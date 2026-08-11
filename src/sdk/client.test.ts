import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StubServer } from "../../test/support/stub-server.js";
import { BASE_URL_ENV_VAR, Comfy } from "./client.js";
import { IdempotencyKeyReuse, QueueFull, WorkflowFormatUi } from "./exceptions.js";

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
