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

  // echo's HTTPError body: what a request-decoder 400 or a BodyLimit 413
  // writes instead of an ErrorEnvelope.
  it("keeps the message of a bare {message} body", () => {
    const decoder =
      "Unmarshal type error: expected=map[string]interface {}, got=string, field=workflow, offset=12";
    const err = errorFromEnvelope(400, { message: decoder });
    expect(err).toBeInstanceOf(ApiError);
    expect(err.constructor.name).toBe("ApiError");
    expect(err.code).toBe("error");
    expect(err.httpStatus).toBe(400);
    expect(err.message).toBe(decoder);
    expect(err.details).toBeNull();
  });

  it("keeps the message of a bare {message} 413", () => {
    const err = errorFromEnvelope(413, { message: "Request Entity Too Large" });
    expect(err.message).toBe("Request Entity Too Large");
    expect(err.code).toBe("error");
  });

  it("prefers the envelope's message over a top-level one", () => {
    const err = errorFromEnvelope(400, {
      error: { code: "invalid_request", message: "metadata is not an object" },
      message: "ignored",
    });
    expect(err.code).toBe("invalid_request");
    expect(err.message).toBe("metadata is not an object");
  });

  it.each([42, "", { x: 1 }])("ignores an envelope message of %j", (message) => {
    const err = errorFromEnvelope(422, { error: { code: "invalid_workflow", message } } as never);
    expect(err.code).toBe("invalid_workflow");
    expect(err.message).toBe("HTTP 422");
  });

  it("falls back to a top-level message when the envelope's is empty", () => {
    const err = errorFromEnvelope(400, { error: { code: "x", message: "" }, message: "diag" });
    expect(err.message).toBe("diag");
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "does not resolve a code of %s off Object.prototype",
    (inherited) => {
      const err = errorFromEnvelope(400, { error: { code: inherited, message: "hostile code" } });
      expect(err).toBeInstanceOf(ApiError);
      expect(err.constructor).toBe(ApiError);
      expect(err.code).toBe(inherited);
      expect(err.message).toBe("hostile code");
    },
  );

  it.each([42, "", { x: 1 }])("ignores a top-level message of %j", (message) => {
    const err = errorFromEnvelope(400, { message } as never);
    expect(err.code).toBe("error");
    expect(err.message).toBe("HTTP 400");
    expect(err.details).toBeNull();
  });
});
