import { describe, expect, it } from "vitest";

import { ApiError } from "../low/index.js";
import {
  BlobNotFound,
  ComfyError,
  Forbidden,
  HashMismatch,
  IdempotencyKeyReuse,
  InsufficientCredits,
  InvalidWorkflow,
  MissingAsset,
  NotFound,
  QueueFull,
  Unauthorized,
  WorkflowFormatUi,
  stampIdempotencyKey,
  stamping,
  toSdkError,
  translate,
} from "./exceptions.js";

describe("toSdkError", () => {
  const cases: Array<[string, new (...args: never[]) => Error]> = [
    ["invalid_workflow", InvalidWorkflow],
    ["workflow_format_ui", WorkflowFormatUi],
    ["missing_asset", MissingAsset],
    ["hash_mismatch", HashMismatch],
    ["blob_not_found", BlobNotFound],
    ["idempotency_key_reuse", IdempotencyKeyReuse],
    ["insufficient_credits", InsufficientCredits],
    ["not_found", NotFound],
    ["job_not_found", NotFound],
    ["asset_not_found", NotFound],
    ["unauthorized", Unauthorized],
    ["forbidden", Forbidden],
  ];

  it.each(cases)("maps protocol code %s to the idiomatic %s", (code, expectedClass) => {
    const apiError = new ApiError("boom", { code, httpStatus: 400 });
    expect(toSdkError(apiError)).toBeInstanceOf(expectedClass);
  });

  it("carries retryAfter onto QueueFull", () => {
    const apiError = new ApiError("full", { code: "queue_full", httpStatus: 429, retryAfter: 5 });
    const sdkError = toSdkError(apiError);
    expect(sdkError).toBeInstanceOf(QueueFull);
    expect((sdkError as QueueFull).retryAfter).toBe(5);
  });

  it("preserves an absent retryAfter on QueueFull", () => {
    const apiError = new ApiError("full", { code: "queue_full", httpStatus: 429 });
    const sdkError = toSdkError(apiError);
    expect(sdkError).toBeInstanceOf(QueueFull);
    expect((sdkError as QueueFull).retryAfter).toBeNull();
  });
});

describe("translate", () => {
  it("re-raises a protocol ApiError as its idiomatic SDK exception", async () => {
    const failing = () =>
      Promise.reject(new ApiError("gone", { code: "not_found", httpStatus: 404 }));
    await expect(translate(failing)).rejects.toBeInstanceOf(NotFound);
  });

  it("passes a non-ApiError through unchanged (same instance, not wrapped)", async () => {
    const original = new TypeError("fetch failed");
    let caught: unknown;
    try {
      await translate(() => Promise.reject(original));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(original); // identity preserved; not coerced into a ComfyError
  });
});

describe("stampIdempotencyKey", () => {
  // The TS twin of comfy-python-sdk
  // tests/test_error_contract.py::test_a_stamped_transport_error_reads_every_attribute_as_none.
  it("defaults requestId and retryAfter to null on a bare Error", () => {
    const err = stampIdempotencyKey(new TypeError("fetch failed"), "k-1") as TypeError &
      Record<string, unknown>;

    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe("fetch failed"); // identity + message untouched
    expect(err.idempotencyKey).toBe("k-1");
    expect(err.requestId).toBeNull();
    expect(err.retryAfter).toBeNull();
  });

  it("returns the same object it was handed", () => {
    const original = new Error("boom");
    expect(stampIdempotencyKey(original, "k-2")).toBe(original);
  });

  // The TS twin of
  // ::test_the_stamp_never_overwrites_an_attribute_that_is_already_set.
  it("never overwrites an existing retryAfter or idempotencyKey", () => {
    const err = new ComfyError("nope", {
      code: "provider_error",
      idempotencyKey: "original-key",
      retryAfter: 7,
    });

    stampIdempotencyKey(err, "late-key");

    expect(err.idempotencyKey).toBe("original-key"); // the built-in key wins
    expect(err.retryAfter).toBe(7); // the pace it already carried is kept
  });

  it("fills a null idempotencyKey but leaves a set one alone", () => {
    const built = new ComfyError("nope", { code: "provider_error" });
    expect(built.idempotencyKey).toBeNull();

    stampIdempotencyKey(built, "k-3");

    expect(built.idempotencyKey).toBe("k-3");
  });

  it("writes nothing when the key is null", () => {
    const err = stampIdempotencyKey(new Error("boom"), null) as Error & Record<string, unknown>;

    expect("idempotencyKey" in err).toBe(false);
    expect("requestId" in err).toBe(false);
    expect("retryAfter" in err).toBe(false);
  });

  it("passes a frozen object through untouched", () => {
    const frozen = Object.freeze(new Error("boom"));

    const returned = stampIdempotencyKey(frozen, "k-4") as Error & Record<string, unknown>;

    expect(returned).toBe(frozen);
    expect("idempotencyKey" in returned).toBe(false);
  });

  it("passes a non-object throwable (a string) through unchanged", () => {
    expect(stampIdempotencyKey("just a string", "k-5")).toBe("just a string");
    expect(stampIdempotencyKey(null, "k-6")).toBeNull();
  });

  // The shared-throwable case. `fetch` rejects with `signal.reason`, and
  // `AbortSignal.any` propagates the SOURCE signal's reason object rather than
  // a copy — so one `AbortController` driving N concurrent calls rejects all N
  // with one object, and stamping it in place would hand N-1 callers a key
  // belonging to someone else's generation.
  it("stands in for the caller's shared abort reason instead of stamping it", () => {
    const controller = new AbortController();
    controller.abort();
    const reason = controller.signal.reason as DOMException;

    const first = stampIdempotencyKey(reason, "k-one", {
      callerSignal: controller.signal,
    }) as DOMException & Record<string, unknown>;
    const second = stampIdempotencyKey(reason, "k-two", {
      callerSignal: controller.signal,
    }) as DOMException & Record<string, unknown>;

    // Each call reads its OWN key, not whichever one got there first.
    expect(first.idempotencyKey).toBe("k-one");
    expect(second.idempotencyKey).toBe("k-two");
    expect(first).not.toBe(reason);
    expect(second).not.toBe(first);
    // And the caller's own state is exactly as they built it.
    expect((reason as unknown as Record<string, unknown>).idempotencyKey).toBeUndefined();
  });

  it("keeps the class, name, message and stack on the stand-in", () => {
    const controller = new AbortController();
    controller.abort();
    const reason = controller.signal.reason as DOMException;

    const standIn = stampIdempotencyKey(reason, "k-shape", {
      callerSignal: controller.signal,
    }) as DOMException;

    // Everything a caller branches on reads identically; only identity differs.
    // `DOMException` keeps name/message in internal slots behind prototype
    // accessors, so this is the case a descriptor copy would silently break.
    expect(standIn).toBeInstanceOf(DOMException);
    expect(standIn.name).toBe("AbortError");
    expect(standIn.message).toBe(reason.message);
    expect(standIn.stack).toBe(reason.stack);
  });

  it("stands in for an Error already carrying a different call's key", () => {
    // Belt and braces for a shared throwable that reaches the stamp by a route
    // `callerSignal` does not cover.
    const shared = new TypeError("fetch failed");
    stampIdempotencyKey(shared, "k-first");

    const standIn = stampIdempotencyKey(shared, "k-second") as TypeError & Record<string, unknown>;

    expect(standIn).not.toBe(shared);
    expect(standIn).toBeInstanceOf(TypeError);
    expect(standIn.message).toBe("fetch failed"); // own data props survive
    expect(standIn.idempotencyKey).toBe("k-second");
    expect((shared as unknown as Record<string, unknown>).idempotencyKey).toBe("k-first");
  });

  it("stands in for a plain-object abort reason too", () => {
    // `controller.abort(reason)` takes any value, and a plain object is the
    // other thing callers routinely hand it.
    const controller = new AbortController();
    controller.abort({ code: "gave-up" });
    const reason = controller.signal.reason as Record<string, unknown>;

    const standIn = stampIdempotencyKey(reason, "k-plain", {
      callerSignal: controller.signal,
    }) as Record<string, unknown>;

    expect(standIn).not.toBe(reason);
    expect(standIn.code).toBe("gave-up");
    expect(standIn.idempotencyKey).toBe("k-plain");
    expect(reason.idempotencyKey).toBeUndefined();
  });

  it("leaves an exotic shared throwable untouched rather than faking a stand-in", () => {
    // A `Map` keeps its entries in internal slots a descriptor copy cannot
    // reach; a stand-in that reads wrong is worse than no stamp.
    const controller = new AbortController();
    controller.abort(new Map([["k", "v"]]));
    const reason = controller.signal.reason as Map<string, string>;

    const returned = stampIdempotencyKey(reason, "k-exotic", { callerSignal: controller.signal });

    expect(returned).toBe(reason);
    expect((reason as unknown as Record<string, unknown>).idempotencyKey).toBeUndefined();
  });

  it("passes a throwable whose key cannot be written through, rather than raising", () => {
    // `Object.isExtensible` passing does not make the write safe: a getter-only
    // accessor reading `undefined` slips past the value guard and then throws
    // from the assignment in strict-mode ESM.
    const err = new Error("boom") as Error & Record<string, unknown>;
    Object.defineProperty(err, "idempotencyKey", { get: () => undefined, configurable: false });

    expect(() => stampIdempotencyKey(err, "k-getter")).not.toThrow();
    expect(err.idempotencyKey).toBeUndefined();
  });

  it("passes a Proxy with a throwing set trap through, rather than raising", () => {
    const proxied = new Proxy(new Error("boom"), {
      set() {
        throw new TypeError("no writes here");
      },
    });

    // The transport failure this helper exists to preserve must not be
    // replaced by a TypeError raised from inside the stamp.
    expect(() => stampIdempotencyKey(proxied, "k-proxy")).not.toThrow();
    expect(stampIdempotencyKey(proxied, "k-proxy")).toBe(proxied);
  });

  it("defaults an own requestId of undefined to null, like idempotencyKey", () => {
    // A value check, not an `in` check — the docstring promises `string | null`,
    // never `undefined`.
    const err = new Error("boom") as Error & Record<string, unknown>;
    err.requestId = undefined;

    stampIdempotencyKey(err, "k-uniform");

    expect(err.requestId).toBeNull();
  });

  it("writes the retryAfter default it was handed", () => {
    // The collect path passes the pace Router named on the 409/504 that started
    // the collect, so a failure to collect hands back the pace as well as the key.
    const err = stampIdempotencyKey(new TypeError("fetch failed"), "k-pace", {
      retryAfter: 7,
    }) as TypeError & Record<string, unknown>;

    expect(err.retryAfter).toBe(7);
    expect(err.idempotencyKey).toBe("k-pace");
  });
});

describe("stamping", () => {
  it("stamps anything fn throws and preserves the same instance", async () => {
    const original = new TypeError("fetch failed");
    let caught: unknown;
    try {
      await stamping("k-7", () => Promise.reject(original));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(original);
    expect((caught as Record<string, unknown>).idempotencyKey).toBe("k-7");
  });

  it("returns fn's value untouched on success", async () => {
    await expect(stamping("k-8", () => Promise.resolve(42))).resolves.toBe(42);
  });
});
