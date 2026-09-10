/**
 * Drift check for the Router route `comfy.models.run` posts to, against the
 * vendored Router contract.
 *
 * `src/sdk/router-spec-coverage.test.ts` beside this one pins the `error_type`
 * table to the same file. This pins the other hand-written thing coupled to
 * it, and the one whose drift is silent: the ROUTE. `RUN_ROUTE_TEMPLATE` and
 * `COMFY_ROUTER_BASE_URL` are the SDK's copy of the path and host that
 * contract declares, and until this test existed nothing compared them — a
 * sync that moved `/v2/models/{provider}/{model}` (a version bump, a rename)
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

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  readRouterRouteContract,
  ROUTER_SPEC_PATH,
  templatePlaceholders,
} from "../../scripts/router-route-contract.mjs";
import { withRouterStub } from "../../test/support/router-stub-server.js";
import { comfy } from "./comfy.js";
import { COMFY_ROUTER_BASE_URL, config } from "./credentials.js";
import {
  MODEL_REQUEST_CANCEL_ROUTE_TEMPLATE,
  MODEL_REQUEST_ROUTE_TEMPLATE,
  MODEL_REQUEST_STATUS_ROUTE_TEMPLATE,
  MODEL_REQUESTS_ROUTE_TEMPLATE,
} from "./modelRequests.js";
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
        "RUN_ROUTE_TEMPLATE in src/sdk/models.ts and parseModelId in src/sdk/modelRoutes.ts " +
        "both assume " +
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
        await comfy.models.run("bfl/flux-2-pro", {});
      } finally {
        config({ credentials: undefined, baseUrl: undefined });
      }
      expect(server.state.lastPath).toBe(
        RUN_ROUTE_TEMPLATE.replace("{provider}", "bfl").replace("{model}", "flux-2-pro"),
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
      expect(server.state.lastPath).toBe("/v2/models/fal%20ai/flux%23pro");
    });
  });
});

/**
 * The four QUEUE routes (`comfy.models.submit` and the handle it returns) are
 * not in the vendored contract yet — the operations are authored upstream but
 * held, and the one-way sync strips a held operation. So there is nothing in
 * `spec/router-openapi.yaml` to compare them against, and the pin has to be a
 * RELATION instead: each one is the run route plus a fixed suffix under a
 * `requests` collection, which is how the Python SDK binds the same four.
 *
 * That relation is worth pinning even without a spec, because it is what makes
 * a sync that moves the RUN route move these too — the failure mode it closes
 * is the run route being updated and the queue routes silently left behind,
 * 404ing every `submit` while `run` works.
 *
 * The last test here is the rot guard: it fails the day the vendored contract
 * DOES declare the collection, which is the signal to replace this whole block
 * with a comparison against the spec — the same shape the run route already
 * gets above.
 */
describe("queued model-request routes (not yet in spec/router-openapi.yaml)", () => {
  it("extends the run route with a `requests` collection", () => {
    expect(MODEL_REQUESTS_ROUTE_TEMPLATE).toBe(`${RUN_ROUTE_TEMPLATE}/requests`);
    expect(MODEL_REQUEST_ROUTE_TEMPLATE).toBe(`${MODEL_REQUESTS_ROUTE_TEMPLATE}/{request_id}`);
    expect(MODEL_REQUEST_STATUS_ROUTE_TEMPLATE).toBe(`${MODEL_REQUEST_ROUTE_TEMPLATE}/status`);
    expect(MODEL_REQUEST_CANCEL_ROUTE_TEMPLATE).toBe(`${MODEL_REQUEST_ROUTE_TEMPLATE}/cancel`);
  });

  it("addresses each route with `provider`, `model`, then `request_id`", async () => {
    // Positional, exactly as the run route's two segments are: a template that
    // carried the right names in the wrong order would still fill in and still
    // address a different request.
    const { parameterNames } = await readRouterRouteContract();
    expect(templatePlaceholders(MODEL_REQUESTS_ROUTE_TEMPLATE)).toEqual(parameterNames);
    for (const template of [
      MODEL_REQUEST_ROUTE_TEMPLATE,
      MODEL_REQUEST_STATUS_ROUTE_TEMPLATE,
      MODEL_REQUEST_CANCEL_ROUTE_TEMPLATE,
    ]) {
      expect(templatePlaceholders(template)).toEqual([...parameterNames, "request_id"]);
    }
  });

  it("still has nothing in the vendored contract to be pinned against", async () => {
    // The rot guard. When this fails, the queue operations have arrived in the
    // vendored spec: read their paths out of it the way `readRouterRouteContract`
    // reads `runRouterModel`'s, and compare the four constants against THOSE
    // instead of against the relation above.
    const doc = parse(await readFile(ROUTER_SPEC_PATH, "utf-8")) as {
      paths?: Record<string, unknown>;
    };
    const queuePaths = Object.keys(doc.paths ?? {}).filter((path) => path.includes("/requests"));
    expect(
      queuePaths,
      "spec/router-openapi.yaml now declares the queued model-request routes — pin the four " +
        "MODEL_REQUEST* constants in src/sdk/modelRequests.ts against the spec and delete the " +
        "relation assertions in this block",
    ).toEqual([]);
  });
});
