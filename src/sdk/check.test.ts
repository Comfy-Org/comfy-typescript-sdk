import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StubServer } from "../../test/support/stub-server.js";
import { BASE_URL_ENV_VAR, Comfy } from "./client.js";
import { CREDENTIALS_ENV_VAR } from "./credentials.js";
import { ComfyError, Unauthorized } from "./exceptions.js";

const ZERO = "00000000-0000-0000-0000-000000000000";
const JOB_NOT_FOUND = {
  status: 404,
  contentType: "application/json",
  body: JSON.stringify({ error: { code: "job_not_found", message: "no such job" } }),
};

describe("Comfy.check", () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
    vi.stubEnv(BASE_URL_ENV_VAR, server.baseUrl);
    vi.stubEnv(CREDENTIALS_ENV_VAR, undefined);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await server.stop();
  });

  it("passes on job_not_found and runs nothing", async () => {
    server.state.jobGetRaw = JOB_NOT_FOUND;
    const result = await new Comfy({ apiKey: "comfyui-test" }).check();
    expect(result).toEqual({ baseUrl: server.baseUrl, authenticated: true });
    expect(server.state.jobGetIds).toEqual([ZERO]);
    expect(server.state.submitCount).toBe(0);
    expect(server.state.lastAuthorizationHeader).toBe("Bearer comfyui-test");
  });

  it("passes unauthenticated against a keyless self-hosted proxy", async () => {
    server.state.jobGetRaw = JOB_NOT_FOUND;
    expect((await new Comfy().check()).authenticated).toBe(false);
  });

  it("throws Unauthorized for a rejected key", async () => {
    server.state.requireAuth = true;
    await expect(new Comfy().check()).rejects.toBeInstanceOf(Unauthorized);
  });

  it.each([
    [
      "a bare 404",
      {
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "not_found", message: "Not Found" } }),
      },
    ],
    ["a web page", { status: 200, contentType: "text/html", body: "<!doctype html><html></html>" }],
  ])("throws not_a_comfy_api for %s", async (_label, raw) => {
    server.state.jobGetRaw = raw;
    const err = await new Comfy({ apiKey: "comfyui-test" }).check().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComfyError);
    expect((err as ComfyError).code).toBe("not_a_comfy_api");
    expect((err as ComfyError).message).toContain(BASE_URL_ENV_VAR);
  });

  it("treats a job for the probe id as an invalid response", async () => {
    const err = await new Comfy().check().catch((e: unknown) => e);
    expect((err as ComfyError).code).toBe("invalid_response");
  });

  it("keeps a server error's own code", async () => {
    server.state.jobGetRaw = {
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "service_unavailable", message: "down" } }),
    };
    const err = await new Comfy().check().catch((e: unknown) => e);
    expect((err as ComfyError).code).toBe("service_unavailable");
    expect((err as ComfyError).httpStatus).toBe(503);
  });

  it("never puts the key in the result", async () => {
    server.state.jobGetRaw = JOB_NOT_FOUND;
    const result = await new Comfy({ apiKey: "comfyui-secret-value" }).check();
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
