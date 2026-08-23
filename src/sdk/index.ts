/**
 * `sdk` — the idiomatic, hand-written layer integrators import (the
 * package's default export surface, re-exported from the package root).
 * Mirrors `comfy_sdk`'s `__init__.py` in the Python SDK, minus the
 * sync/async duplication (JS is async-native).
 */

export { Comfy, BASE_URL_ENV_VAR, COMFY_CLOUD_BASE_URL, type ComfyOptions } from "./client.js";
export { comfy } from "./comfy.js";
export {
  config,
  CREDENTIALS_ENV_VAR,
  resolveCredentials,
  type ComfyConfig,
} from "./credentials.js";
export { models, type Models } from "./models.js";
export { Asset, AssetFactory } from "./assets.js";
export { Workflow, WorkflowFactory, type WorkflowGraph } from "./workflows.js";
export { Job, JobFactory } from "./jobs.js";
export { Output } from "./outputs.js";
export type { ComfyEvent, Log, OutputReady, Preview, Progress, StatusChange } from "./events.js";
export {
  BlobNotFound,
  ComfyError,
  Forbidden,
  HashMismatch,
  IdempotencyKeyReuse,
  InsufficientCredits,
  InvalidWorkflow,
  JobFailed,
  MissingAsset,
  MissingCredentials,
  ModelRunNotImplemented,
  NotFound,
  QueueFull,
  Unauthorized,
  WorkflowFormatUi,
} from "./exceptions.js";

/**
 * `routerErrors` — the typed exceptions for the Comfy Router error contract
 * (`comfy.models.run`), one class per `error_type`, all descending from
 * `routerErrors.RouterError`. Also reachable as `@comfyorg/sdk/errors`.
 *
 * They are namespaced rather than flattened into the exports above because
 * three of the eleven names (`Unauthorized`, `Forbidden`,
 * `InsufficientCredits`) are already taken here by the workflow-API
 * exceptions, which descend from `ComfyError`. See `./routerErrors.ts`.
 */
export * as routerErrors from "./routerErrors.js";
