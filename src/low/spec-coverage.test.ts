import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

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
// (an error envelope) into a typed error via `sseErrorFromFrame`. The server
// already emits that frame, but the vendored spec does not declare it yet, so
// there is nothing to compare against. This is a rot guard, not a pin: it
// fails the day the spec's `x-sse-events` catalog DOES declare `error`. When
// it fires, check the declared schema is the error envelope and that the frame
// is terminal (or fix `Job.events()` and `sseErrorFromFrame` to match), then
// replace this with a real comparison — including the declared codes against
// `SSE_STATUS_BY_CODE` in `./errors.ts`.
describe("SSE error frame (not yet in the vendored spec)", () => {
  it("getJobEvents' x-sse-events catalog does not declare `error` yet", async () => {
    const text = await readFile(SPEC_PATH, "utf-8");
    const doc = parse(text) as {
      paths: Record<string, Record<string, { operationId?: string; "x-sse-events"?: object }>>;
    };
    const op = Object.values(doc.paths)
      .flatMap((methods) => Object.values(methods))
      .find((candidate) => candidate.operationId === "getJobEvents");
    expect(op?.["x-sse-events"], "getJobEvents or its x-sse-events catalog moved").toBeDefined();
    expect(
      Object.keys(op?.["x-sse-events"] ?? {}),
      "the spec now declares the SSE `error` frame: replace this rot guard with a real check",
    ).not.toContain("error");
  });
});
