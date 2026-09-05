/**
 * Cross-SDK surface parity: this SDK against the Python one.
 *
 * Two SDKs maintained by separate PRs drift, and the drift is invisible until
 * somebody follows a Python example in TypeScript and the method is not there.
 * This test makes that visible at the point of change instead: it diffs the
 * public `models` method names, the router error class names, the
 * `error_type` coverage of the two SDKs and the status -> bucket fallback
 * table, and fails naming the symbol that diverged.
 *
 * Names alone are not enough, which is the lesson the fallback comparison
 * encodes: the two SDKs can spell every class identically and still raise
 * DIFFERENT classes for the same wire response. So two behaviours are compared
 * here as well as the names — the status fallback table, and the base class's
 * `error_type` default (the base is NOT excluded from the `error_type`
 * comparison, and excluding it is what previously hid the two SDKs disagreeing
 * about what an unrecognized bucket reads as).
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

import {
  extractErrorTypeByStatus,
  extractRetryPolicyFields,
  extractRouterErrors,
} from "../../scripts/python-surface.mjs";
import * as sdk from "../index.js";
import { models } from "./models.js";
import { DEFAULT_COLLECT_BUDGET_MS, DEFAULT_RETRY_BUDGET_MS, resolveRetry } from "./retry.js";
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
  /**
   * Router error classes this SDK has landed AHEAD of the Python one, as
   * `[className, errorType]`. Tolerated in one direction only — TypeScript
   * may lead, never lag — and only until the twin lands: the rot guard below
   * fails the moment the Python snapshot grows the same name, so the entry
   * cannot outlive the lag it describes.
   *
   * No asymmetry declares one today. `deadline_exceeded`, `not_enabled`,
   * `service_unavailable` and `rate_limited` did until the Python SDK shipped
   * all four, at which point the rot guard fired and the entry was deleted —
   * which is the mechanism working, not a gap. The field stays because the
   * next bucket will land on one side first too.
   */
  readonly routerErrorClassesAheadOfPython?: readonly (readonly [string, string])[];
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
  {
    id: "collect-switched-off-by-budget",
    why:
      "Python switches the collect loop off with a BOOLEAN (`RetryPolicy.retry_collectable=False`) " +
      "beside its `collect_max_elapsed` budget; TypeScript has the budget only, and " +
      "`collectBudgetMs: 0` is how it is switched off — the same way `budgetMs: 0` already " +
      "switches ordinary retries off, so the option surface stays one kind of thing rather " +
      "than a number and a flag that can disagree with each other. The BUDGET itself is " +
      "compared for real below (`collect_max_elapsed` seconds against `DEFAULT_COLLECT_BUDGET_MS` " +
      "milliseconds), so the sizing cannot drift; only the off-switch is spelled differently.",
  },
];

const RENAMES: Record<string, string> = Object.fromEntries(
  INTENTIONAL_ASYMMETRIES.flatMap((a) => Object.entries(a.renamedErrorClasses ?? {})),
);
const ASYNC_MODELS_CLASSES = new Set(
  INTENTIONAL_ASYMMETRIES.flatMap((a) => a.pythonAsyncModelsClasses ?? []),
);
const AHEAD_OF_PYTHON: readonly (readonly [string, string])[] = INTENTIONAL_ASYMMETRIES.flatMap(
  (a) => a.routerErrorClassesAheadOfPython ?? [],
);
const AHEAD_CLASS_NAMES = new Set(AHEAD_OF_PYTHON.map(([className]) => className));
const AHEAD_ERROR_TYPES = new Set(AHEAD_OF_PYTHON.map(([, errorType]) => errorType));

interface PythonSurface {
  source: { repo: string; ref: string; files: string[] };
  modelsMethods: Record<string, string[]>;
  routerErrorClasses: string[];
  routerErrorTypes: Record<string, string>;
  routerErrorTypeOrder: string[];
  routerErrorTypeByStatus: Record<string, string>;
  exportedErrorClasses: string[];
  retryPolicyFields: Record<string, string>;
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
    ["routerErrorTypeByStatus", Object.keys(surface.routerErrorTypeByStatus).length],
    ["exportedErrorClasses", surface.exportedErrorClasses.length],
    ["retryPolicyFields", Object.keys(surface.retryPolicyFields).length],
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

/**
 * The status -> bucket fallback this SDK actually applies, derived by CALLING
 * `toRouterError` rather than by reading its table.
 *
 * Reading the table would need it exported, which would widen the package's
 * public surface for a test's benefit; worse, it would assert the table rather
 * than the behaviour, and the two can part company (the trailing
 * `|| "internal_error"` that used to sit on the resolution line was exactly
 * such a divergence — invisible in the table, decisive in the answer). A
 * status whose fallback resolves to no bucket at all yields the base
 * `RouterError` with an empty `errorType`, and is simply absent here, which is
 * how the Python table spells the same thing.
 */
function typescriptFallbackTable(): Record<string, string> {
  // "No bucket" is whatever the base class reports, not a hardcoded "": that
  // default is compared against Python by its own test below, so keying off
  // it here means a regression in the default fails THAT test alone instead
  // of reddening this one too with a derived symptom.
  const noBucket = routerErrors.RouterError.errorType;
  const table: Record<string, string> = {};
  // Every status code an HTTP response can carry, not just the 4xx/5xx the
  // table happens to name today — an entry that strayed outside that range
  // must fail the comparison, not slip past the sweep.
  for (let status = 100; status <= 599; status += 1) {
    const error = routerErrors.toRouterError(status, new Headers(), null);
    if (error.errorType !== noBucket) table[String(status)] = error.errorType;
  }
  return table;
}

/** Fallback-table divergences, one line per status, in both directions. */
function fallbackDivergences(python: Record<string, string>, typescript: Record<string, string>) {
  // Not `describe` — that name belongs to vitest's own import in this file.
  const named = (bucket: string | undefined) =>
    bucket === undefined ? "the base RouterError (no bucket)" : `\`${bucket}\``;
  const statuses = [...new Set([...Object.keys(python), ...Object.keys(typescript)])].sort();
  return statuses
    .filter((status) => python[status] !== typescript[status])
    .map(
      (status) =>
        `header-less HTTP ${status}: the TypeScript SDK raises ${named(typescript[status])} ` +
        `but the Python SDK raises ${named(python[status])}`,
    );
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
    // Filtered on BOTH sides, so the day the Python SDK catches up produces
    // exactly ONE failure — the rot guard below, whose message says to delete
    // the entry — rather than three that each describe the same lag.
    expect(
      nameDivergences(
        "routerErrors",
        python.routerErrorClasses.filter((name) => !AHEAD_CLASS_NAMES.has(name)),
        errorClassNames(routerErrors).filter((name) => !AHEAD_CLASS_NAMES.has(name)),
      ),
    ).toEqual([]);
  });

  it("maps each router error class to the same `error_type`", async () => {
    // `routerErrorTypes` includes the BASE class, deliberately: excluding it
    // is what used to paper over TypeScript defaulting to `internal_error`
    // where Python defaults to `""`.
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
      nameDivergences(
        "error_type",
        python.routerErrorTypeOrder.filter((type) => !AHEAD_ERROR_TYPES.has(type)),
        [...routerErrors.ROUTER_ERROR_TYPES].filter((type) => !AHEAD_ERROR_TYPES.has(type)),
      ),
    ).toEqual([]);
  });

  it("falls back from a bucket-less response to the same bucket", async () => {
    // The behaviour a name-only check cannot see. Both SDKs consult a status
    // table ONLY when a response carried no `X-Comfy-Error-Type` and no
    // `error_type` in its body — a proxy or gateway that answered before
    // Router was reached — and the two tables have to agree, or the same
    // header-less response is a different `catch` branch in each language.
    //
    // `400` and `422` are the reason this test exists: TypeScript used to map
    // both to `invalid_input`, so a header-less `422` raised `InvalidInput`
    // here and the base `RouterError` in Python. Neither status pins one
    // bucket — a `400` is `invalid_input` OR `content_policy_violation`, which
    // differ in whether a retry can EVER succeed, and the contract pins no
    // bucket to `422` at all — so both are absent from the table on both
    // sides now.
    const python = await loadPythonSurface();
    const typescript = typescriptFallbackTable();
    expect(
      Object.keys(typescript).length,
      "no status resolves to a bucket — the derivation is broken, not in parity",
    ).toBeGreaterThan(0);
    expect(fallbackDivergences(python.routerErrorTypeByStatus, typescript)).toEqual([]);
  });

  it("agrees on what a bucket-less response reads as", async () => {
    // The base class default, compared rather than excluded. It is `""` on
    // both sides — "no bucket" — and NOT `internal_error`, which is a real
    // member of the closed set: defaulting to it would make "we could not
    // tell" indistinguishable from "the server said Router itself failed".
    // The `error_type` comparison above covers this too, now that the
    // manifest records the base class; this asserts it by name so a future
    // reader finds the decision rather than inferring it from a map entry.
    const python = await loadPythonSurface();
    expect(python.routerErrorTypes.RouterError, "the snapshot omits the base class").toBeDefined();
    expect(routerErrors.RouterError.errorType).toBe(python.routerErrorTypes.RouterError);
  });

  it("keeps every declared lead live, and only in the leading direction", async () => {
    // The same rot rule as the renames below, applied to the lead: an entry
    // has to name a class this SDK really has, and it has to STOP naming one
    // the Python SDK has caught up on — otherwise the allowlist would go on
    // excusing a divergence that no longer exists and hide the next real one.
    const python = await loadPythonSurface();
    const pythonClasses = new Set(python.routerErrorClasses);
    const pythonTypes = new Set(python.routerErrorTypeOrder);
    const typescriptClasses = new Set(errorClassNames(routerErrors));

    for (const [className, errorType] of AHEAD_OF_PYTHON) {
      expect(
        typescriptClasses.has(className),
        `the allowlist says \`${className}\` leads the Python SDK, but this SDK does not export it`,
      ).toBe(true);
      expect(
        (routerErrors as Record<string, unknown>)[className],
        `\`${className}\` is not a router error class`,
      ).toBeTypeOf("function");
      expect(
        (routerErrors as Record<string, typeof routerErrors.RouterError>)[className].errorType,
      ).toBe(errorType);
      expect(
        pythonClasses.has(className) || pythonTypes.has(errorType),
        `the Python SDK now carries \`${className}\` — delete its entry from ` +
          "INTENTIONAL_ASYMMETRIES so the two tables are compared again",
      ).toBe(false);
    }
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

  it("refuses to yield an empty status fallback table", () => {
    // Same rule for the fallback table: an absent or unreadable
    // `_ERROR_TYPE_BY_STATUS` must be a hard failure, because an empty Python
    // table would agree with any TypeScript one that also resolved nothing.
    expect(() => extractErrorTypeByStatus("# nothing here\n")).toThrow(/_ERROR_TYPE_BY_STATUS/);
    expect(() =>
      extractErrorTypeByStatus("_ERROR_TYPE_BY_STATUS: dict[int, str] = {\n    # empty\n}\n"),
    ).toThrow(/zero/);
  });

  it("reads every entry of the status fallback table", () => {
    expect(
      extractErrorTypeByStatus(
        '_ERROR_TYPE_BY_STATUS: dict[int, str] = {\n    401: "unauthorized",\n    504: "provider_timeout",\n}\n',
      ),
    ).toEqual({ 401: "unauthorized", 504: "provider_timeout" });
  });
});

describe("the collect budget", () => {
  it("is sized identically in both SDKs", async () => {
    // The one number whose correctness IS the feature: a collect budget
    // shorter than one Router deadline window can never start the attempt it
    // exists for, so the two SDKs agreeing on the class but not on the bound
    // would leave the same 504 collected in one language and raised in the
    // other. Compared as a value, not as a name.
    const { retryPolicyFields } = await loadPythonSurface();
    const pythonSeconds = retryPolicyFields.collect_max_elapsed;
    expect(
      pythonSeconds,
      "the Python SDK's RetryPolicy no longer declares `collect_max_elapsed` — see " +
        "DEFAULT_COLLECT_BUDGET_MS in src/sdk/retry.ts",
    ).toBeTruthy();
    expect(Number(pythonSeconds) * 1000).toBe(DEFAULT_COLLECT_BUDGET_MS);

    // And it is a SEPARATE budget on both sides, longer than the ordinary one.
    expect(Number(retryPolicyFields.max_elapsed) * 1000).toBeLessThan(DEFAULT_RETRY_BUDGET_MS + 1);
    expect(DEFAULT_COLLECT_BUDGET_MS).toBeGreaterThan(DEFAULT_RETRY_BUDGET_MS);
  });

  it("names the off-switch the two SDKs spell differently, and proves the TypeScript one", async () => {
    // Python: `retry_collectable=False`. TypeScript: `collectBudgetMs: 0`.
    // Declared as an intentional asymmetry above; asserted here so the entry
    // cannot outlive either side of what it describes.
    const { retryPolicyFields } = await loadPythonSurface();
    expect(retryPolicyFields.retry_collectable).toBe("True");
    expect(
      INTENTIONAL_ASYMMETRIES.some((a) => a.id === "collect-switched-off-by-budget"),
      "the collect off-switch asymmetry must stay declared while the two spellings differ",
    ).toBe(true);
    expect(resolveRetry({ collectBudgetMs: 0 }).collectBudgetMs).toBe(0);
    // On by default on both sides.
    expect(resolveRetry(undefined).collectBudgetMs).toBe(DEFAULT_COLLECT_BUDGET_MS);
  });

  it("refuses to yield an empty retry policy", () => {
    // Same rule as every other extractor here: an unreadable `RetryPolicy`
    // must be a hard failure, because an empty one would agree with any budget.
    expect(() => extractRetryPolicyFields("# nothing here\n")).toThrow(/RetryPolicy/);
    expect(() => extractRetryPolicyFields("@dataclass\nclass RetryPolicy:\n    pass\n")).toThrow(
      /zero/,
    );
  });

  it("reads a field and its default off a RetryPolicy body", () => {
    expect(
      extractRetryPolicyFields(
        "class RetryPolicy:\n    max_elapsed: float = 60.0\n    retry_collectable: bool = True\n",
      ),
    ).toEqual({ max_elapsed: "60.0", retry_collectable: "True" });
  });
});
