#!/usr/bin/env node
/**
 * Fail if the hand-written code coupled to a vendored spec has drifted from it.
 *
 * Two independent checks. Both are run and both are reported on every
 * invocation, so a failure of one never hides the other; the exit status is
 * non-zero if either fails.
 *
 * 1. `src/low/generated/*` against `spec/openapi.yaml`. Regenerates into a
 *    temp directory using the exact same config as `pnpm generate` and diffs
 *    the result against what's committed, so a spec edit without a regen (or a
 *    hand-edit of a generated file) is caught. Mirrors
 *    `scripts/check_drift.py` in the Python SDK.
 * 2. The Router route `comfy.models.run` posts to, against
 *    `spec/router-openapi.yaml`. Nothing is generated from that contract, so
 *    there is nothing to regenerate and diff — the check is a comparison of
 *    two constants (`RUN_ROUTE_TEMPLATE`, `COMFY_ROUTER_BASE_URL`) against the
 *    path and host the contract declares. `src/sdk/router-spec-contract.test.ts`
 *    asserts the same agreement in the unit suite; this runs it in the drift
 *    job too, so a Router sync that moves the route reddens the job whose name
 *    says why rather than only `pnpm test`.
 */

import { createClient } from "@hey-api/openapi-ts";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readRouterBaseUrl,
  readRouterRouteContract,
  readRunRouteTemplate,
  RUN_OPERATION_ID,
  templatePlaceholders,
} from "./router-route-contract.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const COMMITTED_DIR = join(ROOT, "src", "low", "generated");
const GENERATED_FILES = ["types.gen.ts", "zod.gen.ts", "index.ts"];

/** True when `src/low/generated/*` matches a fresh generation. */
async function checkGeneratedCode() {
  const configModule = await import(join(ROOT, "openapi-ts.config.ts"));
  const baseConfig = configModule.default;

  const tmpDir = await mkdtemp(join(tmpdir(), "comfy-sdk-drift-"));
  try {
    await createClient({
      ...baseConfig,
      output: { ...baseConfig.output, path: tmpDir },
      logs: { level: "silent" },
    });

    let drifted = false;
    for (const file of GENERATED_FILES) {
      const [fresh, committed] = await Promise.all([
        readFile(join(tmpDir, file), "utf-8").catch(() => null),
        readFile(join(COMMITTED_DIR, file), "utf-8").catch(() => null),
      ]);
      if (fresh === null) {
        console.error(`ERROR: codegen did not produce ${file}`);
        drifted = true;
        continue;
      }
      if (fresh !== committed) {
        console.error(
          `ERROR: ${join("src/low/generated", file)} is stale relative to spec/openapi.yaml.`,
        );
        drifted = true;
      }
    }

    if (drifted) {
      console.error("\nRun `pnpm generate` and commit the result.\n");
      return false;
    }
    console.log("OK: src/low/generated is in sync with spec/openapi.yaml");
    return true;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * True when `RUN_ROUTE_TEMPLATE` and `COMFY_ROUTER_BASE_URL` still describe
 * the route the vendored Router contract declares.
 *
 * An extraction failure is a failure of this check, not a crash: the readers
 * throw rather than return nothing (a check that reads nothing reports
 * agreement), and the throw is turned into the same kind of named error the
 * comparisons below emit.
 */
async function checkRouterRoute() {
  let contract;
  let template;
  let baseUrl;
  try {
    [contract, template, baseUrl] = await Promise.all([
      readRouterRouteContract(),
      readRunRouteTemplate(),
      readRouterBaseUrl(),
    ]);
  } catch (error) {
    console.error(`ERROR: could not compare the Router route against spec/router-openapi.yaml.\n`);
    console.error(error instanceof Error ? error.message : String(error));
    console.error("");
    return false;
  }

  const problems = [];
  if (contract.runPath !== template) {
    problems.push(
      `RUN_ROUTE_TEMPLATE (src/sdk/models.ts) is "${template}", but spec/router-openapi.yaml ` +
        `declares "${contract.runPath}" for \`post.operationId: ${RUN_OPERATION_ID}\`. ` +
        "comfy.models.run posts to the template, so it would 404 until the constant follows.",
    );
  }
  if (contract.serverUrl !== baseUrl) {
    problems.push(
      `COMFY_ROUTER_BASE_URL (src/sdk/credentials.ts) is "${baseUrl}", but ` +
        `spec/router-openapi.yaml declares "${contract.serverUrl}" as \`servers[0].url\`.`,
    );
  }
  const placeholders = templatePlaceholders(template);
  if (placeholders.join(",") !== contract.parameterNames.join(",")) {
    problems.push(
      `RUN_ROUTE_TEMPLATE (src/sdk/models.ts) fills [${placeholders.join(", ")}], but ` +
        `spec/router-openapi.yaml declares path parameters ` +
        `[${contract.parameterNames.join(", ")}] in that order.`,
    );
  }

  if (problems.length > 0) {
    console.error("ERROR: the Router route has drifted from spec/router-openapi.yaml.\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      "\nspec/router-openapi.yaml is a one-way vendored copy — update the constants above to " +
        "match it, never the other way round.\n",
    );
    return false;
  }
  console.log("OK: the Router route matches spec/router-openapi.yaml");
  return true;
}

async function main() {
  // Both, always: a stale codegen must not hide a moved Router route.
  const generatedOk = await checkGeneratedCode();
  const routerOk = await checkRouterRoute();
  if (!generatedOk || !routerOk) process.exitCode = 1;
}

await main();
