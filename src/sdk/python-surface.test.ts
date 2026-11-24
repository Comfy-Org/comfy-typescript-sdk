/**
 * The extractor that reads the Python SDK's exported error classes.
 *
 * `comfy_sdk/exceptions.py` defines value types beside the errors that carry
 * them (`FailureCategory` is the enum a `JobFailed` reports). Counting those as
 * error classes would demand a runtime class this SDK models as a type.
 */

import { describe, expect, it } from "vitest";

import { extractExportedErrorClasses } from "../../scripts/python-surface.mjs";

describe("extractExportedErrorClasses", () => {
  it("skips an Enum defined beside the errors", () => {
    const exceptions = [
      "class ComfyError(Exception):",
      "    pass",
      "",
      "class FailureCategory(str, Enum):",
      '    OTHER = "other"',
      "",
      "class JobFailed(ComfyError):",
      "    pass",
    ].join("\n");
    const init = [
      "__all__ = [",
      '    "ComfyError",',
      '    "FailureCategory",',
      '    "JobFailed",',
      "]",
    ].join("\n");

    expect(extractExportedErrorClasses(exceptions, init)).toEqual(["ComfyError", "JobFailed"]);
  });
});
