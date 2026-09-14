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

/** The operation `comfy.models.run` posts to. */
export const RUN_OPERATION_ID = "runRouterModel";

/** The operation `comfy.models.list` reads the model catalog from. */
export const CATALOG_OPERATION_ID = "listRouterModels";

/** The operation `comfy.models.schema` reads a model's OpenAPI document from. */
export const SCHEMA_OPERATION_ID = "getRouterModelInputSchema";

/** The HTTP methods an OpenAPI path item can carry an operation under. */
const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

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
    retryAfterStatuses: retryAfterStatuses(doc, pathItem),
  };
}

/**
 * The run route's error responses that declare a `Retry-After` header, as
 * sorted numeric statuses.
 *
 * This is the contract half of `isCollectable` in `src/sdk/retry.ts`: that
 * predicate accepts a same-key resend on exactly the statuses Router pairs
 * with a pace, and it would be silently wrong — resending a deterministic
 * refusal, or refusing to collect a generation Comfy is still holding — if the
 * contract moved the header and nothing compared the two. Read off the run
 * route rather than off the shared `components/responses`, because it is what
 * THIS operation can answer with that the predicate is about.
 */
export function retryAfterStatuses(doc, pathItem) {
  const responses = deref(doc, pathItem.post.responses ?? {});
  const statuses = [];
  for (const [status, rawResponse] of Object.entries(responses)) {
    const response = deref(doc, rawResponse);
    if (response === null || typeof response !== "object") continue;
    const headers = response.headers ?? {};
    if (Object.keys(headers).some((name) => name.toLowerCase() === "retry-after")) {
      // OpenAPI also allows `default` and the `4XX`/`5XX` range forms as
      // response keys. `Number()` turns those into `NaN`, which compares
      // unequal to everything (itself included) — the "reads as agreement"
      // failure this script exists to refuse, arriving through the other
      // door. Refuse loudly instead: the predicate matches exact statuses.
      if (!/^\d{3}$/.test(status)) {
        fail(
          `spec/router-openapi.yaml: ${RUN_OPERATION_ID} declares a \`Retry-After\` header on ` +
            `response key ${JSON.stringify(status)}, which is not a single numeric status. ` +
            "The predicate it is compared against (`isCollectable`) matches exact statuses.",
        );
      }
      statuses.push(Number(status));
    }
  }
  if (statuses.length === 0) {
    fail(
      `spec/router-openapi.yaml: ${RUN_OPERATION_ID} declares no response carrying a ` +
        "`Retry-After` header. An empty list would read as agreement with any predicate.",
    );
  }
  return statuses.sort((a, b) => a - b);
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

/**
 * Every operation the vendored contract declares, as
 * `{ operationId, method, path }`, sorted by path then method.
 *
 * This is the acquisition half of the ROUTE-COVERAGE check in
 * `src/sdk/router-spec-contract.test.ts`: that test maps each declared
 * operation to the `comfy.models` method that calls it, so the next route a
 * Router sync adds fails CI instead of sitting unreachable from the SDK — the
 * way `listRouterModels` and `getRouterModelInputSchema` both did from the day
 * the contract was first vendored here.
 *
 * An operation with no `operationId`, or one sharing its id with another, is
 * refused rather than skipped: the coverage map is keyed by that id, so a
 * dropped operation is exactly the un-noticed route this exists to catch, and
 * a duplicated one lets a single entry excuse two routes. A path item that is
 * a local `$ref` (legal in OpenAPI 3.x) is resolved rather than skipped for
 * the same reason — unresolved it carries no method keys, and every operation
 * under it would vanish with the non-empty guard below still satisfied.
 */
export function routerOperations(doc) {
  const paths = doc?.paths;
  if (paths === null || typeof paths !== "object") {
    fail("spec/router-openapi.yaml declares no `paths`");
  }
  const operations = [];
  const declaredAt = new Map();
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = deref(doc, rawItem);
    if (item === null || typeof item !== "object") {
      fail(`spec/router-openapi.yaml: malformed path item ${path}`);
    }
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation === undefined) continue;
      if (operation === null || typeof operation !== "object") {
        fail(`spec/router-openapi.yaml: malformed \`${method}\` operation on ${path}`);
      }
      const { operationId } = operation;
      if (typeof operationId !== "string" || operationId === "") {
        fail(`spec/router-openapi.yaml: \`${method} ${path}\` declares no operationId`);
      }
      const earlier = declaredAt.get(operationId);
      if (earlier !== undefined) {
        fail(
          `spec/router-openapi.yaml: operationId ${JSON.stringify(operationId)} is declared by ` +
            `both \`${earlier}\` and \`${method} ${path}\``,
        );
      }
      declaredAt.set(operationId, `${method} ${path}`);
      operations.push({ operationId, method, path });
    }
  }
  if (operations.length === 0) {
    fail("spec/router-openapi.yaml declares no operations — an empty set reads as agreement");
  }
  return operations.sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
}

/** {@link routerOperations} for the vendored contract on disk. */
export async function readRouterOperations(specPath = ROUTER_SPEC_PATH) {
  return routerOperations(parse(await readFile(specPath, "utf-8")));
}

/**
 * Read one `export const <NAME> = "<path template>";` out of
 * `src/sdk/models.ts` — the same acquisition `readRunRouteTemplate` does, for
 * the two discovery routes that now have constants of their own.
 */
export async function readRouteTemplate(name, sourcePath = MODELS_SOURCE_PATH) {
  return readStringConstant(await readFile(sourcePath, "utf-8"), name, "src/sdk/models.ts");
}
