/**
 * The SDK ships to browsers as well as Node, so no module may carry a
 * *static* import of a Node built-in: a bundler follows those from the entry
 * point and fails, or silently ships a shim, long before any Node-only method
 * is called.
 *
 * Node-only helpers (`hashFile`, `Workflow.fromFile`, `Output.toFile`) are
 * still supported — they `await import("node:…")` inside the function, so the
 * built-in is reached only if a caller actually invokes them.
 */

import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = new URL(".", import.meta.url).pathname;

// `import ... from "node:x"` / `export ... from "node:x"`, but not
// `await import("node:x")`, which is the escape hatch this rule permits.
const STATIC_NODE_IMPORT = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']node:[^"']+["']/gm;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (extname(entry.name) !== ".ts") return [];
    if (entry.name.endsWith(".test.ts")) return [];
    return [full];
  });
}

describe("browser safety", () => {
  it("has no static Node built-in imports in shipped source", () => {
    const offenders = sourceFiles(SRC).flatMap((file) => {
      const matches = readFileSync(file, "utf-8").match(STATIC_NODE_IMPORT) ?? [];
      return matches.map((line) => `${file.slice(SRC.length)}: ${line.trim()}`);
    });

    expect(offenders).toEqual([]);
  });

  it("mints an idempotency key without node:crypto", async () => {
    const { newIdempotencyKey } = await import("./sdk/core.js");
    const key = newIdempotencyKey();

    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newIdempotencyKey()).not.toBe(key);
  });
});
