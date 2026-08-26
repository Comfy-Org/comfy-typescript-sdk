#!/usr/bin/env node
/**
 * Refresh (or verify) `parity/python-surface.json` — the committed snapshot of
 * the Python SDK's public surface that `src/sdk/surface-parity.test.ts` diffs
 * this SDK against.
 *
 * ## How the other repo's surface is obtained
 *
 * The Python SDK is a separate, public repository. This script reads four of
 * its source files over plain HTTPS (`raw.githubusercontent.com`, no token, no
 * clone, no Python toolchain) and extracts the surface with
 * `scripts/python-surface.mjs`.
 *
 * The result is committed rather than fetched at test time, for the same
 * reason `spec/openapi.yaml` is vendored: the parity assertion has to run
 * offline, deterministically, on every PR, and a test that reaches the network
 * fails for reasons that have nothing to do with the code under review. So the
 * work is split in two:
 *
 * - `pnpm test` diffs this SDK against the **committed** snapshot. Offline,
 *   deterministic, and the thing that actually asserts parity.
 * - The `sdk-parity` CI job runs this script in `--check` mode, which
 *   re-derives the snapshot from the Python SDK's live default branch and
 *   fails if it has moved. That is the step that makes the snapshot honest:
 *   without it, a Python-side rename would sit undetected behind a stale file.
 *
 * A failure here is not a defect in this repo — it is the drift the check
 * exists to surface. Run `pnpm sync:python-surface`, commit the updated
 * snapshot, and deal with whatever `pnpm test` then says about it.
 *
 * ```bash
 * node scripts/sync-python-surface.mjs            # verify (what CI runs)
 * node scripts/sync-python-surface.mjs --write     # refresh the snapshot
 * node scripts/sync-python-surface.mjs --ref v0.2.0
 * ```
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { PYTHON_SOURCE_FILES, extractPythonSurface } from "./python-surface.mjs";

const MANIFEST_PATH = fileURLToPath(new URL("../parity/python-surface.json", import.meta.url));

/** Public sibling repository — the Python half of the two-SDK surface. */
const REPO = "Comfy-Org/comfy-python-sdk";
const DEFAULT_REF = "refs/heads/main";

function parseArgs(argv) {
  const args = { write: false, ref: DEFAULT_REF };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--write") args.write = true;
    else if (arg === "--ref") {
      i += 1;
      if (!argv[i]) throw new Error("--ref needs a value (a branch, tag or commit SHA)");
      args.ref = argv[i];
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function fetchSource(ref, path) {
  const url = `https://raw.githubusercontent.com/${REPO}/${ref}/${path}`;
  const response = await fetch(url, { headers: { accept: "text/plain" } });
  if (!response.ok) {
    throw new Error(
      `GET ${url} -> ${String(response.status)} ${response.statusText}. ` +
        "If the file moved, update PYTHON_SOURCE_FILES in scripts/python-surface.mjs.",
    );
  }
  return await response.text();
}

/** Stable, human-diffable JSON — this file is reviewed, not just parsed. */
function serialize(surface) {
  return `${JSON.stringify(surface, null, 2)}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const entries = await Promise.all(
    Object.entries(PYTHON_SOURCE_FILES).map(async ([key, path]) => [
      key,
      await fetchSource(args.ref, path),
    ]),
  );
  const surface = extractPythonSurface(Object.fromEntries(entries), {
    repo: REPO,
    ref: args.ref,
  });
  const fresh = serialize(surface);

  if (args.write) {
    await mkdir(dirname(MANIFEST_PATH), { recursive: true });
    await writeFile(MANIFEST_PATH, fresh, "utf-8");
    console.log(`Wrote parity/python-surface.json from ${REPO}@${args.ref}`);
    return;
  }

  const committed = await readFile(MANIFEST_PATH, "utf-8").catch(() => null);
  if (committed === null) {
    console.error("ERROR: parity/python-surface.json is missing. Run `pnpm sync:python-surface`.");
    process.exitCode = 1;
    return;
  }
  if (committed !== fresh) {
    console.error(
      `ERROR: parity/python-surface.json is stale relative to ${REPO}@${args.ref}.\n\n` +
        "The Python SDK's public surface has changed. This is the cross-SDK drift the\n" +
        "parity check exists to surface, not a problem with this branch.\n\n" +
        "  1. pnpm sync:python-surface   # refresh the snapshot\n" +
        "  2. pnpm test                  # see which symbols actually diverged\n" +
        "  3. Either mirror the change here, or declare it in the intentional-asymmetry\n" +
        "     allowlist in src/sdk/surface-parity.test.ts with the reason.\n",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`OK: parity/python-surface.json matches ${REPO}@${args.ref}`);
}

await main();
