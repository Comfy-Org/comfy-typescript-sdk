import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StubServer } from "../../test/support/stub-server.js";
import { ApiError, ComfyLow } from "../low/index.js";
import { ComfyError, NotFound } from "./exceptions.js";
import { JobFactory } from "./jobs.js";
import { Output } from "./outputs.js";

describe("Output", () => {
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

  function outputWithId(id: string): Output {
    return new Output(
      {
        node_id: "13",
        name: "out.png",
        type: "image",
        content_type: "image/png",
        size_bytes: 10,
        id,
        hash: null,
        url: "http://example.invalid/out",
        url_expires_at: "2026-07-10T19:20:00Z",
      },
      low,
    );
  }

  function output(): Output {
    return outputWithId("asset_out_01");
  }

  it("exposes the low-level output fields", () => {
    const out = output();
    expect(out.nodeId).toBe("13");
    expect(out.name).toBe("out.png");
    expect(out.type).toBe("image");
    expect(out.id).toBe("asset_out_01");
    expect(out.sizeBytes).toBe(10);
    expect(out.contentType).toBe("image/png");
    // The fixture model above carries no job_id.
    expect(out.jobId).toBeUndefined();
  });

  it("jobId reflects the producing job's id, once resolved through a real job poll", async () => {
    const job = await new JobFactory(low).get("job_producer_01");
    await job.result();
    expect(job.outputs[0]?.jobId).toBe("job_producer_01");
  });

  it("toFile streams the full content to disk", async () => {
    server.state.contentBytes = Buffer.from("full-output-bytes");
    const dir = await mkdtemp(join(tmpdir(), "comfy-sdk-out-"));
    const path = join(dir, "out.png");
    try {
      await output().toFile(path);
      const written = await readFile(path);
      expect(written.toString()).toBe("full-output-bytes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("toFile honors a byte range", async () => {
    server.state.contentBytes = Buffer.from("0123456789");
    const dir = await mkdtemp(join(tmpdir(), "comfy-sdk-out-"));
    const path = join(dir, "out.bin");
    try {
      await output().toFile(path, { range: [3, 5] });
      const written = await readFile(path);
      expect(written.toString()).toBe("345");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // -- getDownloadUrl -----------------------------------------------------

  it("getDownloadUrl returns this output's content URL with a null expiresAt on a self-hosted backend", async () => {
    server.state.contentBytes = Buffer.from("bytes");
    const result = await output().getDownloadUrl();
    expect(result.url).toBe(`${server.baseUrl}/api/v2/assets/asset_out_01/content`);
    expect(result.expiresAt).toBeNull();
  });

  it("getDownloadUrl surfaces the signed URL + expiresAt when the backend redirects (Cloud/serverless)", async () => {
    const signedUrl =
      "https://storage.googleapis.com/bucket/o?X-Goog-Date=20260722T000000Z&X-Goog-Expires=60";
    server.state.contentRedirectLocation = signedUrl;
    const result = await output().getDownloadUrl();
    expect(result.url).toBe(signedUrl);
    expect(result.expiresAt).toEqual(new Date("2026-07-22T00:01:00.000Z"));
  });

  // -- error translation ---------------------------------------------------
  // A deleted asset 404s at every download method; the raw `low.ApiError`
  // must surface as the SDK's typed NotFound (extends ComfyError), not leak
  // through untranslated the way it did before `translate()` was wired in.

  it("toFile raises the SDK's NotFound, not the raw low.ApiError, for a deleted asset", async () => {
    server.state.deletedAssets.add("asset_out_01");
    const dir = await mkdtemp(join(tmpdir(), "comfy-sdk-out-"));
    try {
      const err = await output()
        .toFile(join(dir, "out.png"))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotFound);
      expect(err).toBeInstanceOf(ComfyError);
      expect(err).not.toBeInstanceOf(ApiError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("toBytes raises the SDK's NotFound, not the raw low.ApiError, for a deleted asset", async () => {
    server.state.deletedAssets.add("asset_out_01");
    const err = await output()
      .toBytes()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFound);
    expect(err).toBeInstanceOf(ComfyError);
    expect(err).not.toBeInstanceOf(ApiError);
  });

  it("getDownloadUrl raises the SDK's NotFound, not the raw low.ApiError, for a deleted asset", async () => {
    server.state.deletedAssets.add("asset_out_01");
    const err = await output()
      .getDownloadUrl()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFound);
    expect(err).toBeInstanceOf(ComfyError);
    expect(err).not.toBeInstanceOf(ApiError);
  });

  it("getDownloadUrl resolves each output of a multi-output job to its own distinct URL", async () => {
    server.state.contentBytes = Buffer.from("bytes");
    const outA = outputWithId("asset_out_a");
    const outB = outputWithId("asset_out_b");
    const [a, b] = await Promise.all([outA.getDownloadUrl(), outB.getDownloadUrl()]);
    expect(a.url).not.toBe(b.url);
    expect(a.url).toBe(`${server.baseUrl}/api/v2/assets/asset_out_a/content`);
    expect(b.url).toBe(`${server.baseUrl}/api/v2/assets/asset_out_b/content`);
    expect(a.expiresAt).toBeNull();
    expect(b.expiresAt).toBeNull();
  });
});
