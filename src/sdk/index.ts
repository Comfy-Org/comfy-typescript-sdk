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
  COMFY_ROUTER_BASE_URL,
  CREDENTIALS_ENV_VAR,
  resolveBaseUrl,
  resolveCredentials,
  ROUTER_BASE_URL_ENV_VAR,
  type ComfyConfig,
} from "./credentials.js";
export {
  DEFAULT_RUN_TIMEOUT_MS,
  ERROR_TYPE_HEADER,
  models,
  REQUEST_ID_HEADER,
  type Models,
  type RunOptions,
  type RunResult,
} from "./models.js";
export {
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_BUDGET_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  type RetryOptions,
} from "./retry.js";
export { Asset, AssetFactory } from "./assets.js";
export { Workflow, WorkflowFactory, type WorkflowGraph } from "./workflows.js";
export { Job, JobFactory } from "./jobs.js";
export { Output } from "./outputs.js";
export type { ComfyEvent, Log, OutputReady, Preview, Progress, StatusChange } from "./events.js";
export {
  BlobNotFound,
  ComfyError,
  type ComfyErrorOptions,
  Forbidden,
  HashMismatch,
  IdempotencyKeyReuse,
  InsufficientCredits,
  InvalidWorkflow,
  JobFailed,
  MissingAsset,
  MissingCredentials,
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
 * three of the fifteen names (`Unauthorized`, `Forbidden`,
 * `InsufficientCredits`) are already taken here by the workflow-API
 * exceptions, which descend from `ComfyError`. See `./routerErrors.ts`.
 */
export * as routerErrors from "./routerErrors.js";
