/**
 * `comfy.models` — the model-execution namespace.
 *
 * This release ships the namespace, its credential resolution and its
 * failure modes; the call itself does not run yet. `run` resolves a
 * credential ({@link resolveCredentials}) and raises
 * {@link MissingCredentials} locally when there is none — no request is
 * built and no socket is opened. With a credential in hand it raises
 * {@link ModelRunNotImplemented}, because the Comfy API v2 spec this SDK
 * generates its types from declares no model-execution operation yet and
 * the wire types must come from the spec rather than be hand-written.
 * `models.spec-contract.test.ts` fails as soon as such an operation lands,
 * which is the signal to replace this body.
 *
 * ```ts
 * import { comfy } from "@comfyorg/sdk";
 *
 * comfy.config({ credentials: "comfyui-..." });
 * await comfy.models.run("owner/model", { prompt: "a cat" });
 * ```
 *
 * To run a workflow graph today, use the class client instead:
 * `await new Comfy({ apiKey }).run(workflow)`.
 */

import { resolveCredentials } from "./credentials.js";
import { MissingCredentials, ModelRunNotImplemented } from "./exceptions.js";

/**
 * The `comfy.models` surface.
 *
 * `run`'s parameters are the minimum the credential gate needs and are
 * provisional: the executed shape is fixed by the spec's model-execution
 * operation, which does not exist yet, so nothing here hand-declares a wire
 * contract. `input` is passed through untouched (and, today, unused).
 */
export interface Models {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

async function run(model: string, input: Record<string, unknown>): Promise<unknown> {
  // Accepted and ignored until there is a route to send them to — keeping
  // them in the signature is what lets the credential gate be called the way
  // the real `run` will be.
  void model;
  void input;
  // Credentials first: the whole point of this gate is that a process with
  // none fails at the call site rather than on a round trip.
  if (resolveCredentials() === undefined) {
    throw new MissingCredentials(
      'no credentials configured — call comfy.config({ credentials: "comfyui-..." }) ' +
        "or set COMFY_API_KEY in the environment",
      { code: "missing_credentials" },
    );
  }
  throw new ModelRunNotImplemented(
    "comfy.models.run is not implemented in this release: the Comfy API v2 spec this SDK is " +
      "generated from declares no model-execution route. To run a workflow graph today, use " +
      "`await new Comfy({ apiKey }).run(workflow)`.",
    { code: "model_run_not_implemented" },
  );
}

/** The `comfy.models` namespace. Frozen — it is shared process-wide. */
export const models: Models = Object.freeze({ run });
