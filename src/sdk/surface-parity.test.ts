/**
 * Cross-SDK surface parity: this SDK against the Python one.
 *
 * Two SDKs maintained by separate PRs drift, and the drift is invisible until
 * somebody follows a Python example in TypeScript and the method is not there.
 * This test makes that visible at the point of change instead: it diffs the
 * public `models` method names, the router error class names, and the
 * `error_type` coverage of the two SDKs and fails naming the symbol that
 * diverged.
 *
 * The Python side is read from `parity/python-surface.json`, a committed
 * snapshot; `scripts/sync-python-surface.mjs` refreshes it from the Python
 * SDK's public repository and the `sdk-parity` CI job re-derives it on every
 * PR so the snapshot cannot go quietly stale. See that script's header for why
 * the acquisition and the assertion are split.
 *
 * The TypeScript side is introspected live off the real exports, so this test
 * cannot pass by describing a surface the package does not actually have.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractRouterErrors } from "../../scripts/python-surface.mjs";
import * as sdk from "../index.js";
import { models } from "./models.js";
import * as routerErrors from "./routerErrors.js";

const MANIFEST_PATH = fileURLToPath(new URL("../../parity/python-surface.json", import.meta.url));

/**
 * The intentional asymmetries between the two SDKs.
 *
 * This list is the whole point of the check being safe to leave on. A parity
 * test with no allowlist is right about the shared surface and wrong about
 * every deliberate divergence, and gets disabled the first time it is wrong.
 * Anything not declared here fails.
 *
 * Adding an entry is a design decision, not a way to quiet a failure: an entry
 * says "the two SDKs differ here on purpose, and here is the purpose". An
 * entry that no longer applies is a failure too — see "every declared rename
 * is still live" below.
 */
interface Asymmetry {
  readonly id: string;
  /** Why the two SDKs differ, in the terms an integrator would ask about. */
  readonly why: string;
  /**
   * Python `models` classes that are the async twin of another class rather
   * than a surface of their own. Their methods are required to be a subset of
   * the sync class's, not to appear in TypeScript.
   */
  readonly pythonAsyncModelsClasses?: readonly string[];
  /** Python error class name -> the TypeScript name carrying the same meaning. */
  readonly renamedErrorClasses?: Readonly<Record<string, string>>;
}

const INTENTIONAL_ASYMMETRIES: readonly Asymmetry[] = [
  {
    id: "result-envelope",
    why:
      "Python returns the provider payload directly; TypeScript returns { data, requestId }. " +
      "TypeScript has no exception-attribute equivalent for surfacing the request id on a " +
      "SUCCESSFUL call, so the id rides the result. This changes return types only — no " +
      "method, class or error_type name differs because of it — and this check compares " +
      "names, so the entry suppresses nothing. It is declared anyway: a future reviewer " +
      "who notices the difference should find it listed as a decision, not wonder whether " +
      "the check simply cannot see it.",
  },
  {
    id: "credential-resolution",
    why:
      "Python resolves credentials per client instance (`Comfy(api_key=...)`); TypeScript " +
      "configures them once at module level (`comfy.config({ credentials })`). The one name " +
      "this changes is the error raised when none is configured: Python's `MissingApiKey` " +
      "names the per-instance argument, and TypeScript's `MissingCredentials` names the " +
      "module-level one. Same failure, and each name is right for its own SDK.",
    renamedErrorClasses: { MissingApiKey: "MissingCredentials" },
  },
  {
    id: "no-sync-variant",
    why:
      "Python ships `Comfy`/`AsyncComfy` (and so `Models`/`AsyncModels`); TypeScript is " +
      "promise-native and has one `comfy.models`. So `AsyncModels` is not expected to have " +
      "a TypeScript counterpart. It is still checked, against the sync class rather than " +
      "against TypeScript: the async twin must introduce no method name of its own, which " +
      "is what stops a suffixed `run_async` from becoming a Python-only method nobody " +
      "notices is missing here.",
    pythonAsyncModelsClasses: ["AsyncModels"],
  },
];

const RENAMES: Record<string, string> = Object.fromEntries(
  INTENTIONAL_ASYMMETRIES.flatMap((a) => Object.entries(a.renamedErrorClasses ?? {})),
);
const ASYNC_MODELS_CLASSES = new Set(
  INTENTIONAL_ASYMMETRIES.flatMap((a) => a.pythonAsyncModelsClasses ?? []),
);

interface PythonSurface {
  source: { repo: string; ref: string; files: string[] };
  modelsMethods: Record<string, string[]>;
  routerErrorClasses: string[];
  routerErrorTypes: Record<string, string>;
  routerErrorTypeOrder: string[];
  exportedErrorClasses: string[];
}

async function loadPythonSurface(): Promise<PythonSurface> {
  const surface = JSON.parse(await readFile(MANIFEST_PATH, "utf-8")) as PythonSurface;
  // A broken introspection step must not read as parity: an empty section
  // would make every comparison below pass vacuously.
  const sections: [string, number][] = [
    ["modelsMethods", Object.keys(surface.modelsMethods).length],
    ["routerErrorClasses", surface.routerErrorClasses.length],
    ["routerErrorTypes", Object.keys(surface.routerErrorTypes).length],
    ["routerErrorTypeOrder", surface.routerErrorTypeOrder.length],
    ["exportedErrorClasses", surface.exportedErrorClasses.length],
  ];
  for (const [name, size] of sections) {
    if (size === 0) {
      throw new Error(
        `parity/python-surface.json has an empty \`${name}\`. Regenerate it with ` +
          "`pnpm sync:python-surface` — an empty section is a broken extraction, not parity.",
      );
    }
  }
  for (const [className, methods] of Object.entries(surface.modelsMethods)) {
    if (methods.length === 0) {
      throw new Error(`parity/python-surface.json: \`${className}\` has zero methods.`);
    }
  }
  return surface;
}

/** Keys of `object` whose value is a function — the callable surface. */
function methodNames(object: object): string[] {
  return Object.entries(object)
    .filter(([, value]) => typeof value === "function")
    .map(([name]) => name)
    .sort();
}

/** Exported bindings that are `Error` subclasses (or `Error` itself). */
function errorClassNames(namespace: object): string[] {
  return Object.entries(namespace)
    .filter(([, value]) => typeof value === "function" && value.prototype instanceof Error)
    .map(([name]) => name)
    .sort();
}

/**
 * Divergences between two name sets, one line per symbol.
 *
 * One line per symbol rather than a set-vs-set dump: "surfaces differ" is not
 * something anybody can act on, and the first question a failure raises is
 * always which name and in which direction.
 */
function nameDivergences(what: string, python: Iterable<string>, typescript: Iterable<string>) {
  const pythonNames = new Set(python);
  const typescriptNames = new Set(typescript);
  const lines: string[] = [];
  for (const name of [...pythonNames].sort()) {
    if (!typescriptNames.has(name)) {
      lines.push(`${what}: \`${name}\` exists in the Python SDK but not in the TypeScript SDK`);
    }
  }
  for (const name of [...typescriptNames].sort()) {
    if (!pythonNames.has(name)) {
      lines.push(`${what}: \`${name}\` exists in the TypeScript SDK but not in the Python SDK`);
    }
  }
  return lines;
}

describe("cross-SDK surface parity", () => {
  it("introspects a non-empty surface on both sides", async () => {
    const python = await loadPythonSurface();

    // The Python half is guarded inside loadPythonSurface(); this is the
    // TypeScript half of the same rule.
    expect(methodNames(models).length, "comfy.models exposes no methods").toBeGreaterThan(0);
    expect(
      errorClassNames(routerErrors).length,
      "routerErrors exports no error classes",
    ).toBeGreaterThan(0);
    expect(
      errorClassNames(sdk).length,
      "the package root exports no error classes",
    ).toBeGreaterThan(0);
    expect(routerErrors.ROUTER_ERROR_TYPES.length, "ROUTER_ERROR_TYPES is empty").toBeGreaterThan(
      0,
    );
    expect(python.source.repo).toBeTruthy();
  });

  it("exposes the same public method names under `models`", async () => {
    const python = await loadPythonSurface();
    const pythonSync = Object.entries(python.modelsMethods).filter(
      ([className]) => !ASYNC_MODELS_CLASSES.has(className),
    );
    expect(pythonSync.length, "no synchronous Python `models` class in the snapshot").toBe(1);

    expect(nameDivergences("comfy.models", pythonSync[0][1], methodNames(models))).toEqual([]);
  });

  it("declares no async-only method name on the Python side", async () => {
    // The `no-sync-variant` asymmetry says TypeScript has no async twin — not
    // that the twin may grow methods of its own. A suffixed `run_async` would
    // land here rather than silently as a Python-only method.
    const python = await loadPythonSurface();
    const sync = new Set(
      Object.entries(python.modelsMethods)
        .filter(([className]) => !ASYNC_MODELS_CLASSES.has(className))
        .flatMap(([, methods]) => methods),
    );
    for (const className of ASYNC_MODELS_CLASSES) {
      const methods = python.modelsMethods[className] ?? [];
      const extra = methods.filter((name) => !sync.has(name));
      expect(extra, `${className} declares methods the synchronous class does not`).toEqual([]);
    }
  });

  it("spells the router error classes identically", async () => {
    const python = await loadPythonSurface();
    expect(
      nameDivergences("routerErrors", python.routerErrorClasses, errorClassNames(routerErrors)),
    ).toEqual([]);
  });

  it("maps each router error class to the same `error_type`", async () => {
    const python = await loadPythonSurface();
    const divergences: string[] = [];
    for (const [className, errorType] of Object.entries(python.routerErrorTypes)) {
      const cls = (routerErrors as Record<string, unknown>)[className] as
        | typeof routerErrors.RouterError
        | undefined;
      // Absence is reported by the class-name test above; only compare where
      // both sides have the class, so one rename does not fail three tests.
      if (typeof cls !== "function") continue;
      if (cls.errorType !== errorType) {
        divergences.push(
          `routerErrors.${className}: error_type is "${cls.errorType}" in the TypeScript SDK ` +
            `but "${errorType}" in the Python SDK`,
        );
      }
    }
    expect(divergences).toEqual([]);
  });

  it("covers the same `error_type` set", async () => {
    const python = await loadPythonSurface();
    expect(
      nameDivergences("error_type", python.routerErrorTypeOrder, routerErrors.ROUTER_ERROR_TYPES),
    ).toEqual([]);
  });

  it("exports the same error class names from the package root", async () => {
    const python = await loadPythonSurface();
    const expected = python.exportedErrorClasses.map((name) => RENAMES[name] ?? name);
    expect(nameDivergences("package root", expected, errorClassNames(sdk))).toEqual([]);
  });

  it("keeps every declared rename live", async () => {
    // A rename that no longer applies is drift in the allowlist itself: it
    // would go on excusing a symbol nobody has, and hide the day the two SDKs
    // converge on one name.
    const python = await loadPythonSurface();
    const pythonNames = new Set(python.exportedErrorClasses);
    const typescriptNames = new Set(errorClassNames(sdk));
    for (const [pythonName, typescriptName] of Object.entries(RENAMES)) {
      expect(
        pythonNames.has(pythonName),
        `the allowlist renames \`${pythonName}\`, which the Python SDK no longer exports`,
      ).toBe(true);
      expect(
        typescriptNames.has(typescriptName),
        `the allowlist renames \`${pythonName}\` to \`${typescriptName}\`, which this SDK does not export`,
      ).toBe(true);
    }
  });

  it("documents every intentional asymmetry", () => {
    expect(INTENTIONAL_ASYMMETRIES.length).toBeGreaterThan(0);
    for (const asymmetry of INTENTIONAL_ASYMMETRIES) {
      expect(asymmetry.id, "an asymmetry needs an id").toBeTruthy();
      expect(
        asymmetry.why.length,
        `asymmetry "${asymmetry.id}" needs a stated reason`,
      ).toBeGreaterThan(80);
    }
  });
});

describe("python surface extraction", () => {
  it("refuses to yield an empty router error set", () => {
    // The failure mode this whole check has to avoid is a broken extraction
    // reading as agreement. Assert the extractor's own guard, on source it
    // genuinely cannot read.
    expect(() => extractRouterErrors("class RouterError(ComfyError):\n    pass\n")).toThrow(
      /ROUTER_EXCEPTIONS/,
    );
    expect(() => extractRouterErrors("# nothing here\n")).toThrow(/RouterError/);
  });
});
