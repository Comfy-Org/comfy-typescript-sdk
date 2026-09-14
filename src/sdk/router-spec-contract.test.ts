/**
 * Drift check for the Router routes this SDK calls, against the vendored
 * Router contract — and, since the discovery methods landed, for the ones it
 * does NOT call.
 *
 * Two halves. The first pins each route's path template. The second, at the
 * bottom of the file, is ROUTE COVERAGE: every operation the contract declares
 * maps to a `comfy.models` method or to a written-down reason there is none,
 * so the next route a sync adds fails CI rather than sitting unreachable. That
 * second half exists because its failure mode already happened — the catalog
 * and per-model-schema routes were in this contract from the day it was
 * vendored, with no SDK method for either and no check that could see it.
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
  readRouterOperations,
  readRouterRouteContract,
  routerOperations,
  ROUTER_SPEC_PATH,
  templatePlaceholders,
} from "../../scripts/router-route-contract.mjs";
import { withRouterStub } from "../../test/support/router-stub-server.js";
import { comfy } from "./comfy.js";
import { COMFY_ROUTER_BASE_URL, config } from "./credentials.js";
import {
  CATALOG_ROUTE_TEMPLATE,
  models,
  RUN_ROUTE_TEMPLATE,
  SCHEMA_ROUTE_TEMPLATE,
} from "./models.js";
import {
  MODEL_REQUEST_CANCEL_ROUTE_TEMPLATE,
  MODEL_REQUEST_ROUTE_TEMPLATE,
  MODEL_REQUEST_STATUS_ROUTE_TEMPLATE,
  MODEL_REQUESTS_ROUTE_TEMPLATE,
} from "./modelRequests.js";
import { isCollectable } from "./retry.js";

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

  it("collects on exactly the statuses the contract paces with a Retry-After", async () => {
    // `isCollectable` accepts a same-key resend on a 409 and a 504 and on
    // nothing else. That is not a choice this SDK gets to make: Router sends
    // `Retry-After` only where it still holds a generation the key can
    // collect, so the predicate's status set has to BE the contract's. A sync
    // that moved the header — onto a 429, or off the 409 — would otherwise
    // leave the SDK resending an answer nothing blesses.
    const { retryAfterStatuses } = await readRouterRouteContract();
    expect(
      retryAfterStatuses,
      "the vendored Router contract moved `Retry-After` on runRouterModel — update " +
        "isCollectable in src/sdk/retry.ts to match it",
    ).toEqual([409, 504]);

    // And the bucket gates, which are what separate the collectable member of
    // each shared status from the refusal beside it.
    for (const status of retryAfterStatuses) {
      const bucket = status === 409 ? "concurrency_limit_exceeded" : "deadline_exceeded";
      expect(isCollectable(status, bucket, 2), String(status)).toBe(true);
      expect(isCollectable(status, null, 2), String(status)).toBe(false);
      expect(isCollectable(status, bucket, null), String(status)).toBe(false);
    }
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
 * Every operation the vendored contract declares, mapped to the
 * `comfy.models` method that calls it — or to `null` with the reason it is
 * deliberately not exposed.
 *
 * This is the ROUTE-COVERAGE half of the drift gate, and it exists because
 * the omission it catches already happened once: `spec/router-openapi.yaml`
 * has declared the catalog and per-model-schema routes since the day it was
 * vendored, and nothing in this repo called either of them or noticed. The
 * error-bucket check beside this one covers `x-comfy-error-types` and says so
 * in its own header; no check looked at `paths` at all.
 *
 * Every entry is a decision, so a `null` is as deliberate as a method name:
 * adding a route to the contract fails this test until somebody either writes
 * the method or writes down why there is none.
 */
const ROUTE_COVERAGE: Record<string, { method: keyof typeof models | null; why: string }> = {
  runRouterModel: { method: "run", why: "the synchronous invocation route." },
  listRouterModels: {
    method: "list",
    why: "the model catalog, walked page by page by `comfy.models.list`.",
  },
  getRouterModelInputSchema: {
    method: "schema",
    why: "the per-model OpenAPI document `comfy.models.schema` returns.",
  },
  getRouterModel: {
    method: null,
    why:
      "per-model catalog DETAIL (`RouterModelDetail`), which no `comfy.models` method reaches " +
      "today. It is not the schema document — that is `getRouterModelInputSchema` above — and " +
      "it is not needed to invoke a model, since `list()` already yields the identity fields " +
      "`run()` and `schema()` take. Exposing it is additive and unblocked; it is left out here " +
      "only because nothing has asked for it yet.",
  },
};

describe("router route coverage (spec/router-openapi.yaml)", () => {
  it("accounts for every operation the contract declares", async () => {
    const declared = await readRouterOperations();
    const unaccounted = declared
      .map((operation) => operation.operationId)
      .filter((operationId) => !Object.hasOwn(ROUTE_COVERAGE, operationId));
    expect(
      unaccounted,
      "the vendored Router contract declares operations this SDK neither calls nor has " +
        "declared a reason for — add each to ROUTE_COVERAGE in this file, with the " +
        "`comfy.models` method that calls it or the reason there is none",
    ).toEqual([]);
  });

  it("declares no operation the contract does not", async () => {
    // The other direction: an entry left behind by a sync that REMOVED a route
    // would otherwise go on excusing coverage of something nobody serves.
    const declared = new Set((await readRouterOperations()).map((o) => o.operationId));
    const stale = Object.keys(ROUTE_COVERAGE).filter((operationId) => !declared.has(operationId));
    expect(
      stale,
      "ROUTE_COVERAGE names operations the vendored contract no longer declares",
    ).toEqual([]);
  });

  it("resolves every mapped operation to a real method on comfy.models", () => {
    for (const [operationId, { method }] of Object.entries(ROUTE_COVERAGE)) {
      if (method === null) continue;
      expect(models[method], `${operationId} maps to comfy.models.${method}`).toBeTypeOf(
        "function",
      );
    }
  });

  it("gives every unexposed operation a stated reason", () => {
    for (const [operationId, { method, why }] of Object.entries(ROUTE_COVERAGE)) {
      if (method !== null) continue;
      expect(why.length, `${operationId} is unexposed with no reason stated`).toBeGreaterThan(80);
    }
  });

  it("spells each discovery route the path the contract declares for it", async () => {
    // The same pinning `RUN_ROUTE_TEMPLATE` gets above, for the two routes
    // this SDK newly calls: a sync that moves either one reddens here rather
    // than turning the method into a 404 at runtime.
    const byId = new Map((await readRouterOperations()).map((o) => [o.operationId, o]));
    expect(byId.get("listRouterModels")?.path).toBe(CATALOG_ROUTE_TEMPLATE);
    expect(byId.get("listRouterModels")?.method).toBe("get");
    expect(byId.get("getRouterModelInputSchema")?.path).toBe(SCHEMA_ROUTE_TEMPLATE);
    expect(byId.get("getRouterModelInputSchema")?.method).toBe("get");
  });

  it("addresses the schema route with the same two segments the run route takes", async () => {
    // `parseModelId` is shared, so the two templates must fill the same
    // placeholders in the same order or one of the two callers is wrong.
    expect(templatePlaceholders(SCHEMA_ROUTE_TEMPLATE)).toEqual(
      templatePlaceholders(RUN_ROUTE_TEMPLATE),
    );
    expect(templatePlaceholders(CATALOG_ROUTE_TEMPLATE)).toEqual([]);
  });
});

describe("the operation extractor the coverage check reads through", () => {
  // Every shape below would otherwise drop an operation out of the coverage
  // set with the non-empty guard still satisfied — the silent miss ROUTE
  // COVERAGE exists to make impossible.
  const operation = (operationId: string) => ({ operationId, responses: {} });

  it("resolves a path item expressed as a local $ref rather than skipping it", () => {
    const doc = {
      paths: { "/v2/models": { $ref: "#/components/pathItems/catalog" } },
      components: { pathItems: { catalog: { get: operation("listRouterModels") } } },
    };
    expect(routerOperations(doc)).toEqual([
      { operationId: "listRouterModels", method: "get", path: "/v2/models" },
    ]);
  });

  it("refuses a path item that is not an object", () => {
    expect(() => routerOperations({ paths: { "/v2/models": null } })).toThrow(
      "malformed path item /v2/models",
    );
    expect(() => routerOperations({ paths: { "/v2/models": "get" } })).toThrow(
      "malformed path item /v2/models",
    );
    // An ARRAY is the shape a `typeof item !== "object"` test alone lets
    // through: it carries no method keys, so every operation under that path
    // vanishes while another path keeps the non-empty guard satisfied.
    expect(() => routerOperations({ paths: { "/v2/models": [] } })).toThrow(
      "malformed path item /v2/models",
    );
  });

  it("refuses an operationId declared twice, as it refuses one declared nowhere", () => {
    // Two operations under one id are both excused by a single ROUTE_COVERAGE
    // entry — and `find()` and `new Map()` consumers would disagree on which.
    const doc = {
      paths: {
        "/v2/models": { get: operation("listRouterModels") },
        "/v2/catalog": { get: operation("listRouterModels") },
      },
    };
    expect(() => routerOperations(doc)).toThrow(/"listRouterModels" is declared by both/);
    expect(() => routerOperations({ paths: { "/v2/models": { get: { responses: {} } } } })).toThrow(
      "declares no operationId",
    );
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
    // Narrowed at runtime rather than asserted: `src/**` forbids unsafe type
    // assertions, and a spec that parsed to something other than a mapping
    // would otherwise reach `Object.keys` as a lie about its own shape.
    const doc: unknown = parse(await readFile(ROUTER_SPEC_PATH, "utf-8"));
    const paths = typeof doc === "object" && doc !== null && "paths" in doc ? doc.paths : undefined;
    const queuePaths =
      typeof paths === "object" && paths !== null
        ? Object.keys(paths).filter((path) => path.includes("/requests"))
        : [];
    expect(
      queuePaths,
      "spec/router-openapi.yaml now declares the queued model-request routes — pin the four " +
        "MODEL_REQUEST* constants in src/sdk/modelRequests.ts against the spec and delete the " +
        "relation assertions in this block",
    ).toEqual([]);
  });
});
