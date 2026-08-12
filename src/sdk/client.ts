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
 * wf.setInput("10", "image", asset);
 *
 * const job = await client.run(wf); // submit + poll-to-done
 * (await job.getOutputs("13")[0].toFile("out.png"));
 * ```
 */

import type { AssetReference } from "../low/index.js";
import { ApiError, ComfyLow, type ComfyLowOptions } from "../low/index.js";
import { abortableSleep } from "./abortable-sleep.js";
import { AssetFactory } from "./assets.js";
import {
  extraDataFor,
  findAssetHandles,
  looksLikeUiFormat,
  newIdempotencyKey,
  substituteAssetHandles,
  SUCCESS,
} from "./core.js";
import type { AssetHandleLike } from "./core.js";
import { JobFailed, QueueFull, WorkflowFormatUi, toSdkError } from "./exceptions.js";
import { Job, JobFactory } from "./jobs.js";
import type { Workflow, WorkflowGraph } from "./workflows.js";
import { WorkflowFactory } from "./workflows.js";

// How long to keep retrying a full queue before giving up (ms).
const QUEUE_RETRY_BUDGET_MS = 60_000;
/** Base URL of the hosted Comfy Cloud deployment — where a client points by default. */
export const COMFY_CLOUD_BASE_URL = "https://cloud.comfy.org";
/** Environment variable that redirects a client at another deployment. */
export const BASE_URL_ENV_VAR = "COMFY_BASE_URL";

const DEFAULT_RETRY_AFTER_S = 2;

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
   * Submit a workflow. Retries `queue_full` with `Retry-After`. An aborted
   * `signal` stops asset materialization, the submit request, and the
   * `queue_full` retry pause.
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
   * Pass `embedWorkflow: true` to embed the materialized graph as output
   * metadata (`extra_data.extra_pnginfo.workflow`), so it can be recovered
   * later from a generated image — useful when debugging. Off by default.
   */
  async submit(
    workflow: Workflow,
    options: {
      idempotencyKey?: string;
      apiKey?: string;
      embedWorkflow?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<Job> {
    guardUiFormat(workflow);
    const graph = await this.materialize(workflow, options.signal);
    const key = options.idempotencyKey ?? newIdempotencyKey();
    const extraData = extraDataFor(options.apiKey, options.embedWorkflow ? graph : undefined);
    const deadline = Date.now() + QUEUE_RETRY_BUDGET_MS;
    for (;;) {
      try {
        const job = await this.low.postJobs(graph, {
          idempotencyKey: key,
          extraData,
          signal: options.signal,
        });
        return new Job(this.low, job);
      } catch (exc) {
        if (!(exc instanceof ApiError)) throw exc;
        const err = toSdkError(exc);
        if (err instanceof QueueFull && Date.now() < deadline) {
          await abortableSleep((err.retryAfter || DEFAULT_RETRY_AFTER_S) * 1000, options.signal);
          continue;
        }
        throw err;
      }
    }
  }

  /** Submit, then poll to terminal (authoritative). Throws on failure. */
  async run(
    workflow: Workflow,
    options: {
      timeoutMs?: number;
      apiKey?: string;
      embedWorkflow?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<Job> {
    const job = await this.submit(workflow, {
      apiKey: options.apiKey,
      embedWorkflow: options.embedWorkflow,
      signal: options.signal,
    });
    return options.timeoutMs === undefined
      ? job.result(options.signal)
      : runWithTimeout(job, options.timeoutMs, options.signal);
  }
}

async function runWithTimeout(job: Job, timeoutMs: number, signal?: AbortSignal): Promise<Job> {
  await job.wait(timeoutMs, signal);
  if (job.status !== SUCCESS) {
    throw new JobFailed(`job ${job.id} ended ${job.status}`, { error: job.error });
  }
  return job;
}
