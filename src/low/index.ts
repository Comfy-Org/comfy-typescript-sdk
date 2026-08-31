/**
 * `low` — generated types/validators + thin hand-written transport for
 * Comfy API v2. Mirrors the two-part split of `comfy_low` in the Python
 * SDK:
 *
 * - generated (`./generated/types.gen.ts`, `./generated/zod.gen.ts`) —
 *   TypeScript types and Zod schemas produced by `@hey-api/openapi-ts` from
 *   `spec/openapi.yaml` (`pnpm generate`; do not hand-edit).
 * - hand-written (`./transport.ts`, `./errors.ts`, `./sse.ts`, `./models.ts`)
 *   — the transport and the handful of schemas codegen can't reach (see
 *   `./models.ts`).
 *
 * This layer is deliberately boring: no orchestration, retries, hashing, or
 * SSE reconnection. Those live in `../sdk`.
 */

export * from "./generated/types.gen.js";
export * as schemas from "./generated/zod.gen.js";
export * from "./models.js";
export * from "./errors.js";
export { type RawEvent, iterateSse } from "./sse.js";
export {
  buildUserAgent,
  ComfyLow,
  OPERATION_IDS,
  OPERATION_METHODS,
  type ComfyLowOptions,
  type RequestOptions,
  type AssetContentUrl,
  type JobWorkflowFormat,
  type JobWorkflowResult,
} from "./transport.js";
