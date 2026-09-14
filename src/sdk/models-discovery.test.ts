/**
 * `comfy.models.schema` and `comfy.models.list` against a stubbed router: the
 * routes they call, the credential and base URL they resolve, the request id
 * and error mapping they surface, `ETag` revalidation, and the paging walk.
 *
 * Kept beside `models.test.ts` rather than inside it: that file is about the
 * one long-lived, retrying, billable call, and these two are ordinary reads.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RouterStubServer, withRouterStub } from "../../test/support/router-stub-server.js";
import {
  comfy,
  ComfyError,
  config,
  CREDENTIALS_ENV_VAR,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  MissingCredentials,
  models,
  NotFound,
  Unauthorized,
} from "./index.js";
// Not re-exported from the package root, exactly like `RUN_ROUTE_TEMPLATE`:
// the route a call goes to is the SDK's business, and these constants are the
// anchor for the drift gate rather than a knob a caller configures.
import { CATALOG_ROUTE_TEMPLATE, SCHEMA_ROUTE_TEMPLATE } from "./models.js";

const CREDENTIAL = "comfyui-test-credential";
const MODEL = "bfl/flux-2-pro";
const SCHEMA_PATH = "/v2/models/bfl/flux-2-pro/openapi.json";
const REQUEST_ID = "6f1a1a6e-6a53-4a5f-9d3a-2b3b0a1f9c21";
const ETAG = '"6b8c1f2e0a9d4c3b5e7f8a1b2c3d4e5f"';

/** A stand-in for the per-model OpenAPI document the route serves. */
const DOCUMENT = {
  openapi: "3.0.2",
  info: { title: "bfl/flux-2-pro", version: "1.0" },
  paths: {
    "/v2/models/bfl/flux-2-pro": {
      post: { requestBody: { content: { "application/json": { schema: { type: "object" } } } } },
    },
  },
};

/** Any socket attempt at all fails the test that made it. */
function forbidNetwork(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(() => Promise.reject(new Error("network call attempted")));
  vi.stubGlobal("fetch", spy);
  return spy;
}

function useStub(server: RouterStubServer): void {
  config({ credentials: CREDENTIAL, baseUrl: server.baseUrl });
}

/** A catalog entry, as the contract shapes one. */
function entry(id: string): Record<string, unknown> {
  const [provider, model] = id.split("/");
  return { id, provider, model, billing: { charges_on_policy_rejection: "unknown" } };
}

beforeEach(() => {
  vi.stubEnv(CREDENTIALS_ENV_VAR, undefined);
  config({ credentials: undefined, baseUrl: undefined });
});

afterEach(() => {
  config({ credentials: undefined, baseUrl: undefined });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the comfy.models discovery surface", () => {
  it("exposes schema and list beside run, on the same frozen namespace", () => {
    expect(comfy.models).toBe(models);
    expect(comfy.models.schema).toBeTypeOf("function");
    expect(comfy.models.list).toBeTypeOf("function");
    expect(Object.isFrozen(comfy.models)).toBe(true);
  });

  it("deadlines a discovery read in seconds, not the minutes a generation gets", () => {
    // A catalog page and a schema document are ordinary API calls: nothing is
    // being generated behind them, so `run`'s twenty minutes would only ever
    // hide a hung request.
    expect(DEFAULT_DISCOVERY_TIMEOUT_MS).toBeLessThan(DEFAULT_RUN_TIMEOUT_MS);
    expect(DEFAULT_DISCOVERY_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("adds no validator to the package's runtime dependencies", async () => {
    // The documents are OpenAPI 3.0.2 — draft-04 plus `nullable` — and every
    // consumer that validates one needs `ajv-draft-04` rather than stock Ajv.
    // Making that choice here would impose it (and its bundle weight) on every
    // caller, including the browser ones, so `schema()` returns the document
    // and the caller validates.
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf-8"),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      "eventsource-parser",
      "hash-wasm",
      "zod",
    ]);
  });
});

describe("comfy.models.schema", () => {
  it("GETs the per-model openapi.json route and resolves to the document and its ETag", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.body = DOCUMENT;
      server.state.etag = ETAG;
      server.state.cacheControl = "private, max-age=300, must-revalidate";

      const result = await comfy.models.schema(MODEL);

      expect(server.state.lastMethod).toBe("GET");
      expect(server.state.lastPath).toBe(SCHEMA_PATH);
      expect(result.unchanged).toBe(false);
      // Narrowed by the assertion above; `document` only exists on that arm.
      if (result.unchanged) throw new Error("unreachable");
      expect(result.document).toEqual(DOCUMENT);
      expect(result.etag).toBe(ETAG);
      expect(result.requestId).toBe(REQUEST_ID);
    });
  });

  it("fills the route from the vendored contract's own template", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.body = DOCUMENT;
      await comfy.models.schema(MODEL);
      expect(server.state.lastPath).toBe(
        SCHEMA_ROUTE_TEMPLATE.replace("{provider}", "bfl").replace("{model}", "flux-2-pro"),
      );
    });
  });

  it("percent-encodes each segment rather than letting one add a path segment", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.body = DOCUMENT;
      await comfy.models.schema("fal ai/flux#pro");
      expect(server.state.lastPath).toBe("/v2/models/fal%20ai/flux%23pro/openapi.json");
    });
  });

  it("attaches the credential the same way run does, and negotiates JSON", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.body = DOCUMENT;
      await comfy.models.schema(MODEL);
      expect(server.state.lastAuthorization).toBe(`Bearer ${CREDENTIAL}`);
      expect(server.state.lastAccept).toBe("application/json");
      expect(server.state.lastUserAgent).toMatch(/comfy/i);
    });
  });

  it("accepts a credential supplied only by the environment", async () => {
    await withRouterStub(async (server) => {
      config({ baseUrl: server.baseUrl });
      vi.stubEnv(CREDENTIALS_ENV_VAR, "comfyui-from-env");
      server.state.body = DOCUMENT;
      await comfy.models.schema(MODEL);
      expect(server.state.lastAuthorization).toBe("Bearer comfyui-from-env");
    });
  });

  it("reports requestId as null when the response carries no such header", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.body = DOCUMENT;
      server.state.requestId = null;
      const result = await comfy.models.schema(MODEL);
      expect(result.requestId).toBeNull();
    });
  });

  it("sends no If-None-Match when the caller holds no tag", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.body = DOCUMENT;
      await comfy.models.schema(MODEL);
      expect(server.state.lastIfNoneMatch).toBeNull();
      // An empty string is "no copy", not a tag to compare against nothing.
      await comfy.models.schema(MODEL, { etag: "" });
      expect(server.state.lastIfNoneMatch).toBeNull();
    });
  });

  it("sends a held ETag as If-None-Match and resolves a 304 as unchanged", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.body = DOCUMENT;
      server.state.etag = ETAG;

      const first = await comfy.models.schema(MODEL);
      if (first.unchanged) throw new Error("the first read should carry a document");

      const second = await comfy.models.schema(MODEL, { etag: first.etag });

      expect(server.state.lastIfNoneMatch).toBe(ETAG);
      // Not an error, and not an empty document — an explicit "still current".
      expect(second.unchanged).toBe(true);
      expect(second.document).toBeUndefined();
      // Round-trippable: the tag comes back so the next read can revalidate too.
      expect(second.etag).toBe(ETAG);
      expect(second.requestId).toBe(REQUEST_ID);
    });
  });

  it("re-reads the document when the held tag no longer matches", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.body = DOCUMENT;
      server.state.etag = '"newer"';
      const result = await comfy.models.schema(MODEL, { etag: '"stale"' });
      expect(result.unchanged).toBe(false);
      if (result.unchanged) throw new Error("unreachable");
      expect(result.document).toEqual(DOCUMENT);
      expect(result.etag).toBe('"newer"');
    });
  });

  it("keeps the caller's own tag on a 304 that echoed none", async () => {
    // A `304` is required to repeat the `ETag`, but an intermediary can strip
    // it — and the tag the caller just sent is still the one that matched, so
    // dropping it would cost them the next revalidation for nothing.
    const fetchSpy = vi.fn(
      () =>
        Promise.resolve(
          new Response(null, { status: 304, headers: { "X-Comfy-Request-Id": REQUEST_ID } }),
        ) as Promise<Response>,
    );
    vi.stubGlobal("fetch", fetchSpy);
    config({ credentials: CREDENTIAL });
    const result = await comfy.models.schema(MODEL, { etag: ETAG });
    expect(result.unchanged).toBe(true);
    expect(result.etag).toBe(ETAG);
  });

  it("refuses a 304 to a request that sent no If-None-Match", async () => {
    // An unsolicited 304 — a proxy, a buggy origin — confirms a copy the
    // caller does not hold. Read as "unchanged" it would resolve with neither
    // a document nor an error, and a cache keyed on `!result.unchanged` would
    // never fill. The empty tag deliberately sends no header, so it is the
    // same case.
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.status = 304;
      server.state.body = null;
      for (const options of [{}, { etag: "" }]) {
        const err = (await comfy.models
          .schema(MODEL, options)
          .catch((e: unknown) => e)) as ComfyError;
        expect(err).toBeInstanceOf(ComfyError);
        expect(err.code).toBe("unexpected_response");
        expect(err.httpStatus).toBe(304);
        expect(err.requestId).toBe(REQUEST_ID);
        expect(err.message).toContain("If-None-Match");
      }
      expect(server.state.lastIfNoneMatch).toBeNull();
    });
  });

  it("raises the same model_not_found class an unknown ID raises on run", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.status = 404;
      server.state.errorType = "model_not_found";
      server.state.body = { detail: "no such model", error_type: "model_not_found" };

      const fromSchema = (await comfy.models
        .schema("bfl/nope")
        .catch((e: unknown) => e)) as ComfyError;
      const fromRun = (await comfy.models
        .run("bfl/nope", {})
        .catch((e: unknown) => e)) as ComfyError;

      expect(fromSchema).toBeInstanceOf(NotFound);
      // Not "both are NotFound" by two separate assertions — the criterion is
      // that they are the SAME class, so a future change to one path that did
      // not move the other fails here.
      expect(fromSchema.constructor).toBe(fromRun.constructor);
      expect(fromSchema.code).toBe("model_not_found");
      expect(fromSchema.httpStatus).toBe(404);
      expect(fromSchema.requestId).toBe(REQUEST_ID);
    });
  });

  it("maps an unauthorized read through the same table run uses", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.status = 401;
      server.state.errorType = "unauthorized";
      server.state.body = { detail: "bad key", error_type: "unauthorized" };
      const err = (await comfy.models.schema(MODEL).catch((e: unknown) => e)) as ComfyError;
      expect(err).toBeInstanceOf(Unauthorized);
      expect(err.requestId).toBe(REQUEST_ID);
    });
  });

  it("refuses a 200 whose body is not a JSON document", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.body = "<html>gateway</html>";
      server.state.contentType = "text/html";
      const err = (await comfy.models.schema(MODEL).catch((e: unknown) => e)) as ComfyError;
      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("unexpected_response");
      expect(err.requestId).toBe(REQUEST_ID);
    });
  });

  it("rejects without a credential, and without opening a socket", async () => {
    const fetchSpy = forbidNetwork();
    await expect(comfy.models.schema(MODEL)).rejects.toBeInstanceOf(MissingCredentials);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an ID that cannot address the route, naming schema", async () => {
    const fetchSpy = forbidNetwork();
    config({ credentials: CREDENTIAL });
    for (const bad of ["flux-pro", "", "fal-ai/", "fal-ai/flux/pro", "fal-ai/.."]) {
      await expect(comfy.models.schema(bad), bad).rejects.toBeInstanceOf(TypeError);
    }
    const err = (await comfy.models.schema("flux-pro").catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("models.schema(model)");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("gives up on a response slower than its deadline, naming the knob to turn", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.hang = true;
      const err = (await comfy.models
        .schema(MODEL, { timeoutMs: 40 })
        .catch((e: unknown) => e)) as ComfyError;
      expect(err.code).toBe("request_timeout");
      expect(err.message).toContain("timeoutMs");
    });
  });

  it("re-throws a caller's own abort rather than dressing it as a timeout", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.hang = true;
      const controller = new AbortController();
      const pending = comfy.models.schema(MODEL, { signal: controller.signal });
      controller.abort();
      const err = (await pending.catch((e: unknown) => e)) as Error;
      expect(err.name).toBe("AbortError");
      expect(err).not.toBeInstanceOf(ComfyError);
    });
  });
});

describe("comfy.models.list", () => {
  const PAGES = [
    {
      cursor: null,
      data: [entry("bfl/flux-2-pro"), entry("bfl/flux-1")],
      has_more: true,
      next_cursor: "c1",
      limit: 2,
    },
    {
      cursor: "c1",
      data: [entry("ideogram/ideogram-v3")],
      has_more: true,
      next_cursor: "c2",
      limit: 2,
    },
    { cursor: "c2", data: [entry("elevenlabs/tts"), entry("kling/v2")], has_more: false, limit: 2 },
  ];

  it("iterates every model across pages, exactly once, following next_cursor", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.catalogPages = PAGES;

      const seen: string[] = [];
      for await (const model of comfy.models.list()) seen.push(model.id);

      expect(seen).toEqual([
        "bfl/flux-2-pro",
        "bfl/flux-1",
        "ideogram/ideogram-v3",
        "elevenlabs/tts",
        "kling/v2",
      ]);
      expect(new Set(seen).size).toBe(seen.length);
      // Three pages means three requests, walked in cursor order — not one
      // request whose first twenty rows a caller mistakes for the catalog.
      expect(server.state.catalogCursors).toEqual([null, "c1", "c2"]);
      expect(server.state.requestCount).toBe(3);
    });
  });

  it("yields models rather than pages, so the common case cannot be a page walk", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.catalogPages = PAGES;
      for await (const model of comfy.models.list()) {
        expect(model.id).toBeTypeOf("string");
        expect(model.provider).toBeTypeOf("string");
        expect(model.model).toBeTypeOf("string");
        expect(model.id).toBe(`${model.provider}/${model.model}`);
        break;
      }
    });
  });

  it("GETs the catalog route the vendored contract declares", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.catalogPages = PAGES;
      await comfy.models.list().page();
      expect(server.state.lastMethod).toBe("GET");
      expect(server.state.lastPath).toBe(CATALOG_ROUTE_TEMPLATE);
      expect(server.state.lastAuthorization).toBe(`Bearer ${CREDENTIAL}`);
    });
  });

  it("offers the single page a caller driving its own pagination wants", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.catalogPages = PAGES;

      const first = await comfy.models.list().page();
      expect(first.data.map((m) => m.id)).toEqual(["bfl/flux-2-pro", "bfl/flux-1"]);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBe("c1");
      expect(first.limit).toBe(2);
      expect(first.requestId).toBe(REQUEST_ID);
      expect(server.state.requestCount).toBe(1);

      const second = await comfy.models.list({ cursor: first.nextCursor }).page();
      expect(second.data.map((m) => m.id)).toEqual(["ideogram/ideogram-v3"]);
      expect(server.state.requestCount).toBe(2);
    });
  });

  it("merges page() overrides over the options list() was given", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.catalogPages = PAGES;
      const page = await comfy.models.list({ cursor: "c1" }).page({ cursor: "c2" });
      expect(page.data.map((m) => m.id)).toEqual(["elevenlabs/tts", "kling/v2"]);
    });
  });

  it("sends the page size asked for, and reports the one actually served", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.catalogPages = [
        { cursor: null, data: [entry("bfl/flux-1")], has_more: false, limit: 100 },
      ];
      const page = await comfy.models.list({ limit: 500 }).page();
      expect(server.state.lastCatalogLimit).toBe("500");
      // Clamped by the server; the caller must paginate by what came back.
      expect(page.limit).toBe(100);
    });
  });

  it("starts a fresh walk on each iteration, and sends nothing until one starts", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.catalogPages = PAGES;
      const catalog = comfy.models.list();
      expect(server.state.requestCount).toBe(0);

      const first: string[] = [];
      for await (const model of catalog) first.push(model.id);
      const second: string[] = [];
      for await (const model of catalog) second.push(model.id);
      expect(second).toEqual(first);
    });
  });

  it("stops on has_more rather than on a short or empty page", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.catalogPages = [
        { cursor: null, data: [], has_more: true, next_cursor: "c1", limit: 20 },
        { cursor: "c1", data: [entry("bfl/flux-1")], has_more: false, limit: 20 },
      ];
      const seen: string[] = [];
      for await (const model of comfy.models.list()) seen.push(model.id);
      expect(seen).toEqual(["bfl/flux-1"]);
      expect(server.state.requestCount).toBe(2);
    });
  });

  it("refuses a page claiming another exists while naming no cursor", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.catalogPages = [{ cursor: null, data: [entry("bfl/flux-1")], has_more: true }];
      const err = (await (async () => {
        for await (const _ of comfy.models.list()) void _;
      })().catch((e: unknown) => e)) as ComfyError;
      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("unexpected_response");
      expect(err.message).toContain("next_cursor");
    });
  });

  it("refuses a cursor it has already followed rather than looping forever", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.catalogPages = [
        { cursor: null, data: [entry("bfl/flux-1")], has_more: true, next_cursor: "c1" },
        { cursor: "c1", data: [entry("bfl/flux-2")], has_more: true, next_cursor: "c1" },
      ];
      const err = (await (async () => {
        for await (const _ of comfy.models.list()) void _;
      })().catch((e: unknown) => e)) as ComfyError;
      expect(err.code).toBe("unexpected_response");
      expect(err.message).toContain("already followed");
      expect(server.state.requestCount).toBe(2);
    });
  });

  it("refuses has_more with no cursor on a single page() too, not only mid-walk", async () => {
    // The README's hand-pagination recipe is `list({ cursor: page.nextCursor
    // }).page()`; handed a `null` cursor it would omit the parameter and
    // re-serve page one, and a `while (page.hasMore)` loop over it would never
    // end. So the refusal lives where both consumers read a page.
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.catalogPages = [{ cursor: null, data: [entry("bfl/flux-1")], has_more: true }];
      const err = (await comfy.models
        .list()
        .page()
        .catch((e: unknown) => e)) as ComfyError;
      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("unexpected_response");
      expect(err.httpStatus).toBe(200);
      expect(err.requestId).toBe(REQUEST_ID);
      expect(err.message).toContain("next_cursor");
      expect(server.state.requestCount).toBe(1);
    });
  });

  it("refuses an entry that is not the identity the contract promises", async () => {
    // `CatalogModel` promises string `id`, `provider` and `model`; a `null`
    // or a bare object handed on under that type would crash a consumer at
    // `model.id`, far from the response that caused it.
    await withRouterStub(async (server) => {
      useStub(server);
      for (const bad of [null, { id: "bfl/flux-1" }, "bfl/flux-1"]) {
        server.state.catalogPages = [
          { cursor: null, data: [entry("bfl/flux-2"), bad], has_more: false },
        ];
        const err = (await comfy.models
          .list()
          .page()
          .catch((e: unknown) => e)) as ComfyError;
        expect(err).toBeInstanceOf(ComfyError);
        expect(err.code).toBe("unexpected_response");
        expect(err.message).toContain("data[1]");
      }
      const walked = (await (async () => {
        for await (const _ of comfy.models.list()) void _;
      })().catch((e: unknown) => e)) as ComfyError;
      expect(walked.code).toBe("unexpected_response");
    });
  });

  it("names the field a page lacked, rather than both", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.body = { has_more: false };
      const err = (await comfy.models
        .list()
        .page()
        .catch((e: unknown) => e)) as ComfyError;
      expect(err.code).toBe("unexpected_response");
      expect(err.message).toContain("`data` array");
      expect(err.message).not.toContain("has_more");
    });
  });

  it("refuses a page with no boolean has_more rather than reading it as the last", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.body = { data: [entry("bfl/flux-1")] };
      const err = (await comfy.models
        .list()
        .page()
        .catch((e: unknown) => e)) as ComfyError;
      expect(err.code).toBe("unexpected_response");
      expect(err.message).toContain("has_more");
      expect(err.requestId).toBe(REQUEST_ID);
    });
  });

  it("maps a catalog failure through the same table run uses, with the request id", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.status = 401;
      server.state.errorType = "unauthorized";
      server.state.body = { detail: "bad key", error_type: "unauthorized" };
      const err = (await comfy.models
        .list()
        .page()
        .catch((e: unknown) => e)) as ComfyError;
      expect(err).toBeInstanceOf(Unauthorized);
      expect(err.httpStatus).toBe(401);
      expect(err.requestId).toBe(REQUEST_ID);
    });
  });

  it("surfaces a mid-walk failure rather than ending the iteration quietly", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      // Page one is a fixture page; the cursor it names has none, so the stub
      // answers the second request with a 400.
      server.state.catalogPages = [
        { cursor: null, data: [entry("bfl/flux-1")], has_more: true, next_cursor: "gone" },
      ];
      const seen: string[] = [];
      const err = (await (async () => {
        for await (const model of comfy.models.list()) seen.push(model.id);
      })().catch((e: unknown) => e)) as ComfyError;
      expect(seen).toEqual(["bfl/flux-1"]);
      expect(err).toBeInstanceOf(ComfyError);
      expect(err.httpStatus).toBe(400);
    });
  });

  it("rejects without a credential, and without opening a socket", async () => {
    const fetchSpy = forbidNetwork();
    await expect(comfy.models.list().page()).rejects.toBeInstanceOf(MissingCredentials);
    await expect(
      (async () => {
        for await (const _ of comfy.models.list()) void _;
      })(),
    ).rejects.toBeInstanceOf(MissingCredentials);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("gives up on a page slower than its deadline", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.hang = true;
      const err = (await comfy.models
        .list({ timeoutMs: 40 })
        .page()
        .catch((e: unknown) => e)) as ComfyError;
      expect(err.code).toBe("request_timeout");
    });
  });

  it("resolves the credential and base URL once per walk, not once per page", async () => {
    // `comfy.config()` is reconfigurable mid-run. A cursor is minted by one
    // host; re-resolving per page would present it to another host, under
    // another credential, because the consumer happened to reconfigure
    // between two yielded models. `run` resolves both once per call — so does
    // a walk.
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.catalogPages = PAGES;
      const seen: string[] = [];
      for await (const model of comfy.models.list()) {
        seen.push(model.id);
        if (seen.length === 1) {
          config({ credentials: "comfyui-someone-else", baseUrl: "http://127.0.0.1:9/" });
        }
      }
      expect(seen).toHaveLength(5);
      expect(server.state.requestCount).toBe(3);
      expect(server.state.lastAuthorization).toBe(`Bearer ${CREDENTIAL}`);
    });
  });

  it("ends the iteration at an abort between yields, without draining the page", async () => {
    // `DiscoveryOptions.signal` says an abort "ends the iteration". Observed
    // only by the fetches, an abort after a yield would still hand over every
    // remaining model on the current page before the next fetch noticed.
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.catalogPages = PAGES;
      const controller = new AbortController();
      const seen: string[] = [];
      const err = (await (async () => {
        for await (const model of comfy.models.list({ signal: controller.signal })) {
          seen.push(model.id);
          controller.abort();
        }
      })().catch((e: unknown) => e)) as Error;
      expect(err.name).toBe("AbortError");
      expect(seen).toEqual(["bfl/flux-2-pro"]);
      expect(server.state.requestCount).toBe(1);
    });
  });

  it("ends the walk at the caller's abort", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.hang = true;
      const controller = new AbortController();
      const pending = (async () => {
        for await (const _ of comfy.models.list({ signal: controller.signal })) void _;
      })();
      controller.abort();
      const err = (await pending.catch((e: unknown) => e)) as Error;
      expect(err.name).toBe("AbortError");
    });
  });
});
