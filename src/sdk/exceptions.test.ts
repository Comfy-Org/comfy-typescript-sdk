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
