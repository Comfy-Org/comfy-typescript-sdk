/**
 * `comfy.models.submit` / `subscribe` / `handle` against a stubbed router: the
 * four routes they call, the handle's operations, the poll loop's pacing and
 * bounds, and the completion-carries-a-failure rule.
 *
 * This file imports `./modelRequests.js` FIRST, before `./index.js`, on
 * purpose: `./models.ts` reads this module's three namespace functions at
 * module-evaluation time, so this import order is the one that would surface a
 * temporal-dead-zone regression if either side grew a `const` the other reads.
 */
import { RequestHandle, nextPollDelayMs, MAX_RETRY_AFTER_MS } from "./modelRequests.js";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type RecordedRequest,
  RouterStubServer,
  withRouterStub,
} from "../../test/support/router-stub-server.js";
import {
  comfy,
  ComfyError,
  config,
  CREDENTIALS_ENV_VAR,
  DEFAULT_MAX_RESPONSE_BYTES,
  MissingCredentials,
} from "./index.js";
import * as routerErrors from "./routerErrors.js";

const CREDENTIAL = "comfyui-test-credential";
const MODEL = "bfl/flux-2-pro";
const REQUEST_ID = "6f1a1a6e-6a53-4a5f-9d3a-2b3b0a1f9c21";
const SUBMIT_PATH = "/v2/models/bfl/flux-2-pro/requests";
const REQUEST_PATH = `${SUBMIT_PATH}/${REQUEST_ID}`;
const STATUS_PATH = `${REQUEST_PATH}/status`;
const CANCEL_PATH = `${REQUEST_PATH}/cancel`;

/** The provider payload the result route hands back. */
const PAYLOAD = { images: [{ url: "https://example.invalid/out.png" }], seed: 7 };

/** Any socket attempt at all fails the test that made it. */
function forbidNetwork(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(() => Promise.reject(new Error("network call attempted")));
  vi.stubGlobal("fetch", spy);
  return spy;
}

function useStub(server: RouterStubServer): void {
  config({ credentials: CREDENTIAL, baseUrl: server.baseUrl });
}

/**
 * Script the four queue routes from a list of status bodies.
 *
 * The submit is answered `201` with `REQUEST_ID`; each status read consumes
 * the next entry of `statuses` and repeats the last one once they run out; the
 * result route answers `result`; the cancel answers `202`. `extra` overrides
 * any of that per request.
 */
function queueScript(options: {
  statuses: Record<string, unknown>[];
  result?: unknown;
  statusHeaders?: Record<string, string>;
}) {
  let polls = 0;
  return (request: RecordedRequest) => {
    if (request.method === "POST" && request.path === SUBMIT_PATH) {
      return { status: 201, body: { request_id: REQUEST_ID, status: "IN_QUEUE" } };
    }
    if (request.method === "GET" && request.path === STATUS_PATH) {
      const index = Math.min(polls, options.statuses.length - 1);
      polls += 1;
      return {
        status: 200,
        body: options.statuses[index],
        headers: options.statusHeaders,
      };
    }
    if (request.method === "GET" && request.path === REQUEST_PATH) {
      return { status: 200, body: options.result ?? PAYLOAD };
    }
    if (request.method === "PUT" && request.path === CANCEL_PATH) {
      return { status: 202, body: { request_id: REQUEST_ID, status: "CANCELLATION_REQUESTED" } };
    }
    return { status: 404, body: { detail: `unscripted ${request.method} ${request.path}` } };
  };
}

const IN_QUEUE = { request_id: REQUEST_ID, status: "IN_QUEUE", queue_position: 3 };
const IN_PROGRESS = { request_id: REQUEST_ID, status: "IN_PROGRESS" };
const DONE = { request_id: REQUEST_ID, status: "COMPLETED" };

beforeEach(() => {
  vi.stubEnv(CREDENTIALS_ENV_VAR, undefined);
  config({ credentials: undefined, baseUrl: undefined });
});

afterEach(() => {
  config({ credentials: undefined, baseUrl: undefined });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the queued surface on the comfy.models namespace", () => {
  it("exposes submit, subscribe and handle beside run, all frozen", () => {
    expect(comfy.models.submit).toBeTypeOf("function");
    expect(comfy.models.subscribe).toBeTypeOf("function");
    expect(comfy.models.handle).toBeTypeOf("function");
    expect(Object.isFrozen(comfy.models)).toBe(true);
  });

  it("rejects with MissingCredentials before any request", async () => {
    const fetchSpy = forbidNetwork();
    await expect(comfy.models.submit(MODEL, {})).rejects.toBeInstanceOf(MissingCredentials);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("comfy.models.submit", () => {
  it("POSTs the native input to the model's `requests` collection", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = queueScript({ statuses: [DONE] });

      const input = { prompt: "a cat", seed: 7 };
      const handle = await comfy.models.submit(MODEL, input);

      expect(server.state.requests).toHaveLength(1);
      expect(server.state.requests[0].method).toBe("POST");
      expect(server.state.requests[0].path).toBe(SUBMIT_PATH);
      // No Comfy envelope: the body is the provider's own document.
      expect(JSON.parse(server.state.requests[0].body)).toEqual(input);
      expect(handle.requestId).toBe(REQUEST_ID);
      expect(handle.model).toBe(MODEL);
    });
  });

  it("accepts 200, 201 and 202 as an acceptance", async () => {
    for (const status of [200, 201, 202]) {
      await withRouterStub(async (server) => {
        useStub(server);
        server.state.respond = () => ({ status, body: { request_id: REQUEST_ID } });
        const handle = await comfy.models.submit(MODEL, {});
        expect(handle.requestId, String(status)).toBe(REQUEST_ID);
      });
    }
  });

  it("mints a fresh Idempotency-Key per call", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = () => ({ status: 201, body: { request_id: REQUEST_ID } });

      await comfy.models.submit(MODEL, { prompt: "a cat" });
      await comfy.models.submit(MODEL, { prompt: "a cat" });

      expect(server.state.idempotencyKeys).toHaveLength(2);
      expect(server.state.idempotencyKeys[0]).not.toBe(server.state.idempotencyKeys[1]);
    });
  });

  it("reuses the one key across every retry inside a single call", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      // Two transport failures, then the acceptance — three attempts, one key,
      // so the retry replays the original acceptance rather than queueing a
      // second generation.
      server.state.resetTimes = 2;
      server.state.respond = () => ({ status: 201, body: { request_id: REQUEST_ID } });

      await comfy.models.submit(MODEL, {}, { retry: { baseDelayMs: 1 } });

      expect(server.state.idempotencyKeys).toHaveLength(3);
      expect(new Set(server.state.idempotencyKeys).size).toBe(1);
    });
  });

  it("lets idempotencyKey override the minted one", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = () => ({ status: 201, body: { request_id: REQUEST_ID } });
      await comfy.models.submit(MODEL, {}, { idempotencyKey: "chosen-by-the-caller" });
      expect(server.state.idempotencyKeys).toEqual(["chosen-by-the-caller"]);
    });
  });

  it("rejects with NotEnabled on a 403 not_enabled, and does not retry it", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = () => ({
        status: 403,
        errorType: "not_enabled",
        body: {
          detail: "Comfy Router does not run this model yet for this workspace.",
          error_type: "not_enabled",
        },
      });

      const err = (await comfy.models.submit(MODEL, {}).catch((e: unknown) => e)) as Error;

      expect(err).toBeInstanceOf(routerErrors.NotEnabled);
      expect(err).toBeInstanceOf(routerErrors.RouterError);
      // Terminal: one attempt, not a spent retry budget.
      expect(server.state.requestCount).toBe(1);
    });
  });

  it("rejects when the acceptance names no usable request_id", async () => {
    const cases: unknown[] = [{}, { request_id: "" }, { request_id: 7 }, { request_id: "a/b" }];
    for (const body of cases) {
      await withRouterStub(async (server) => {
        useStub(server);
        server.state.respond = () => ({ status: 201, body });
        const err = (await comfy.models.submit(MODEL, {}).catch((e: unknown) => e)) as ComfyError;
        expect(err, JSON.stringify(body)).toBeInstanceOf(ComfyError);
        expect(err.code).toBe("invalid_response");
      });
    }
  });

  it("rejects when the acceptance body is not a JSON object", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = () => ({ status: 201, body: [1, 2, 3] });
      const err = (await comfy.models.submit(MODEL, {}).catch((e: unknown) => e)) as ComfyError;
      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("invalid_response");
    });
  });

  it("refuses a malformed model ID and a non-object input locally", async () => {
    const fetchSpy = forbidNetwork();
    config({ credentials: CREDENTIAL });
    for (const bad of ["flux-pro", "", "a/b/c", "./x", "a/.."]) {
      await expect(comfy.models.submit(bad, {}), bad).rejects.toBeInstanceOf(TypeError);
    }
    for (const bad of [null, [1], "prompt"]) {
      await expect(
        comfy.models.submit(MODEL, bad as unknown as Record<string, unknown>),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("RequestHandle.status", () => {
  it("GETs the status route once and reports what the queue said", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = queueScript({
        statuses: [IN_QUEUE],
        statusHeaders: { "Retry-After": "2" },
      });

      const handle = await comfy.models.submit(MODEL, {});
      const update = await handle.status();

      expect(server.state.requests[1].method).toBe("GET");
      expect(server.state.requests[1].path).toBe(STATUS_PATH);
      expect(update.status).toBe("IN_QUEUE");
      expect(update.completed).toBe(false);
      expect(update.queuePosition).toBe(3);
      expect(update.errorType).toBeNull();
      expect(update.retryAfterMs).toBe(2_000);
      expect(update.requestId).toBe(REQUEST_ID);
      expect(update.raw).toEqual(IN_QUEUE);
    });
  });

  it("reports a completion's error_type as data rather than raising", async () => {
    // `status()` is the read a caller uses to LOOK. The raising belongs to
    // `get()`, which is the one that hands back a result.
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = queueScript({
        statuses: [{ ...DONE, error_type: "content_policy_violation" }],
      });

      const update = await comfy.models.handle(MODEL, REQUEST_ID).status();

      expect(update.completed).toBe(true);
      expect(update.errorType).toBe("content_policy_violation");
    });
  });

  it("rejects on a status body that is not a JSON object", async () => {
    for (const body of [[1, 2], "not json at all", 7]) {
      await withRouterStub(async (server) => {
        useStub(server);
        server.state.respond = () => ({ status: 200, body });
        const err = (await comfy.models
          .handle(MODEL, REQUEST_ID)
          .status()
          .catch((e: unknown) => e)) as ComfyError;
        expect(err, JSON.stringify(body)).toBeInstanceOf(ComfyError);
        expect(err.code).toBe("invalid_response");
      });
    }
  });

  it("rejects on a status body that names no status", async () => {
    // Treating it as "not yet terminal" would poll a `200 {}` forever.
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = () => ({ status: 200, body: { request_id: REQUEST_ID } });
      const err = (await comfy.models
        .handle(MODEL, REQUEST_ID)
        .status()
        .catch((e: unknown) => e)) as ComfyError;
      expect(err.code).toBe("invalid_response");
    });
  });

  it("ignores a queue_position that is not an integer", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = () => ({
        status: 200,
        body: { status: "IN_QUEUE", queue_position: "3" },
      });
      const update = await comfy.models.handle(MODEL, REQUEST_ID).status();
      expect(update.queuePosition).toBeNull();
    });
  });
});

describe("RequestHandle.events", () => {
  it("yields the first observation, every change, and the completion", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = queueScript({
        statuses: [
          IN_QUEUE,
          IN_QUEUE, // unchanged — not yielded
          { ...IN_QUEUE, queue_position: 1 },
          IN_PROGRESS,
          DONE,
        ],
      });

      const handle = comfy.models.handle(MODEL, REQUEST_ID);
      const seen: (string | number | null)[][] = [];
      for await (const update of handle.events()) {
        seen.push([update.status, update.queuePosition]);
      }

      expect(seen).toEqual([
        ["IN_QUEUE", 3],
        ["IN_QUEUE", 1],
        ["IN_PROGRESS", null],
        ["COMPLETED", null],
      ]);
      // Five polls, four yields: the repeat of an unchanged update is polled
      // and then dropped rather than redrawing a caller's progress bar.
      expect(server.state.requestCount).toBe(5);
    }, 30_000);
  }, 30_000);

  it("does not raise for a completion carrying an error_type", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = queueScript({
        statuses: [{ ...DONE, error_type: "provider_error" }],
      });
      const seen = [];
      for await (const update of comfy.models.handle(MODEL, REQUEST_ID).events()) {
        seen.push(update.errorType);
      }
      expect(seen).toEqual(["provider_error"]);
    });
  });

  it("treats a status this release has never heard of as not yet terminal", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = queueScript({
        statuses: [{ request_id: REQUEST_ID, status: "WARMING_UP" }, DONE],
      });
      const seen: string[] = [];
      for await (const update of comfy.models.handle(MODEL, REQUEST_ID).events()) {
        seen.push(update.status);
      }
      expect(seen).toEqual(["WARMING_UP", "COMPLETED"]);
    }, 30_000);
  }, 30_000);

  it("always makes the first poll, so timeoutMs: 0 reads `look once`", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = queueScript({ statuses: [IN_QUEUE] });

      const seen: string[] = [];
      const err = await (async () => {
        try {
          for await (const update of comfy.models
            .handle(MODEL, REQUEST_ID)
            .events({ timeoutMs: 0 })) {
            seen.push(update.status);
          }
          return null;
        } catch (e: unknown) {
          return e as ComfyError;
        }
      })();

      expect(seen).toEqual(["IN_QUEUE"]);
      expect(server.state.requestCount).toBe(1);
      expect(err?.code).toBe("request_timeout");
    });
  });

  it("bounds the poll requests themselves, not only the pauses", async () => {
    // The server never answers, so nothing here is a pause: if `timeoutMs`
    // only covered the sleeps between polls, this would hang until the
    // per-request default rather than reject at the bound.
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.hang = true;

      const startedAt = Date.now();
      const err = (await comfy.models
        .handle(MODEL, REQUEST_ID)
        .get({ timeoutMs: 1_500 })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("request_timeout");
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    });
  }, 30_000);

  it("stops polling when the caller's signal aborts, and re-throws their abort", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = queueScript({
        statuses: [IN_QUEUE],
        statusHeaders: { "Retry-After": "30" },
      });
      const controller = new AbortController();
      const handle = comfy.models.handle(MODEL, REQUEST_ID);

      const promise = (async () => {
        for await (const update of handle.events({ signal: controller.signal })) {
          void update;
          controller.abort();
        }
      })();

      const err = (await promise.catch((e: unknown) => e)) as Error;
      expect(err.name).toBe("AbortError");
      expect(server.state.requestCount).toBe(1);
    });
  });
});

describe("RequestHandle.get", () => {
  it("polls to completion, then collects the provider payload as a RunResult", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = queueScript({ statuses: [DONE], result: PAYLOAD });
      server.state.requestId = "http-req-9";

      const handle = comfy.models.handle<typeof PAYLOAD>(MODEL, REQUEST_ID);
      const result = await handle.get();

      // The DISCRIMINANT, so a caller can narrow one `RunResult` across both
      // paths. `"json"` is what a JSON `Content-Type` produces; a partner's own
      // media type produces `"binary"`, exactly as on the synchronous route.
      expect(result.kind).toBe("json");
      // No cast: `data` is the supplied type, exactly as `run<T>` gives it.
      expect(result.data.images[0].url).toBe("https://example.invalid/out.png");
      expect(result.requestId).toBe("http-req-9");
      expect(server.state.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        `GET ${STATUS_PATH}`,
        `GET ${REQUEST_PATH}`,
      ]);
    });
  });

  it("rejects with the typed router error a completion reports, and fetches no result", async () => {
    const cases: [string, new (...args: never[]) => Error][] = [
      ["content_policy_violation", routerErrors.ContentPolicyViolation],
      ["provider_error", routerErrors.ProviderError],
      ["insufficient_credits", routerErrors.InsufficientCredits],
      ["model_not_found", routerErrors.ModelNotFound],
    ];
    for (const [errorType, cls] of cases) {
      await withRouterStub(async (server) => {
        useStub(server);
        server.state.respond = queueScript({
          statuses: [{ ...DONE, error_type: errorType, detail: "the model refused" }],
        });

        const err = (await comfy.models
          .handle(MODEL, REQUEST_ID)
          .get()
          .catch((e: unknown) => e)) as routerErrors.RouterError;

        expect(err, errorType).toBeInstanceOf(cls);
        expect(err.errorType).toBe(errorType);
        expect(err.message).toBe("the model refused");
        // There was no failing HTTP status — the poll that found this was a 200.
        expect(err.httpStatus).toBeNull();
        // One request: the status read. The result is never fetched.
        expect(server.state.requestCount).toBe(1);
      });
    }
  });

  it("never returns a 200 result as success when the RESULT body reports the failure", async () => {
    // Which of the two responses carries the `error_type` is the server's
    // choice; reading only the status read is how a failure gets handed back
    // as data.
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = queueScript({
        statuses: [DONE],
        result: { status: "COMPLETED", error_type: "provider_timeout", detail: "upstream stalled" },
      });

      const err = (await comfy.models
        .handle(MODEL, REQUEST_ID)
        .get()
        .catch((e: unknown) => e)) as routerErrors.RouterError;

      expect(err).toBeInstanceOf(routerErrors.ProviderTimeout);
      expect(err.message).toBe("upstream stalled");
    });
  });

  it("keeps an `error_type` in the provider's own output out of the raising path", async () => {
    // The result route's body is the partner's payload, forwarded verbatim. A
    // model whose native output happens to have an `error_type` field must not
    // fail a generation that succeeded, so it only counts inside the queue's
    // own envelope — which a `COMPLETED` status alongside it identifies.
    await withRouterStub(async (server) => {
      useStub(server);
      const nativeOutput = { images: [], error_type: "invalid_input", note: "the model's own" };
      server.state.respond = queueScript({ statuses: [DONE], result: nativeOutput });

      const { data } = await comfy.models.handle(MODEL, REQUEST_ID).get();

      expect(data).toEqual(nativeOutput);
    });
  });

  it("returns a result body that is not a JSON object unchanged in `data`", async () => {
    // A partner whose native output is an array, a number or a bare string is
    // handed back untouched: the payload is the partner's, not this SDK's to
    // reshape, so "not an object" is not the same thing as "malformed".
    for (const result of [[{ url: "a.png" }], 42, true, "a bare string"]) {
      await withRouterStub(async (server) => {
        useStub(server);
        server.state.respond = (request) => {
          if (request.path === STATUS_PATH) return { status: 200, body: DONE };
          // Pre-encoded, because the stub sends a `string` body verbatim —
          // which is how it serves a non-JSON fixture elsewhere.
          return { status: 200, body: JSON.stringify(result) };
        };
        const { data } = await comfy.models.handle(MODEL, REQUEST_ID).get();
        expect(data, JSON.stringify(result)).toEqual(result);
      });
    }
  });

  it("rejects when the result body is not JSON at all", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = (request) => {
        if (request.path === STATUS_PATH) return { status: 200, body: DONE };
        return { status: 200, body: "<html>gateway</html>" };
      };
      const err = (await comfy.models
        .handle(MODEL, REQUEST_ID)
        .get()
        .catch((e: unknown) => e)) as ComfyError;
      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("invalid_response");
      expect(err.cause).toBeInstanceOf(SyntaxError);
    });
  });

  it("reports a 202 on the result route rather than typing it as a result", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = (request) => {
        if (request.path === STATUS_PATH) return { status: 200, body: DONE };
        return { status: 202, body: { request_id: REQUEST_ID, status: "IN_PROGRESS" } };
      };

      const err = (await comfy.models
        .handle(MODEL, REQUEST_ID)
        .get()
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("invalid_response");
      expect(err.message).toContain("202");
    });
  });

  it("collects an already-completed request without waiting", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = queueScript({ statuses: [DONE] });
      const handle = comfy.models.handle(MODEL, REQUEST_ID);
      await handle.get();
      await handle.get();
      // Two polls and two fetches: collecting twice costs no more than once.
      expect(server.state.requestCount).toBe(4);
    });
  });
});

describe("RequestHandle.cancel", () => {
  it("is sent as PUT to the cancel route", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = queueScript({ statuses: [IN_QUEUE] });

      const update = await comfy.models.handle(MODEL, REQUEST_ID).cancel();

      expect(server.state.requests[0].method).toBe("PUT");
      expect(server.state.requests[0].path).toBe(CANCEL_PATH);
      expect(update.status).toBe("CANCELLATION_REQUESTED");
      expect(update.requestId).toBe(REQUEST_ID);
    });
  });

  it("accepts a body-less 204 and reports no status", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = () => ({ status: 204 });
      const update = await comfy.models.handle(MODEL, REQUEST_ID).cancel();
      expect(update.status).toBe("");
      expect(update.completed).toBe(false);
      // The id still identifies the request the cancel was about.
      expect(update.requestId).toBe(REQUEST_ID);
    });
  });

  it("surfaces a 400 ALREADY_COMPLETED as a typed router error", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = () => ({
        status: 400,
        body: { detail: "ALREADY_COMPLETED", error_type: "invalid_input" },
        errorType: "invalid_input",
      });
      const err = (await comfy.models
        .handle(MODEL, REQUEST_ID)
        .cancel()
        .catch((e: unknown) => e)) as routerErrors.RouterError;
      expect(err).toBeInstanceOf(routerErrors.InvalidInput);
      expect(err.message).toBe("ALREADY_COMPLETED");
    });
  });
});

describe("comfy.models.handle", () => {
  it("rebuilds a handle from the two ids with no request made", () => {
    const fetchSpy = forbidNetwork();
    config({ credentials: CREDENTIAL });
    const handle = comfy.models.handle(MODEL, REQUEST_ID);
    expect(handle).toBeInstanceOf(RequestHandle);
    expect(handle.model).toBe(MODEL);
    expect(handle.requestId).toBe(REQUEST_ID);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("needs no credentials to build one — only to use it", () => {
    forbidNetwork();
    expect(() => comfy.models.handle(MODEL, REQUEST_ID)).not.toThrow();
  });

  it("validates the model ID locally", () => {
    forbidNetwork();
    for (const bad of ["flux-pro", "", "a/b/c", "a/", "./x"]) {
      expect(() => comfy.models.handle(bad, REQUEST_ID), bad).toThrow(TypeError);
    }
  });

  it("refuses a request id that is not one printable path segment of at most 256 chars", () => {
    forbidNetwork();
    const bad: unknown[] = [
      "", // empty
      "a/b", // more than one path segment
      ".", // would traverse the path
      "..",
      "a\u0007b", // a control character
      "a\nb", // a newline, the same rule
      "\u2028", // a Unicode line separator is not printable either
      "x".repeat(257), // one over the bound
      7, // not a string at all
      null,
    ];
    for (const value of bad) {
      expect(() => comfy.models.handle(MODEL, value as string), JSON.stringify(value)).toThrow(
        TypeError,
      );
    }
    // Exactly at the bound, and a plain UUID, are both fine.
    expect(() => comfy.models.handle(MODEL, "x".repeat(256))).not.toThrow();
    expect(() => comfy.models.handle(MODEL, REQUEST_ID)).not.toThrow();
  });

  it("percent-encodes both ids into the path rather than letting one add a segment", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = () => ({ status: 200, body: { status: "IN_QUEUE" } });
      await comfy.models.handle("fal ai/flux#pro", "req id#1").status();
      expect(server.state.lastPath).toBe(
        "/v2/models/fal%20ai/flux%23pro/requests/req%20id%231/status",
      );
    });
  });
});

/**
 * The result route's 200 is declared as `application/json` OR `*\/*` bytes, and
 * the handle branches on `Content-Type` exactly as `run` does. Router refuses
 * binary models at submit today, so this is the contract's arm rather than one
 * a live queue produces yet.
 */
describe("RequestHandle on a binary result", () => {
  /** The head of a real `audio/mpeg` body, including bytes that are not valid
   * UTF-8 and would not survive a text decode — the fixture `run` uses. */
  const MP3_BYTES = new Uint8Array([
    0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x64, 0x00, 0x0d,
  ]);

  function binaryScript(
    body: Uint8Array | string | undefined,
    contentType: string | null,
    headers?: Record<string, string>,
  ) {
    return (request: RecordedRequest) => {
      if (request.method === "POST" && request.path === SUBMIT_PATH) {
        return { status: 201, body: { request_id: REQUEST_ID, status: "IN_QUEUE" } };
      }
      if (request.path === STATUS_PATH) return { status: 200, body: DONE };
      return { status: 200, body, contentType, headers };
    };
  }

  it("get() resolves audio/mpeg bytes verbatim as the binary arm", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = binaryScript(MP3_BYTES, "audio/mpeg");
      server.state.requestId = "http-req-bin";

      const result = await comfy.models.handle(MODEL, REQUEST_ID).get();

      if (result.kind !== "binary") throw new Error(`expected binary, got ${result.kind}`);
      expect(result.contentType).toBe("audio/mpeg");
      expect(result.data).toEqual(MP3_BYTES);
      expect(result.requestId).toBe("http-req-bin");
    });
  });

  it("subscribe() resolves to the binary arm too", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = binaryScript(MP3_BYTES, "audio/mpeg");

      const result = await comfy.models.subscribe(MODEL, { text: "hi" });

      if (result.kind !== "binary") throw new Error(`expected binary, got ${result.kind}`);
      expect(result.data).toEqual(MP3_BYTES);
    });
  });

  it("keeps the full Content-Type string, parameters included", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = binaryScript(MP3_BYTES, "audio/mpeg; rate=44100");

      const result = await comfy.models.handle(MODEL, REQUEST_ID).get();

      if (result.kind !== "binary") throw new Error(`expected binary, got ${result.kind}`);
      expect(result.contentType).toBe("audio/mpeg; rate=44100");
    });
  });

  it("returns a headerless non-JSON body as binary with an empty contentType", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = binaryScript(MP3_BYTES, null);

      const result = await comfy.models.handle(MODEL, REQUEST_ID).get();

      if (result.kind !== "binary") throw new Error(`expected binary, got ${result.kind}`);
      expect(result.contentType).toBe("");
      expect(result.data).toEqual(MP3_BYTES);
    });
  });

  it("still parses a headerless JSON body as the json arm", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = binaryScript(JSON.stringify(PAYLOAD), null);

      const result = await comfy.models.handle(MODEL, REQUEST_ID).get();

      expect(result.kind).toBe("json");
      expect(result.data).toEqual(PAYLOAD);
    });
  });

  it("accepts any media type on the result request and only JSON on the status request", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = binaryScript(MP3_BYTES, "audio/mpeg");

      await comfy.models.handle(MODEL, REQUEST_ID).get();

      expect(server.state.requests.map((r) => [r.path, r.accept])).toEqual([
        [STATUS_PATH, "application/json"],
        [REQUEST_PATH, "application/json, */*;q=0.9"],
      ]);
    });
  });

  it("rejects an empty 200 rather than handing back zero bytes", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = binaryScript(undefined, "audio/mpeg");

      const err = (await comfy.models
        .handle(MODEL, REQUEST_ID)
        .get()
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("invalid_response");
    });
  });

  it("refuses a result that declares more than the default cap, without retrying", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = binaryScript(undefined, "audio/mpeg", {
        "Content-Length": String(DEFAULT_MAX_RESPONSE_BYTES + 1),
      });

      const err = (await comfy.models
        .handle(MODEL, REQUEST_ID)
        .get()
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("response_too_large");
      expect(err.details?.maxBytes).toBe(DEFAULT_MAX_RESPONSE_BYTES);
      expect(err.message).toContain(REQUEST_ID);
      // The queued surface has no per-call cap, so the advice must not name one.
      expect(err.message).not.toContain("raise maxBytes");
      expect(err.message).toContain("takes no per-call maxBytes");
      expect(server.state.requests.map((r) => r.path)).toEqual([STATUS_PATH, REQUEST_PATH]);
    });
  });
});

describe("comfy.models.subscribe", () => {
  it("submits, follows the queue, and resolves to the result", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = queueScript({
        statuses: [IN_QUEUE, DONE],
        statusHeaders: { "Retry-After": "1" },
      });

      const seen: string[] = [];
      const { data } = await comfy.models.subscribe(
        MODEL,
        { prompt: "a cat" },
        {
          onQueueUpdate: (update) => {
            seen.push(update.status);
          },
        },
      );

      expect(data).toEqual(PAYLOAD);
      expect(seen).toEqual(["IN_QUEUE", "COMPLETED"]);
      expect(server.state.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        `POST ${SUBMIT_PATH}`,
        `GET ${STATUS_PATH}`,
        `GET ${STATUS_PATH}`,
        `GET ${REQUEST_PATH}`,
      ]);
    }, 30_000);
  }, 30_000);

  it("awaits an async onQueueUpdate before the next poll", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = queueScript({ statuses: [DONE] });
      let finished = false;
      await comfy.models.subscribe(
        MODEL,
        {},
        {
          onQueueUpdate: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            finished = true;
          },
        },
      );
      expect(finished).toBe(true);
    });
  });

  it("rejects with the typed router error when the completion reports a failure", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = queueScript({
        statuses: [{ ...DONE, error_type: "content_policy_violation", detail: "refused" }],
      });

      const err = (await comfy.models
        .subscribe(MODEL, {})
        .catch((e: unknown) => e)) as routerErrors.RouterError;

      expect(err).toBeInstanceOf(routerErrors.ContentPolicyViolation);
    });
  });

  it("issues one best-effort cancel on its own timeout, then rejects with the timeout", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = queueScript({
        statuses: [IN_QUEUE],
        statusHeaders: { "Retry-After": "30" },
      });

      const err = (await comfy.models
        .subscribe(MODEL, {}, { timeoutMs: 1_200 })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("request_timeout");
      const cancels = server.state.requests.filter((r) => r.method === "PUT");
      expect(cancels).toHaveLength(1);
      expect(cancels[0].path).toBe(CANCEL_PATH);
    }, 30_000);
  }, 30_000);

  it("issues one best-effort cancel on an abort, then re-throws the caller's abort", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = queueScript({
        statuses: [IN_QUEUE],
        statusHeaders: { "Retry-After": "30" },
      });
      const controller = new AbortController();

      const err = (await comfy.models
        .subscribe(
          MODEL,
          {},
          {
            signal: controller.signal,
            onQueueUpdate: () => {
              controller.abort();
            },
          },
        )
        .catch((e: unknown) => e)) as Error;

      expect(err.name).toBe("AbortError");
      const cancels = server.state.requests.filter((r) => r.method === "PUT");
      expect(cancels).toHaveLength(1);
    });
  });

  it("never lets the cleanup cancel's own failure mask the timeout", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = (request) => {
        if (request.method === "PUT") return { status: 500, body: { detail: "cancel exploded" } };
        if (request.method === "POST") return { status: 201, body: { request_id: REQUEST_ID } };
        return { status: 200, body: IN_QUEUE, headers: { "Retry-After": "30" } };
      };

      const err = (await comfy.models
        .subscribe(MODEL, {}, { timeoutMs: 1_200 })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err.code).toBe("request_timeout");
      expect(err.message).not.toContain("cancel exploded");
      // ONE attempt. A 500 is retryable, so without `retry: false` on the
      // cleanup cancel this would climb the caller's whole retry budget after
      // they had already stopped waiting.
      expect(server.state.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
    }, 30_000);
  }, 30_000);

  it("does not cancel when the caller's own onQueueUpdate throws", async () => {
    // A callback is the caller's code and may fail for reasons that have
    // nothing to do with the wait; cancelling a healthy request on the
    // strength of one would be destructive.
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = queueScript({ statuses: [IN_QUEUE, DONE] });

      const err = (await comfy.models
        .subscribe(
          MODEL,
          {},
          {
            onQueueUpdate: () => {
              throw new Error("the progress bar exploded");
            },
          },
        )
        .catch((e: unknown) => e)) as Error;

      expect(err.message).toBe("the progress bar exploded");
      expect(server.state.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
    });
  });

  it("starts its clock before the submit, so timeoutMs bounds the whole call", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      // The submit itself is slow enough to consume the whole budget, so a
      // clock started after it would leave the poll loop a full budget.
      server.state.delayMs = 1_500;
      server.state.respond = queueScript({ statuses: [IN_QUEUE] });

      const startedAt = Date.now();
      const err = (await comfy.models
        .subscribe(MODEL, {}, { timeoutMs: 1_800 })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err.code).toBe("request_timeout");
      // One submit plus at most one floored poll, not a fresh 1.8 s of polling.
      expect(Date.now() - startedAt).toBeLessThan(6_000);
    }, 30_000);
  }, 30_000);
});

describe("poll pacing", () => {
  it("prefers a server-named Retry-After over the adaptive schedule", () => {
    // The adaptive schedule starts at 500 ms; a server that names 2 s wins.
    expect(nextPollDelayMs(2_000, 500)).toBe(2_000);
    // And a server that names nothing leaves the schedule alone.
    expect(nextPollDelayMs(null, 500)).toBe(500);
    expect(nextPollDelayMs(null, 5_000)).toBe(5_000);
  });

  it("caps a server-named Retry-After at 60 seconds before sleeping on it", () => {
    // A hint, honoured — but not a bound one header can park a caller behind.
    expect(nextPollDelayMs(86_400_000, 500)).toBe(MAX_RETRY_AFTER_MS);
    expect(MAX_RETRY_AFTER_MS).toBe(60_000);
    // Just under and just over the ceiling.
    expect(nextPollDelayMs(59_000, 500)).toBe(59_000);
    expect(nextPollDelayMs(61_000, 500)).toBe(MAX_RETRY_AFTER_MS);
  });

  it("actually waits the pace the server named", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = queueScript({
        statuses: [IN_QUEUE, DONE],
        statusHeaders: { "Retry-After": "1" },
      });

      const startedAt = Date.now();
      await comfy.models.handle(MODEL, REQUEST_ID).get();

      // 1 s from the header, not the 500 ms the schedule would have chosen.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(950);
    }, 30_000);
  }, 30_000);

  it("ignores a Retry-After that names no usable pace", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      for (const raw of ["0", "-5", "soon", "Wed, 21 Oct 2026 07:28:00 GMT"]) {
        server.state.respond = () => ({
          status: 200,
          body: IN_QUEUE,
          headers: { "Retry-After": raw },
        });
        const update = await comfy.models.handle(MODEL, REQUEST_ID).status();
        expect(update.retryAfterMs, raw).toBeNull();
      }
    });
  });
});
