/**
 * `comfy.models.run` with `respondAsync`: the `Prefer: respond-async` opt-in,
 * and following the `202` + `Preference-Applied` handoff through the queued
 * routes to the same result `run` returns from a `200`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type RecordedRequest,
  RouterStubServer,
  withRouterStub,
} from "../../test/support/router-stub-server.js";
import { appliedRespondAsync } from "./models.js";
import { comfy, ComfyError, config, CREDENTIALS_ENV_VAR, InsufficientCredits } from "./index.js";
import * as routerErrors from "./routerErrors.js";

const CREDENTIAL = "comfyui-test-credential";
const MODEL = "tripo/p2-text";
const RUN_PATH = "/v2/models/tripo/p2-text";
const QUEUED_ID = "0b6f3c1e-2a4d-4e8f-9c1b-7d5e3f2a1b0c";
const REQUEST_PATH = `${RUN_PATH}/requests/${QUEUED_ID}`;
const STATUS_PATH = `${REQUEST_PATH}/status`;
const CANCEL_PATH = `${REQUEST_PATH}/cancel`;
const PAYLOAD = { model_url: "https://example.invalid/out.glb" };

/** The queue handle Router's handoff `202` carries — the submit acceptance's shape. */
const HANDLE_BODY = {
  request_id: QUEUED_ID,
  status: "IN_QUEUE",
  status_url: `https://router.invalid${STATUS_PATH}`,
  response_url: `https://router.invalid${REQUEST_PATH}`,
  cancel_url: `https://router.invalid${CANCEL_PATH}`,
};

/** Paces every poll at zero, so a test never sleeps out the adaptive backoff. */
const NO_WAIT = { "Retry-After": "0" };

function useStub(server: RouterStubServer): void {
  config({ credentials: CREDENTIAL, baseUrl: server.baseUrl });
}

/**
 * Script the run route and the queued reads behind it.
 *
 * The run `POST` answers `accepted` (a `202` handoff by default); each status
 * read consumes the next of `statuses`, repeating the last; the result read
 * answers `PAYLOAD`; a cancel answers `202`.
 */
function handoffScript(
  options: {
    accepted?: { status: number; body?: unknown; headers?: Record<string, string> };
    statuses?: Record<string, unknown>[];
    resultHeaders?: Record<string, string>;
  } = {},
) {
  const statuses = options.statuses ?? [
    { request_id: QUEUED_ID, status: "IN_PROGRESS" },
    { request_id: QUEUED_ID, status: "COMPLETED" },
  ];
  let polls = 0;
  return (request: RecordedRequest) => {
    if (request.method === "POST" && request.path === RUN_PATH) {
      return (
        options.accepted ?? {
          status: 202,
          body: HANDLE_BODY,
          headers: { "Preference-Applied": "respond-async" },
        }
      );
    }
    if (request.method === "GET" && request.path === STATUS_PATH) {
      const body = statuses[Math.min(polls, statuses.length - 1)];
      polls += 1;
      return { status: 200, body, headers: NO_WAIT };
    }
    if (request.method === "GET" && request.path === REQUEST_PATH) {
      return { status: 200, body: PAYLOAD, headers: options.resultHeaders };
    }
    if (request.method === "PUT" && request.path === CANCEL_PATH) {
      return { status: 202, body: { request_id: QUEUED_ID, status: "CANCELLATION_REQUESTED" } };
    }
    return { status: 404, body: { detail: `unscripted ${request.method} ${request.path}` } };
  };
}

function posts(server: RouterStubServer): RecordedRequest[] {
  return server.state.requests.filter((r) => r.method === "POST");
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

describe("models.run: the Prefer: respond-async opt-in", () => {
  it("sends no Prefer header by default, keeping the 200 hold-and-return", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.body = PAYLOAD;

      const result = await comfy.models.run(MODEL, { prompt: "a chair" });

      expect(result.kind).toBe("json");
      expect(result.data).toEqual(PAYLOAD);
      expect(server.state.requests).toHaveLength(1);
      expect(server.state.requests[0].prefer).toBeNull();
    });
  });

  it("sends no Prefer header when respondAsync is false", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.body = PAYLOAD;

      await comfy.models.run(MODEL, {}, { respondAsync: false });

      expect(server.state.requests[0].prefer).toBeNull();
    });
  });

  it("sends Prefer: respond-async alongside the Idempotency-Key when opted in", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.body = PAYLOAD;

      await comfy.models.run(MODEL, {}, { respondAsync: true, idempotencyKey: "key-1" });

      expect(server.state.requests[0].prefer).toBe("respond-async");
      expect(server.state.requests[0].idempotencyKey).toBe("key-1");
    });
  });

  it("returns the native 200 body when the server ignores the preference", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      // Flag off, model not allowlisted, or otherwise ineligible: an ordinary 200.
      server.state.body = PAYLOAD;

      const result = await comfy.models.run(MODEL, {}, { respondAsync: true });

      expect(result.kind).toBe("json");
      expect(result.data).toEqual(PAYLOAD);
      expect(server.state.requests).toHaveLength(1);
    });
  });
});

describe("models.run: following a 202 handoff", () => {
  it("polls the handle to completion and returns the same result shape run returns", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = handoffScript({
        resultHeaders: { "X-Comfy-Credits-Used": "0.42" },
      });

      const result = await comfy.models.run(
        MODEL,
        { prompt: "a chair" },
        { respondAsync: true, idempotencyKey: "key-2" },
      );

      expect(result).toMatchObject({
        kind: "json",
        data: PAYLOAD,
        replayed: false,
        creditsUsed: "0.42",
      });
      // One POST — the only call that can start (and bill) a generation —
      // then reads of the handle it named.
      expect(posts(server)).toHaveLength(1);
      expect(server.state.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        `POST ${RUN_PATH}`,
        `GET ${STATUS_PATH}`,
        `GET ${STATUS_PATH}`,
        `GET ${REQUEST_PATH}`,
      ]);
    });
  });

  it("matches Preference-Applied among several preferences, case-insensitively", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = handoffScript({
        accepted: {
          status: 202,
          body: HANDLE_BODY,
          headers: { "Preference-Applied": "return=minimal, Respond-Async; wait=10" },
        },
      });

      const result = await comfy.models.run(MODEL, {}, { respondAsync: true });

      expect(result.data).toEqual(PAYLOAD);
    });
  });

  it("does not treat a 202 without Preference-Applied as a handoff", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = handoffScript({ accepted: { status: 202, body: HANDLE_BODY } });

      const err = (await comfy.models
        .run(MODEL, {}, { respondAsync: true, idempotencyKey: "key-3" })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("unexpected_response");
      expect(err.httpStatus).toBe(202);
      expect(err.idempotencyKey).toBe("key-3");
      expect(err.message).toContain("Preference-Applied");
      // Nothing was polled: an unmarked 202 is not a handle this call follows.
      expect(server.state.requests).toHaveLength(1);
    });
  });

  it("collects a replayed handoff on a retry without the opt-in, starting no second generation", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      // An earlier opted-in call under this key was handed off and its answer
      // lost; the retry does not set respondAsync, and Router replays the 202.
      server.state.respond = handoffScript({
        accepted: {
          status: 202,
          body: HANDLE_BODY,
          headers: { "Preference-Applied": "respond-async", "Idempotent-Replayed": "true" },
        },
      });

      const result = await comfy.models.run(MODEL, {}, { idempotencyKey: "key-4" });

      expect(result.data).toEqual(PAYLOAD);
      expect(result.replayed).toBe(true);
      expect(posts(server)).toHaveLength(1);
      expect(posts(server)[0].prefer).toBeNull();
      expect(posts(server)[0].idempotencyKey).toBe("key-4");
    });
  });

  it("re-sends the same Idempotency-Key when the handoff POST is retried", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      let attempts = 0;
      const script = handoffScript();
      server.state.respond = (request) => {
        if (request.method === "POST" && attempts++ === 0) {
          return { status: 503, body: { detail: "busy" }, errorType: "service_unavailable" };
        }
        return script(request);
      };

      const result = await comfy.models.run(
        MODEL,
        {},
        { respondAsync: true, retry: { baseDelayMs: 1 } },
      );

      expect(result.data).toEqual(PAYLOAD);
      const keys = posts(server).map((r) => r.idempotencyKey);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(keys[1]);
      expect(posts(server).every((r) => r.prefer === "respond-async")).toBe(true);
    });
  });

  it("rejects a handoff whose body names no request_id, carrying the key to replay it", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = handoffScript({
        accepted: {
          status: 202,
          body: { status: "IN_QUEUE" },
          headers: { "Preference-Applied": "respond-async" },
        },
      });

      const err = (await comfy.models
        .run(MODEL, {}, { respondAsync: true, idempotencyKey: "key-5" })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("unexpected_response");
      expect(err.idempotencyKey).toBe("key-5");
      expect(server.state.requests).toHaveLength(1);
    });
  });

  it("raises the typed Router error when the handed-off request completes failed", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = handoffScript({
        statuses: [
          {
            request_id: QUEUED_ID,
            status: "COMPLETED",
            error_type: "provider_error",
            error: { message: "upstream failed" },
          },
        ],
      });

      const err = (await comfy.models
        .run(MODEL, {}, { respondAsync: true, idempotencyKey: "key-8" })
        .catch((e: unknown) => e)) as ComfyError;

      // `run`'s own error family, as the same failure on the `200` path
      // raises — not the queued surface's `routerErrors.*` — with that one
      // kept as the cause.
      expect(err).toBeInstanceOf(ComfyError);
      expect(err).not.toBeInstanceOf(routerErrors.RouterError);
      expect(err.code).toBe("provider_error");
      expect(err.idempotencyKey).toBe("key-8");
      expect(err.details).toEqual({ queuedRequestId: QUEUED_ID });
      expect(err.cause).toBeInstanceOf(routerErrors.ProviderError);
      expect(server.state.requests.some((r) => r.path === REQUEST_PATH)).toBe(false);
    });
  });

  it("maps a failed result read onto run's typed ComfyError, carrying the queued id", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      const script = handoffScript();
      server.state.respond = (request) => {
        if (request.method === "GET" && request.path === REQUEST_PATH) {
          return {
            status: 402,
            body: { detail: "out of credits", error_type: "insufficient_credits" },
            headers: { "X-Comfy-Error-Type": "insufficient_credits" },
          };
        }
        return script(request);
      };

      const err = (await comfy.models
        .run(MODEL, {}, { respondAsync: true, idempotencyKey: "key-9" })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(InsufficientCredits);
      expect(err.code).toBe("insufficient_credits");
      expect(err.httpStatus).toBe(402);
      expect(err.idempotencyKey).toBe("key-9");
      expect(err.details).toEqual({ queuedRequestId: QUEUED_ID });
      expect(server.state.requests.some((r) => r.method === "PUT")).toBe(false);
    });
  });

  it("carries the queued id on an invalid_response from the status read", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = handoffScript({ statuses: [{ request_id: QUEUED_ID }] });

      const err = (await comfy.models
        .run(MODEL, {}, { respondAsync: true, idempotencyKey: "key-10" })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("invalid_response");
      expect(err.idempotencyKey).toBe("key-10");
      expect(err.details).toMatchObject({ queuedRequestId: QUEUED_ID });
      expect(server.state.requests.some((r) => r.method === "PUT")).toBe(false);
    });
  });

  it("does not cancel a finished generation when the deadline ends its result download", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      const script = handoffScript({
        statuses: [{ request_id: QUEUED_ID, status: "COMPLETED" }],
      });
      server.state.respond = (request) => {
        // The poll answers at once and reports COMPLETED; the result read
        // after it outlasts the whole run deadline.
        if (request.method === "GET" && request.path === STATUS_PATH) server.state.delayMs = 700;
        return script(request);
      };

      const err = (await comfy.models
        .run(MODEL, {}, { respondAsync: true, timeoutMs: 300, idempotencyKey: "key-11" })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("request_timeout");
      expect(err.idempotencyKey).toBe("key-11");
      expect(err.details).toEqual({ queuedRequestId: QUEUED_ID });
      expect(err.message).toContain("not cancelled");
      expect(server.state.requests.some((r) => r.method === "PUT")).toBe(false);
    });
  });

  it("reports the fallback provider and dropped params the handoff 202 disclosed", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = handoffScript({
        accepted: {
          status: 202,
          body: HANDLE_BODY,
          headers: {
            "Preference-Applied": "respond-async",
            "X-Comfy-Router-Fallback-Provider": "alt-provider",
            "X-Comfy-Router-Dropped-Params": "seed",
          },
        },
      });

      const result = await comfy.models.run(MODEL, {}, { respondAsync: true });

      expect(result.servingProvider).toBe("alt-provider");
      expect(result.droppedParams).toEqual(["seed"]);
    });
  });

  it("reads the handoff handle under its own bound, not a small result cap", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = handoffScript();

      const result = await comfy.models.run(
        MODEL,
        {},
        { respondAsync: true, maxBytes: JSON.stringify(PAYLOAD).length },
      );

      expect(result).toMatchObject({ kind: "json", data: PAYLOAD });
    });
  });

  it("cancels the handed-off request when run's deadline ends the wait", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      server.state.respond = handoffScript({
        statuses: [{ request_id: QUEUED_ID, status: "IN_PROGRESS" }],
      });

      const err = (await comfy.models
        .run(MODEL, {}, { respondAsync: true, timeoutMs: 300, idempotencyKey: "key-6" })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("request_timeout");
      expect(err.idempotencyKey).toBe("key-6");
      expect(err.details).toEqual({ queuedRequestId: QUEUED_ID });
      expect(server.state.requests.some((r) => r.method === "PUT" && r.path === CANCEL_PATH)).toBe(
        true,
      );
      expect(posts(server)).toHaveLength(1);
    });
  });

  it("keeps the deadline's request_timeout when the caller aborts during the cleanup cancel", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      const script = handoffScript({
        statuses: [{ request_id: QUEUED_ID, status: "IN_PROGRESS" }],
      });
      const controller = new AbortController();
      server.state.respond = (request) => {
        // The deadline has already ended the wait when the cancel goes out;
        // the caller's abort arrives only after that.
        if (request.method === "PUT") controller.abort();
        return script(request);
      };

      const err = (await comfy.models
        .run(
          MODEL,
          {},
          {
            respondAsync: true,
            timeoutMs: 300,
            signal: controller.signal,
            idempotencyKey: "key-8",
          },
        )
        .catch((e: unknown) => e)) as ComfyError;

      expect(controller.signal.aborted).toBe(true);
      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("request_timeout");
      expect(err.details).toEqual({ queuedRequestId: QUEUED_ID });
    });
  });

  it("does not resolve past run's deadline when a poll is slow to answer", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      const script = handoffScript({
        statuses: [{ request_id: QUEUED_ID, status: "COMPLETED" }],
      });
      server.state.respond = (request) => {
        // The handoff answers at once; every queue read after it takes longer
        // than the whole run deadline, but less than the per-request floor
        // the queue reads would otherwise get.
        if (request.method === "POST") server.state.delayMs = 700;
        return script(request);
      };

      const err = (await comfy.models
        .run(MODEL, {}, { respondAsync: true, timeoutMs: 300, idempotencyKey: "key-7" })
        .catch((e: unknown) => e)) as ComfyError;

      expect(err).toBeInstanceOf(ComfyError);
      expect(err.code).toBe("request_timeout");
      expect(err.details).toEqual({ queuedRequestId: QUEUED_ID });
      expect(server.state.requests.some((r) => r.path === REQUEST_PATH)).toBe(false);
      expect(server.state.requests.some((r) => r.method === "PUT" && r.path === CANCEL_PATH)).toBe(
        true,
      );
    });
  });

  it("re-throws the caller's abort untouched during a slow poll", async () => {
    await withRouterStub(async (server) => {
      useStub(server);
      const script = handoffScript();
      server.state.respond = (request) => {
        if (request.method === "POST") server.state.delayMs = 700;
        return script(request);
      };
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);

      const err = (await comfy.models
        .run(MODEL, {}, { respondAsync: true, timeoutMs: 5_000, signal: controller.signal })
        .catch((e: unknown) => e)) as Error;

      // The caller's AbortError, not the deadline's request_timeout.
      expect(err.name).toBe("AbortError");
      expect(server.state.requests.some((r) => r.method === "PUT" && r.path === CANCEL_PATH)).toBe(
        true,
      );
    });
  });
});

describe("appliedRespondAsync", () => {
  it.each([
    ["respond-async", true],
    ["RESPOND-ASYNC", true],
    [" respond-async ", true],
    ["return=minimal, respond-async", true],
    ['other="x, respond-async=1"', false],
    ['other="x\\", respond-async"', false],
    ['other="x, y", respond-async', true],
    ["respond-async; wait=10", true],
    ["respond-async=1", true],
    ["return=minimal", false],
    ["respond-asynchronous", false],
    ["", false],
  ])("%j -> %s", (raw, expected) => {
    expect(appliedRespondAsync(raw)).toBe(expected);
  });

  it("is false when the header is absent", () => {
    expect(appliedRespondAsync(null)).toBe(false);
  });
});
