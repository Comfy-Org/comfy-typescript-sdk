/**
 * Sans-IO core shared across the `sdk` layer.
 *
 * Pure decision logic — no network, no awaiting — for terminal-state
 * detection, adaptive poll backoff, idempotency-key minting, the
 * `core/ASSET` reference shape, and the workflow-graph walk that finds and
 * substitutes asset handles. Mirrors `comfy_sdk._core` in the Python SDK.
 */

import type { AssetReference } from "../low/index.js";

// Terminal job states. `canceling` is deliberately NOT terminal —
// cancellation takes effect at node/step boundaries and can take seconds.
export const TERMINAL = new Set(["succeeded", "canceled", "failed", "expired"]);
export const SUCCESS = "succeeded";

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function isTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

/** Adaptive poll intervals (ms): start small, grow, then hold at the cap. */
export function* backoffSchedule(
  start = 500,
  factor = 1.5,
  cap = 5_000,
): Generator<number, never, void> {
  let delay = start;
  for (;;) {
    yield delay;
    delay = Math.min(delay * factor, cap);
  }
}

/** Build the `core/ASSET` object substituted into workflow JSON. */
export function assetReference(
  assetId: string,
  options: { hash?: string | null; filePath?: string | null } = {},
): AssetReference {
  const info: AssetReference["info"] = { id: assetId };
  if (options.hash) info.hash = options.hash;
  if (options.filePath) info.file_path = options.filePath;
  return { __type: "core/ASSET", info };
}

// A unique marker so `findAssetHandles`/`substituteAssetHandles` can spot an
// asset handle embedded anywhere in a workflow graph without importing
// `Asset` here (avoids a core <-> assets circular import).
export const ASSET_HANDLE = Symbol("comfy.assetHandle");

export interface AssetHandleLike {
  readonly [ASSET_HANDLE]: true;
  asReference(signal?: AbortSignal): Promise<AssetReference>;
}

function isAssetHandle(value: unknown): value is AssetHandleLike {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[ASSET_HANDLE] === true
  );
}

/** Collect every asset handle embedded anywhere in the workflow graph. */
export function findAssetHandles(graph: unknown): AssetHandleLike[] {
  if (isAssetHandle(graph)) return [graph];
  if (Array.isArray(graph)) return graph.flatMap(findAssetHandles);
  if (graph !== null && typeof graph === "object") {
    return Object.values(graph as Record<string, unknown>).flatMap(findAssetHandles);
  }
  return [];
}

/**
 * Return a copy of `graph` with each asset handle replaced by its
 * `core/ASSET` reference, keyed by identity in `refs`.
 */
export function substituteAssetHandles(
  graph: unknown,
  refs: Map<AssetHandleLike, AssetReference>,
): unknown {
  if (isAssetHandle(graph)) {
    const ref = refs.get(graph);
    if (!ref) throw new Error("asset handle was not materialized before substitution");
    return ref;
  }
  if (Array.isArray(graph)) {
    return graph.map((v) => substituteAssetHandles(v, refs));
  }
  if (graph !== null && typeof graph === "object") {
    return Object.fromEntries(
      Object.entries(graph as Record<string, unknown>).map(([k, v]) => [
        k,
        substituteAssetHandles(v, refs),
      ]),
    );
  }
  return graph;
}

// UI-export detection: the ComfyUI editor export carries these top-level
// keys, whereas the API format is a flat node-id -> node map. Catching it
// locally lets the SDK fail fast with a clear message instead of relying
// only on the server.
const UI_KEYS = ["nodes", "links", "last_node_id"] as const;

export function looksLikeUiFormat(graph: unknown): boolean {
  if (graph === null || typeof graph !== "object" || Array.isArray(graph)) return false;
  const record = graph as Record<string, unknown>;
  return UI_KEYS.every((key) => key in record);
}
