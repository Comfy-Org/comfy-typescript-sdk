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

  it.each([42, "", { x: 1 }])("ignores a top-level message of %j", (message) => {
    const err = errorFromEnvelope(400, { message } as never);
    expect(err.code).toBe("error");
    expect(err.message).toBe("HTTP 400");
    expect(err.details).toBeNull();
  });
});

describe("sseErrorFromFrame", () => {
  it.each([
    ["credential_expired", 401, Unauthorized],
    ["forbidden", 403, Forbidden],
    ["job_not_found", 404, NotFound],
    ["unauthorized", 401, Unauthorized],
    ["not_found", 404, NotFound],
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

  it("still yields an ApiError for a frame that is not an envelope, keeping its payload", () => {
    const err = sseErrorFromFrame({ raw: "not json" });
    expect(err.constructor).toBe(ApiError);
    expect(err.httpStatus).toBe(0);
    expect(err.code).toBe("error");
    expect(err.message).toBe("not json");
  });

  it("names the frame, not a nonexistent HTTP 0, when the envelope has no message", () => {
    const err = sseErrorFromFrame({ error: { code: "forbidden" } });
    expect(err).toBeInstanceOf(Forbidden);
    expect(err.message).not.toContain("HTTP 0");
    expect(err.message).toContain("forbidden");
  });

  it.each([
    ["a string `error`", { error: "gateway timeout" }, "gateway timeout"],
    ["a non-object JSON string", { value: "credential expired" }, "credential expired"],
    ["a non-object JSON number", { value: 42 }, "42"],
    ["an object with no envelope", { reason: "gone" }, '{"reason":"gone"}'],
  ])("keeps the server's reason from %s", (_label, data, message) => {
    const err = sseErrorFromFrame(data);
    expect(err.constructor).toBe(ApiError);
    expect(err.code).toBe("error");
    expect(err.message).toBe(message);
  });

  it("keeps object details and drops ill-typed ones instead of trusting the envelope", () => {
    const kept = sseErrorFromFrame({
      error: { code: "forbidden", message: "x", details: { a: 1 } },
    });
    expect(kept.details).toEqual({ a: 1 });
    for (const details of [["a"], "nope", 7]) {
      const err = sseErrorFromFrame({ error: { code: "forbidden", message: "x", details } });
      expect(err.details).toBeNull();
    }
  });

  it("does not read an array `error` as an envelope", () => {
    const err = sseErrorFromFrame({ error: ["gone"] });
    expect(err.constructor).toBe(ApiError);
    expect(err.code).toBe("error");
    expect(err.message).toBe('{"error":["gone"]}');
  });

  it("names the frame when its payload is empty", () => {
    const err = sseErrorFromFrame({ raw: "" });
    expect(err.message).toBe("event stream ended with an `error` frame (error)");
  });

  it("flattens line breaks and bounds the length of a server-stated reason", () => {
    const err = sseErrorFromFrame({ raw: `forged\r\nline ${"x".repeat(10_000)}` });
    expect(err.message).not.toMatch(/[\r\n]/);
    expect(err.message.startsWith("forged line x")).toBe(true);
    expect(err.message.length).toBe(501);
  });

  it("flattens and bounds the fallback when it names a server-stated code", () => {
    const code = `forged\nline${"x".repeat(1_000)}`;
    const err = sseErrorFromFrame({ error: { code } });
    expect(err.code).toBe(code);
    expect(err.message).not.toMatch(/[\r\n]/);
    expect(err.message.startsWith("event stream ended with an `error` frame (forged line")).toBe(
      true,
    );
    expect(err.message.length).toBe(501);
  });

  it.each(["constructor", "toString", "valueOf", "__proto__"])(
    "does not resolve the code %s through Object.prototype",
    (code) => {
      const err = sseErrorFromFrame({ error: { code, message: "x" } });
      expect(err.constructor).toBe(ApiError);
      expect(err.httpStatus).toBe(0);
      expect(err.code).toBe(code);
    },
  );
});

describe("errorFromEnvelope prototype keys", () => {
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty"])(
    "maps the server code %s to a bare ApiError",
    (code) => {
      const err = errorFromEnvelope(400, { error: { code, message: "x" } });
      expect(err.constructor).toBe(ApiError);
      expect(err.code).toBe(code);
    },
  );
});
