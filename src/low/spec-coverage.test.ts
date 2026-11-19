import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { ApiError, Forbidden, NotFound, Unauthorized, sseErrorFromFrame } from "./errors.js";
import { OPERATION_IDS, OPERATION_METHODS, ComfyLow } from "./transport.js";

const SPEC_PATH = fileURLToPath(new URL("../../spec/openapi.yaml", import.meta.url));
const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head"];

interface OpenApiOperation {
  operationId: string;
  tags?: string[];
  "x-internal"?: boolean;
}

async function specOperationIds(): Promise<Set<string>> {
  const text = await readFile(SPEC_PATH, "utf-8");
  const doc = parse(text) as { paths: Record<string, Record<string, OpenApiOperation>> };
  const ids = new Set<string>();
  for (const methods of Object.values(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!HTTP_METHODS.includes(method)) continue;
      // An operation tagged internal would be stripped before vendoring.
      if (op["x-internal"] === true || op.tags?.includes("internal")) continue;
      ids.add(op.operationId);
    }
  }
  return ids;
}

describe("spec coverage", () => {
  it("declared operation IDs match the vendored spec", async () => {
    const specIds = await specOperationIds();
    expect(new Set(OPERATION_IDS)).toEqual(specIds);
  });

  it("every operation has a transport method", () => {
    for (const [opId, methodName] of Object.entries(OPERATION_METHODS)) {
      expect(OPERATION_IDS as readonly string[]).toContain(opId);
      expect(typeof ComfyLow.prototype[methodName as keyof ComfyLow]).toBe("function");
    }
  });

  it("operation methods cover every operation", () => {
    expect(new Set(Object.keys(OPERATION_METHODS))).toEqual(new Set(OPERATION_IDS));
  });
});

// Four schemas (`StatusEvent`, `PreviewEvent`, `LogEvent`, `AssetReference`)
// are hand-maintained in `./models.ts` because codegen only reaches schemas
// wired to an operation's request/response (see the doc comment there).
// This asserts their property lists stay in sync with the spec.
describe("hand-maintained model parity (models.ts)", () => {
  it("StatusEvent, PreviewEvent, LogEvent, AssetReference match the spec's declared properties", async () => {
    const text = await readFile(SPEC_PATH, "utf-8");
    const doc = parse(text) as {
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    const expected: Record<string, string[]> = {
      StatusEvent: ["status", "queue_position"],
      PreviewEvent: ["node_id", "content_type", "data_base64"],
      LogEvent: ["level", "message"],
      AssetReference: ["__type", "info"],
    };
    for (const [name, props] of Object.entries(expected)) {
      const schema = doc.components.schemas[name];
      expect(schema, `schema ${name} missing from spec`).toBeDefined();
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...props].sort());
    }
  });
});

// `Job.events()` treats an SSE `error` frame as terminal and turns its data
// (an error envelope) into a typed error via `sseErrorFromFrame`. The spec's
// `x-sse-events` catalog declares that frame, and names its codes only in the
// description's prose, so the codes are pinned here and each one is checked
// both ways: the description still names it, and `sseErrorFromFrame` turns it
// into a typed error with a real status rather than a bare `ApiError` with
// `httpStatus` `0`. A spec sync that adds a code fails the count below; add it
// here and to `SSE_STATUS_BY_CODE` in `./errors.ts`.
describe("SSE error frame matches the vendored spec", () => {
  const SSE_ERROR_CODES: Record<string, { cls: typeof ApiError; status: number }> = {
    credential_expired: { cls: Unauthorized, status: 401 },
    forbidden: { cls: Forbidden, status: 403 },
    job_not_found: { cls: NotFound, status: 404 },
  };

  async function errorFrame(): Promise<{ description?: string; schema?: string }> {
    const text = await readFile(SPEC_PATH, "utf-8");
    const doc = parse(text) as {
      paths: Record<
        string,
        Record<
          string,
          {
            operationId?: string;
            "x-sse-events"?: Record<string, { description?: string; schema?: string }>;
          }
        >
      >;
    };
    const op = Object.values(doc.paths)
      .flatMap((methods) => Object.values(methods))
      .find((candidate) => candidate.operationId === "getJobEvents");
    const frame = op?.["x-sse-events"]?.error;
    expect(frame, "getJobEvents' x-sse-events catalog no longer declares `error`").toBeDefined();
    return frame ?? {};
  }

  it("declares the frame terminal, carrying the error envelope", async () => {
    const frame = await errorFrame();
    expect(frame.schema).toBe("#/components/schemas/ErrorEnvelope");
    expect(frame.description).toMatch(/^Terminal event\b/);
    expect(frame.description).toContain("No `status` event follows it");
  });

  it("names exactly the codes sseErrorFromFrame types", async () => {
    const description = (await errorFrame()).description ?? "";
    // The codes are the snake_case backticked words of the first paragraph
    // (the browser note after it names no codes).
    const named = new Set(
      [...(description.split("\n")[0] ?? "").matchAll(/`([a-z]+(?:_[a-z]+)+|forbidden)`/g)].map(
        (match) => match[1],
      ),
    );
    expect([...named].sort()).toEqual(Object.keys(SSE_ERROR_CODES).sort());
    for (const [code, { cls, status }] of Object.entries(SSE_ERROR_CODES)) {
      const err = sseErrorFromFrame({ error: { code, message: "cut off" } });
      expect(err, code).toBeInstanceOf(cls);
      expect(err.httpStatus, code).toBe(status);
      expect(err.code, code).toBe(code);
    }
  });
});
