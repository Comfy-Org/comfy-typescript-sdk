/**
 * Extract the Python SDK's public surface from its source text.
 *
 * This is the acquisition half of the cross-SDK parity check. The comparison
 * itself lives in `src/sdk/surface-parity.test.ts`, which reads the manifest
 * this module produces (`parity/python-surface.json`) and diffs it against
 * the TypeScript surface introspected live.
 *
 * ## Why parse the source instead of importing it
 *
 * Importing `comfy_sdk` would need a Python toolchain, a virtualenv and the
 * SDK's own runtime dependencies installed inside a Node repo's CI — a lot of
 * moving parts for a check whose whole job is to be trustworthy. Parsing is
 * narrower: it reads four files and knows exactly four shapes. The cost is
 * that a sufficiently unusual refactor on the Python side could make an
 * extraction return nothing, which would silently read as "parity" — so every
 * extractor here throws on an empty result rather than returning one. A
 * broken introspection step must never look like agreement.
 *
 * The shapes this depends on are the same ones the Python SDK's own tests
 * pin (`tests/test_router_exceptions.py` asserts the one-class-per-error_type
 * rule, `tests/test_models_run.py` asserts the absence of a `run_async`
 * suffix), so they are contract rather than incidental formatting.
 */

/** The Python SDK files the surface is read out of, relative to that repo's root. */
export const PYTHON_SOURCE_FILES = {
  models: "src/comfy_sdk/models.py",
  routerExceptions: "src/comfy_sdk/router_exceptions.py",
  exceptions: "src/comfy_sdk/exceptions.py",
  packageInit: "src/comfy_sdk/__init__.py",
};

/** The two `models` namespace classes: the sync client's, then the async client's. */
export const PYTHON_MODELS_CLASSES = ["Models", "AsyncModels"];

class ExtractionError extends Error {}

function fail(message) {
  throw new ExtractionError(
    `${message}\n\nThis usually means the Python SDK moved something this extractor ` +
      "reads by shape. Fix scripts/python-surface.mjs — do not weaken the check: an " +
      "extractor that returns nothing would read as parity.",
  );
}

/**
 * The lines of a top-level `class <name>` body, or `null` if there is no such
 * class. The body ends at the next line that starts in column 0 with
 * something other than whitespace, which is how a top-level Python block ends.
 */
function classBody(source, className) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^class ${className}\\b`).test(line));
  if (start === -1) return null;

  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() !== "" && !/^\s/.test(line)) break;
    body.push(line);
  }
  return body;
}

/**
 * Public, non-property methods declared directly on a class body.
 *
 * `@property` accessors are excluded on purpose: the criterion is method
 * parity, and the Python namespace's `base_url` / `timeout` / `retry` are a
 * read-only view of the host client's configuration rather than operations.
 * The TypeScript `comfy.models` object is configured module-wide and so has
 * no equivalent — that is the credential-resolution asymmetry, and it is
 * declared as such in `src/sdk/surface-parity.test.ts`.
 */
function publicMethods(body) {
  const methods = [];
  let decorators = [];

  for (const line of body) {
    const decorator = /^\s{4}@([\w.]+)/.exec(line);
    if (decorator) {
      decorators.push(decorator[1]);
      continue;
    }
    // Anything else at method indentation ends the decorator run, whether or
    // not it turns out to be a `def`.
    if (!/^\s{4}\S/.test(line)) continue;

    const def = /^\s{4}(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(line);
    const isProperty = decorators.some(
      (d) => d === "property" || d.endsWith(".setter") || d.endsWith(".getter"),
    );
    decorators = [];

    if (!def) continue;
    const name = def[1];
    if (name.startsWith("_")) continue;
    if (isProperty) continue;
    methods.push(name);
  }

  return methods;
}

/**
 * Public method names on each of the two `models` namespace classes.
 *
 * The class list is fixed rather than discovered, so a third public namespace
 * class appearing in that module is a hard failure here instead of a surface
 * this check quietly does not look at.
 */
export function extractModelsMethods(source) {
  const declared = [...source.matchAll(/^class\s+([A-Za-z]\w*)\s*[(:]/gm)].map((m) => m[1]);
  const unknown = declared.filter((name) => !PYTHON_MODELS_CLASSES.includes(name));
  if (unknown.length > 0) {
    fail(
      `${PYTHON_SOURCE_FILES.models}: unrecognized public class(es) ${unknown.join(", ")}. ` +
        "If one of them is part of the `models` namespace surface, add it to " +
        "PYTHON_MODELS_CLASSES (and declare any intentional asymmetry in " +
        "src/sdk/surface-parity.test.ts).",
    );
  }

  const result = {};
  for (const className of PYTHON_MODELS_CLASSES) {
    const body = classBody(source, className);
    if (body === null) fail(`${PYTHON_SOURCE_FILES.models}: no \`class ${className}\` found.`);
    const methods = publicMethods(body);
    if (methods.length === 0) {
      fail(`${PYTHON_SOURCE_FILES.models}: \`${className}\` yielded zero public methods.`);
    }
    result[className] = methods.sort();
  }
  return result;
}

/**
 * The router error hierarchy: the class names, and the wire `error_type` each
 * one maps to.
 *
 * The order comes from the `ROUTER_EXCEPTIONS` tuple rather than from the
 * class definitions, because that tuple is what the Python SDK derives its
 * own `ROUTER_ERROR_TYPES` from — reading it here means the manifest records
 * the same list the Python SDK publishes, not a re-derivation that could
 * disagree with it.
 */
export function extractRouterErrors(source) {
  if (!/^class RouterError\(/m.test(source)) {
    fail(`${PYTHON_SOURCE_FILES.routerExceptions}: no \`class RouterError\` found.`);
  }

  const tuple = /^ROUTER_EXCEPTIONS[^=]*=\s*\(([\s\S]*?)^\)/m.exec(source);
  if (!tuple) {
    fail(`${PYTHON_SOURCE_FILES.routerExceptions}: no \`ROUTER_EXCEPTIONS\` tuple found.`);
  }
  const ordered = tuple[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^[A-Z]\w*$/.test(entry));
  if (ordered.length === 0) {
    fail(`${PYTHON_SOURCE_FILES.routerExceptions}: \`ROUTER_EXCEPTIONS\` listed zero classes.`);
  }

  const errorTypes = {};
  for (const className of ordered) {
    const body = classBody(source, className);
    if (body === null) {
      fail(
        `${PYTHON_SOURCE_FILES.routerExceptions}: \`ROUTER_EXCEPTIONS\` names ${className}, ` +
          "but no such class is defined in the file.",
      );
    }
    const assignment = body
      .map((line) => /^\s{4}error_type\s*(?::\s*str\s*)?=\s*"([^"]*)"/.exec(line))
      .find(Boolean);
    if (!assignment || assignment[1] === "") {
      fail(
        `${PYTHON_SOURCE_FILES.routerExceptions}: ${className} declares no non-empty ` +
          "`error_type`. Every class in the closed set maps to exactly one wire value.",
      );
    }
    errorTypes[className] = assignment[1];
  }

  return {
    // The base class first, then the closed set in declaration order.
    classes: ["RouterError", ...ordered],
    errorTypes,
    // `ROUTER_ERROR_TYPES` as the Python SDK publishes it: the tuple's order.
    errorTypeOrder: ordered.map((className) => errorTypes[className]),
  };
}

/** The names in a module's `__all__`, in declaration order. */
function dunderAll(source, file) {
  const block = /^__all__[^=]*=\s*\[([\s\S]*?)^\]/m.exec(source);
  if (!block) fail(`${file}: no \`__all__\` list found.`);
  const names = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (names.length === 0) fail(`${file}: \`__all__\` is empty.`);
  return names;
}

/**
 * Error classes the package root re-exports — the intersection of the classes
 * defined in `comfy_sdk/exceptions.py` and the names in `comfy_sdk.__all__`.
 *
 * The router errors are deliberately not in here: the Python SDK does not
 * re-export `router_exceptions` from its root, because three of those names
 * are already taken at the root by the workflow-API exceptions. The
 * TypeScript SDK resolves the same collision the same way, with a
 * `routerErrors` namespace.
 */
export function extractExportedErrorClasses(exceptionsSource, initSource) {
  const defined = [...exceptionsSource.matchAll(/^class\s+(\w+)\s*\(/gm)].map((m) => m[1]);
  if (defined.length === 0) fail(`${PYTHON_SOURCE_FILES.exceptions}: no classes found.`);

  const exported = new Set(dunderAll(initSource, PYTHON_SOURCE_FILES.packageInit));
  const names = defined.filter((name) => exported.has(name)).sort();
  if (names.length === 0) {
    fail(
      `${PYTHON_SOURCE_FILES.exceptions}: none of its classes appear in ` +
        `${PYTHON_SOURCE_FILES.packageInit}'s \`__all__\`.`,
    );
  }
  return names;
}

/**
 * Build the whole manifest from the four Python source files.
 *
 * `sources` is keyed by the keys of {@link PYTHON_SOURCE_FILES}.
 */
export function extractPythonSurface(sources, { repo, ref }) {
  for (const [key, file] of Object.entries(PYTHON_SOURCE_FILES)) {
    if (typeof sources[key] !== "string" || sources[key].trim() === "") {
      fail(`${file}: fetched empty.`);
    }
  }

  const routerErrors = extractRouterErrors(sources.routerExceptions);

  return {
    source: { repo, ref, files: Object.values(PYTHON_SOURCE_FILES) },
    modelsMethods: extractModelsMethods(sources.models),
    routerErrorClasses: routerErrors.classes,
    routerErrorTypes: routerErrors.errorTypes,
    routerErrorTypeOrder: routerErrors.errorTypeOrder,
    exportedErrorClasses: extractExportedErrorClasses(sources.exceptions, sources.packageInit),
  };
}
