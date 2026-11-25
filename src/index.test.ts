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
  RateLimited,
  routerErrors,
  Unauthorized,
  Workflow,
} from "./index.js";

describe("public surface", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("constructs a client and exposes assets/workflows/jobs namespaces", () => {
    // An invalid COMFY_BASE_URL in the ambient shell would otherwise throw
    // here; the key is explicit so the ambient COMFY_API_KEY is never read.
    vi.stubEnv(BASE_URL_ENV_VAR, undefined);
    const client = new Comfy({ apiKey: "comfyui-surface-test" });
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
    expect(routerErrors.ROUTER_ERROR_TYPES).toHaveLength(23);
    // The length assertion above counts the closed set but cannot say the new
    // members reached the package ROOT — a class added to the set and missed by
    // the re-export would keep that count at 23 and still be unreachable to a
    // caller writing `import { routerErrors }`. Name the newest buckets' classes.
    expect(routerErrors.BudgetExceeded).toBeTypeOf("function");
    expect(routerErrors.BudgetCheckUnavailable).toBeTypeOf("function");
    expect(new routerErrors.ContentPolicyViolation("boom")).toBeInstanceOf(
      routerErrors.RouterError,
    );
  });

  it("keeps the four colliding names distinct from the workflow-API exceptions", () => {
    // `Unauthorized` at the root is a workflow-API `ComfyError`;
    // `routerErrors.Unauthorized` is a `RouterError`. Unrelated classes, so
    // neither may answer for the other — unlike the Python SDK, which shares
    // one class object per name (see `router-errors-namespaced` in
    // `surface-parity.test.ts`).
    expect(routerErrors.Unauthorized).not.toBe(Unauthorized);
    expect(new routerErrors.Unauthorized("boom")).not.toBeInstanceOf(Unauthorized);
    expect(new Unauthorized("boom")).not.toBeInstanceOf(routerErrors.RouterError);
    // The same holds for the v2 `rate_limited` code and the Router bucket.
    expect(routerErrors.RateLimited).not.toBe(RateLimited);
    expect(new routerErrors.RateLimited("boom")).not.toBeInstanceOf(RateLimited);
    expect(new RateLimited("boom")).not.toBeInstanceOf(routerErrors.RouterError);
    expect(new RateLimited("boom")).toBeInstanceOf(ComfyError);
  });

  it("exports the idiomatic classes and the shared error base", () => {
    expect(Job).toBeTypeOf("function");
    expect(Asset).toBeTypeOf("function");
    expect(Workflow).toBeTypeOf("function");
    expect(new ComfyError("boom")).toBeInstanceOf(Error);
  });
});
