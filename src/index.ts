/**
 * Comfy SDK — the idiomatic TypeScript client for the Comfy API v2.
 *
 * Runs an API-format workflow against any Comfy API v2 surface (self-hosted
 * ComfyUI through `comfy-api-proxy`, Comfy Cloud, or a serverless
 * deployment) — the only per-surface difference is the `COMFY_BASE_URL`
 * environment variable and an optional key. This is the `sdk` (idiomatic) layer; the generated
 * types/validators + thin transport live under `@comfyorg/sdk/low` for
 * advanced/escape-hatch use. Behaviorally mirrors the Python SDK
 * (`Comfy-Org/comfy-python-sdk`), collapsed to one async client (JS is
 * async-native — no sync/async split).
 *
 * ```ts
 * import { Comfy } from "@comfyorg/sdk";
 *
 * const client = new Comfy({ apiKey: "..." }); // Comfy Cloud
 * // COMFY_BASE_URL=http://127.0.0.1:8189 targets a local proxy instead
 *
 * const wf = await client.workflows.fromFile("workflow_api.json");
 * const asset = client.assets.fromFile("photo.png"); // lazy; uploaded on use
 * wf.setInput("10", "image", asset);
 *
 * const job = await client.run(wf);
 * await job.getOutputs("13")[0].toFile("out.png");
 * ```
 */

export * from "./sdk/index.js";
