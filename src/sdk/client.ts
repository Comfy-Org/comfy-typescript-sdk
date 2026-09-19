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
 * Credentials resolve in a fixed order at construction: the explicit `apiKey`
 * option, then the `COMFY_API_KEY` environment variable, then — targeting
 * Comfy Cloud, which always requires a key — a local `MissingCredentials`
 * naming that variable, thrown before any request rather than surfacing as a
 * server 401 on the first call. A deployment named by `COMFY_BASE_URL` may
 * have no auth at all (a self-hosted ComfyUI behind the API proxy), so there
 * an unresolved key stays valid and means "send no credentials".
 *
 * @example
 * ```ts
 * import { Comfy } from "@comfyorg/sdk";
 *
 * const client = new Comfy({ apiKey: "comfyui-..." }); // Comfy Cloud
 * // ...or COMFY_API_KEY in the environment, which `new Comfy()` reads when
 * // no `apiKey` is passed.
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
import { CREDENTIALS_ENV_VAR } from "./credentials.js";
import {
  findAssetHandles,
  looksLikeUiFormat,
  newIdempotencyKey,
  substituteAssetHandles,
  SUCCESS,
} from "./core.js";
import type { AssetHandleLike } from "./core.js";
import {
  JobFailed,
  MissingCredentials,
  QueueFull,
  WorkflowFormatUi,
  toSdkError,
} from "./exceptions.js";
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

/**
 * Whether two base URLs name the same deployment.
 *
 * Compared by normalized origin (scheme, host, effective port — the rule the
 * transport already applies to credentials) plus path, rather than by string.
 * `https://cloud.comfy.org:443/` is Comfy Cloud with its default port written
 * out, and reading it as *some other* deployment would hand the caller a
 * keyless client and a server 401 on the first request instead of the local
 * error {@link resolveApiKey} promises.
 *
 * The path is part of the comparison because a deployment mounted under the
 * same host (`https://cloud.comfy.org/self-hosted`) is a different target, and
 * the keyless carve-out has to keep applying to it.
 *
 * Both arguments are already-validated http(s) URLs — the caller's comes from
 * {@link resolveBaseUrl}, which parses and rejects anything else before this
 * runs — so neither `new URL` can throw. Catching here instead would have to
 * answer "is it Comfy Cloud?" with a guess, and the safe-looking guess (`no`)
 * is the one that hands back a keyless client.
 */
function sameDeployment(url: string, other: string): boolean {
  const a = new URL(url);
  const b = new URL(other);
  return a.origin === b.origin && stripTrailingSlash(a.pathname) === stripTrailingSlash(b.pathname);
}

function stripTrailingSlash(path: string): string {
  return path.replace(/\/$/, "");
}

/**
 * The explicit `apiKey`, then `COMFY_API_KEY`, then a clear local error.
 *
 * Read per construction (like {@link resolveBaseUrl}) so one process can build
 * successive clients under different credentials and a test can stub the
 * environment. Surrounding whitespace is stripped and a blank value counts as
 * unset at either source, so `COMFY_API_KEY=` in a shell profile — or a key
 * read out of a file with a trailing newline — behaves the way it looks; a
 * runtime with no `process` (a browser) simply never sees the variable.
 *
 * Comfy Cloud always requires a key, so exhausting both sources *there* throws
 * {@link MissingCredentials} at construction with no network call attempted: a
 * missing credential reported as a server 401 sends the caller looking at
 * their key's validity instead of at its absence. A deployment named by
 * `COMFY_BASE_URL` may legitimately have none (a self-hosted ComfyUI behind
 * the API proxy), so there an unresolved key is not an error and keeps its
 * documented meaning — send no credentials at all.
 *
 * This is the order `comfy_sdk`'s `_resolve_api_key` uses in the Python SDK,
 * and it reads the same variable `comfy.models.*` resolves through
 * `resolveCredentials()`. The two surfaces stay separate on purpose — a
 * `comfy.config({ credentials })` call does NOT configure a class client,
 * which is what keeps the namespace's process-global binding out of a
 * multi-tenant server's per-request clients — but neither of them can now be
 * reached with a key in the environment and no key in hand.
 */
function resolveApiKey(explicit: string | undefined, baseUrl: string): string | undefined {
  if (explicit !== undefined && typeof explicit !== "string") {
    // Falling through to the environment here would authenticate as whatever
    // `COMFY_API_KEY` names while the caller believes they supplied a key.
    // Names the offending *type* only — never the value — so a mistyped
    // secret cannot land in a log or a stack, the same rule `config()` follows.
    throw new TypeError(`Comfy({ apiKey }) must be a string or undefined, got ${typeof explicit}`);
  }
  for (const candidate of [explicit, globalThis.process?.env?.[CREDENTIALS_ENV_VAR]]) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  if (sameDeployment(baseUrl, COMFY_CLOUD_BASE_URL)) {
    throw new MissingCredentials(
      `no API key: pass apiKey to the client, or set ${CREDENTIALS_ENV_VAR} in the environment. ` +
        `Comfy Cloud (${COMFY_CLOUD_BASE_URL}) requires one; set ${BASE_URL_ENV_VAR} to target ` +
        "a deployment that does not.",
      { code: "missing_credentials" },
    );
  }
  return undefined;
}

export interface ComfyOptions {
  /**
   * This client's own credential, sent as the `Authorization` bearer token.
   * Omit it to fall back to `COMFY_API_KEY` in the environment — see
   * {@link resolveApiKey} for the full order.
   *
   * Unrelated to the `apiKey` {@link Comfy.submit} and {@link Comfy.run}
   * accept, which authenticates partner (API) nodes inside a workflow.
   */
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
 *
 * `apiKey` is optional: omit it to fall back to `COMFY_API_KEY`. Against
 * Comfy Cloud, neither throws {@link MissingCredentials} at construction.
 */
export class Comfy {
  private readonly low: ComfyLow;
  readonly assets: AssetFactory;
  readonly workflows: WorkflowFactory;
  readonly jobs: JobFactory;

  /**
   * Connect to Comfy Cloud, or to whatever deployment `COMFY_BASE_URL` names.
   *
   * @throws {MissingCredentials} targeting Comfy Cloud with no `apiKey` and no
   * `COMFY_API_KEY` in the environment — before any network call.
   */
  constructor(options: ComfyOptions = {}) {
    // Untyped JS callers get no compile error for the old positional base URL,
    // and it would otherwise be ignored silently.
    if (typeof (options as unknown) === "string") {
      throw new TypeError(
        `Comfy takes no base URL; set ${BASE_URL_ENV_VAR} in the environment to target another deployment`,
      );
    }
    // The base URL first: it decides whether a missing key is an error at all.
    const baseUrl = resolveBaseUrl();
    this.low = new ComfyLow(baseUrl, resolveApiKey(options.apiKey, baseUrl), {
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
   */
  async submit(
    workflow: Workflow,
    options: { idempotencyKey?: string; apiKey?: string; signal?: AbortSignal } = {},
  ): Promise<Job> {
    guardUiFormat(workflow);
    const graph = await this.materialize(workflow, options.signal);
    const key = options.idempotencyKey ?? newIdempotencyKey();
    // A falsy apiKey (undefined or "") means "no key" — send no extra_data,
    // matching the Python SDK's behavior so the two stay in lockstep.
    const extraData = options.apiKey ? { api_key_comfy_org: options.apiKey } : undefined;
    const deadline = performance.now() + QUEUE_RETRY_BUDGET_MS;
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
          await abortableSleep(Math.min(retryDelayS * 1000, remainingMs), options.signal);
          continue;
        }
        throw err;
      }
    }
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

async function runWithTimeout(job: Job, timeoutMs: number, signal?: AbortSignal): Promise<Job> {
  await job.wait(timeoutMs, signal);
  if (job.status !== SUCCESS) {
    throw new JobFailed(`job ${job.id} ended ${job.status}`, { error: job.error });
  }
  return job;
}
