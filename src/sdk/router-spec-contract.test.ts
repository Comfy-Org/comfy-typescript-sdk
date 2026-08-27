/**
 * Drift check for the Router route `comfy.models.run` posts to, against the
 * vendored Router contract.
 *
 * `src/sdk/router-spec-coverage.test.ts` beside this one pins the `error_type`
 * table to the same file. This pins the other hand-written thing coupled to
 * it, and the one whose drift is silent: the ROUTE. `RUN_ROUTE_TEMPLATE` and
 * `COMFY_ROUTER_BASE_URL` are the SDK's copy of the path and host that
 * contract declares, and until this test existed nothing compared them — a
 * sync that moved `/v1/models/{provider}/{model}` (a version bump, a rename)
 * would land green and `models.run` would 404 at runtime against a route the
 * SDK still spelled the old way. Nothing is generated from this spec, so there
 * is nothing to regenerate and byte-diff; the drift check is a comparison
 * instead, exactly as it is for the error buckets.
 *
 * The same two assertions also run inside `pnpm check:spec-drift`, so the
 * drift job reddens by name too rather than only the unit suite. That job
 * reads the constants out of the source text (no TypeScript loader in plain
 * Node); this test imports them, so it is the half that proves the value the
 * SDK actually builds a URL from — not just the value its source spells.
 *
 * When a sync PR legitimately moves the route, update `RUN_ROUTE_TEMPLATE` in
 * `./models.ts` (and `COMFY_ROUTER_BASE_URL` in `./credentials.ts` for the
 * host). Never patch `spec/router-openapi.yaml` to match the SDK — it is a
 * one-way vendored copy, and the SDK is the side that follows.
 */

import { describe, expect, it } from "vitest";

import {
  readRouterRouteContract,
  templatePlaceholders,
} from "../../scripts/router-route-contract.mjs";
import { withRouterStub } from "../../test/support/router-stub-server.js";
import { comfy } from "./comfy.js";
import { COMFY_ROUTER_BASE_URL, config } from "./credentials.js";
import { RUN_ROUTE_TEMPLATE } from "./models.js";

describe("router route contract (spec/router-openapi.yaml)", () => {
  it("spells RUN_ROUTE_TEMPLATE the path the contract declares for runRouterModel", async () => {
    const { runPath } = await readRouterRouteContract();
    expect(
      runPath,
      "the vendored Router contract moved the runRouterModel path — update RUN_ROUTE_TEMPLATE " +
        "in src/sdk/models.ts to match it (comfy.models.run 404s until you do)",
    ).toBe(RUN_ROUTE_TEMPLATE);
  });

  it("spells COMFY_ROUTER_BASE_URL the host the contract declares", async () => {
    const { serverUrl } = await readRouterRouteContract();
    expect(
      serverUrl,
      "the vendored Router contract moved servers[0].url — update COMFY_ROUTER_BASE_URL in " +
        "src/sdk/credentials.ts to match it",
    ).toBe(COMFY_ROUTER_BASE_URL);
  });

  it("addresses the route with `provider` then `model`, in that order", async () => {
    // The two segments are positional, so a contract that renamed or swapped
    // them would still contain both names while addressing a different model.
    // Asserted on both sides of the comparison: the contract's declared path
    // parameters, and the placeholders RUN_ROUTE_TEMPLATE actually fills.
    const { parameterNames } = await readRouterRouteContract();
    expect(
      parameterNames,
      "the vendored Router contract changed the runRouterModel path parameters — " +
        "RUN_ROUTE_TEMPLATE and parseModelId in src/sdk/models.ts both assume " +
        "`{provider}` then `{model}`",
    ).toEqual(["provider", "model"]);
    expect(templatePlaceholders(RUN_ROUTE_TEMPLATE)).toEqual(parameterNames);
  });

  it("sends a real request to the path the template fills in", async () => {
    // The constant is only worth pinning if it is what the call actually uses,
    // and `runUrl`/`fillRoute` are module-private — so this closes the loop the
    // only way that proves it: run a call and read the path off the wire.
    // Without it the two assertions above would agree with the contract while
    // `runUrl` built its URL from something else entirely.
    await withRouterStub(async (server) => {
      config({ credentials: "comfyui-test-credential", baseUrl: server.baseUrl });
      try {
        await comfy.models.run("fal-ai/flux-pro", {});
      } finally {
        config({ credentials: undefined, baseUrl: undefined });
      }
      expect(server.state.lastPath).toBe(
        RUN_ROUTE_TEMPLATE.replace("{provider}", "fal-ai").replace("{model}", "flux-pro"),
      );
    });
  });

  it("percent-encodes each segment rather than letting one add a path segment", async () => {
    // `req.url` is the raw request target, so an unencoded `/` or space would
    // show up here as one. The encoding moved into `fillRoute` with the
    // template; this is the assertion that it moved intact.
    await withRouterStub(async (server) => {
      config({ credentials: "comfyui-test-credential", baseUrl: server.baseUrl });
      try {
        await comfy.models.run("fal ai/flux#pro", {});
      } finally {
        config({ credentials: undefined, baseUrl: undefined });
      }
      expect(server.state.lastPath).toBe("/v1/models/fal%20ai/flux%23pro");
    });
  });
});
