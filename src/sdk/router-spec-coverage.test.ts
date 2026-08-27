/**
 * Drift check for the hand-written Router error table against the vendored
 * Router contract.
 *
 * `spec/router-openapi.yaml` is a one-way vendored copy of the canonical
 * Comfy Router contract, and unlike `spec/openapi.yaml` nothing in this repo
 * generates code from it — so `scripts/check-spec-drift.mjs`, which works by
 * regenerating and diffing, has nothing to compare. This is the equivalent
 * check for the one thing that IS coupled to that contract: the closed
 * `error_type` set in `./routerErrors.ts` and the class per bucket.
 *
 * It mirrors `src/low/spec-coverage.test.ts`, which does the same job for the
 * hand-written pieces coupled to the v2 spec. Both fail in the direction that
 * matters: a spec sync that adds a bucket is not done until a class exists
 * for it, and a class invented here that the contract does not declare fails
 * too.
 *
 * The contract carries the bucket set twice — as the `RouterErrorType`
 * schema's prose and as the `x-comfy-error-types` vendor extension beside it.
 * The extension is what is read here: it is the machine-readable half, it
 * carries the tier each bucket belongs to, and it is what a generator would
 * consume if Router codegen lands in this repo later.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import * as routerErrors from "./routerErrors.js";
import {
  ERROR_TYPE_HEADER,
  REQUEST_ERROR_TYPES,
  ROUTER_ERROR_TYPES,
  RouterError,
  TRANSPORT_ERROR_TYPES,
  toRouterError,
} from "./routerErrors.js";

const SPEC_PATH = fileURLToPath(new URL("../../spec/router-openapi.yaml", import.meta.url));
const MODULE_PATH = fileURLToPath(new URL("./routerErrors.ts", import.meta.url));

interface SpecErrorType {
  value: string;
  tier: string;
  meaning: string;
}

async function specErrorTypes(): Promise<SpecErrorType[]> {
  const doc = parse(await readFile(SPEC_PATH, "utf-8")) as {
    components?: {
      schemas?: Record<string, { "x-comfy-error-types"?: SpecErrorType[] } | undefined>;
    };
  };
  const declared = doc.components?.schemas?.RouterErrorType?.["x-comfy-error-types"];
  // A vendored spec that stopped declaring the extension would otherwise make
  // every assertion below pass against an empty set — agreement by absence,
  // which is the one failure mode a drift check must not have.
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error(
      "spec/router-openapi.yaml declares no `components.schemas.RouterErrorType." +
        "x-comfy-error-types` — the vendored Router contract is missing the error-type set " +
        "this table is checked against.",
    );
  }
  for (const entry of declared) {
    if (typeof entry?.value !== "string" || typeof entry.tier !== "string") {
      throw new Error(
        `spec/router-openapi.yaml: malformed x-comfy-error-types entry ${JSON.stringify(entry)}`,
      );
    }
  }
  return declared;
}

/** The module's exported `RouterError` subclasses, keyed by their `errorType`. */
function classesByErrorType(): Map<string, typeof RouterError> {
  const table = new Map<string, typeof RouterError>();
  for (const value of Object.values(routerErrors)) {
    if (typeof value !== "function") continue;
    if (!(value.prototype instanceof RouterError)) continue;
    const cls = value as unknown as typeof RouterError;
    table.set(cls.errorType, cls);
  }
  return table;
}

/** The JSDoc block immediately above `export class <name>`, if there is one. */
function jsdocFor(source: string, className: string): string {
  const declaration = source.indexOf(`export class ${className} extends RouterError`);
  if (declaration === -1) return "";
  const before = source.slice(0, declaration);
  const closed = before.lastIndexOf("*/");
  // The block has to be ADJACENT — only whitespace between it and the
  // declaration. Without that, an unrelated earlier comment would answer for
  // a class that carries no doc of its own.
  if (closed === -1 || before.slice(closed + 2).trim() !== "") return "";
  const opened = before.lastIndexOf("/**", closed);
  return opened === -1 ? "" : before.slice(opened, closed + 2);
}

describe("router spec coverage (spec/router-openapi.yaml)", () => {
  it("declares exactly the buckets the vendored contract does, in its order", async () => {
    const declared = await specErrorTypes();
    expect([...ROUTER_ERROR_TYPES]).toEqual(declared.map((entry) => entry.value));
  });

  it("splits them into the tiers the contract assigns", async () => {
    const declared = await specErrorTypes();
    const tier = (want: string) =>
      declared.filter((entry) => entry.tier === want).map((entry) => entry.value);

    expect([...REQUEST_ERROR_TYPES]).toEqual(tier("request"));
    expect([...TRANSPORT_ERROR_TYPES]).toEqual(tier("transport"));
    // Every declared bucket lands in one of the two tiers, so a third tier
    // added upstream fails here rather than silently dropping its buckets.
    expect(tier("request").length + tier("transport").length).toBe(declared.length);
  });

  it("has a class for every bucket the contract declares", async () => {
    const declared = await specErrorTypes();
    const classes = classesByErrorType();

    const missing = declared.map((entry) => entry.value).filter((value) => !classes.has(value));
    expect(
      missing,
      "the vendored Router contract declares error_type buckets with no class in routerErrors.ts",
    ).toEqual([]);
  });

  it("declares no class the contract does not", async () => {
    const declared = new Set((await specErrorTypes()).map((entry) => entry.value));
    const extra = [...classesByErrorType().keys()].filter((value) => !declared.has(value));
    expect(
      extra,
      "routerErrors.ts carries error_type buckets the vendored Router contract does not declare",
    ).toEqual([]);
  });

  it("names every class the PascalCase of its wire value", async () => {
    // The shared naming rule, and the reason a class name never needs its own
    // decision: both SDKs derive it the same way from the same contract.
    for (const { value } of await specErrorTypes()) {
      const expected = value
        .split("_")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("");
      const cls = (routerErrors as Record<string, unknown>)[expected];
      expect(typeof cls, `routerErrors.${expected} is missing for "${value}"`).toBe("function");
      expect((cls as typeof RouterError).errorType).toBe(value);
    }
  });

  it("resolves every bucket through toRouterError, off the header", async () => {
    // The tables above are static; this proves the runtime lookup agrees with
    // them for every bucket the contract declares, which is the property a
    // caller's `instanceof` actually rests on.
    const classes = classesByErrorType();
    for (const { value } of await specErrorTypes()) {
      const err = toRouterError(500, new Headers({ [ERROR_TYPE_HEADER]: value }), {
        detail: "boom",
      });
      expect(err.constructor, value).toBe(classes.get(value));
      expect(err.errorType).toBe(value);
    }
  });

  it("carries each bucket's distinguishing meaning from the contract into the class JSDoc", async () => {
    // Not a prose diff — the contract's `meaning` text is long and is edited
    // upstream for readability, so diffing it would fail on a comma. What is
    // asserted is that the class comment was written FROM the contract, by
    // requiring the phrase that distinguishes each bucket whose whole point
    // is that an older bucket shares its HTTP status.
    const source = await readFile(MODULE_PATH, "utf-8");
    const phrases: [string, string][] = [
      ["NotEnabled", "not switched on for this caller yet"],
      ["ServiceUnavailable", "temporarily unavailable"],
      ["DeadlineExceeded", "own configured bound"],
      ["RateLimited", "measured over a WINDOW"],
    ];
    for (const [className, phrase] of phrases) {
      expect(
        jsdocFor(source, className),
        `${className}'s JSDoc lost its contract meaning`,
      ).toContain(phrase);
    }
  });
});
