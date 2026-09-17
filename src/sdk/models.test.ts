/** `comfy.models.run` against a stubbed router: the call, the result shape,
 * the headers it sends and reads, its deadline, and its failures. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachedDispatcher } from "../../test/support/dispatchers.js";
import { RouterStubServer, withRouterStub } from "../../test/support/router-stub-server.js";
import {
  comfy,
  ComfyError,
  config,
  CREDENTIALS_ENV_VAR,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_RUN_TIMEOUT_MS,
  Forbidden,
  InsufficientCredits,
  MissingCredentials,
  models,
  NotFound,
  Unauthorized,
} from "./index.js";

const CREDENTIAL = "comfyui-test-credential";
const MODEL = "bfl/flux-2-pro";

/** Any socket attempt at all fails the test that made it. */
function forbidNetwork(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(() => Promise.reject(new Error("network call attempted")));
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** Poll `predicate` until it holds — for state a server updates on its own
 * schedule (a socket closing), which has no promise to await. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the stub server");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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

      expect(result).toEqual({ kind: "json", data: payload, requestId: "req-abc-123" });
    });
  });

  it("types data as the caller's own shape when one is supplied", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.body = { images: [{ url: "https://example.invalid/a.png" }] };

      const result = await comfy.models.run<{ images: { url: string }[] }>(MODEL, {});

      // No cast and no `any`: this compiles only because `kind` narrows the
      // union to the JSON member and `data` is then the supplied type, whose
      // default is `unknown` rather than `any`.
      if (result.kind !== "json") throw new Error(`expected a JSON result, got ${result.kind}`);
      expect(result.data.images[0].url).toBe("https://example.invalid/a.png");
    });
  });

  it("POSTs the canonical model ID as two path segments", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      await comfy.models.run(MODEL, {});
      expect(server.state.lastMethod).toBe("POST");
      expect(server.state.lastPath).toBe("/v2/models/bfl/flux-2-pro");
    });
  });

  it("appends no query for the alt-provider controls unless the caller set one", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      await comfy.models.run(MODEL, { prompt: "a cat" });
      // Byte-for-byte the path this route has always used — no trailing `?`.
      expect(server.state.lastPath).toBe("/v2/models/bfl/flux-2-pro");
    });
  });

  it("sends the alt-provider controls as query params, in a fixed order, only when set", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      await comfy.models.run(MODEL, { prompt: "a cat" }, { modelProvider: "fal" });
      expect(server.state.lastPath).toBe("/v2/models/bfl/flux-2-pro?model_provider=fal");

      await comfy.models.run(MODEL, { prompt: "a cat" }, { strictMode: true });
      expect(server.state.lastPath).toBe("/v2/models/bfl/flux-2-pro?strict_mode=true");

      await comfy.models.run(
        MODEL,
        { prompt: "a cat" },
        { modelProvider: "fal", strictMode: false, fallbackProvider: "false" },
      );
      expect(server.state.lastPath).toBe(
        "/v2/models/bfl/flux-2-pro?model_provider=fal&strict_mode=false&fallback_provider=false",
      );
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

  it("sends the credential as a bearer token, and JSON-first content negotiation", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      await comfy.models.run(MODEL, {});
      expect(server.state.lastAuthorization).toBe(`Bearer ${CREDENTIAL}`);
      expect(server.state.lastContentType).toBe("application/json");
      // JSON preferred, but not exclusive: the run route's 200 has a `*/*`
      // binary branch too, and a client that handles it must say so.
      expect(server.state.lastAccept).toBe("application/json, */*;q=0.9");
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

  it("carries the deadline into undici's own inactivity limits, not just the signal", async () => {
    // `models.run` holds one request open for the whole generation, so nothing
    // — not even the response headers — arrives until the model is done. That
    // is exactly what undici's 300s `headersTimeout`/`bodyTimeout` defaults cut
    // short, out of any `AbortSignal`'s reach, so a longer deadline has to
    // reach the dispatcher as well.
    await withRouterStub(async (server) => {
      useStub(server);
      let seen: RequestInit | undefined;
      const realFetch = globalThis.fetch;
      vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
        seen = init;
        return realFetch(url, init);
      });

      await comfy.models.run(MODEL, {}, { timeoutMs: 660_000 });

      const dispatcher = attachedDispatcher(seen);
      expect(dispatcher?.headersTimeout).toBeGreaterThan(660_000);
      expect(dispatcher?.bodyTimeout).toBeGreaterThan(660_000);
    });
  });

  it("disables undici's inactivity limits when the deadline is disabled", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      let seen: RequestInit | undefined;
      const realFetch = globalThis.fetch;
      vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
        seen = init;
        return realFetch(url, init);
      });

      await comfy.models.run(MODEL, {}, { timeoutMs: null });

      const dispatcher = attachedDispatcher(seen);
      expect(dispatcher?.headersTimeout).toBe(0);
      expect(dispatcher?.bodyTimeout).toBe(0);
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
        detail: 'no model "bfl/flux-2-prro"; did you mean "bfl/flux-2-pro"?',
        error_type: "model_not_found",
      };

      const err = (await comfy.models
        .run("bfl/flux-2-prro", {})
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

  it("branches the two buckets only the header can name, off a shared status", async () => {
    // `not_enabled` shares its 403 with `forbidden` and `service_unavailable`
    // its 503 with a load balancer's own; the header is the only thing that
    // tells them apart, and it is what `code` is read from. `routerErrors`
    // carries the matching `instanceof`-able classes for the same buckets —
    // see `routerErrors.test.ts`, which asserts them against `toRouterError`.
    const cases: [number, string, string][] = [
      [403, "not_enabled", "Comfy Router does not run this model yet for this workspace."],
      [503, "service_unavailable", "a dependency is down; retry with backoff"],
    ];
    for (const [status, errorType, detail] of cases) {
      await withRouterStub(async (server) => {
        useStub(server);
        server.state.status = status;
        server.state.errorType = errorType;
        server.state.body = { detail, error_type: errorType };

        // `retry: false` for the 503, which is retryable on purpose (the
        // attempt count is asserted separately below); it costs the 403
        // nothing, since a 403 is never retried either way.
        const err = (await comfy.models
          .run(MODEL, {}, { retry: false })
          .catch((e: unknown) => e)) as ComfyError;

        expect(err, errorType).toBeInstanceOf(ComfyError);
        expect(err.code).toBe(errorType);
        expect(err.httpStatus).toBe(status);
        expect(err.message).toBe(detail);
        expect(err.requestId).toBe("6f1a1a6e-6a53-4a5f-9d3a-2b3b0a1f9c21");
      });
    }
  });

  it("does not read a header-less 403 as not_enabled", async () => {
    // The rollout gate is a header, not a status. A 403 with no
    // `X-Comfy-Error-Type` — a proxy ahead of the router, say — carries no
    // evidence of which 403 it is, and must not be labelled the new bucket.
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.status = 403;
      server.state.errorType = null;
      server.state.body = { detail: "no" };

      const err = (await comfy.models.run(MODEL, {}).catch((e: unknown) => e)) as ComfyError;

      expect(err.code).not.toBe("not_enabled");
      expect(err.code).toBe("http_403");
      expect(err.httpStatus).toBe(403);
    });

    // With the body naming the bucket instead, the existing mapping still
    // wins: `forbidden` is an entitlement decision, not the rollout gate.
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.status = 403;
      server.state.errorType = null;
      server.state.body = { detail: "no", error_type: "forbidden" };

      const err = (await comfy.models.run(MODEL, {}).catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(Forbidden);
      expect(err.code).toBe("forbidden");
    });
  });

  it("keeps an unmapped bucket branchable as the error code", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.status = 504;
      server.state.errorType = "provider_timeout";
      server.state.body = { detail: "upstream took too long", error_type: "provider_timeout" };

      // `retry: false` because this asserts the MAPPING of a 5xx, and a 5xx
      // is retryable — left on, the call would spend its whole retry budget
      // before raising the error under test.
      const err = (await comfy.models
        .run(MODEL, {}, { retry: false })
        .catch((e: unknown) => e)) as ComfyError;

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

      // Same reason as above: a 502 is retryable, and this asserts mapping.
      const err = (await comfy.models
        .run(MODEL, {}, { retry: false })
        .catch((e: unknown) => e)) as ComfyError;

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

  it("refuses a 200 that says it is JSON and then is not", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.contentType = "application/json";
      server.state.body = "not json at all";

      const err = (await comfy.models.run(MODEL, {}).catch((e: unknown) => e)) as ComfyError;

      expect(err.code).toBe("unexpected_response");
      expect(err.httpStatus).toBe(200);
      expect(err.requestId).toBe("6f1a1a6e-6a53-4a5f-9d3a-2b3b0a1f9c21");
    });
  });
});

/**
 * The run route's `200` has two documented shapes, not one: an
 * `application/json` document and a `*\/*` `format: binary` body, which is how
 * a partner whose generation IS the response answers. The ElevenLabs audio
 * models (`elevenlabs/eleven_v3`, `elevenlabs/eleven_sfx_v2`) are the first of
 * those in the catalog, and before this the SDK read every 200 as text and
 * `JSON.parse`d it — so the call threw AFTER the server had run and billed the
 * generation, with the bytes already destroyed by the lossy UTF-8 decode.
 */
describe("comfy.models.run on a binary result", () => {
  const AUDIO_MODEL = "elevenlabs/eleven_v3";

  /** An ID3v2.4 header followed by the first MPEG frame's sync word — the
   * head of a real `audio/mpeg` body, including bytes that are not valid
   * UTF-8 and would not survive a text decode. */
  const MP3_BYTES = new Uint8Array([
    0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x64, 0x00, 0x0d,
  ]);

  it("resolves audio/mpeg bytes verbatim rather than throwing on the JSON parse", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.contentType = "audio/mpeg";
      server.state.body = MP3_BYTES;
      server.state.requestId = "req-audio-1";

      const result = await comfy.models.run(AUDIO_MODEL, { text: "hello there" });

      expect(result.kind).toBe("binary");
      if (result.kind !== "binary") throw new Error("unreachable");
      expect(result.contentType).toBe("audio/mpeg");
      expect(result.requestId).toBe("req-audio-1");
      expect(result.data).toBeInstanceOf(Uint8Array);
      // Byte for byte, and the exact length — a `Uint8Array` view onto a
      // larger buffer would compare equal on content but hand a caller
      // trailing garbage the moment they wrote `.buffer` to a file.
      expect(Array.from(result.data)).toEqual(Array.from(MP3_BYTES));
      expect(result.data.byteLength).toBe(MP3_BYTES.byteLength);
    });
  });

  it("keeps the media type's parameters on contentType, for a Blob to use", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.contentType = "audio/mpeg; rate=44100";
      server.state.body = MP3_BYTES;

      const result = await comfy.models.run(AUDIO_MODEL, {});

      expect(result.kind).toBe("binary");
      if (result.kind !== "binary") throw new Error("unreachable");
      expect(result.contentType).toBe("audio/mpeg; rate=44100");
    });
  });

  it("treats any other non-JSON media type the same way", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.contentType = "image/png";
      server.state.body = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

      const result = await comfy.models.run("some/image-model", {});

      expect(result.kind).toBe("binary");
      if (result.kind !== "binary") throw new Error("unreachable");
      expect(result.contentType).toBe("image/png");
      expect(Array.from(result.data)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    });
  });

  it("reads a +json suffix as JSON, not as bytes", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.contentType = "application/vnd.partner.result+json; charset=utf-8";
      server.state.body = { audio_url: "https://example.invalid/out.mp3" };

      const result = await comfy.models.run(AUDIO_MODEL, {});

      expect(result).toEqual({
        kind: "json",
        data: { audio_url: "https://example.invalid/out.mp3" },
        requestId: "6f1a1a6e-6a53-4a5f-9d3a-2b3b0a1f9c21",
      });
    });
  });

  it("falls back to JSON when the 200 declared no Content-Type at all", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.contentType = null;
      server.state.body = { images: [{ url: "https://example.invalid/a.png" }] };

      const result = await comfy.models.run(MODEL, {});

      expect(result.kind).toBe("json");
      if (result.kind !== "json") throw new Error("unreachable");
      expect(result.data).toEqual({ images: [{ url: "https://example.invalid/a.png" }] });
    });
  });

  it("is binary with an empty contentType when there is no Content-Type and no JSON", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.contentType = null;
      server.state.body = MP3_BYTES;

      const result = await comfy.models.run(AUDIO_MODEL, {});

      expect(result.kind).toBe("binary");
      if (result.kind !== "binary") throw new Error("unreachable");
      expect(result.contentType).toBe("");
      expect(Array.from(result.data)).toEqual(Array.from(MP3_BYTES));
    });
  });

  it("refuses a 2xx that is not the contract's 200, rather than calling it a result", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.status = 204;
      server.state.contentType = null;
      server.state.body = null;

      const err = (await comfy.models
        .run(AUDIO_MODEL, {}, { retry: false })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("unexpected_response");
      expect(err.httpStatus).toBe(204);
    });
  });

  it("refuses an empty 200 body rather than handing back zero bytes as the generation", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.contentType = "audio/mpeg";
      server.state.body = null;

      const err = (await comfy.models
        .run(AUDIO_MODEL, {}, { retry: false })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("unexpected_response");
      expect(err.httpStatus).toBe(200);
    });
  });

  it("reads a Content-Type sent twice as the one media type it is", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      // What `Headers.get` hands back for a header the response carried twice:
      // the values joined with ", ". Parsed naively it matches neither
      // `application/json` nor `+json`, and an ordinary result comes back as
      // bytes.
      server.state.contentType = "application/json, application/json";
      server.state.body = { images: [{ url: "https://example.invalid/a.png" }] };

      const result = await comfy.models.run(MODEL, {});

      expect(result.kind).toBe("json");
      if (result.kind !== "json") throw new Error("unreachable");
      expect(result.data).toEqual({ images: [{ url: "https://example.invalid/a.png" }] });
    });
  });

  it("treats a json subtype as JSON whatever the type, and a suffix with no type as not", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.contentType = "text/json";
      server.state.body = { ok: true };

      const json = await comfy.models.run(MODEL, {});

      expect(json.kind).toBe("json");

      // No `type/subtype` at all: the trailing `+json` is not a structured
      // suffix, so this is the contract's byte branch rather than a document.
      server.state.contentType = "garbage+json";
      server.state.body = MP3_BYTES;

      const bytes = await comfy.models.run(AUDIO_MODEL, {});

      expect(bytes.kind).toBe("binary");
    });
  });

  it("does not let a lossy decode turn headerless bytes into a JSON string", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.contentType = null;
      // `22 FF 22`: not valid UTF-8, but a non-fatal decode replaces the FF
      // with U+FFFD and leaves `"\uFFFD"` — a JSON document. These are the
      // partner's bytes, and they have to come back as bytes.
      const bytes = new Uint8Array([0x22, 0xff, 0x22]);
      server.state.body = bytes;

      const result = await comfy.models.run(AUDIO_MODEL, {});

      expect(result.kind).toBe("binary");
      if (result.kind !== "binary") throw new Error("unreachable");
      expect(Array.from(result.data)).toEqual(Array.from(bytes));
    });
  });

  it("still refuses a 202, whatever the body's media type says", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.status = 202;
      server.state.contentType = "audio/mpeg";
      server.state.body = MP3_BYTES;

      const err = (await comfy.models.run(AUDIO_MODEL, {}).catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("unexpected_response");
      expect(err.httpStatus).toBe(202);
    });
  });

  it("still reports a non-2xx as the error it is, never as bytes", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.status = 422;
      server.state.errorType = "invalid_input";
      server.state.contentType = "application/json";
      server.state.body = { detail: [{ loc: ["body", "text"], msg: "field required" }] };

      const err = (await comfy.models
        .run(AUDIO_MODEL, {}, { retry: false })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("invalid_input");
      expect(err.httpStatus).toBe(422);
    });
  });

  it("collects a binary 200 across a paced 409, replay header and all", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.contentType = "audio/mpeg";
      server.state.body = MP3_BYTES;
      server.state.failTimes = 1;
      server.state.failStatus = 409;
      server.state.failErrorType = "concurrency_limit_exceeded";
      server.state.failRetryAfter = "0";
      server.state.idempotentReplayed = true;

      const result = await comfy.models.run(AUDIO_MODEL, {}, { retry: { collectBudgetMs: 5_000 } });

      expect(server.state.requestCount).toBe(2);
      // Both attempts under the one key: the collect is a re-ask for the
      // generation the first attempt already started, not a second run.
      expect(new Set(server.state.idempotencyKeys).size).toBe(1);
      expect(result.kind).toBe("binary");
      if (result.kind !== "binary") throw new Error("unreachable");
      expect(result.contentType).toBe("audio/mpeg");
      expect(Array.from(result.data)).toEqual(Array.from(MP3_BYTES));
    });
  });

  it("honours the deadline on a binary body just as on a JSON one", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.contentType = "audio/mpeg";
      // `stallBody` rather than `delayMs`: the delay sleeps BEFORE the status
      // line, so the deadline would fire while waiting for headers and never
      // reach `response.arrayBuffer()` — which is the call this change moved
      // the body read to. Stalling after the headers puts the deadline where
      // the new code actually runs.
      server.state.stallBody = true;

      const err = (await comfy.models
        .run(AUDIO_MODEL, {}, { timeoutMs: 50, retry: false })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("request_timeout");
    });
  });

  it("stops a binary run on the caller's signal", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.contentType = "audio/mpeg";
      // As above: `hang` never sends a status line, so the abort would land on
      // a pending `fetch()` instead of on the pending binary body read.
      server.state.stallBody = true;
      const controller = new AbortController();

      const pending = comfy.models.run(AUDIO_MODEL, {}, { signal: controller.signal });
      await waitFor(() => server.state.requestCount === 1);
      controller.abort();

      await expect(pending).rejects.toThrow();
      await waitFor(() => server.state.clientDisconnects === 1);
    });
  });
});

/**
 * The body is buffered whole — one call resolves with one finished result, so
 * there is nothing to stream it into — and `maxBytes` is the ceiling on that.
 * Two checks, because they catch different responses: `Content-Length` before
 * the body is touched (the exit that avoids the download rather than just the
 * allocation), and the bytes as they are read (the only check a chunked
 * response has). A breach is deliberately kept out of the retry loop, since
 * retrying it re-downloads the same oversized body on every attempt.
 *
 * What the cap does NOT do is decide what a response means: the class is read
 * off the status and the headers first, a body this call will retry or
 * collect is never read at all, and an error body it does surface is
 * truncated rather than refused. Those are the last four tests here.
 */
describe("comfy.models.run response size cap", () => {
  /** A retry policy that WOULD retry, and fast — so a test asserting one
   * attempt is asserting the classification rather than a slow clock. */
  const WOULD_RETRY = { budgetMs: 5_000, baseDelayMs: 5, maxDelayMs: 20 };

  it("refuses a Content-Length over the cap without reading the body", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      // The stall is the proof: this response declares 4096 bytes and sends
      // ten, so a client that waited for the body would wait until its
      // deadline. Returning at all means the header alone decided it.
      server.state.stallBody = true;
      server.state.stallBodyContentLength = 4096;

      const startedAt = Date.now();
      const err = (await comfy.models
        .run(MODEL, {}, { maxBytes: 512, timeoutMs: 30_000 })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("response_too_large");
      expect(err.httpStatus).toBe(200);
      expect(err.requestId).toBe("6f1a1a6e-6a53-4a5f-9d3a-2b3b0a1f9c21");
      expect(err.details).toEqual({ maxBytes: 512, contentLength: 4096 });
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(server.state.requestCount).toBe(1);
      // The connection is dropped rather than left draining a body nothing
      // will read.
      await waitFor(() => server.state.clientDisconnects === 1);
    });
  });

  it("caps at DEFAULT_MAX_RESPONSE_BYTES when the call names no maxBytes", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.stallBody = true;
      server.state.stallBodyContentLength = DEFAULT_MAX_RESPONSE_BYTES + 1;

      const err = (await comfy.models
        .run(MODEL, {}, { timeoutMs: 30_000 })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err.code).toBe("response_too_large");
      expect(err.details).toEqual({
        maxBytes: DEFAULT_MAX_RESPONSE_BYTES,
        contentLength: DEFAULT_MAX_RESPONSE_BYTES + 1,
      });
    });
  });

  it("stops a chunked response that declares no length mid-read", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      // 8 MiB with no Content-Length at all: the only thing that can refuse
      // this is counting the bytes as they arrive.
      server.state.chunkedBody = { chunkBytes: 64 * 1024, chunks: 128 };

      const err = (await comfy.models
        .run(MODEL, {}, { maxBytes: 8_192, timeoutMs: 30_000, retry: WOULD_RETRY })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("response_too_large");
      expect(err.details?.maxBytes).toBe(8_192);
      expect(err.details?.bytesRead).toBeGreaterThan(8_192);
      // Mid-read, not after: the server never got to write the whole body.
      expect(server.state.chunkedBodyCompleted).toBe(false);
      expect(server.state.chunkedChunksSent).toBeLessThan(128);
      // And it is a verdict, not a transport failure — one attempt, however
      // much retry budget was left.
      expect(server.state.requestCount).toBe(1);
      await waitFor(() => server.state.clientDisconnects === 1);
    });
  });

  it("holds a body delivered as many small chunks without breaching on overhead", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      // Ten thousand chunks for a body of a few hundred KiB: the payload is
      // far under the cap, and a reader that kept one view per chunk would
      // cost the heap orders of magnitude more than the payload. The cap is
      // on the bytes, and the bytes are what this stays under.
      server.state.chunkedBody = { chunkBytes: 32, chunks: 10_000 };

      const err = (await comfy.models
        .run(MODEL, {}, { maxBytes: 1_000_000, timeoutMs: 30_000 })
        .catch((e: unknown) => e)) as ComfyError;

      // The whole body arrives — 320_000 bytes of `a`, which is not JSON, so
      // the read succeeds and the PARSE is what fails. That is the assertion:
      // the cap let it through.
      expect(server.state.chunkedBodyCompleted).toBe(true);
      expect(err.code).not.toBe("response_too_large");
    });
  });

  it("does not retry a result past the cap, however much budget is left", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      // A 200 whose body is the result: nothing about it is worth re-asking
      // for, and retrying would re-download the same oversized body on every
      // attempt until the budget ran out.
      server.state.body = { caption: "x".repeat(20_000) };

      const err = (await comfy.models
        .run(MODEL, {}, { maxBytes: 512, retry: WOULD_RETRY })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err.code).toBe("response_too_large");
      expect(err.httpStatus).toBe(200);
      expect(server.state.requestCount).toBe(1);
    });
  });

  it("disables the cap entirely on maxBytes: null", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      const payload = { caption: "x".repeat(20_000) };
      server.state.body = payload;

      const refused = (await comfy.models
        .run(MODEL, {}, { maxBytes: 64 })
        .catch((e: unknown) => e)) as ComfyError;
      expect(refused.code).toBe("response_too_large");

      const result = await comfy.models.run(MODEL, {}, { maxBytes: null });

      expect(result.data).toEqual(payload);
    });
  });

  it("admits a body of exactly maxBytes and refuses one byte more", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      const payload = { caption: "x".repeat(1_000) };
      const exact = Buffer.byteLength(JSON.stringify(payload));
      server.state.body = payload;

      const result = await comfy.models.run(MODEL, {}, { maxBytes: exact });
      expect(result.data).toEqual(payload);

      const err = (await comfy.models
        .run(MODEL, {}, { maxBytes: exact - 1 })
        .catch((e: unknown) => e)) as ComfyError;
      expect(err.code).toBe("response_too_large");
    });
  });

  it("decodes a multi-byte body the same as the runtime's own text()", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      // Big enough to arrive as several chunks, and non-ASCII throughout, so
      // a character straddles a chunk boundary. Counting bytes chunk by chunk
      // is only safe because the decode happens once, over the whole buffer —
      // decoding per chunk would replace every split character with U+FFFD.
      const payload = { caption: "é🎧".repeat(20_000) };
      server.state.body = payload;

      const result = await comfy.models.run(MODEL, {});

      expect(result.data).toEqual(payload);
    });
  });

  it("carries the response's Retry-After on the breach", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      // `retryAfter` is documented as "any failure that carried the header
      // has it", and a cap breach is a failure like any other: it hands back
      // an `idempotencyKey`, so it owes the pace to use it at.
      server.state.respond = () => ({
        status: 200,
        body: { caption: "x".repeat(20_000) },
        headers: { "Retry-After": "3" },
      });

      const err = (await comfy.models
        .run(MODEL, {}, { maxBytes: 512 })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err.code).toBe("response_too_large");
      expect(err.retryAfter).toBe(3);
      expect(err.idempotencyKey).toEqual(expect.any(String));
    });
  });

  it("rejects a maxBytes that is not a size, before any request goes out", async () => {
    const fetchSpy = forbidNetwork();
    config({ credentials: CREDENTIAL, baseUrl: "http://127.0.0.1:1" });

    // NaN is the one worth pinning: every comparison against it is false, so
    // an unchecked NaN reads as "no cap" and silently undoes the ceiling.
    await expect(comfy.models.run(MODEL, {}, { maxBytes: Number.NaN })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(comfy.models.run(MODEL, {}, { maxBytes: -1 })).rejects.toBeInstanceOf(TypeError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("names NaN as NaN when it rejects it", async () => {
    config({ credentials: CREDENTIAL, baseUrl: "http://127.0.0.1:1" });
    // `JSON.stringify(NaN)` is `"null"`, and `null` is the one value the same
    // sentence calls valid — the message would name what it accepts.
    const err = (await comfy.models
      .run(MODEL, {}, { maxBytes: Number.NaN })
      .catch((e: unknown) => e)) as TypeError;
    expect(err.message).toContain("got NaN");
  });

  it("keeps a retryable status retryable behind an oversized error body", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      // The README's own case: an intermediary answering a 503 with an HTML
      // error page far past the cap. The status is what says "ask again", and
      // the body has nothing to add — so it is dropped unread and the retry
      // budget is spent on retries rather than on one fatal cap breach.
      server.state.status = 503;
      server.state.errorType = "service_unavailable";
      server.state.body = { detail: "x".repeat(20_000), error_type: "service_unavailable" };

      const err = (await comfy.models
        // A budget short enough to exhaust inside one test, so what is
        // asserted is that the retries happened at all.
        .run(MODEL, {}, { maxBytes: 512, retry: { budgetMs: 300, baseDelayMs: 5, maxDelayMs: 20 } })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err.code).toBe("service_unavailable");
      expect(err.httpStatus).toBe(503);
      expect(server.state.requestCount).toBeGreaterThan(1);
    });
  });

  it("collects a generation behind an oversized 409 body", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      const payload = { caption: "done" };
      // A collectable 409 is Router saying it still holds the generation —
      // already billed — and asking to be re-asked. A cap breach on its body
      // would abandon it, so the body is never read.
      server.state.respond = (_request, index) =>
        index === 0
          ? {
              status: 409,
              errorType: "concurrency_limit_exceeded",
              body: { detail: "y".repeat(20_000), error_type: "concurrency_limit_exceeded" },
              headers: { "Retry-After": "1" },
            }
          : { status: 200, body: payload };

      const result = await comfy.models.run(
        MODEL,
        {},
        {
          maxBytes: 1_024,
          retry: { budgetMs: 60_000, baseDelayMs: 5, maxDelayMs: 10, collectBudgetMs: 5_000 },
        },
      );

      expect(result.kind).toBe("json");
      expect(result.data).toEqual(payload);
      expect(server.state.requestCount).toBe(2);
    });
  });

  it("truncates an oversized error body rather than losing its class", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      // 402 with an error page past the cap. The bucket lives in the status
      // and `X-Comfy-Error-Type`, not in the body, and refusing the body
      // would trade `InsufficientCredits` for a bare `ComfyError` — the one
      // thing the response was actually carrying.
      server.state.status = 402;
      server.state.errorType = "insufficient_credits";
      server.state.body = { detail: "z".repeat(20_000), error_type: "insufficient_credits" };

      const err = (await comfy.models
        .run(MODEL, {}, { maxBytes: 512 })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(InsufficientCredits);
      expect(err.code).toBe("insufficient_credits");
      expect(err.httpStatus).toBe(402);
    });
  });

  it("still refuses a RESULT past the cap when the status is a 200", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      // The mirror of the test above: nothing about a 200 is worth keeping
      // once the result itself will not fit, so this one does raise.
      server.state.body = { caption: "x".repeat(20_000) };

      const err = (await comfy.models
        .run(MODEL, {}, { maxBytes: 512 })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err.code).toBe("response_too_large");
      expect(err.details?.maxBytes).toBe(512);
    });
  });
});

describe("comfy.models.run retries", () => {
  /** A retry policy with tiny delays, so a test exercises the loop rather
   * than the default half-second backoff. */
  const FAST = { budgetMs: 5_000, baseDelayMs: 5, maxDelayMs: 20 };

  it("climbs out of a run of 5xx and resolves once the server recovers", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.failTimes = 2;
      server.state.failStatus = 503;

      const result = await comfy.models.run(MODEL, { prompt: "a cat" }, { retry: FAST });

      expect(result.data).toEqual({ images: [{ url: "https://example.invalid/out.png" }] });
      expect(server.state.requestCount).toBe(3);
    });
  });

  it("retries a transport failure, where there is no status to read at all", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.resetTimes = 1; // socket destroyed mid-request

      const result = await comfy.models.run(MODEL, {}, { retry: FAST });

      expect(result.requestId).toBe("6f1a1a6e-6a53-4a5f-9d3a-2b3b0a1f9c21");
      expect(server.state.requestCount).toBe(2);
    });
  });

  it("sends the SAME Idempotency-Key on every attempt of one logical call", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.failTimes = 2;

      await comfy.models.run(MODEL, {}, { retry: FAST });

      expect(server.state.idempotencyKeys).toHaveLength(3);
      expect(new Set(server.state.idempotencyKeys).size).toBe(1);
    });
  });

  it("mints a new key for the next call, so a retried call and a new call differ", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.failTimes = 1;
      await comfy.models.run(MODEL, {}, { retry: FAST });
      const firstCallKeys = [...server.state.idempotencyKeys];
      await comfy.models.run(MODEL, {}, { retry: FAST });

      expect(firstCallKeys).toHaveLength(2);
      expect(new Set(firstCallKeys).size).toBe(1);
      expect(server.state.idempotencyKeys.at(-1)).not.toBe(firstCallKeys[0]);
    });
  });

  it("retries a 503 that names service_unavailable, replaying the same Idempotency-Key", async () => {
    // The one bucket whose condition clears on its own. The key is what makes
    // the replay safe: the server answers the repeat with the original
    // response rather than running — and billing — the model twice.
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.failTimes = 1;
      server.state.failStatus = 503;
      server.state.failErrorType = "service_unavailable";

      const result = await comfy.models.run(MODEL, { prompt: "a cat" }, { retry: FAST });

      expect(result.data).toEqual({ images: [{ url: "https://example.invalid/out.png" }] });
      expect(server.state.requestCount).toBe(2);
      expect(server.state.idempotencyKeys).toHaveLength(2);
      expect(server.state.idempotencyKeys[0]).toBe(server.state.idempotencyKeys[1]);
    });
  });

  it("does not retry not_enabled, which no replay turns on", async () => {
    // Terminal by contract, and on a 403 besides — one attempt either way.
    // Asserted under a 5xx too, where only the bucket says not to retry.
    for (const status of [403, 503]) {
      await withRouterStub(async (server) => {
        useStub(server);
        server.state.status = status;
        server.state.errorType = "not_enabled";
        server.state.body = {
          detail: "Comfy Router does not run this model yet for this workspace.",
          error_type: "not_enabled",
        };

        const err = (await comfy.models
          .run(MODEL, {}, { retry: FAST })
          .catch((e: unknown) => e)) as ComfyError;

        expect(err.code, String(status)).toBe("not_enabled");
        expect(server.state.requestCount, String(status)).toBe(1);
      });
    }
  });

  it("does not retry a verdict about the request — 404, 422, content policy", async () => {
    const cases: [number, string | null][] = [
      [404, "model_not_found"],
      [422, "invalid_input"],
      [400, "content_policy_violation"],
      // Same verdict, arriving under a 5xx: still not worth replaying.
      [503, "content_policy_violation"],
    ];
    for (const [status, errorType] of cases) {
      await withRouterStub(async (server) => {
        useStub(server);
        server.state.status = status;
        server.state.errorType = errorType;
        server.state.body = { detail: "no", error_type: errorType };

        await expect(comfy.models.run(MODEL, {}, { retry: FAST })).rejects.toBeInstanceOf(
          ComfyError,
        );
        expect(server.state.requestCount, `${String(status)} ${String(errorType)}`).toBe(1);
      });
    }
  });

  it("makes the call a single attempt when retries are disabled", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.status = 503;
      server.state.body = { detail: "down", error_type: "internal_error" };

      const err = (await comfy.models
        .run(MODEL, {}, { retry: false })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err.httpStatus).toBe(503);
      expect(server.state.requestCount).toBe(1);
    });
  });

  it("raises the server's own last failure when the budget runs out, not a synthetic one", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.status = 500;
      server.state.errorType = "internal_error";
      server.state.body = { detail: "still broken", error_type: "internal_error" };

      const err = (await comfy.models
        .run(MODEL, {}, { retry: { budgetMs: 120, baseDelayMs: 5, maxDelayMs: 10 } })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.httpStatus).toBe(500);
      expect(err.message).toBe("still broken");
      expect(server.state.requestCount).toBeGreaterThan(1);
    });
  });

  it("bounds the retries by elapsed time, so a bigger budget buys more attempts", async () => {
    const attemptsWithin = async (budgetMs: number): Promise<number> =>
      withRouterStub(async (server) => {
        useStub(server);
        server.state.status = 503;
        server.state.body = { detail: "down", error_type: "internal_error" };
        await comfy.models
          .run(MODEL, {}, { retry: { budgetMs, baseDelayMs: 10, maxDelayMs: 10 } })
          .catch(() => undefined);
        return server.state.requestCount;
      });

    const short = await attemptsWithin(300);
    const long = await attemptsWithin(1_500);

    expect(short).toBeGreaterThan(1);
    expect(long).toBeGreaterThan(short);
  }, 20_000);

  it("keeps the deadline spanning every attempt rather than restarting it per attempt", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.status = 503;
      server.state.body = { detail: "down", error_type: "internal_error" };
      server.state.delayMs = 150;

      const started = Date.now();
      await expect(
        comfy.models.run(
          MODEL,
          {},
          // A retry budget 60x the deadline: if each attempt got its own
          // fresh `timeoutMs` the call would run until the budget ran out.
          { timeoutMs: 1_000, retry: { budgetMs: 60_000, baseDelayMs: 5, maxDelayMs: 10 } },
        ),
      ).rejects.toBeTruthy();

      // Several attempts happened, and the DEADLINE is what ended them.
      expect(server.state.requestCount).toBeGreaterThan(1);
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  }, 20_000);
});

describe("comfy.models.run collecting a generation under the same key", () => {
  /** A collect budget short enough to run in a test, with the ordinary retry
   * budget left generous so it is never what ended the loop. */
  const COLLECT = { budgetMs: 60_000, baseDelayMs: 5, maxDelayMs: 10, collectBudgetMs: 5_000 };

  it("does not read a bare 409 as an invitation to ask again", async () => {
    // Split out of the verdict table above, and the split IS the point: the
    // status alone says nothing. A 409 with no `X-Comfy-Error-Type` and no
    // `Retry-After` is a deterministic refusal — a proxy's conflict, or the
    // contract's spent-key case — and stays one attempt.
    for (const errorType of [null, "invalid_input"]) {
      await withRouterStub(async (server) => {
        useStub(server);
        server.state.status = 409;
        server.state.errorType = errorType;
        server.state.body = { detail: "no", error_type: errorType };

        await expect(comfy.models.run(MODEL, {}, { retry: COLLECT })).rejects.toBeInstanceOf(
          ComfyError,
        );
        expect(server.state.requestCount, String(errorType)).toBe(1);
      });
    }
  });

  it("collects a 409 concurrency_limit_exceeded, re-asking under the SAME key", async () => {
    // The shape a re-send after a dropped connection meets: an earlier attempt
    // of this same call is still in flight, and Router answers the repeat with
    // "wait, then ask again for it" rather than dispatching a second one.
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.failTimes = 2;
      server.state.failStatus = 409;
      server.state.failErrorType = "concurrency_limit_exceeded";
      server.state.failRetryAfter = "1";
      server.state.idempotentReplayed = true;

      const result = await comfy.models.run(MODEL, { prompt: "a cat" }, { retry: COLLECT });

      expect(result.data).toEqual({ images: [{ url: "https://example.invalid/out.png" }] });
      expect(server.state.requestCount).toBe(3);
      // One key across all three — this is the whole reason the collect is
      // safe. A fresh key would dispatch, and bill, a second generation.
      expect(server.state.idempotencyKeys).toHaveLength(3);
      expect(new Set(server.state.idempotencyKeys).size).toBe(1);
    });
  }, 20_000);

  it("collects a 504 deadline_exceeded the same way", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.failTimes = 1;
      server.state.failStatus = 504;
      server.state.failErrorType = "deadline_exceeded";
      server.state.failRetryAfter = "1";
      server.state.idempotentReplayed = true;

      const result = await comfy.models.run(MODEL, { prompt: "a cat" }, { retry: COLLECT });

      expect(result.data).toEqual({ images: [{ url: "https://example.invalid/out.png" }] });
      expect(server.state.requestCount).toBe(2);
      expect(new Set(server.state.idempotencyKeys).size).toBe(1);
    });
  }, 20_000);

  it("collects a Retry-After: 0 on its own backoff rather than spinning", async () => {
    // `0` is a pace the SDK cannot honour literally — re-asking with no delay
    // would drain `collectBudgetMs` in a tight loop of full model-run POSTs.
    // `nextCollectDelayMs` falls back to this module's jittered backoff, so
    // the collect still happens and still waits.
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.failTimes = 1;
      server.state.failStatus = 409;
      server.state.failErrorType = "concurrency_limit_exceeded";
      server.state.failRetryAfter = "0";
      server.state.idempotentReplayed = true;

      const started = Date.now();
      const result = await comfy.models.run(MODEL, {}, { retry: COLLECT });

      expect(result.requestId).toBe("6f1a1a6e-6a53-4a5f-9d3a-2b3b0a1f9c21");
      expect(server.state.requestCount).toBe(2);
      expect(new Set(server.state.idempotencyKeys).size).toBe(1);
      // Backoff pacing (milliseconds), not the second the header did not name.
      expect(Date.now() - started).toBeLessThan(500);
    });
  }, 20_000);

  it("keeps collecting through a transport failure once Router has said the generation is running", async () => {
    // A paced 409 says Router holds a generation under this key. The re-ask
    // that follows loses its socket — and that is a failure to COLLECT, not an
    // ordinary transport failure: it is re-asked at the server's pace and
    // budgeted against `collectBudgetMs`. `budgetMs` is 1ms here, so an
    // ordinary retry would have been refused outright and the generation
    // Router was still holding abandoned.
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.failTimes = 1;
      server.state.failStatus = 409;
      server.state.failErrorType = "concurrency_limit_exceeded";
      server.state.failRetryAfter = "1";
      server.state.resetTimes = 1;
      server.state.resetAfterFail = true;
      server.state.idempotentReplayed = true;

      const result = await comfy.models.run(
        MODEL,
        { prompt: "a cat" },
        { retry: { ...COLLECT, budgetMs: 1 } },
      );

      expect(result.data).toEqual({ images: [{ url: "https://example.invalid/out.png" }] });
      expect(server.state.requestCount).toBe(3);
      expect(new Set(server.state.idempotencyKeys).size).toBe(1);
    });
  }, 20_000);

  it("carries the collect's pace on a deadline that fires mid-collect", async () => {
    // The re-ask is pending when the call's own deadline fires. The
    // `request_timeout` that raises is the end of a collect, not of a plain
    // call: it carries the pace of the last collectable answer beside the key,
    // so a manual re-ask still has both. (Only the first request is asserted
    // on: whether the re-ask itself reached the stub before the deadline is
    // undici's timing, not this SDK's.)
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.status = 409;
      server.state.errorType = "concurrency_limit_exceeded";
      server.state.retryAfter = "1";
      server.state.body = { detail: "still running", error_type: "concurrency_limit_exceeded" };
      server.state.delayMs = 1_000;

      const err = (await comfy.models
        .run(MODEL, {}, { timeoutMs: 2_800, retry: { ...COLLECT, collectBudgetMs: 60_000 } })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("request_timeout");
      expect(err.retryAfter).toBe(1);
      expect(err.idempotencyKey).toBe(server.state.idempotencyKeys[0]);
    });
  }, 20_000);

  it("leaves a 504 with no Retry-After to the ordinary 5xx backoff", async () => {
    // No header means Router holds no handle to collect from — so this is a
    // plain 5xx, retried on `budgetMs` and this SDK's own jittered backoff
    // rather than on a pace the server named. The distinction is invisible in
    // the outcome, so it is asserted on the clock: the ordinary backoff here
    // is milliseconds, while a collect would have been paced in seconds.
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.failTimes = 1;
      server.state.failStatus = 504;
      server.state.failErrorType = "deadline_exceeded";
      server.state.failRetryAfter = null;

      const started = Date.now();
      const result = await comfy.models.run(MODEL, {}, { retry: COLLECT });

      expect(result.requestId).toBe("6f1a1a6e-6a53-4a5f-9d3a-2b3b0a1f9c21");
      expect(server.state.requestCount).toBe(2);
      expect(Date.now() - started).toBeLessThan(500);
    });
  }, 20_000);

  it("raises the server's own 409 once the collect budget is spent", async () => {
    // Never a synthetic "retries exhausted": the last answer the server gave
    // is what the caller sees, and it carries what a manual re-ask needs.
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.status = 409;
      server.state.errorType = "concurrency_limit_exceeded";
      server.state.retryAfter = "1";
      server.state.body = {
        detail: "already in progress",
        error_type: "concurrency_limit_exceeded",
      };

      const err = (await comfy.models
        .run(MODEL, {}, { retry: { ...COLLECT, collectBudgetMs: 300 } })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("concurrency_limit_exceeded");
      expect(err.httpStatus).toBe(409);
      expect(err.message).toBe("already in progress");
      expect(err.requestId).toBe("6f1a1a6e-6a53-4a5f-9d3a-2b3b0a1f9c21");
      // The two values a caller needs to re-ask by hand after the budget: the
      // pace, and the key that names the generation Router is still holding.
      expect(err.retryAfter).toBe(1);
      expect(err.idempotencyKey).toBe(server.state.idempotencyKeys[0]);
      expect(server.state.requestCount).toBeGreaterThan(1);
    });
  }, 20_000);

  it("stops the collect at the caller's abort rather than sleeping out the pace", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.status = 409;
      server.state.errorType = "concurrency_limit_exceeded";
      server.state.retryAfter = "1";
      server.state.body = { detail: "still running", error_type: "concurrency_limit_exceeded" };

      const controller = new AbortController();
      const pending = comfy.models.run(MODEL, {}, { retry: COLLECT, signal: controller.signal });
      await waitFor(() => server.state.requestCount >= 1);
      controller.abort();

      // The caller's own abort, re-thrown untouched — not dressed up as an
      // SDK error, and not the 409 the collect was waiting to re-ask about.
      const err = (await pending.catch((e: unknown) => e)) as Error;
      expect(err.name).toBe("AbortError");
      expect(server.state.requestCount).toBe(1);
    });
  }, 20_000);

  it("collects nothing under retry: false, or with the collect budget switched off", async () => {
    for (const retry of [false as const, { ...COLLECT, collectBudgetMs: 0 }]) {
      await withRouterStub(async (server) => {
        useStub(server);
        server.state.status = 409;
        server.state.errorType = "concurrency_limit_exceeded";
        server.state.retryAfter = "1";
        server.state.body = { detail: "still running", error_type: "concurrency_limit_exceeded" };

        const err = (await comfy.models
          .run(MODEL, {}, { retry })
          .catch((e: unknown) => e)) as ComfyError;

        expect(err.httpStatus).toBe(409);
        expect(err.retryAfter).toBe(1);
        expect(server.state.requestCount, JSON.stringify(retry)).toBe(1);
      });
    }
  });

  it("keeps the call's own deadline as the cap over the collect budget", async () => {
    // `collectBudgetMs` is generous and `timeoutMs` is not: the deadline wins,
    // which is what makes a caller-supplied `timeoutMs` shorter than Router's
    // own deadline forfeit the 504 collect.
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.status = 409;
      server.state.errorType = "concurrency_limit_exceeded";
      server.state.retryAfter = "1";
      server.state.body = { detail: "still running", error_type: "concurrency_limit_exceeded" };

      const started = Date.now();
      const err = (await comfy.models
        .run(MODEL, {}, { timeoutMs: 400, retry: { ...COLLECT, collectBudgetMs: 60_000 } })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err.httpStatus).toBe(409);
      expect(server.state.requestCount).toBe(1);
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  }, 20_000);
});

describe("comfy.models.run cancellation", () => {
  it("aborts the underlying connection, so the server sees a disconnect", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.hang = true; // the request is open on the server when we abort
      const controller = new AbortController();
      const pending = comfy.models.run(MODEL, {}, { signal: controller.signal });

      await waitFor(() => server.state.requestCount === 1);
      controller.abort();
      await expect(pending).rejects.toBeTruthy();

      // Not merely an abandoned promise: the socket went away, which is what
      // the server measures a client disconnect from.
      await waitFor(() => server.state.clientDisconnects >= 1);
      expect(server.state.clientDisconnects).toBeGreaterThanOrEqual(1);
    });
  }, 10_000);

  it("rejects with a distinguishable abort, not a generic network error", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.hang = true;
      const controller = new AbortController();
      const pending = comfy.models.run(MODEL, {}, { signal: controller.signal });
      await waitFor(() => server.state.requestCount === 1);
      controller.abort();

      const err = (await pending.catch((e: unknown) => e)) as Error;
      // `AbortError` — told apart from a transport failure (`TypeError`) and
      // from this SDK's own deadline (`ComfyError` / `request_timeout`).
      expect(err.name).toBe("AbortError");
      expect(err).not.toBeInstanceOf(ComfyError);
      expect(err).not.toBeInstanceOf(TypeError);
    });
  }, 10_000);

  it("stops the retry loop mid-backoff instead of letting the next attempt go out", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.status = 503;
      server.state.body = { detail: "down", error_type: "internal_error" };
      const controller = new AbortController();

      // A backoff long enough that only an abort can end the wait.
      const pending = comfy.models.run(
        MODEL,
        {},
        {
          signal: controller.signal,
          retry: { budgetMs: 60_000, baseDelayMs: 10_000, maxDelayMs: 10_000 },
        },
      );
      await waitFor(() => server.state.requestCount === 1);
      controller.abort();

      const err = (await pending.catch((e: unknown) => e)) as Error;
      expect(err.name).toBe("AbortError");
      // The second attempt never went out.
      expect(server.state.requestCount).toBe(1);
    });
  }, 10_000);
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
      .run("bfl/flux-2-pro/v1.1", {})
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
