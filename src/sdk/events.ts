/**
 * Typed, discriminated (`switch (event.kind)`-able) streamed events.
 *
 * The raw SSE frames from `../low` (an event name + a data record) are
 * lifted into a small closed set of interfaces so callers can pattern-match:
 *
 * ```ts
 * for await (const event of job.events()) {
 *   switch (event.kind) {
 *     case "progress": ...
 *     case "outputReady": await event.output.toFile(...); break;
 *     case "statusChange": if (event.status === "succeeded") return;
 *   }
 * }
 * ```
 *
 * Named to match the Python SDK's `comfy_sdk.events` (`Progress`,
 * `Preview`, `OutputReady`, `StatusChange`, `Log`) with one deviation: the
 * union is `ComfyEvent`, not `Event` — `Event` is a global DOM/Node type.
 */

import type { RawEvent } from "../low/index.js";
import type { Output } from "./outputs.js";

export interface Progress {
  kind: "progress";
  value: number;
  message: string | null;
  nodesDone: number | null;
  nodesTotal: number | null;
  currentNode: string | null;
  currentNodeClass: string | null;
  step: number | null;
  steps: number | null;
}

export interface Preview {
  kind: "preview";
  nodeId: string;
  contentType: string;
  data: Uint8Array;
}

export interface OutputReady {
  kind: "outputReady";
  output: Output;
}

export interface StatusChange {
  kind: "statusChange";
  status: string;
  queuePosition: number | null;
}

export interface Log {
  kind: "log";
  level: string;
  message: string;
}

export type ComfyEvent = Progress | Preview | OutputReady | StatusChange | Log;

/**
 * A wire progress snapshot as the SDK's {@link Progress}. Shared by the
 * `progress` frames of `job.events()` and `job.progress`, so a snapshot read
 * off a handle and one received live are the same type.
 */
export function progressFrom(data: Record<string, unknown>): Progress {
  return {
    kind: "progress",
    value: typeof data.value === "number" ? data.value : 0,
    message: (data.message as string | null | undefined) ?? null,
    nodesDone: (data.nodes_done as number | null | undefined) ?? null,
    nodesTotal: (data.nodes_total as number | null | undefined) ?? null,
    currentNode: (data.current_node as string | null | undefined) ?? null,
    currentNodeClass: (data.current_node_class as string | null | undefined) ?? null,
    step: (data.step as number | null | undefined) ?? null,
    steps: (data.steps as number | null | undefined) ?? null,
  };
}

function previewFrom(data: Record<string, unknown>): Preview {
  const raw = typeof data.data_base64 === "string" ? data.data_base64 : "";
  let decoded: Uint8Array;
  try {
    decoded = Uint8Array.from(Buffer.from(raw, "base64"));
  } catch {
    decoded = new Uint8Array(0);
  }
  return {
    kind: "preview",
    nodeId: typeof data.node_id === "string" ? data.node_id : "",
    contentType:
      typeof data.content_type === "string" ? data.content_type : "application/octet-stream",
    data: decoded,
  };
}

function statusFrom(data: Record<string, unknown>): StatusChange {
  return {
    kind: "statusChange",
    status: typeof data.status === "string" ? data.status : "",
    queuePosition: (data.queue_position as number | null | undefined) ?? null,
  };
}

function logFrom(data: Record<string, unknown>): Log {
  return {
    kind: "log",
    level: typeof data.level === "string" ? data.level : "info",
    message: typeof data.message === "string" ? data.message : "",
  };
}

/**
 * Lift a raw SSE frame into a typed event. `bindOutput` wraps the
 * low-level output model into an SDK `Output` (the only event type that
 * needs the transport, for download). Unknown event names return `null` so
 * the iterator can skip them.
 */
export function eventFromRaw(
  raw: RawEvent,
  bindOutput: (model: Record<string, unknown>) => Output,
): ComfyEvent | null {
  switch (raw.event) {
    case "progress":
      return progressFrom(raw.data);
    case "preview":
      return previewFrom(raw.data);
    case "status":
      return statusFrom(raw.data);
    case "log":
      return logFrom(raw.data);
    case "output":
      return { kind: "outputReady", output: bindOutput(raw.data) };
    default:
      return null;
  }
}
