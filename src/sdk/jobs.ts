/**
 * Job handles — the resumable, poll-authoritative core of the SDK.
 *
 * A {@link Job} is rehydratable purely from its ID. `wait` polls
 * `GET /api/v2/jobs/{id}` with adaptive backoff as the source of truth for
 * terminal status and outputs, so a stream that is throttled, dropped, or
 * permanently unavailable never stalls completion. `events` is the live SSE
 * stream on top: typed, auto-reconnecting (no replay — the stream carries
 * no cursor), with the poll path as its backstop. Mirrors `comfy_sdk.jobs`
 * in the Python SDK — one async class since JS is async-native.
 */

import type {
  ComfyLow,
  Job as LowJob,
  JobWorkflowResult,
  Output as LowOutput,
} from "../low/index.js";
import { abortableSleep } from "./abortable-sleep.js";
import { backoffSchedule, isTerminal, SUCCESS } from "./core.js";
import { eventFromRaw, type ComfyEvent, type StatusChange } from "./events.js";
import { JobFailed, translate } from "./exceptions.js";
import { Output } from "./outputs.js";

// Pause before reconnecting an SSE stream that dropped mid-job, without a
// terminal frame having been seen.
const RECONNECT_PAUSE_MS = 100;

/**
 * A handle to one submitted job — rehydratable from its ID alone via
 * `client.jobs.get(id)`.
 *
 * Every accessor reads the state currently on the handle; nothing re-fetches
 * implicitly. {@link Job.wait} or {@link Job.result} advances it to a
 * terminal state, {@link Job.refresh} pulls fresh state once, and
 * {@link Job.events} streams live progress.
 */
export class Job {
  private readonly low: ComfyLow;
  private model: LowJob;

  constructor(low: ComfyLow, model: LowJob) {
    this.low = low;
    this.model = model;
  }

  /** Server-assigned job ID. Enough on its own to rebuild this handle later. */
  get id(): string {
    return this.model.id;
  }

  /** Last known status — `queued`, `running`, `succeeded`, `canceled`, `failed`, `expired`. Reflects the most recent fetch, not necessarily the server's current state. */
  get status(): string {
    return this.model.status;
  }

  /** Every output across all nodes. Empty until the job succeeds. */
  get outputs(): Output[] {
    return this.model.outputs.map((o) => this.bindOutput(o));
  }

  /** Failure detail when the job ended `failed`, otherwise `null`. */
  get error(): LowJob["error"] {
    return this.model.error;
  }

  /**
   * The outputs produced by one node, in server order.
   *
   * Reads state already on this handle — it does not re-fetch, so await
   * {@link Job.result} or {@link Job.wait} first. An unknown `nodeId`, or a
   * node that produced nothing, gives an empty array rather than throwing.
   */
  getOutputs(nodeId: string): Output[] {
    return this.model.outputs.filter((o) => o.node_id === nodeId).map((o) => this.bindOutput(o));
  }

  private bindOutput(model: LowOutput): Output {
    return new Output(model, this.low);
  }

  /** Poll `GET /api/v2/jobs/{id}` once and adopt the fresh state. */
  async refresh(signal?: AbortSignal): Promise<this> {
    this.model = await translate(() =>
      this.low.getJob(this.model.urls.self || this.model.id, { signal }),
    );
    return this;
  }

  /** Poll to a terminal state (adaptive backoff). Rejects with a
   * `TimeoutError` if `timeoutMs` elapses first, or immediately if `signal`
   * aborts — the abort interrupts the backoff wait itself, not just the
   * in-flight poll request. */
  async wait(timeoutMs?: number, signal?: AbortSignal): Promise<this> {
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    const backoff = backoffSchedule();
    for (;;) {
      await this.refresh(signal);
      if (isTerminal(this.status)) return this;
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error(`job ${this.id} not terminal after ${timeoutMs}ms (status=${this.status})`);
      }
      await abortableSleep(backoff.next().value, signal);
    }
  }

  /** Wait for terminal, then throw `JobFailed` unless it succeeded. */
  async result(signal?: AbortSignal): Promise<this> {
    await this.wait(undefined, signal);
    if (this.status !== SUCCESS) {
      throw new JobFailed(`job ${this.id} ended ${this.status}`, { error: this.model.error });
    }
    return this;
  }

  /**
   * Ask the server to cancel, and adopt the state it returns.
   *
   * Cancellation is a request, not a guarantee: a job that already reached a
   * terminal state stays in it, so check {@link Job.status} afterwards rather
   * than assuming the job stopped.
   */
  async cancel(signal?: AbortSignal): Promise<this> {
    this.model = await translate(() =>
      this.low.cancelJob(this.model.urls.cancel || this.model.id, { signal }),
    );
    return this;
  }

  /**
   * Fetch the graph that produced this job via
   * `GET /api/v2/jobs/{id}/workflow`.
   *
   * **Depends on a server endpoint currently in review.** Until it ships,
   * expect a 404 from the server (surfaced as this SDK's usual `NotFound`)
   * rather than a working response — see `low.getJobWorkflow`, which is
   * hand-written for the same reason (the spec doesn't know this operation
   * yet).
   *
   * `format` tells you which shape you got: `"api"` is the executed graph,
   * with frontend-only constructs (Note nodes, Get/Set) already resolved
   * away. `"save"` is the authoring workflow at the version the job ran,
   * un-mangled — only returned for a job that pinned a workflow version; a
   * job submitted through this SDK today always gets `"api"`.
   */
  async getWorkflow(signal?: AbortSignal): Promise<JobWorkflowResult> {
    return translate(() => this.low.getJobWorkflow(this.model.id, { signal }));
  }

  /**
   * Typed live event iterator. Auto-reconnects with no replay; falls back
   * to polling to detect terminal status if the stream ends early. An
   * aborted `signal` stops both the current SSE connection/poll and the
   * pause between reconnect attempts.
   */
  async *events(signal?: AbortSignal): AsyncGenerator<ComfyEvent, void, void> {
    const eventsUrl = this.model.urls.events || this.model.id;
    // Progress is monotonic across the whole stream, reconnects included: a
    // frame whose value regresses (e.g. a lower value replayed by the server
    // after a mid-stream drop) is suppressed so a consumer's progress never
    // goes backwards.
    let lastProgress = Number.NEGATIVE_INFINITY;
    for (;;) {
      let terminalSeen = false;
      try {
        for await (const raw of this.low.getJobEvents(eventsUrl, { signal })) {
          const event = eventFromRaw(raw, (data) => this.bindOutput(data as unknown as LowOutput));
          if (event === null) continue;
          if (event.kind === "progress") {
            if (event.value < lastProgress) continue;
            lastProgress = event.value;
          }
          if (event.kind === "statusChange" && isTerminal(event.status)) {
            terminalSeen = true;
            yield event;
            return;
          }
          yield event;
        }
      } catch (exc) {
        // A caller abort must propagate (and stop the loop), not be
        // swallowed as an ordinary mid-stream drop.
        if (signal?.aborted) throw exc;
        // Connection dropped mid-stream — reconnect below.
      }
      if (terminalSeen) return;
      // Stream ended without a terminal frame. Poll the authoritative
      // state: stop if already terminal, else reconnect for fresh frames.
      await this.refresh(signal);
      if (isTerminal(this.status)) {
        const statusChange: StatusChange = {
          kind: "statusChange",
          status: this.status,
          queuePosition: null,
        };
        yield statusChange;
        return;
      }
      await abortableSleep(RECONNECT_PAUSE_MS, signal);
    }
  }
}

/**
 * Rebuilds {@link Job} handles from an ID. Reached as `client.jobs`.
 */
export class JobFactory {
  private readonly low: ComfyLow;

  constructor(low: ComfyLow) {
    this.low = low;
  }

  /**
   * Fetch a job by ID and wrap it in a fresh handle — the resume path for a
   * job submitted by another process, or in an earlier run.
   */
  async get(jobId: string): Promise<Job> {
    return new Job(this.low, await translate(() => this.low.getJob(jobId)));
  }
}
