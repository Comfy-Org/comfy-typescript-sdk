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

import { ApiError } from "../low/index.js";
import type {
  ComfyLow,
  Job as LowJob,
  JobLogs as LowJobLogs,
  JobWorkflowResult,
  Output as LowOutput,
} from "../low/index.js";
import { abortableSleep } from "./abortable-sleep.js";
import { backoffSchedule, isTerminal, SUCCESS } from "./core.js";
import { eventFromRaw, type ComfyEvent, type StatusChange } from "./events.js";
import { JobFailed, toSdkError, translate } from "./exceptions.js";
import { Output } from "./outputs.js";

/**
 * What a run printed — the resolved form of {@link Job.getLogs}.
 *
 * Untrusted text: a workflow chooses what goes in it, so render `text` as
 * plain text rather than interpreting it.
 *
 * `truncated` says the BEGINNING was discarded and this is the tail of a
 * longer run, which is where a failure normally is. It describes the stored
 * log, not the response, so it never means a caller asked for part of one;
 * `truncated` with an empty `text` means the log was captured and then shed
 * entirely to fit, which is not the same as never having had one.
 *
 * `complete` says no more output will be appended. Always true today, because
 * a log is read back off the worker once, when the run ends.
 */
export type JobLogs = Readonly<{
  text: string;
  truncated: boolean;
  capturedAt: Date;
  complete: boolean;
}>;

function toJobLogs(raw: LowJobLogs): JobLogs {
  return {
    text: raw.text,
    truncated: raw.truncated,
    capturedAt: new Date(raw.captured_at),
    complete: raw.complete,
  };
}

// Pause before reconnecting an SSE stream that dropped mid-job, without a
// terminal frame having been seen.
const RECONNECT_PAUSE_MS = 100;
// Match submit()'s fallback when a 429 omits a usable Retry-After value.
const DEFAULT_429_RECONNECT_PAUSE_MS = 2_000;
// Ceiling on a server-supplied 429 Retry-After used as the reconnect pause —
// this loop has no overall deadline of its own (only an optional caller
// signal), so an unbounded value from a malicious/misbehaving server would
// otherwise stall reconnection indefinitely.
const MAX_RECONNECT_PAUSE_MS = 60_000;

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

  /** Last known status — `queued`, `running`, `canceling`, `succeeded`, `canceled`, `failed`, `expired`. Reflects the most recent fetch, not necessarily the server's current state. */
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
   * Fetch what this run printed via `GET /api/v2/jobs/{id}/logs`, or `null`
   * if there is no log to fetch.
   *
   * Fetched on demand and never cached: {@link Job.wait} and
   * {@link Comfy.run} download no log, and a second call re-reads rather than
   * replaying the first, so an early `null` on a job that had not finished
   * cannot mask the log it went on to produce.
   *
   * `null` is every reason there is nothing to read, which the contract
   * deliberately does not distinguish: this deployment does not capture logs
   * at all (Comfy Cloud and self-hosted never do), the job has not finished,
   * it predates log capture, the run was killed before the worker could report
   * an outcome (an out-of-memory kill, a crashed worker, a timeout, a job past
   * its maximum runtime), capture was attempted and failed, or the job ran on
   * the public demo deployment, which captures a log but withholds it from
   * anonymous callers. Do not branch on which — but a job that has not
   * finished may have a log once it has, so a caller that wants one calls
   * again after a terminal status.
   *
   * The killed-run case is a known gap rather than an oversight: a log is read
   * back off the worker, so a run the platform killed never produced one. The
   * failures a caller most wants a log for are the ones least likely to have
   * left one.
   *
   * On a surface that offers a logs link, a missing job still rejects with the
   * usual {@link NotFound}. Where there is no link there is no request, so a
   * job that has expired or never existed resolves `null` too — the answer
   * "this deployment has no logs" is reached without asking about the job.
   */
  async getLogs(signal?: AbortSignal): Promise<JobLogs | null> {
    const url = this.model.urls.logs;
    // No link means the surface serves no logs for any job, so the answer is
    // known without a request. Never synthesized: the URL is the surface's to
    // give, and building one here would turn a deployment that cannot answer
    // into a 404 that looks like a missing job. Falsy, not `=== undefined`: a
    // server that serializes an absent optional link as "" rather than
    // omitting it would otherwise reach the transport and have `/jobs//logs`
    // built for it, which is that same 404.
    if (!url) return null;
    const raw = await translate(() => this.low.getJobLogs(url, { signal }));
    return raw === null ? null : toJobLogs(raw);
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
      let reconnectPauseMs: number = RECONNECT_PAUSE_MS;
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
        if (exc instanceof ApiError) {
          // 501 means this deployment doesn't serve live SSE. End the
          // iterator; callers can use wait() to poll for completion.
          if (exc.httpStatus === 501) return;
          if (exc.httpStatus === 429) {
            const retryAfterMs =
              exc.retryAfter === null ? DEFAULT_429_RECONNECT_PAUSE_MS : exc.retryAfter * 1000;
            reconnectPauseMs = Math.min(retryAfterMs, MAX_RECONNECT_PAUSE_MS);
          } else {
            throw toSdkError(exc);
          }
        }
        // Connection dropped mid-stream (or the server returned 429) — reconnect below.
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
      await abortableSleep(reconnectPauseMs, signal);
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
