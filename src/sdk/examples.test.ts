import { describe, expect, it } from "vitest";

import { ASSET_HANDLE, findAssetHandles } from "./core.js";
import { EXAMPLES, MAX_SEED, getExample, type Example } from "./examples.js";
import { WorkflowFactory } from "./workflows.js";

const factory = new WorkflowFactory();
type Node = { class_type: string; inputs: Record<string, unknown> };

function fakeHandle(): object {
  return { [ASSET_HANDLE]: true };
}

function required(example: Example): Record<string, unknown> {
  return Object.fromEntries(
    example.inputs.filter((i) => i.required).map((i) => [i.name, fakeHandle()]),
  );
}

describe.each(EXAMPLES.map((e) => [e.name, e] as const))("example %s", (_name, example) => {
  it("puts every input on an existing node and field", () => {
    for (const input of example.inputs) {
      const node = example.graph[input.nodeId] as Node | undefined;
      expect(node, `${input.name} -> node ${input.nodeId}`).toBeDefined();
      expect(Object.keys(node!.inputs)).toContain(input.field);
    }
  });

  it("links only to nodes in the graph", () => {
    const graph = factory.fromExample(example.name, required(example)).json as Record<string, Node>;
    for (const [id, node] of Object.entries(graph)) {
      expect(node.class_type, id).toBeTypeOf("string");
      for (const value of Object.values(node.inputs)) {
        if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string") {
          expect(Object.keys(graph)).toContain(value[0]);
        }
      }
    }
  });
});

describe("fromExample", () => {
  it("applies named inputs over the defaults", () => {
    const wf = factory.fromExample("text-to-image", { prompt: "a red fox", seed: 7, width: 768 });
    const g = wf.json as Record<string, Node>;
    expect(g["4"]!.inputs.text).toBe("a red fox");
    expect(g["8"]!.inputs.seed).toBe(7);
    expect(g["6"]!.inputs.width).toBe(768);
    expect(g["6"]!.inputs.height).toBe(1024);
  });

  it("draws a fresh seed per call", () => {
    const seeds = new Set(
      Array.from(
        { length: 8 },
        () => (factory.fromExample("t2i").json as Record<string, Node>)["8"]!.inputs.seed,
      ),
    );
    for (const s of seeds) {
      expect(Number.isInteger(s) && (s as number) >= 0 && (s as number) < MAX_SEED).toBe(true);
    }
    expect(seeds.size).toBeGreaterThan(1);
  });

  it("never mutates the template", () => {
    const before = JSON.stringify(getExample("text-to-image").graph);
    const wf = factory.fromExample("text-to-image", { prompt: "changed" });
    (wf.json["1"] as Node).inputs.unet_name = "other";
    expect(JSON.stringify(getExample("text-to-image").graph)).toBe(before);
  });

  it.each(["text-to-image", "TEXT_TO_IMAGE", " txt2img ", "t2i"])("accepts %j", (name) => {
    expect(getExample(name).name).toBe("text-to-image");
  });

  it("names the available examples for an unknown one", () => {
    expect(() => factory.fromExample("txt2music")).toThrow(
      /text-to-image, image-to-video, text-to-video/,
    );
  });

  it("names the valid inputs for an unknown one", () => {
    expect(() => factory.fromExample("text-to-image", { promt: "typo" })).toThrow(
      /no input "promt".*prompt, seed, width, height/,
    );
  });

  it("says how to get the required image", () => {
    expect(() => factory.fromExample("image-to-video")).toThrow(/needs image.*assets\.fromFile/);
  });

  it("embeds the image handle for substitution at submit", () => {
    const handle = fakeHandle();
    const wf = factory.fromExample("image-to-video", { image: handle });
    expect(findAssetHandles(wf.json)).toEqual([handle]);
  });

  it("lists every example", () => {
    expect(factory.examples().map((e) => e.name)).toEqual(EXAMPLES.map((e) => e.name));
  });
});
