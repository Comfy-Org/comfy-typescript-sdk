import { describe, expect, it } from "vitest";

import { ApiError } from "../low/index.js";
import {
  BlobNotFound,
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
