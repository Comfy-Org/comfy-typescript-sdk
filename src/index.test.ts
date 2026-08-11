import { describe, expect, it } from "vitest";

import { Comfy, ComfyError, Job, Asset, Workflow } from "./index.js";

describe("public surface", () => {
  it("constructs a client and exposes assets/workflows/jobs namespaces", () => {
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
