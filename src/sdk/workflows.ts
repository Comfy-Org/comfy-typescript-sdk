/**
 * Workflow construction and mutation.
 *
 * A {@link Workflow} is a thin, local wrapper over the raw API-format
 * graph. The graph stays a freely-mutable object (`wf.json`); `setInput` is
 * sugar for `wf.json[node].inputs[field] = value` that also accepts an
 * asset handle (substituted into a `core/ASSET` object at submit time).
 * Construction does no network I/O in v1. Mirrors `comfy_sdk.workflows` in
 * the Python SDK.
 */

import { readFile } from "node:fs/promises";

export type WorkflowGraph = Record<string, unknown>;

/**
 * An API-format ComfyUI graph, ready to submit.
 *
 * Build one through `client.workflows` rather than constructing it directly.
 * This is the API format produced by "Save (API Format)" — not the UI format,
 * which the SDK rejects locally with `WorkflowFormatUi` before any request is
 * made. The raw graph stays readable and mutable as
 * {@link Workflow.json}.
 */
export class Workflow {
  json: WorkflowGraph;

  constructor(graph: WorkflowGraph) {
    this.json = graph;
  }

  /**
   * Set `node.inputs.field`. `value` may be a plain JSON value or an asset
   * handle; handles are substituted into `core/ASSET` objects when the
   * workflow is submitted. An asset handle may only be set on an input that
   * takes a filename (a loader node's file widget); it cannot be set on an
   * IMAGE/VIDEO/AUDIO socket.
   */
  setInput(nodeId: string, field: string, value: unknown): void {
    const node = (this.json[nodeId] ??= {}) as Record<string, unknown>;
    const inputs = (node.inputs ??= {}) as Record<string, unknown>;
    inputs[field] = value;
  }
}

/**
 * `client.workflows` — alternative constructors for {@link Workflow}.
 * Namespaced on the client (rather than free-standing) because
 * construction is expected to become client-bound once server-side
 * subgraphs land; in v1 it is purely local.
 */
export class WorkflowFactory {
  /** Read and parse an API-format workflow from a JSON file on disk. */
  async fromFile(path: string): Promise<Workflow> {
    const text = await readFile(path, "utf-8");
    return new Workflow(JSON.parse(text) as WorkflowGraph);
  }

  /** Wrap an already-parsed graph object. The object is used as-is, not copied. */
  fromJson(graph: WorkflowGraph): Workflow {
    return new Workflow(graph);
  }

  /** Parse an API-format workflow from a JSON string. */
  fromString(text: string): Workflow {
    return new Workflow(JSON.parse(text) as WorkflowGraph);
  }
}
