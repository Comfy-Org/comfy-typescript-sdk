/**
 * Contract tripwire for `comfy.models`.
 *
 * The wire types for model execution must be **generated** from
 * `spec/openapi.yaml` (`pnpm generate`, drift-checked by
 * `scripts/check-spec-drift.mjs`, coverage-checked by
 * `src/low/spec-coverage.test.ts`) — never hand-declared, or a contract
 * change would land silently instead of as a compile failure.
 *
 * The spec declares no model-execution operation yet, which is precisely why
 * `models.run` is a credential gate rather than a request. This test pins
 * that premise: the moment such an operation appears in the vendored spec,
 * it fails and says what to do, so the placeholder cannot outlive the route
 * it is waiting on.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const SPEC_PATH = fileURLToPath(new URL("../../spec/openapi.yaml", import.meta.url));
const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head"];

/** Paths/operationIds that would carry the model-execution contract. */
const MODEL_PATH_RE = /\/models?(\/|$)/i;
const MODEL_OPERATION_RE = /model/i;

const FIX_IT =
  "The spec now declares a model-execution operation. Run `pnpm generate`, wire it through " +
  "src/low/transport.ts (OPERATION_IDS + OPERATION_METHODS), and replace the " +
  "ModelRunNotImplemented placeholder in src/sdk/models.ts with a call typed by the " +
  "generated request/response types. Then delete this test.";

async function specOperations(): Promise<{ paths: string[]; operationIds: string[] }> {
  const text = await readFile(SPEC_PATH, "utf-8");
  const doc = parse(text) as {
    paths: Record<string, Record<string, { operationId?: string }>>;
  };
  const operationIds: string[] = [];
  for (const methods of Object.values(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!HTTP_METHODS.includes(method)) continue;
      if (op.operationId) operationIds.push(op.operationId);
    }
  }
  return { paths: Object.keys(doc.paths), operationIds };
}

describe("model-execution contract", () => {
  it("the vendored spec declares no model-execution route yet", async () => {
    const { paths } = await specOperations();
    expect(
      paths.filter((path) => MODEL_PATH_RE.test(path)),
      FIX_IT,
    ).toEqual([]);
  });

  it("the vendored spec declares no model-execution operation yet", async () => {
    const { operationIds } = await specOperations();
    expect(
      operationIds.filter((id) => MODEL_OPERATION_RE.test(id)),
      FIX_IT,
    ).toEqual([]);
  });
});
