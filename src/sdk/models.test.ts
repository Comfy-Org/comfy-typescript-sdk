/** `comfy.models.run` against a stubbed router: the call, the result shape,
 * the headers it sends and reads, its deadline, and its failures. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RouterStubServer, withRouterStub } from "../../test/support/router-stub-server.js";
import {
  comfy,
  ComfyError,
  config,
  CREDENTIALS_ENV_VAR,
  DEFAULT_RUN_TIMEOUT_MS,
  Forbidden,
  InsufficientCredits,
  MissingCredentials,
  models,
  NotFound,
  Unauthorized,
} from "./index.js";

const CREDENTIAL = "comfyui-test-credential";
const MODEL = "fal-ai/flux-pro";

/** Any socket attempt at all fails the test that made it. */
function forbidNetwork(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(() => Promise.reject(new Error("network call attempted")));
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** Point the namespace at `server` with a credential configured. */
function useStub(server: RouterStubServer): void {
  config({ credentials: CREDENTIAL, baseUrl: server.baseUrl });
}

beforeEach(() => {
  vi.stubEnv(CREDENTIALS_ENV_VAR, undefined);
  config({ credentials: undefined, baseUrl: undefined });
});

afterEach(() => {
  config({ credentials: undefined, baseUrl: undefined });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the comfy.models namespace", () => {
  it("is reachable off the comfy namespace and as a named export", () => {
    expect(comfy.models).toBe(models);
    expect(comfy.models.run).toBeTypeOf("function");
  });

  it("is frozen, so a consumer cannot swap the shared namespace out", () => {
    expect(Object.isFrozen(comfy)).toBe(true);
    expect(Object.isFrozen(comfy.models)).toBe(true);
  });
});

describe("comfy.models.run without credentials", () => {
  it("rejects with the named MissingCredentials error", async () => {
    forbidNetwork();
    await expect(comfy.models.run(MODEL, {})).rejects.toBeInstanceOf(MissingCredentials);
  });

  it("names both ways to supply a credential", async () => {
    forbidNetwork();
    const err = (await comfy.models.run(MODEL, {}).catch((e: unknown) => e)) as ComfyError;
    expect(err.message).toContain("comfy.config({ credentials");
    expect(err.message).toContain(CREDENTIALS_ENV_VAR);
    expect(err.code).toBe("missing_credentials");
    expect(err).toBeInstanceOf(ComfyError);
    expect(err.name).toBe("MissingCredentials");
  });

  it("throws locally — no request is made", async () => {
    const fetchSpy = forbidNetwork();
    await comfy.models.run(MODEL, {}).catch(() => {});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("comfy.models.run on success", () => {
  it("resolves to { data, requestId } with the provider's payload untouched", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      const payload = {
        images: [{ url: "https://example.invalid/a.png", width: 1024 }],
        seed: 42,
        has_nsfw_concepts: [false],
      };
      server.state.body = payload;
      server.state.requestId = "req-abc-123";

      const result = await comfy.models.run(MODEL, { prompt: "a cat" });

      expect(result).toEqual({ data: payload, requestId: "req-abc-123" });
    });
  });

  it("types data as the caller's own shape when one is supplied", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.body = { images: [{ url: "https://example.invalid/a.png" }] };

      const { data } = await comfy.models.run<{ images: { url: string }[] }>(MODEL, {});

      // No cast and no `any`: this compiles only because `data` is the
      // supplied type, and the default is `unknown` rather than `any`.
      expect(data.images[0].url).toBe("https://example.invalid/a.png");
    });
  });

  it("POSTs the canonical model ID as two path segments", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      await comfy.models.run(MODEL, {});
      expect(server.state.lastMethod).toBe("POST");
      expect(server.state.lastPath).toBe("/v1/models/fal-ai/flux-pro");
    });
  });

  it("sends the input as the body, with no Comfy envelope around it", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      const input = { prompt: "a cat", image_size: { width: 512, height: 512 }, seed: 7 };
      await comfy.models.run(MODEL, input);
      expect(JSON.parse(server.state.lastRawBody ?? "null")).toEqual(input);
    });
  });

  it("sends the credential as a bearer token, and JSON content negotiation", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      await comfy.models.run(MODEL, {});
      expect(server.state.lastAuthorization).toBe(`Bearer ${CREDENTIAL}`);
      expect(server.state.lastContentType).toBe("application/json");
      expect(server.state.lastAccept).toBe("application/json");
      expect(server.state.lastUserAgent).toContain("comfy-sdk-typescript/");
    });
  });

  it("accepts a credential supplied only by the environment", async () => {
    await withRouterStub(async (server) => {
      config({ baseUrl: server.baseUrl });
      vi.stubEnv(CREDENTIALS_ENV_VAR, "comfyui-from-env");
      await comfy.models.run(MODEL, {});
      expect(server.state.lastAuthorization).toBe("Bearer comfyui-from-env");
    });
  });

  it("reports requestId as null when the response carries no such header", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.requestId = null;
      const result = await comfy.models.run(MODEL, {});
      expect(result.requestId).toBeNull();
    });
  });
});

describe("comfy.models.run and Idempotency-Key", () => {
  it("sends one on every call", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      await comfy.models.run(MODEL, {});
      expect(server.state.lastIdempotencyKey).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  it("mints a fresh key per call, so two runs are two logical calls", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      await comfy.models.run(MODEL, {});
      await comfy.models.run(MODEL, {});
      expect(server.state.idempotencyKeys).toHaveLength(2);
      expect(server.state.idempotencyKeys[0]).not.toBe(server.state.idempotencyKeys[1]);
    });
  });

  it("uses a caller-supplied key verbatim, so a retry can replay", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      await comfy.models.run(MODEL, {}, { idempotencyKey: "my-own-key" });
      expect(server.state.lastIdempotencyKey).toBe("my-own-key");
    });
  });
});

describe("comfy.models.run deadline", () => {
  it("defaults to minutes, not tens of seconds", () => {
    expect(DEFAULT_RUN_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("gives up on a response slower than the deadline, naming the knob to turn", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.delayMs = 5_000;

      const err = (await comfy.models
        .run(MODEL, {}, { timeoutMs: 50 })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("request_timeout");
      expect(err.message).toContain("50ms");
      expect(err.message).toContain("timeoutMs");
      expect(server.state.requestCount).toBe(1);
    });
  });

  it("waits out a slow response that finishes inside the deadline", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.delayMs = 150;
      const result = await comfy.models.run(MODEL, {}, { timeoutMs: 30_000 });
      expect(result.requestId).toBe("6f1a1a6e-6a53-4a5f-9d3a-2b3b0a1f9c21");
    });
  });

  it("never times out on its own when the deadline is disabled", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.delayMs = 100;
      const result = await comfy.models.run(MODEL, {}, { timeoutMs: null });
      expect(result.data).toBeDefined();
    });
  });

  it("applies to the body too, not just the wait for headers", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.stallBody = true;

      const err = (await comfy.models
        .run(MODEL, {}, { timeoutMs: 50 })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("request_timeout");
    });
  });

  it("re-throws a caller's own abort rather than dressing it as a timeout", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.hang = true;
      const controller = new AbortController();
      const pending = comfy.models.run(MODEL, {}, { signal: controller.signal });
      controller.abort();

      const err = (await pending.catch((e: unknown) => e)) as Error;
      expect(err).not.toBeInstanceOf(ComfyError);
      expect(err.name).toBe("AbortError");
    });
  });
});

describe("comfy.models.run failures", () => {
  it("maps an unknown model ID to NotFound, carrying the request id", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.status = 404;
      server.state.errorType = "model_not_found";
      server.state.requestId = "req-404";
      server.state.body = {
        detail: 'no model "fal-ai/flux-prro"; did you mean "fal-ai/flux-pro"?',
        error_type: "model_not_found",
      };

      const err = (await comfy.models
        .run("fal-ai/flux-prro", {})
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(NotFound);
      expect(err.code).toBe("model_not_found");
      expect(err.httpStatus).toBe(404);
      expect(err.requestId).toBe("req-404");
      expect(err.message).toContain("did you mean");
    });
  });

  it("maps the auth and quota buckets to their existing exceptions", async () => {
    const cases: [number, string, new (...args: never[]) => ComfyError][] = [
      [401, "unauthorized", Unauthorized],
      [403, "forbidden", Forbidden],
      [402, "insufficient_credits", InsufficientCredits],
    ];
    for (const [status, errorType, cls] of cases) {
      await withRouterStub(async (server) => {
        useStub(server);
        server.state.status = status;
        server.state.errorType = errorType;
        server.state.body = { detail: "nope", error_type: errorType };
        const err = (await comfy.models.run(MODEL, {}).catch((e: unknown) => e)) as ComfyError;
        expect(err, errorType).toBeInstanceOf(cls);
        expect(err.code).toBe(errorType);
        expect(err.requestId).toBe("6f1a1a6e-6a53-4a5f-9d3a-2b3b0a1f9c21");
      });
    }
  });

  it("keeps an unmapped bucket branchable as the error code", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.status = 504;
      server.state.errorType = "provider_timeout";
      server.state.body = { detail: "upstream took too long", error_type: "provider_timeout" };

      const err = (await comfy.models.run(MODEL, {}).catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("provider_timeout");
      expect(err.httpStatus).toBe(504);
      expect(err.message).toBe("upstream took too long");
    });
  });

  it("reads the bucket off the header for a validation failure, which has none in its body", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.status = 422;
      server.state.errorType = "invalid_input";
      server.state.body = {
        detail: [
          { loc: ["body", "image_url"], msg: "image is too small", type: "image_too_small" },
          { loc: ["body", "seed"], msg: "input should be greater than 0", type: "greater_than" },
        ],
      };

      const err = (await comfy.models.run(MODEL, {}).catch((e: unknown) => e)) as ComfyError;

      expect(err.code).toBe("invalid_input");
      expect(err.httpStatus).toBe(422);
      expect(err.message).toContain("body.image_url: image is too small");
      expect(err.message).toContain("body.seed");
      // The per-field detail survives intact for a caller that branches on it.
      const failures = err.details?.detail as { type: string }[] | undefined;
      expect(failures?.[0].type).toBe("image_too_small");
    });
  });

  it("still produces a typed error when the body is not the router's at all", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.status = 502;
      server.state.contentType = "text/html";
      server.state.body = "<html>Bad Gateway</html>";
      server.state.requestId = null;

      const err = (await comfy.models.run(MODEL, {}).catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("http_502");
      expect(err.httpStatus).toBe(502);
      expect(err.requestId).toBeNull();
    });
  });

  it("refuses a 202, which is a task handle rather than a finished result", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.status = 202;
      server.state.body = { request_id: "queued-1", status: "IN_QUEUE" };

      const err = (await comfy.models.run(MODEL, {}).catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("unexpected_response");
      expect(err.httpStatus).toBe(202);
      expect(err.requestId).toBe("6f1a1a6e-6a53-4a5f-9d3a-2b3b0a1f9c21");
    });
  });

  it("refuses a 200 whose body is not JSON", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.contentType = "text/plain";
      server.state.body = "not json at all";

      const err = (await comfy.models.run(MODEL, {}).catch((e: unknown) => e)) as ComfyError;

      expect(err.code).toBe("unexpected_response");
      expect(err.httpStatus).toBe(200);
      expect(err.requestId).toBe("6f1a1a6e-6a53-4a5f-9d3a-2b3b0a1f9c21");
    });
  });
});

describe("comfy.models.run argument validation", () => {
  it("refuses an ID that cannot address the route, without opening a socket", async () => {
    const fetchSpy = forbidNetwork();
    config({ credentials: CREDENTIAL });
    for (const bad of [
      "flux-pro",
      "",
      "fal-ai/",
      "/flux-pro",
      "fal-ai/flux/pro",
      "./flux-pro",
      "fal-ai/..",
    ]) {
      await expect(comfy.models.run(bad, {}), bad).rejects.toBeInstanceOf(TypeError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("says so when the extra segment is a variant", async () => {
    forbidNetwork();
    config({ credentials: CREDENTIAL });
    const err = (await comfy.models
      .run("fal-ai/flux-pro/v1.1", {})
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("variant");
  });

  it("refuses an input that is not a JSON object", async () => {
    const fetchSpy = forbidNetwork();
    config({ credentials: CREDENTIAL });
    for (const bad of [null, [1, 2], "prompt"]) {
      await expect(
        comfy.models.run(MODEL, bad as unknown as Record<string, unknown>),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
