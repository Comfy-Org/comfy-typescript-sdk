/**
 * The extractor that reads the Python SDK's exported error classes.
 *
 * `comfy_sdk/exceptions.py` publishes value types beside the errors that carry
 * them (`FailureCategory` is the enum a `JobFailed` reports). Counting those as
 * error classes would demand a runtime class this SDK models as a type.
 */

import { describe, expect, it } from "vitest";

import { extractExportedErrorClasses } from "../../scripts/python-surface.mjs";

/** An `__init__.py` whose `__all__` publishes `names`. */
function initExporting(...names: string[]): string {
  return ["__all__ = [", ...names.map((name) => `    "${name}",`), "]"].join("\n");
}

const COMFY_ERROR = "class ComfyError(Exception):\n    pass\n";
const JOB_FAILED = "class JobFailed(ComfyError):\n    pass\n";

describe("extractExportedErrorClasses", () => {
  it.each([
    ["(str, Enum)", "class FailureCategory(str, Enum):\n    OTHER = 'other'\n"],
    ["StrEnum", "class FailureCategory(StrEnum):\n    OTHER = 'other'\n"],
    ["an aliased import", "class FailureCategory(str, PyEnum):\n    OTHER = 'other'\n"],
    ["a nested call in its bases", "class FailureCategory(_mixin(str), Enum):\n    pass\n"],
    ["a one-line re-export", "from ._categories import FailureCategory\n"],
    ["a parenthesized re-export", "from ._categories import (\n    FailureCategory,\n)\n"],
  ])("skips a value type spelled as %s", (_spelling, valueType) => {
    const exceptions = [valueType, COMFY_ERROR, JOB_FAILED].join("\n");
    const init = initExporting("ComfyError", "FailureCategory", "JobFailed");

    expect(extractExportedErrorClasses(exceptions, init)).toEqual(["ComfyError", "JobFailed"]);
  });

  it.each([
    ["on the opening line", "class JobFailed(  # unlike an Enum value\n    ComfyError,\n):\n"],
    ["after a base", "class JobFailed(\n    ComfyError,  # carries an Enum category (str)\n):\n"],
  ])("keeps an error whose base list mentions Enum in a comment %s", (_where, jobFailed) => {
    const exceptions = ["class FailureCategory(str, Enum):\n    pass\n", COMFY_ERROR, jobFailed];
    const init = initExporting("ComfyError", "FailureCategory", "JobFailed");

    expect(extractExportedErrorClasses(exceptions.join("\n"), init)).toEqual([
      "ComfyError",
      "JobFailed",
    ]);
  });

  it("reads errors supplied only by re-export, beside a value type defined here", () => {
    const exceptions =
      "from ._errors import ComfyError\n\nclass FailureCategory(StrEnum):\n    pass\n";
    const init = initExporting("ComfyError", "FailureCategory");

    expect(extractExportedErrorClasses(exceptions, init)).toEqual(["ComfyError"]);
  });

  it("fails on a listed value type the Python root no longer publishes", () => {
    const unpublished = "class FailureCategory(str, Enum):\n    pass\n";

    expect(() => extractExportedErrorClasses(COMFY_ERROR, initExporting("ComfyError"))).toThrow(
      /PYTHON_EXCEPTIONS_VALUE_TYPES names FailureCategory/,
    );
    expect(() =>
      extractExportedErrorClasses(unpublished + COMFY_ERROR, initExporting("ComfyError")),
    ).toThrow(/PYTHON_EXCEPTIONS_VALUE_TYPES names FailureCategory/);
  });

  it("fails rather than reading nothing as parity", () => {
    expect(() => extractExportedErrorClasses("", initExporting("ComfyError"))).toThrow(
      /no classes defined or re-exported/,
    );
    expect(() =>
      extractExportedErrorClasses(
        "class FailureCategory(str, Enum):\n    pass\n",
        initExporting("FailureCategory"),
      ),
    ).toThrow(/none of its error classes appear/);
  });
});
