/**
 * Read the Router invocation route out of the vendored Router contract.
 *
 * This is the acquisition half of a drift check whose two consumers cannot
 * share an assertion:
 *
 * - `src/sdk/router-spec-contract.test.ts` compares what this returns against
 *   the LIVE constants (`RUN_ROUTE_TEMPLATE`, `COMFY_ROUTER_BASE_URL`), so it
 *   cannot pass by describing a route the SDK does not actually build.
 * - `scripts/check-spec-drift.mjs` runs in the `check:spec-drift` CI job,
 *   which is plain Node with no TypeScript loader, so it compares against the
 *   same constants read out of their source text (below).
 *
 * Both are wanted: a Router sync that moves the route should redden the drift
 * job by name, not only the unit suite. The split mirrors
 * `scripts/python-surface.mjs`, which the cross-SDK parity test imports the
 * same way — and it inherits that module's rule: **every extractor here throws
 * on an empty or unrecognized result rather than returning one.** A check that
 * silently reads nothing reports agreement, which is the one failure mode a
 * drift check must not have.
 *
 * Nothing here is coupled to `spec/openapi.yaml`; that contract has real
 * codegen and the byte-for-byte diff in `check-spec-drift.mjs` covers it.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const ROOT = new URL("../", import.meta.url);

/** The vendored Comfy Router contract. One-way sync; never hand-edited. */
export const ROUTER_SPEC_PATH = fileURLToPath(new URL("spec/router-openapi.yaml", ROOT));

/** Source of `RUN_ROUTE_TEMPLATE`. */
export const MODELS_SOURCE_PATH = fileURLToPath(new URL("src/sdk/models.ts", ROOT));

/** Source of `COMFY_ROUTER_BASE_URL`. */
export const CREDENTIALS_SOURCE_PATH = fileURLToPath(new URL("src/sdk/credentials.ts", ROOT));

/**
 * The operation whose path this SDK hard-codes. `comfy.models.run` posts to
 * exactly this one; the catalog and per-model-schema routes beside it in the
 * contract are not called from here and are not pinned.
 */
export const RUN_OPERATION_ID = "runRouterModel";

function fail(message) {
  throw new Error(
    `${message}\n\nThis reads spec/router-openapi.yaml by shape. If the vendored contract ` +
      "moved something, fix scripts/router-route-contract.mjs — do not weaken the check: an " +
      "extractor that returns nothing would read as agreement.",
  );
}

/**
 * Resolve a local `$ref`, or return the node unchanged when there is none.
 *
 * Only same-document refs are supported, which is all a vendored single-file
 * contract can carry — a remote one is refused rather than skipped, so it
 * cannot drop a path parameter out of the comparison below.
 */
function deref(doc, node) {
  if (node === null || typeof node !== "object") return node;
  const ref = node.$ref;
  if (typeof ref !== "string") return node;
  if (!ref.startsWith("#/")) {
    fail(`spec/router-openapi.yaml: unsupported non-local $ref ${JSON.stringify(ref)}`);
  }
  let cursor = doc;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (cursor === null || typeof cursor !== "object" || !(segment in cursor)) {
      fail(`spec/router-openapi.yaml: $ref ${JSON.stringify(ref)} does not resolve`);
    }
    cursor = cursor[segment];
  }
  return cursor;
}

/**
 * The NAMES of an operation's path parameters, in declaration order.
 *
 * Path-item-level parameters are read before operation-level ones, which is
 * the order OpenAPI defines for the merge, and a name seen at both levels
 * keeps its first position — so a contract that hoists a parameter up a level
 * does not read here as a reordering. Only the names are compared: their
 * schemas are the error-bucket check's business, not this one's.
 */
function pathParameterNames(doc, pathItem, operation) {
  const merged = [];
  for (const raw of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
    const parameter = deref(doc, raw);
    if (parameter === null || typeof parameter !== "object" || typeof parameter.name !== "string") {
      fail(`spec/router-openapi.yaml: malformed parameter ${JSON.stringify(raw)}`);
    }
    if (parameter.in !== "path") continue;
    if (!merged.includes(parameter.name)) merged.push(parameter.name);
  }
  if (merged.length === 0) {
    fail(`spec/router-openapi.yaml: ${RUN_OPERATION_ID} declares no path parameters`);
  }
  return merged;
}

/**
 * The route and host the vendored Router contract declares, as
 * `{ runPath, serverUrl, parameterNames }`.
 */
export async function readRouterRouteContract(specPath = ROUTER_SPEC_PATH) {
  const doc = parse(await readFile(specPath, "utf-8"));
  if (doc === null || typeof doc !== "object") {
    fail("spec/router-openapi.yaml did not parse as an OpenAPI document");
  }

  const paths = doc.paths;
  if (paths === null || typeof paths !== "object") {
    fail("spec/router-openapi.yaml declares no `paths`");
  }
  const found = Object.entries(paths).filter(
    ([, item]) =>
      item !== null && typeof item === "object" && item.post?.operationId === RUN_OPERATION_ID,
  );
  if (found.length !== 1) {
    fail(
      `spec/router-openapi.yaml declares ${String(found.length)} paths with ` +
        `\`post.operationId: ${RUN_OPERATION_ID}\`, expected exactly 1`,
    );
  }
  const [runPath, pathItem] = found[0];

  const serverUrl = Array.isArray(doc.servers) ? doc.servers[0]?.url : undefined;
  if (typeof serverUrl !== "string" || serverUrl === "") {
    fail("spec/router-openapi.yaml declares no `servers[0].url`");
  }

  return {
    runPath,
    serverUrl,
    parameterNames: pathParameterNames(doc, pathItem, pathItem.post),
  };
}

/**
 * Read a `export const <name> = "<value>";` string constant out of TypeScript
 * source text.
 *
 * Deliberately not an import: `check-spec-drift.mjs` runs under plain Node in
 * CI, with no TypeScript loader and no build step ahead of it. The unit test
 * imports the real constants instead, so the value this returns is checked
 * against the runtime one there.
 */
function readStringConstant(source, name, file) {
  const match = new RegExp(`^export const ${name} = "([^"\\n]*)";$`, "m").exec(source);
  if (match === null || match[1] === "") {
    fail(`${file} declares no \`export const ${name} = "…";\` on a line of its own`);
  }
  return match[1];
}

/** `RUN_ROUTE_TEMPLATE` as `src/sdk/models.ts` declares it. */
export async function readRunRouteTemplate(sourcePath = MODELS_SOURCE_PATH) {
  return readStringConstant(
    await readFile(sourcePath, "utf-8"),
    "RUN_ROUTE_TEMPLATE",
    "src/sdk/models.ts",
  );
}

/** `COMFY_ROUTER_BASE_URL` as `src/sdk/credentials.ts` declares it. */
export async function readRouterBaseUrl(sourcePath = CREDENTIALS_SOURCE_PATH) {
  return readStringConstant(
    await readFile(sourcePath, "utf-8"),
    "COMFY_ROUTER_BASE_URL",
    "src/sdk/credentials.ts",
  );
}

/**
 * The two path parameters `RUN_ROUTE_TEMPLATE` addresses, in the order they
 * appear in it — `["provider", "model"]`.
 *
 * Order is the point: the segments are positional, so a contract that swapped
 * them would still contain both names while addressing a different model.
 */
export function templatePlaceholders(template) {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
}
