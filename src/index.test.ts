import { afterEach, describe, expect, it, vi } from "vitest";

import { BASE_URL_ENV_VAR, Comfy, ComfyError, Job, Asset, Workflow } from "./index.js";

describe("public surface", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("constructs a client and exposes assets/workflows/jobs namespaces", () => {
    // An invalid COMFY_BASE_URL in the ambient shell would otherwise throw here.
    vi.stubEnv(BASE_URL_ENV_VAR, undefined);
    const client = new Comfy();
    expect(client).toBeInstanceOf(Comfy);
    expect(client.assets).toBeDefined();
    expect(client.workflows).toBeDefined();
    expect(client.jobs).toBeDefined();
  });

  it("exports the idiomatic classes and the shared error base", () => {
    expect(Job).toBeTypeOf("function");
    expect(Asset).toBeTypeOf("function");
    expect(Workflow).toBeTypeOf("function");
    expect(new ComfyError("boom")).toBeInstanceOf(Error);
  });
});
