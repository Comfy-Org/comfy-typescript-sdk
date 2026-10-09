import { describe, expect, it } from "vitest";

import {
  ApiError,
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
  errorFromEnvelope,
  sseErrorFromFrame,
} from "./errors.js";

describe("errorFromEnvelope", () => {
  const cases: Array<[string, number, new (...args: never[]) => Error]> = [
    ["invalid_workflow", 422, InvalidWorkflow],
    ["workflow_format_ui", 422, WorkflowFormatUi],
    ["missing_asset", 422, MissingAsset],
    ["hash_mismatch", 409, HashMismatch],
    ["blob_not_found", 404, BlobNotFound],
    ["idempotency_key_reuse", 422, IdempotencyKeyReuse],
    ["queue_full", 429, QueueFull],
    ["insufficient_credits", 402, InsufficientCredits],
    ["not_found", 404, NotFound],
    ["job_not_found", 404, NotFound],
    ["asset_not_found", 404, NotFound],
    ["unauthorized", 401, Unauthorized],
    ["forbidden", 403, Forbidden],
  ];

  it.each(cases)("maps code %s to %s", (code, status, expectedClass) => {
    const err = errorFromEnvelope(status, { error: { code, message: "boom" } });
    expect(err).toBeInstanceOf(expectedClass);
    expect(err.code).toBe(code);
    expect(err.httpStatus).toBe(status);
    expect(err.message).toBe("boom");
  });

  it("falls back to a status-derived code when the body is missing", () => {
    const err = errorFromEnvelope(401, null);
    expect(err).toBeInstanceOf(Unauthorized);
    expect(err.message).toBe("HTTP 401");
  });

  it("carries retryAfter through", () => {
    const err = errorFromEnvelope(
      429,
      { error: { code: "queue_full", message: "full" } },
      { retryAfter: 3 },
    );
    expect(err.retryAfter).toBe(3);
  });

  it("falls back to a bare ApiError for an unmapped code", () => {
    const err = errorFromEnvelope(500, { error: { code: "weird_new_code", message: "?" } });
    expect(err.constructor.name).toBe("ApiError");
  });
});

describe("sseErrorFromFrame", () => {
  it.each([
    ["credential_expired", 401, Unauthorized],
    ["forbidden", 403, Forbidden],
    ["job_not_found", 404, NotFound],
  ] as const)("maps %s to its typed error at status %i", (code, status, cls) => {
    const err = sseErrorFromFrame({ error: { code, message: "x" } });
    expect(err).toBeInstanceOf(cls);
    expect(err.httpStatus).toBe(status);
    expect(err.code).toBe(code);
    expect(err.message).toBe("x");
  });

  it("falls back to a bare ApiError with httpStatus 0 for an unknown code", () => {
    const err = sseErrorFromFrame({ error: { code: "stream_gone", message: "x" } });
    expect(err.constructor).toBe(ApiError);
    expect(err.httpStatus).toBe(0);
    expect(err.code).toBe("stream_gone");
  });

  it("still yields an ApiError for a frame that is not an envelope", () => {
    const err = sseErrorFromFrame({ raw: "not json" });
    expect(err.constructor).toBe(ApiError);
    expect(err.httpStatus).toBe(0);
    expect(err.code).toBe("error");
  });
});
