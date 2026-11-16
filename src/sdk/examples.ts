/**
 * Built-in example workflows: something to run before you have a workflow of
 * your own. Mirrors `comfy_sdk.examples` in the Python SDK; the graphs are the
 * same.
 *
 * `client.workflows.fromExample("text-to-image", { prompt: "..." })` returns an
 * ordinary {@link Workflow}, so everything that works on a workflow you
 * exported yourself works on one of these too. The graphs use models from the
 * Comfy Cloud library; a self-hosted ComfyUI runs them only if it has the same
 * model files.
 */

import { Workflow, type WorkflowGraph } from "./workflows.js";

/** One named input of an example: where it lands in the graph, and its default. */
export interface ExampleInput {
  readonly name: string;
  readonly nodeId: string;
  readonly field: string;
  readonly description: string;
  readonly default?: unknown;
  /** No default: `fromExample` throws without it. */
  readonly required?: boolean;
  /** Defaults to a new random seed on every call, so two runs do not repeat. */
  readonly randomSeed?: boolean;
}

/** A built-in example workflow. List them with `client.workflows.examples()`. */
export interface Example {
  readonly name: string;
  readonly description: string;
  /** What the job produces. */
  readonly output: "image" | "video";
  readonly aliases: readonly string[];
  readonly inputs: readonly ExampleInput[];
  readonly graph: WorkflowGraph;
}

/** Seeds are drawn below this bound (unsigned 32-bit). */
export const MAX_SEED = 2 ** 32;

export const EXAMPLES: readonly Example[] = [
  {
    name: "text-to-image",
    description: "Generate an image from a prompt (Z-Image Turbo, 1024x1024).",
    output: "image",
    aliases: ["txt2img", "t2i"],
    inputs: [
      {
        name: "prompt",
        nodeId: "4",
        field: "text",
        description: "what to draw",
        default: "a lighthouse on a cliff at dusk, waves below, oil painting",
      },
      {
        name: "seed",
        nodeId: "8",
        field: "seed",
        description: "random seed; pass one to make a run repeatable",
        randomSeed: true,
      },
      {
        name: "width",
        nodeId: "6",
        field: "width",
        description: "image width in pixels",
        default: 1024,
      },
      {
        name: "height",
        nodeId: "6",
        field: "height",
        description: "image height in pixels",
        default: 1024,
      },
    ],
    graph: {
      "1": {
        class_type: "UNETLoader",
        inputs: {
          unet_name: "z_image_turbo_bf16.safetensors",
          weight_dtype: "default",
        },
      },
      "2": {
        class_type: "CLIPLoader",
        inputs: {
          clip_name: "qwen_3_4b.safetensors",
          type: "lumina2",
          device: "default",
        },
      },
      "3": {
        class_type: "VAELoader",
        inputs: {
          vae_name: "ae.safetensors",
        },
      },
      "4": {
        class_type: "CLIPTextEncode",
        inputs: {
          text: "",
          clip: ["2", 0],
        },
      },
      "5": {
        class_type: "ConditioningZeroOut",
        inputs: {
          conditioning: ["4", 0],
        },
      },
      "6": {
        class_type: "EmptySD3LatentImage",
        inputs: {
          width: 1024,
          height: 1024,
          batch_size: 1,
        },
      },
      "7": {
        class_type: "ModelSamplingAuraFlow",
        inputs: {
          model: ["1", 0],
          shift: 3,
        },
      },
      "8": {
        class_type: "KSampler",
        inputs: {
          model: ["7", 0],
          seed: 0,
          steps: 8,
          cfg: 1,
          sampler_name: "res_multistep",
          scheduler: "simple",
          positive: ["4", 0],
          negative: ["5", 0],
          latent_image: ["6", 0],
          denoise: 1,
        },
      },
      "9": {
        class_type: "VAEDecode",
        inputs: {
          samples: ["8", 0],
          vae: ["3", 0],
        },
      },
      "10": {
        class_type: "SaveImage",
        inputs: {
          images: ["9", 0],
          filename_prefix: "comfy-sdk",
        },
      },
    },
  },
  {
    name: "image-to-video",
    description: "Animate a still image into a 3 second clip (Wan 2.2 5B, 1280x704).",
    output: "video",
    aliases: ["img2vid", "i2v"],
    inputs: [
      {
        name: "image",
        nodeId: "6",
        field: "image",
        description: 'the first frame: an asset from client.assets.fromFile("photo.png")',
        required: true,
      },
      {
        name: "prompt",
        nodeId: "4",
        field: "text",
        description: "what should happen in the video",
        default: "the camera slowly pushes in, gentle natural motion",
      },
      {
        name: "negative_prompt",
        nodeId: "5",
        field: "text",
        description: "what to keep out of it",
        default: "blurry, low quality, distorted, static, watermark, text",
      },
      {
        name: "seed",
        nodeId: "9",
        field: "seed",
        description: "random seed; pass one to make a run repeatable",
        randomSeed: true,
      },
      {
        name: "width",
        nodeId: "7",
        field: "width",
        description: "frame width in pixels",
        default: 1280,
      },
      {
        name: "height",
        nodeId: "7",
        field: "height",
        description: "frame height in pixels",
        default: 704,
      },
      {
        name: "frames",
        nodeId: "7",
        field: "length",
        description: "number of frames at 24 fps (4n+1, e.g. 49, 73, 121)",
        default: 73,
      },
    ],
    graph: {
      "1": {
        class_type: "UNETLoader",
        inputs: {
          unet_name: "wan2.2_ti2v_5B_fp16.safetensors",
          weight_dtype: "default",
        },
      },
      "2": {
        class_type: "CLIPLoader",
        inputs: {
          clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
          type: "wan",
          device: "default",
        },
      },
      "3": {
        class_type: "VAELoader",
        inputs: {
          vae_name: "wan2.2_vae.safetensors",
        },
      },
      "4": {
        class_type: "CLIPTextEncode",
        inputs: {
          text: "",
          clip: ["2", 0],
        },
      },
      "5": {
        class_type: "CLIPTextEncode",
        inputs: {
          text: "",
          clip: ["2", 0],
        },
      },
      "7": {
        class_type: "Wan22ImageToVideoLatent",
        inputs: {
          vae: ["3", 0],
          width: 1280,
          height: 704,
          length: 73,
          batch_size: 1,
          start_image: ["6", 0],
        },
      },
      "8": {
        class_type: "ModelSamplingSD3",
        inputs: {
          model: ["1", 0],
          shift: 8,
        },
      },
      "9": {
        class_type: "KSampler",
        inputs: {
          model: ["8", 0],
          seed: 0,
          steps: 20,
          cfg: 5,
          sampler_name: "uni_pc",
          scheduler: "simple",
          positive: ["4", 0],
          negative: ["5", 0],
          latent_image: ["7", 0],
          denoise: 1,
        },
      },
      "10": {
        class_type: "VAEDecode",
        inputs: {
          samples: ["9", 0],
          vae: ["3", 0],
        },
      },
      "11": {
        class_type: "CreateVideo",
        inputs: {
          images: ["10", 0],
          fps: 24,
        },
      },
      "12": {
        class_type: "SaveVideo",
        inputs: {
          video: ["11", 0],
          filename_prefix: "comfy-sdk",
          format: "auto",
          codec: "auto",
        },
      },
      "6": {
        class_type: "LoadImage",
        inputs: {
          image: "",
        },
      },
    },
  },
  {
    name: "text-to-video",
    description: "Generate a 3 second clip from a prompt (Wan 2.2 5B, 1280x704).",
    output: "video",
    aliases: ["txt2vid", "t2v"],
    inputs: [
      {
        name: "prompt",
        nodeId: "4",
        field: "text",
        description: "what should happen in the video",
        default: "a red fox trotting through fresh snow in a pine forest, morning",
      },
      {
        name: "negative_prompt",
        nodeId: "5",
        field: "text",
        description: "what to keep out of it",
        default: "blurry, low quality, distorted, static, watermark, text",
      },
      {
        name: "seed",
        nodeId: "9",
        field: "seed",
        description: "random seed; pass one to make a run repeatable",
        randomSeed: true,
      },
      {
        name: "width",
        nodeId: "7",
        field: "width",
        description: "frame width in pixels",
        default: 1280,
      },
      {
        name: "height",
        nodeId: "7",
        field: "height",
        description: "frame height in pixels",
        default: 704,
      },
      {
        name: "frames",
        nodeId: "7",
        field: "length",
        description: "number of frames at 24 fps (4n+1, e.g. 49, 73, 121)",
        default: 73,
      },
    ],
    graph: {
      "1": {
        class_type: "UNETLoader",
        inputs: {
          unet_name: "wan2.2_ti2v_5B_fp16.safetensors",
          weight_dtype: "default",
        },
      },
      "2": {
        class_type: "CLIPLoader",
        inputs: {
          clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
          type: "wan",
          device: "default",
        },
      },
      "3": {
        class_type: "VAELoader",
        inputs: {
          vae_name: "wan2.2_vae.safetensors",
        },
      },
      "4": {
        class_type: "CLIPTextEncode",
        inputs: {
          text: "",
          clip: ["2", 0],
        },
      },
      "5": {
        class_type: "CLIPTextEncode",
        inputs: {
          text: "",
          clip: ["2", 0],
        },
      },
      "7": {
        class_type: "Wan22ImageToVideoLatent",
        inputs: {
          vae: ["3", 0],
          width: 1280,
          height: 704,
          length: 73,
          batch_size: 1,
        },
      },
      "8": {
        class_type: "ModelSamplingSD3",
        inputs: {
          model: ["1", 0],
          shift: 8,
        },
      },
      "9": {
        class_type: "KSampler",
        inputs: {
          model: ["8", 0],
          seed: 0,
          steps: 20,
          cfg: 5,
          sampler_name: "uni_pc",
          scheduler: "simple",
          positive: ["4", 0],
          negative: ["5", 0],
          latent_image: ["7", 0],
          denoise: 1,
        },
      },
      "10": {
        class_type: "VAEDecode",
        inputs: {
          samples: ["9", 0],
          vae: ["3", 0],
        },
      },
      "11": {
        class_type: "CreateVideo",
        inputs: {
          images: ["10", 0],
          fps: 24,
        },
      },
      "12": {
        class_type: "SaveVideo",
        inputs: {
          video: ["11", 0],
          filename_prefix: "comfy-sdk",
          format: "auto",
          codec: "auto",
        },
      },
    },
  },
];

function key(name: string): string {
  return name.trim().toLowerCase().replaceAll("_", "-");
}

const BY_NAME = new Map<string, Example>(
  EXAMPLES.flatMap((ex) => [ex.name, ...ex.aliases].map((alias) => [key(alias), ex] as const)),
);

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
}

/** The example called `name` (case, `_` vs `-` and the short aliases are accepted). */
export function getExample(name: string): Example {
  const example = BY_NAME.get(key(name));
  if (example === undefined) {
    const names = EXAMPLES.map((ex) => ex.name).join(", ");
    throw new RangeError(`no example named ${JSON.stringify(name)}; available: ${names}`);
  }
  return example;
}

/** A fresh {@link Workflow} from `example`, with `values` applied over its defaults. */
export function buildExample(example: Example, values: Record<string, unknown> = {}): Workflow {
  const known = new Map(example.inputs.map((input) => [input.name, input]));
  const unknown = Object.keys(values)
    .filter((name) => !known.has(name))
    .sort();
  if (unknown.length > 0) {
    throw new RangeError(
      `example ${JSON.stringify(example.name)} has no input ${unknown.map((n) => JSON.stringify(n)).join(", ")}; ` +
        `its inputs are: ${[...known.keys()].join(", ")}`,
    );
  }
  const wf = new Workflow(structuredClone(example.graph));
  for (const input of example.inputs) {
    let value: unknown;
    if (Object.hasOwn(values, input.name)) {
      value = values[input.name];
    } else if (input.required) {
      throw new RangeError(
        `example ${JSON.stringify(example.name)} needs ${input.name} (${input.description})`,
      );
    } else {
      value = input.randomSeed ? randomSeed() : input.default;
    }
    wf.setInput(input.nodeId, input.field, value);
  }
  return wf;
}
