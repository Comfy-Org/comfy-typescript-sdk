import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BASE_URL_ENV_VAR,
  Comfy,
  comfy,
  ComfyError,
  config,
  Job,
  Asset,
  models,
  routerErrors,
  Unauthorized,
  Workflow,
} from "./index.js";

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

  it("re-exports the module-level namespace from the package root", () => {
    // The root is what `@comfyorg/sdk` resolves to, so both documented import
    // shapes — `import { comfy }` and `import * as comfy` — are covered here.
    expect(comfy.config).toBe(config);
    expect(comfy.models).toBe(models);
    expect(comfy.models.run).toBeTypeOf("function");
  });

  it("re-exports the Router error namespace from the package root", () => {
    expect(routerErrors.RouterError).toBeTypeOf("function");
    expect(routerErrors.ROUTER_ERROR_TYPES).toHaveLength(15);
    expect(new routerErrors.ContentPolicyViolation("boom")).toBeInstanceOf(
      routerErrors.RouterError,
    );
  });

  it("keeps the three colliding names distinct from the workflow-API exceptions", () => {
    // `Unauthorized` at the root is a workflow-API `ComfyError`;
    // `routerErrors.Unauthorized` is a `RouterError`. Same spelling as the
    // Python SDK's, unrelated classes, so neither may answer for the other.
    expect(routerErrors.Unauthorized).not.toBe(Unauthorized);
    expect(new routerErrors.Unauthorized("boom")).not.toBeInstanceOf(Unauthorized);
    expect(new Unauthorized("boom")).not.toBeInstanceOf(routerErrors.RouterError);
  });

  it("exports the idiomatic classes and the shared error base", () => {
    expect(Job).toBeTypeOf("function");
    expect(Asset).toBeTypeOf("function");
    expect(Workflow).toBeTypeOf("function");
    expect(new ComfyError("boom")).toBeInstanceOf(Error);
  });
});
