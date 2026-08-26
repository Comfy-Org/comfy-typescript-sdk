/**
 * `comfy` — the module-level namespace, configured once per process.
 *
 * Two import styles reach the same members, so either of the shapes an
 * integrator is likely to already have in their editor works:
 *
 * ```ts
 * import { comfy } from "@comfyorg/sdk";
 * comfy.config({ credentials: "comfyui-..." });
 * await comfy.models.run("owner/model", { prompt: "a cat" });
 * ```
 *
 * ```ts
 * import * as comfy from "@comfyorg/sdk";
 * comfy.config({ credentials: "comfyui-..." });
 * ```
 *
 * The namespace holds functions only — never the credential itself, which
 * lives in a module-private binding in `./credentials.ts`. That is what
 * makes `JSON.stringify(comfy)` and `console.log(comfy)` safe to paste into
 * a bug report.
 *
 * This is additive: `new Comfy({ apiKey })` is untouched and still resolves
 * its key per instance.
 */

import { config } from "./credentials.js";
import { models } from "./models.js";

/** The module-level `comfy` namespace. Frozen — it is shared process-wide. */
export const comfy = Object.freeze({ config, models });
