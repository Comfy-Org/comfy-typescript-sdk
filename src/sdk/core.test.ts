import { describe, expect, it } from "vitest";

import type { AssetReference } from "../low/index.js";
import {
  ASSET_HANDLE,
  type AssetHandleLike,
  assetReference,
  backoffSchedule,
  extraDataFor,
  findAssetHandles,
  isTerminal,
  substituteAssetHandles,
} from "./core.js";

const ref = (id: string): AssetReference => ({ __type: "core/ASSET", info: { id } });

function handle(reference: AssetReference): AssetHandleLike {
  return { [ASSET_HANDLE]: true, asReference: async () => reference };
}

describe("findAssetHandles / substituteAssetHandles", () => {
  it("finds handles nested inside arrays and objects (batch inputs)", () => {
    const h1 = handle(ref("a"));
    const h2 = handle(ref("b"));
    const graph = { "1": { inputs: { images: [h1, h2, "literal"] } } };
    expect(findAssetHandles(graph)).toEqual([h1, h2]);
  });

  it("substitutes each handle in an array, leaving non-handles untouched", () => {
    const h1 = handle(ref("a"));
    const h2 = handle(ref("b"));
    const graph = { "1": { inputs: { images: [h1, h2, "literal"] } } };
    const refs = new Map([
      [h1, ref("a")],
      [h2, ref("b")],
    ]);
    expect(substituteAssetHandles(graph, refs)).toEqual({
      "1": { inputs: { images: [ref("a"), ref("b"), "literal"] } },
    });
  });

  it("throws if a handle was never materialized into the refs map", () => {
    const graph = { "1": { inputs: { image: handle(ref("a")) } } };
    expect(() => substituteAssetHandles(graph, new Map())).toThrow(
      /not materialized before substitution/,
    );
  });

  it("passes plain graphs through unchanged", () => {
    const graph = { "1": { inputs: { seed: 42, model: "x.safetensors" } } };
    expect(substituteAssetHandles(graph, new Map())).toEqual(graph);
    expect(findAssetHandles(graph)).toEqual([]);
  });
});

describe("assetReference", () => {
  it("includes only the provided optional fields", () => {
    expect(assetReference("id1")).toEqual({ __type: "core/ASSET", info: { id: "id1" } });
    expect(assetReference("id1", { hash: "blake3:x", filePath: "p.png" })).toEqual({
      __type: "core/ASSET",
      info: { id: "id1", hash: "blake3:x", file_path: "p.png" },
    });
    // Falsy hash/filePath are omitted rather than emitted as empty.
    expect(assetReference("id1", { hash: null, filePath: "" })).toEqual({
      __type: "core/ASSET",
      info: { id: "id1" },
    });
  });
});

describe("extraDataFor", () => {
  it("returns undefined when neither an apiKey nor a workflow graph is given", () => {
    expect(extraDataFor(undefined, undefined)).toBeUndefined();
    expect(extraDataFor("", undefined)).toBeUndefined(); // empty string is falsy, like no key
  });

  it("carries only api_key_comfy_org when just an apiKey is given", () => {
    expect(extraDataFor("comfyui-test-key", undefined)).toEqual({
      api_key_comfy_org: "comfyui-test-key",
    });
  });

  it("carries only extra_pnginfo.workflow when just a graph is given", () => {
    const graph = { "1": { inputs: { seed: 42 } } };
    expect(extraDataFor(undefined, graph)).toEqual({ extra_pnginfo: { workflow: graph } });
  });

  it("merges both keys when both are given", () => {
    const graph = { "1": {} };
    expect(extraDataFor("comfyui-test-key", graph)).toEqual({
      api_key_comfy_org: "comfyui-test-key",
      extra_pnginfo: { workflow: graph },
    });
  });
});

describe("isTerminal", () => {
  it("treats canceling as non-terminal but the four end states as terminal", () => {
    expect(isTerminal("canceling")).toBe(false);
    expect(isTerminal("running")).toBe(false);
    for (const s of ["succeeded", "canceled", "failed", "expired"]) {
      expect(isTerminal(s)).toBe(true);
    }
  });
});

describe("backoffSchedule", () => {
  it("grows by the factor then holds at the cap", () => {
    const it = backoffSchedule(500, 1.5, 5_000);
    const first = [it.next().value, it.next().value, it.next().value];
    expect(first).toEqual([500, 750, 1125]);
    // Drain to the cap and confirm it holds there.
    let last = 0;
    for (let i = 0; i < 20; i++) last = it.next().value;
    expect(last).toBe(5_000);
  });
});
