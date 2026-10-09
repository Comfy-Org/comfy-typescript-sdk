/**
 * `Comfy` — the client integrators import.
 *
 * Runs an API-format workflow against any Comfy API v2 surface (Comfy Cloud,
 * serverless, self-hosted proxy) — the only per-surface difference is the
 * `COMFY_BASE_URL` environment variable and an optional key — and owns
 * everything a generator cannot produce: local blake3 dedup-upload,
 * `core/ASSET` substitution, idempotent
 * submit, live SSE with a poll-authoritative backstop, range-aware
 * downloads, and typed errors. It is layered over `../low` (the generated
 * types/validators + thin transport).
 *
 * Mirrors `comfy_sdk.client.AsyncComfy` in the Python SDK — there is no
 * separate sync client here (JS is async-native, so the Python SDK's
 * sync/async split collapses to one class).
 *
 * @example
 * ```ts
 * import { Comfy } from "@comfyorg/sdk";
 *
 * const client = new Comfy({ apiKey: "ck_..." }); // Comfy Cloud
 * // COMFY_BASE_URL=http://127.0.0.1:8189 in the environment targets a
 * // self-hosted proxy instead, where no key is needed.
 *
 * const wf = await client.workflows.fromFile("workflow_api.json");
 * const asset = client.assets.fromFile("photo.png"); // lazy; uploaded on use
 * wf.setInput("10", "image", asset); // "10" is a LoadImage node: bind handles to a loader's file widget
 *
 * const job = await client.run(wf); // submit + poll-to-done
 * (await job.getOutputs("13")[0].toFile("out.png"));
 * ```
 */

import type { AssetReference, JobMetadata } from "../low/index.js";
import { ApiError, ComfyLow, type ComfyLowOptions } from "../low/index.js";
import { abortableSleep } from "./abortable-sleep.js";
import { AssetFactory } from "./assets.js";
import {
  findAssetHandles,
  looksLikeUiFormat,
  newIdempotencyKey,
  substituteAssetHandles,
  SUCCESS,
} from "./core.js";
import type { AssetHandleLike } from "./core.js";
import { ComfyError, JobFailed, QueueFull, WorkflowFormatUi, toSdkError } from "./exceptions.js";
import { Job, JobFactory, jobSummary, type JobSummary } from "./jobs.js";
import type { Workflow, WorkflowGraph } from "./workflows.js";
import { WorkflowFactory } from "./workflows.js";

// How long to keep retrying a full queue before giving up (ms).
const QUEUE_RETRY_BUDGET_MS = 60_000;
/** Base URL of the hosted Comfy Cloud deployment — where a client points by default. */
export const COMFY_CLOUD_BASE_URL = "https://cloud.comfy.org";
/** Environment variable that redirects a client at another deployment. */
export const BASE_URL_ENV_VAR = "COMFY_BASE_URL";

const DEFAULT_RETRY_AFTER_S = 2;
// The shortest pause before re-sending a 429: a `Retry-After: 0` must not
// turn the retry into a tight loop for the whole budget.
const MIN_RETRY_PAUSE_MS = 1_000;

/**
 * Comfy Cloud, unless `COMFY_BASE_URL` names another deployment.
 *
 * Read per construction rather than at module load so a process can point
 * successive clients at different deployments. An unset-or-blank variable
 * means Comfy Cloud, so `COMFY_BASE_URL=` in a shell profile or `.env` is not
 * an error; a runtime with no `process` (a browser) simply never sees one.
 */
function resolveBaseUrl(): string {
  const raw = globalThis.process?.env?.[BASE_URL_ENV_VAR]?.trim();
  if (!raw) return COMFY_CLOUD_BASE_URL;
  let parsed: URL | undefined;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = undefined;
  }
  // A query or fragment would land in the middle of every request URL, since
  // the transport builds those by appending the API path to this string.
  const valid =
    parsed !== undefined &&
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.search === "" &&
    parsed.hash === "";
  if (!valid) {
    throw new TypeError(
      `${BASE_URL_ENV_VAR} must be an http(s) URL with no query or fragment (e.g. "http://127.0.0.1:8189"), got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

export interface ComfyOptions {
  apiKey?: string;
  timeoutMs?: number;
  fetch?: ComfyLowOptions["fetch"];
  /** Appended to the SDK's default `User-Agent` as `app/{clientInfo}` — lets
   * an app built on this SDK attribute its own traffic in request logs. */
  clientInfo?: string;
}

function guardUiFormat(workflow: Workflow): void {
  if (looksLikeUiFormat(workflow.json)) {
    throw new WorkflowFormatUi(
      "workflow is in UI-export format (nodes/links/last_node_id); submit the API-format graph instead",
      { code: "workflow_format_ui", httpStatus: 422 },
    );
  }
}

/**
 * The SDK entry point — one client per Comfy deployment.
 *
 * Holds the three factories you build work from ({@link Comfy.assets},
 * {@link Comfy.workflows}, {@link Comfy.jobs}) and submits graphs via
 * {@link Comfy.run} (submit, then poll to terminal) or {@link Comfy.submit}
 * (submit and return immediately). Targets Comfy Cloud unless the
 * `COMFY_BASE_URL` environment variable names another deployment.
 */
export class Comfy {
  private readonly low: ComfyLow;
  readonly assets: AssetFactory;
  readonly workflows: WorkflowFactory;
  readonly jobs: JobFactory;

  /** Connect to Comfy Cloud, or to whatever deployment `COMFY_BASE_URL` names. */
  constructor(options: ComfyOptions = {}) {
    // Untyped JS callers get no compile error for the old positional base URL,
    // and it would otherwise be ignored silently.
    if (typeof (options as unknown) === "string") {
      throw new TypeError(
        `Comfy takes no base URL; set ${BASE_URL_ENV_VAR} in the environment to target another deployment`,
      );
    }
    this.low = new ComfyLow(resolveBaseUrl(), options.apiKey, {
      timeoutMs: options.timeoutMs,
      fetch: options.fetch,
      clientInfo: options.clientInfo,
    });
    this.assets = new AssetFactory(this.low);
    this.workflows = new WorkflowFactory();
    this.jobs = new JobFactory(this.low);
  }

  private async materialize(workflow: Workflow, signal?: AbortSignal): Promise<WorkflowGraph> {
    const handles = findAssetHandles(workflow.json);
    const refs = new Map<AssetHandleLike, AssetReference>();
    for (const handle of handles) {
      refs.set(handle, await handle.asReference(signal));
    }
    return substituteAssetHandles(workflow.json, refs) as WorkflowGraph;
  }

  /**
   * Submit a workflow. Retries any 429 that carries `Retry-After` (e.g.
   * `queue_full`, a serverless `deployment_not_ready` cold start);
   * `queue_full` also retries without one, in case the server omits it. An
   * aborted `signal` stops asset materialization, the submit request, and
   * the retry pause.
   *
   * Sends an auto-generated `Idempotency-Key` so the server rejects an
   * accidental exact resend of *this* request (`422 idempotency_key_reuse`)
   * instead of creating a duplicate job. Each call mints a fresh key, so
   * calling `submit()` again is a distinct submission — to make a retry
   * idempotent, pass an explicit `idempotencyKey` and reuse it. Note a reused
   * key is *rejected*, not replayed: on reuse, catch the error and poll/list
   * for the job the first attempt already created.
   *
   * Pass `apiKey` to authenticate partner (API) nodes in the workflow (for
   * example Gemini) — it is sent once, as `extra_data.api_key_comfy_org`
   * alongside the workflow, and is unrelated to the `Idempotency-Key`: it
   * does not affect idempotency and is never persisted or logged by this
   * SDK. Omit it and no `extra_data` is sent at all.
   *
   * Pass `metadata` to label the job (for example, which of your customers
   * it is for); find it again later with {@link Comfy.listJobs}. It is sent
   * as is: the server checks its limits and rejects a bad map with a
   * `ComfyError` of code `metadata_invalid`, whose message names the key.
   * Omit it and the request is the same as before.
   */
  async submit(
    workflow: Workflow,
    options: {
      idempotencyKey?: string;
      apiKey?: string;
      metadata?: JobMetadata;
      signal?: AbortSignal;
    } = {},
  ): Promise<Job> {
    guardUiFormat(workflow);
    const graph = await this.materialize(workflow, options.signal);
    const key = options.idempotencyKey ?? newIdempotencyKey();
    // A falsy apiKey (undefined or "") means "no key" — send no extra_data,
    // matching the Python SDK's behavior so the two stay in lockstep.
    const extraData = options.apiKey ? { api_key_comfy_org: options.apiKey } : undefined;
    const job = await this.retryThrottled(
      () =>
        this.low.postJobs(graph, {
          idempotencyKey: key,
          extraData,
          metadata: options.metadata,
          signal: options.signal,
        }),
      options.signal,
    );
    return new Job(this.low, job);
  }

  /**
   * Run one request, retrying any 429 that carries `Retry-After` (and
   * `queue_full` without one) for up to a minute. Every other failure is
   * raised as its SDK exception.
   */
  private async retryThrottled<T>(send: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const deadline = performance.now() + QUEUE_RETRY_BUDGET_MS;
    for (;;) {
      try {
        return await send();
      } catch (exc) {
        if (!(exc instanceof ApiError)) throw exc;
        const err = toSdkError(exc);
        // Per spec, any 429 with Retry-After means back off and retry; fall
        // back to a default pause for queue_full specifically, since a
        // server may omit the header on that code today.
        const retryDelayS =
          exc.retryAfter ?? (err instanceof QueueFull ? DEFAULT_RETRY_AFTER_S : null);
        // Clamp the sleep to what's left of the budget: a malicious or
        // misbehaving server's Retry-After (e.g. 86400s) must not sleep past
        // it — the loop-entry check alone doesn't bound the sleep itself.
        const remainingMs = deadline - performance.now();
        if (exc.httpStatus === 429 && retryDelayS !== null && remainingMs > 0) {
          const pauseMs = Math.max(retryDelayS * 1000, MIN_RETRY_PAUSE_MS);
          await abortableSleep(Math.min(pauseMs, remainingMs), signal);
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Your jobs, newest first, fetched page by page as you iterate. Pass
   * `metadata` to keep only the jobs whose labels match every pair given. The
   * SDK checks each job against the filter too, so a server that ignores it
   * still yields only matching jobs; there one step of the loop can fetch
   * several pages, or all of them, before it yields or ends. `limit` is the page size, not a total:
   * stop iterating to stop fetching. An aborted `signal` stops the request in flight. A 429 on any
   * page is retried as {@link Comfy.submit} retries one, so the walk carries
   * on from that page. A bad filter raises a `ComfyError` of code
   * `invalid_metadata_filter`, and a cursor the server did not issue one of
   * code `invalid_cursor`. A `next_cursor` the walk has already followed
   * would fetch the same pages forever, so it raises a `ComfyError` of code
   * `unexpected_response`, as `comfy.models.list()` does. Comfy Cloud does not list jobs yet: it answers
   * with a `ComfyError` of code `not_implemented` (HTTP 501). A self-hosted
   * proxy does not keep labels, so there `metadata` is empty on every job and
   * a filtered list yields nothing.
   *
   * @example
   * ```ts
   * for await (const job of client.listJobs({ metadata: { customer: "acme" } })) {
   *   console.log(job.id, job.status, job.metadata);
   * }
   * ```
   */
  async *listJobs(
    options: { metadata?: JobMetadata; limit?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<JobSummary, void, void> {
    let cursor: string | undefined;
    const followed = new Set<string>();
    do {
      const page = await this.retryThrottled(
        () =>
          this.low.listJobs({
            metadata: options.metadata,
            limit: options.limit,
            cursor,
            signal: options.signal,
          }),
        options.signal,
      );
      for (const item of page.jobs ?? []) {
        const summary = jobSummary(item);
        if (matchesLabels(summary.metadata, options.metadata)) yield summary;
      }
      cursor = page.next_cursor || undefined;
      if (cursor !== undefined) {
        if (followed.has(cursor)) {
          throw new ComfyError(
            "listJobs() was handed a `next_cursor` it had already followed, which would " +
              "walk the same pages forever",
            { code: "unexpected_response" },
          );
        }
        followed.add(cursor);
      }
    } while (cursor !== undefined);
  }

  /** Submit, then poll to terminal (authoritative). Throws on failure. */
  async run(
    workflow: Workflow,
    options: { timeoutMs?: number; apiKey?: string; signal?: AbortSignal } = {},
  ): Promise<Job> {
    const job = await this.submit(workflow, { apiKey: options.apiKey, signal: options.signal });
    return options.timeoutMs === undefined
      ? job.result(options.signal)
      : runWithTimeout(job, options.timeoutMs, options.signal);
  }
}

/**
 * Whether `labels` holds every pair of `filter` (an absent filter matches
 * all). A key and a value are compared as the text the query sent, so an
 * untyped caller's number, or a lone surrogate (which the query sends as
 * U+FFFD), still matches the label the server matched.
 */
function matchesLabels(labels: JobMetadata, filter: JobMetadata | undefined): boolean {
  return Object.entries(filter ?? {}).every(([key, value]) => {
    const sentKey = asQuerySends(key);
    return Object.hasOwn(labels, sentKey) && labels[sentKey] === asQuerySends(value);
  });
}

/**
 * `value` as `URLSearchParams` sends it: as a string, with each lone
 * surrogate replaced by U+FFFD.
 */
function asQuerySends(value: unknown): string {
  return new URLSearchParams([["", String(value)]]).get("") ?? "";
}

async function runWithTimeout(job: Job, timeoutMs: number, signal?: AbortSignal): Promise<Job> {
  await job.wait(timeoutMs, signal);
  if (job.status !== SUCCESS) {
    throw new JobFailed(`job ${job.id} ended ${job.status}`, { error: job.error });
  }
  return job;
}
