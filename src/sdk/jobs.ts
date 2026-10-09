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

import { ApiError, sseErrorFromFrame } from "../low/index.js";
import type {
  ComfyLow,
  Job as LowJob,
  JobListItem,
  JobLogs,
  JobMetadata,
  JobWorkflowResult,
  Output as LowOutput,
} from "../low/index.js";
import { abortableSleep } from "./abortable-sleep.js";
import { backoffSchedule, isTerminal, SUCCESS } from "./core.js";
import {
  eventFromRaw,
  progressFrom,
  type ComfyEvent,
  type Progress,
  type StatusChange,
} from "./events.js";
import { ComfyError, JobFailed, toSdkError, translate } from "./exceptions.js";
import { Output } from "./outputs.js";

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
 * A nullable wire timestamp as a `Date`, keeping "no timestamp" as `null`.
 *
 * Absent counts as none: the field is required-but-nullable on the wire, so a
 * server that omits it rather than sending `null` must not read as
 * `new Date(undefined)`, which is an `Invalid Date` that compares false
 * against everything instead of announcing itself.
 *
 * Unusable counts as none too. The transport hands responses back as
 * `JSON.parse(text) as T` with no runtime validation, so a non-string or an
 * unparseable string can reach here — and an `Invalid Date` built from one is
 * truthy, so it would pass the `if (job.startedAt && job.completedAt)` guard
 * the README documents and turn the subtraction behind it into `NaN`. That is
 * the same silent-false failure the nullish branch exists to prevent, so it
 * gets the same answer.
 */
function toDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A required, non-nullable wire timestamp as a `Date`.
 *
 * `created_at` and `expires_at` are required AND non-nullable in the
 * contract, so unlike {@link toDate}'s fields there is no "none" for them to
 * mean — absent, `null`, or unparseable is a response that breaks the
 * contract, and nothing validates it on the way in. Say so instead of
 * handing back a `Date` that lies: `new Date(undefined)` is an `Invalid Date`
 * whose every comparison is false, and `new Date(null)` is the Unix epoch, so
 * a retention check against one reads a live job as having expired in 1970.
 */
function requireDate(value: unknown, field: string, jobId: string): Date {
  const date = toDate(value);
  if (date === null) {
    throw new ComfyError(
      `job ${jobId} returned ${field}=${JSON.stringify(value) ?? "undefined"} where the contract requires a timestamp`,
      { code: "unexpected_response" },
    );
  }
  return date;
}

/**
 * A handle to one submitted job — rehydratable from its ID alone via
 * `client.jobs.get(id)`.
 *
 * Every accessor reads the state currently on the handle; nothing re-fetches
 * implicitly. {@link Job.wait} or {@link Job.result} advances it to a
 * terminal state, {@link Job.refresh} pulls fresh state once, and
 * {@link Job.events} streams live progress. Three object-valued accessors
 * ({@link Job.progress}, {@link Job.metrics}, {@link Job.urls}) hand back a
 * snapshot copy, so editing what you get back cannot rewrite the handle's own
 * state — notably the links it polls and cancels through. {@link Job.error}
 * is the exception: it hands back the handle's own object by reference, which
 * is also the one {@link Job.result} embeds in the {@link JobFailed} it
 * throws, so treat it as read-only.
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

  /** When the server accepted this job. Set for every job, from submit onwards. */
  get createdAt(): Date {
    return requireDate(this.model.created_at, "created_at", this.model.id);
  }

  /** When the job started executing, or `null` while it is still queued. */
  get startedAt(): Date | null {
    return toDate(this.model.started_at);
  }

  /**
   * When the job reached a terminal state, or `null` before it did.
   *
   * With {@link Job.startedAt} this is how long the run took:
   * `job.completedAt.getTime() - job.startedAt.getTime()`.
   */
  get completedAt(): Date | null {
    return toDate(this.model.completed_at);
  }

  /** Retention deadline — after this the job and its outputs are gone. A platform property, not an API constant. */
  get expiresAt(): Date {
    return requireDate(this.model.expires_at, "expires_at", this.model.id);
  }

  /**
   * Latest progress snapshot the handle holds, or `null` when the state it
   * holds carries none.
   *
   * A snapshot is complete in itself — one fully re-syncs a consumer. The
   * contract says a poll returns the latest one, but Comfy Cloud has been
   * reported to send `null` here even for a running job, so `null` means
   * "this state carries no snapshot" rather than "not running" — take live
   * progress from {@link Job.events}.
   *
   * The same {@link Progress} the `progress` frames of {@link Job.events}
   * carry, so a snapshot read off the handle and one received live are one
   * type — matching `Job.progress` in the Python SDK.
   */
  get progress(): Progress | null {
    const progress = this.model.progress;
    // Absent reads as none, not as an empty snapshot: lifting `undefined`
    // would hand back a `Progress` whose `value` and `nodesTotal` were never
    // sent, and a percentage computed off those is meaningless.
    return progress == null ? null : progressFrom(progress as Record<string, unknown>);
  }

  /** Place in the queue as of the state this handle holds, or `null` when the server reports none. */
  get queuePosition(): number | null {
    // Required-but-nullable, so a server that drops the key rather than
    // sending `null` still means "none". Returning it verbatim would hand
    // back `undefined` through a declared `number | null`, so a caller's
    // `job.queuePosition !== null` guard passes and the value goes on into
    // arithmetic as `NaN`.
    return this.model.queue_position ?? null;
  }

  /** Per-run measurements keyed by name (e.g. `queue_ms`, `execution_ms`), or `undefined` on a surface that reports none. A value is `null` until that metric is available. */
  get metrics(): LowJob["metrics"] {
    const metrics = this.model.metrics;
    // `undefined` is how this SDK says "this surface measures nothing"; a
    // server that says so with `null` means the same thing and must not read
    // as an empty-but-present `{}`.
    return metrics == null ? undefined : { ...metrics };
  }

  /** The job's own links — `self`, `events`, `cancel`, and `logs` on a surface that captures logs. Follow these rather than building paths from {@link Job.id}. */
  get urls(): LowJob["urls"] {
    const urls = this.model.urls;
    // Required and non-nullable, and the one accessor whose absence cannot be
    // softened into "none": spreading an absent one yields a `{}` typed as a
    // full `JobUrls`, so `job.urls.self` would be `undefined` while the type
    // promises a string — and a caller told to follow these rather than build
    // paths would fetch that `undefined`.
    if (urls == null) {
      throw new ComfyError(
        `job ${this.model.id} returned no urls where the contract requires them`,
        { code: "unexpected_response" },
      );
    }
    return { ...urls };
  }

  /** The labels attached at submit. An empty object when the job has none. */
  get metadata(): JobMetadata {
    return readMetadata((this.model as LowJob & { metadata?: unknown }).metadata);
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
   * What the run printed, via `GET /api/v2/jobs/{id}/logs` — or `null` when
   * this job has no log.
   *
   * `null` is the ordinary answer, not a failure, and it does not say why:
   * the surface captures no logs (Comfy Cloud today), the job has not
   * finished, the run was killed before the worker could report one, or the
   * log is withheld. Read it after a terminal status: a job still running may
   * have one once it finishes, and a `null` read after that is final. Follows
   * the job's own `urls.logs` link, and returns `null` without a request when
   * the server offers none — that is the surface saying it captures no logs
   * for any job. The text is untrusted workflow output: render it as plain
   * text, never interpret it. `truncated` means the beginning was shed and
   * `text` is the tail of a longer run.
   */
  async getLogs(signal?: AbortSignal): Promise<JobLogs | null> {
    const link = this.model.urls.logs;
    if (link === undefined) return null;
    return translate(() => this.low.getJobLogs(link, { signal }));
  }

  /**
   * Typed live event iterator. Auto-reconnects with no replay; falls back
   * to polling to detect terminal status if the stream ends early. An
   * aborted `signal` stops both the current SSE connection/poll and the
   * pause between reconnect attempts.
   *
   * When the server cuts the stream with its terminal `error` event, the
   * iterator rejects with `Unauthorized` (`code: "credential_expired"`),
   * `Forbidden` or `NotFound` (`code: "job_not_found"`) and does
   * not reconnect.
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
      let terminalError: ApiError | null = null;
      try {
        for await (const raw of this.low.getJobEvents(eventsUrl, { signal })) {
          if (raw.event === "error") {
            // Terminal frame: the server is ending the stream for a reason other
            // than the job finishing (credential_expired / forbidden / job_not_found).
            // No status follows it, so surface it and stop — never reconnect.
            // Thrown after the try, so the reconnect dispatch below (and its
            // abort check, which would let the untranslated low error escape)
            // never sees it.
            terminalError = sseErrorFromFrame(raw.data);
            break;
          }
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
      if (terminalError !== null) throw toSdkError(terminalError);
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
 * One job as `client.listJobs()` yields it. A list item carries no outputs:
 * read the full job with `client.jobs.get(summary.id)`.
 */
export interface JobSummary {
  readonly id: string;
  readonly status: string;
  /** When the job was created, as the server sent it; `null` if it sent none. */
  readonly createTime: string | null;
  /** When the job last changed, as the server sent it; `null` if it sent none. */
  readonly updateTime: string | null;
  /**
   * The id of the deployment copy that ran the job; `null` for a job outside
   * one. After a deployment moves to a new release this can differ from the
   * deployment's own id, so it is not the address the job was sent to.
   */
  readonly deploymentId: string | null;
  /** The labels attached at submit. An empty object when the job has none. */
  readonly metadata: JobMetadata;
}

export function jobSummary(item: JobListItem): JobSummary {
  return {
    id: item.id,
    status: item.status,
    createTime: item.create_time ?? null,
    updateTime: item.update_time ?? null,
    deploymentId: item.deployment_id ?? null,
    metadata: readMetadata(item.metadata),
  };
}

/**
 * The string pairs of a job's `metadata`, read leniently: anything that is
 * not an object (a self-hosted proxy sends its own metadata as a plain
 * string) reads as `{}`, and a value that is not a string is dropped.
 */
function readMetadata(raw: unknown): JobMetadata {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  // Built by Object.fromEntries, not by assignment: a label keyed
  // `__proto__` (a valid key) would otherwise hit the prototype setter and
  // be dropped.
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
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
