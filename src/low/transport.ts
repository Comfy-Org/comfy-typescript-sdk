/**
 * Thin `low` transport over `fetch` — one async function per `operationId`
 * in `spec/openapi.yaml`, plus the mandatory escape hatches the hand-written
 * `sdk` layer builds on:
 *
 * - **raw response access** — every method's Promise resolves from (or, via
 *   {@link ComfyLow.request}, directly returns) a `Response` whose body is
 *   never pre-read.
 * - **unbuffered / streaming bodies** — a `fetch` `Response.body` is always a
 *   lazy `ReadableStream`; nothing here buffers it before the caller asks
 *   for `.json()`/`.body`. This is why, unlike the Python transport (which
 *   distinguishes a buffering `raw_request` from a streaming `open`), there
 *   is exactly one request primitive here — fetch's laziness already gives
 *   both hatches from a single call.
 * - **streaming request bodies** — `postAssets` takes a `Blob` (a Node
 *   `fs.openAsBlob()` handle is a lazy, disk-backed `Blob`, so a multi-GB
 *   upload is never buffered whole in memory) inside a native `FormData`;
 *   `fetch`/undici streams the encoded body to the wire.
 * - **per-request timeout/abort** — every method accepts `signal` and
 *   `timeoutMs`; `AbortSignal.any` composes a caller's signal with this
 *   client's default timeout (or overrides/disables it per call).
 *
 * This layer contains no orchestration, retries, hashing, or SSE
 * reconnection — those live in `../sdk`. Mirrors `comfy_low.transport` in
 * the Python SDK (its `AsyncComfyLow`; there is no sync variant here — see
 * the package README for why).
 */

import { errorFromEnvelope } from "./errors.js";
import type {
  Asset,
  AssetFromHashData,
  Job,
  JobWorkflowResponse,
  PostJobsData,
} from "./generated/types.gen.js";
import { iterateSse, type RawEvent } from "./sse.js";
import { SDK_VERSION } from "./version.js";

const API_PREFIX = "/api/v2";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface RequestOptions {
  headers?: Record<string, string>;
  json?: unknown;
  body?: string | FormData;
  signal?: AbortSignal;
  /**
   * Per-request timeout. `undefined` uses the client's default; `null`
   * disables the default timeout entirely (used for the SSE stream, which
   * must not time out while idle mid-job).
   */
  timeoutMs?: number | null;
  /** Defaults to `"follow"`; `getAssetContentUrl` passes `"manual"` so it can
   * read a redirect's `Location` instead of following it. */
  redirect?: "follow" | "manual" | "error";
}

export interface ComfyLowOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /**
   * Appended to the default `User-Agent` as `app/{clientInfo}` — lets an
   * app built on this SDK attribute its own traffic in request logs.
   * Opt-in; omitted by default.
   */
  clientInfo?: string;
}

/** Return shape of {@link ComfyLow.getAssetContentUrl}. */
export interface AssetContentUrl {
  url: string;
  expiresAt: Date | null;
}

/**
 * `"api"` — the executed graph; API-format, so frontend-only constructs
 * (Note nodes, Get/Set) are already resolved away. `"save"` — the authoring
 * workflow at the version the job ran, un-mangled; only present for a job
 * that pinned a workflow version (a job submitted through this SDK today
 * always gets `"api"`).
 */
export type JobWorkflowFormat = JobWorkflowResponse["format"];

/** Return shape of {@link ComfyLow.getJobWorkflow} — the generated response schema. */
export type JobWorkflowResult = JobWorkflowResponse;

function looksLikePath(value: string): boolean {
  return value.startsWith("http") || value.startsWith("/");
}

/**
 * Job base path from a bare id or a follow-up URL/path (e.g. `urls.self`).
 * Unlike `getJob`/`cancelJob`/`getJobEvents`, whose `jobIdOrUrl` URL branch
 * IS the pre-built target, `getJobWorkflow` has no `urls.workflow` link to
 * receive verbatim — a URL input is the job's own address, and `/workflow`
 * must be appended to it the same as it would be to a bare id. Strips one
 * trailing slash so the append never double-slashes.
 */
function jobBasePath(jobIdOrUrl: string): string {
  if (!looksLikePath(jobIdOrUrl)) return `/jobs/${encodeURIComponent(jobIdOrUrl)}`;
  return jobIdOrUrl.replace(/\/$/, "");
}

/**
 * The SDK's default `User-Agent`, optionally carrying a caller's own token.
 * Exported because every Comfy surface this package speaks to should be
 * attributable to the SDK in request logs, including the `comfy.models`
 * router calls in `../sdk/models.ts`, which do not go through
 * {@link ComfyLow}.
 */
export function buildUserAgent(clientInfo?: string): string {
  // `process` is read defensively because this string is now built on the
  // `comfy.models` path too, which a browser can reach — a bare `process`
  // there is a ReferenceError, and a browser drops a caller-set `User-Agent`
  // anyway (it is a forbidden header name), so degrading beats throwing.
  const runtime = globalThis.process?.version;
  const base = `comfy-sdk-typescript/${SDK_VERSION}${runtime ? ` (node ${runtime})` : ""}`;
  if (!clientInfo) return base;
  // A caller-set token goes verbatim into a header value; reject CR/LF so it
  // can never split/inject headers (undici would reject it anyway, but fail
  // fast with a clear message at construction).
  if (/[\r\n]/.test(clientInfo)) {
    throw new Error("clientInfo must not contain CR or LF characters");
  }
  return `${base} app/${clientInfo}`;
}

const GOOG_DATE_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/**
 * Expiry off a GCS V4 signed URL's `X-Goog-Date` (`YYYYMMDDTHHMMSSZ`, UTC) +
 * `X-Goog-Expires` (seconds) query params. `null` if either is missing or
 * doesn't match — an unrecognized signed-URL flavor degrades to "unknown
 * expiry" rather than throwing.
 */
function parseExpiry(url: string): Date | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const dateParam = parsed.searchParams.get("X-Goog-Date");
  const expiresParam = parsed.searchParams.get("X-Goog-Expires");
  if (!dateParam || !expiresParam) return null;
  const match = GOOG_DATE_RE.exec(dateParam);
  if (!match) return null;
  const expiresSeconds = Number.parseInt(expiresParam, 10);
  if (Number.isNaN(expiresSeconds)) return null;
  const [, year, month, day, hour, minute, second] = match;
  const epochMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return new Date(epochMs + expiresSeconds * 1000);
}

function parseRetryAfter(response: Response): number | null {
  const raw = response.headers.get("Retry-After");
  if (raw === null) return null;
  const seconds = Number.parseInt(raw, 10);
  return Number.isNaN(seconds) || seconds < 0 ? null : seconds;
}

/** Synchronous protocol bindings — async throughout (JS is async-native). */
export class ComfyLow {
  private readonly baseUrl: string;
  /**
   * An ECMAScript `#private` field, not a TypeScript `private` one: TS
   * `private` is erased at runtime, so the key showed up in
   * `JSON.stringify(client)` and `console.log(client)` — i.e. in every bug
   * report that pasted a client. `#` is invisible to both.
   * `credentials.test.ts` asserts it stays that way.
   */
  readonly #apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;
  private readonly userAgent: string;

  constructor(baseUrl: string, apiKey?: string, options: ComfyLowOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.#apiKey = apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = buildUserAgent(options.clientInfo);
  }

  private urlFor(path: string): string {
    if (path.startsWith("http")) return path;
    // A server link (job.urls.*, marked by containing /api/) already carries
    // the server's mount prefix, so it resolves against the origin — joining
    // it to baseUrl would double the prefix on a prefix-mounted surface.
    if (path.startsWith("/") && path.includes("/api/")) {
      try {
        return new URL(this.baseUrl).origin + path;
      } catch {
        return this.baseUrl + path;
      }
    }
    return this.baseUrl + API_PREFIX + path;
  }

  /**
   * Is `url` on the same origin (scheme + host + port) as this client's
   * `baseUrl`? A relative `path` always resolves to a `baseUrl`-derived URL
   * (see {@link urlFor}), so this only ever says "no" for a server-returned
   * absolute URL (`model.urls.self`/`cancel`/`events`) that points somewhere
   * else — which is exactly the case where the bearer token must not be
   * attached.
   */
  private isSameOrigin(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.baseUrl).origin;
    } catch {
      return false;
    }
  }

  private buildHeaders(url: string, extra?: Record<string, string>): Headers {
    const headers = new Headers();
    // Only authenticate when a key is set (a local proxy fronts a ComfyUI
    // with no auth, so we never leak credentials it does not want) AND the
    // request target is this client's own origin. `getJob`/`cancelJob`/
    // `getJobEvents` can be fed a server-returned absolute URL
    // (`model.urls.self/cancel/events`); if that ever points at a different
    // host, the bearer token must not follow it there.
    if (this.#apiKey && this.isSameOrigin(url)) {
      headers.set("Authorization", `Bearer ${this.#apiKey}`);
    }
    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        headers.set(key, value);
      }
    }
    // Identifies this SDK's traffic in request logs (support + adoption
    // metrics, no other data collected) — never overrides a caller-supplied
    // header.
    if (!headers.has("User-Agent")) {
      headers.set("User-Agent", this.userAgent);
    }
    return headers;
  }

  private resolveSignal(
    callerSignal: AbortSignal | undefined,
    timeoutMs: number | null | undefined,
  ): AbortSignal | undefined {
    const effective = timeoutMs === undefined ? this.defaultTimeoutMs : timeoutMs;
    if (effective === null) return callerSignal;
    const timeoutSignal = AbortSignal.timeout(effective);
    return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
  }

  /**
   * The single escape hatch: an unread `Response` (raw headers/status,
   * lazy body) for a request built from `{json | body}`. Every typed
   * method below is a thin wrapper over this.
   */
  async request(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const url = this.urlFor(path);
    const headers = this.buildHeaders(url, options.headers);
    let body = options.body;
    if (options.json !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.json);
    }
    const signal = this.resolveSignal(options.signal, options.timeoutMs);
    return this.fetchImpl(url, {
      method,
      headers,
      body,
      signal,
      redirect: options.redirect ?? "follow",
    });
  }

  private async parseOrRaise<T>(response: Response, ok: readonly number[]): Promise<T> {
    if (ok.includes(response.status)) {
      if (response.status === 204 || response.headers.get("Content-Length") === "0") {
        return {} as T;
      }
      const text = await response.text();
      return text ? (JSON.parse(text) as T) : ({} as T);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    throw errorFromEnvelope(response.status, body as never, {
      retryAfter: parseRetryAfter(response),
    });
  }

  // -- assets -------------------------------------------------------------

  /** `POST /api/v2/assets` — streaming multipart upload. */
  async postAssets(
    file: Blob,
    contentType: string,
    filePath: string,
    options: {
      expectedHash?: string;
      tags?: readonly string[];
      idempotencyKey?: string;
      signal?: AbortSignal;
      timeoutMs?: number | null;
    } = {},
  ): Promise<Asset> {
    // public-api streams the multipart upload and requires the metadata fields
    // BEFORE the file part (so it can route the file stream without buffering).
    // The `file` part MUST be appended last, or the server rejects with 422
    // "content_type is required and must be sent before the file field".
    const form = new FormData();
    form.append("content_type", contentType);
    form.append("file_path", filePath);
    if (options.expectedHash !== undefined) {
      form.append("expected_hash", options.expectedHash);
    }
    for (const tag of options.tags ?? []) {
      form.append("tags", tag);
    }
    form.append("file", file, filePath);
    const headers: Record<string, string> = {};
    if (options.idempotencyKey) {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }
    const response = await this.request("POST", "/assets", {
      headers,
      body: form,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    return this.parseOrRaise<Asset>(response, [200, 201, 202]);
  }

  /** `POST /api/v2/assets/from-hash` — dedup mint over existing bytes. */
  async assetFromHash(
    hash: string,
    options: { filePath?: string; tags?: readonly string[]; signal?: AbortSignal } = {},
  ): Promise<Asset> {
    const json: AssetFromHashData["body"] = { hash };
    if (options.filePath !== undefined) json.file_path = options.filePath;
    if (options.tags !== undefined) json.tags = [...options.tags];
    const response = await this.request("POST", "/assets/from-hash", {
      json,
      signal: options.signal,
    });
    return this.parseOrRaise<Asset>(response, [200, 201]);
  }

  /** `HEAD /api/v2/assets/by-hash/{hash}` — existence probe. */
  async headAssetByHash(hash: string, options: { signal?: AbortSignal } = {}): Promise<boolean> {
    const response = await this.request("HEAD", `/assets/by-hash/${encodeURIComponent(hash)}`, {
      signal: options.signal,
    });
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    return this.parseOrRaise<boolean>(response, [200]);
  }

  /** `GET /api/v2/assets/{id}` — metadata with a fresh content URL. */
  async getAsset(assetId: string, options: { signal?: AbortSignal } = {}): Promise<Asset> {
    const response = await this.request("GET", `/assets/${encodeURIComponent(assetId)}`, {
      signal: options.signal,
    });
    return this.parseOrRaise<Asset>(response, [200]);
  }

  /**
   * `GET /api/v2/assets/{id}/content` — raw, streamed, range-aware body.
   * Returns the response itself (escape hatch); the caller reads
   * `response.body`. No default timeout, matching {@link getJobEvents}: the
   * default `AbortSignal.timeout` covers body consumption too, and a
   * download larger than the default deadline allows must not be killed
   * mid-transfer (pass `timeoutMs` to opt back into a deadline).
   */
  async getAssetContent(
    assetId: string,
    options: {
      range?: readonly [number, number];
      signal?: AbortSignal;
      timeoutMs?: number | null;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (options.range) {
      headers.Range = `bytes=${options.range[0]}-${options.range[1]}`;
    }
    const response = await this.request("GET", `/assets/${encodeURIComponent(assetId)}/content`, {
      headers,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? null,
    });
    if (response.status !== 200 && response.status !== 206) {
      await this.parseOrRaise(response, [200, 206]);
    }
    return response;
  }

  /**
   * `GET /api/v2/assets/{id}/content` with the redirect **not** followed —
   * hands back a directly-fetchable URL instead of the bytes, so a caller
   * (e.g. a serverless/Cloudflare Worker) can pass the URL to a downstream
   * consumer without streaming the body through itself. On an object-storage
   * backend (Cloud/serverless) the server redirects to a short-lived signed
   * URL; that redirect is deliberately not followed (unlike
   * {@link getAssetContent}), both so its `Location` can be read and so this
   * client's bearer token is never attached to the object-storage host. On a
   * self-hosted proxy (which serves the bytes inline, no redirect) this
   * returns the endpoint's own absolute URL instead. Works on every backend;
   * a genuine failure maps to the usual typed error.
   */
  async getAssetContentUrl(
    assetId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<AssetContentUrl> {
    const path = `/assets/${encodeURIComponent(assetId)}/content`;
    const response = await this.request("GET", path, {
      signal: options.signal,
      redirect: "manual",
    });
    const location = response.headers.get("Location");
    // Node/undici hands back the real 3xx status with a readable `Location`
    // for a manual redirect; status 0 covers a browser's opaque redirect.
    // We only want the URL, not the bytes — release the response body so
    // undici can reuse the connection instead of pinning it until GC.
    if (location && (response.status === 0 || (response.status >= 300 && response.status < 400))) {
      await response.body?.cancel();
      return { url: location, expiresAt: parseExpiry(location) };
    }
    if (response.status === 200 || response.status === 206) {
      await response.body?.cancel();
      return { url: this.urlFor(path), expiresAt: null };
    }
    return this.parseOrRaise<AssetContentUrl>(response, [200, 206]); // always throws here
  }

  /** `DELETE /api/v2/assets/{id}` — removes the asset record and its content. */
  async deleteAsset(assetId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    const response = await this.request("DELETE", `/assets/${encodeURIComponent(assetId)}`, {
      signal: options.signal,
    });
    await this.parseOrRaise<void>(response, [204]);
  }

  // -- jobs -----------------------------------------------------------------

  /**
   * `POST /api/v2/jobs`. `extraData` (e.g. the partner-node API key) is a
   * sibling of `workflow` on the wire, per the spec's closed `extra_data`
   * object; omitted entirely when not provided, never sent empty.
   */
  async postJobs(
    workflow: Record<string, unknown>,
    options: {
      idempotencyKey?: string;
      extraData?: PostJobsData["body"]["extra_data"];
      signal?: AbortSignal;
    } = {},
  ): Promise<Job> {
    const headers: Record<string, string> = {};
    if (options.idempotencyKey) {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }
    const json: PostJobsData["body"] = { workflow };
    // Only attach a non-empty extra_data — never serialize an empty object onto
    // the wire (mirrors the Python low layer's truthy guard).
    if (options.extraData && Object.keys(options.extraData).length > 0) {
      json.extra_data = options.extraData;
    }
    const response = await this.request("POST", "/jobs", { headers, json, signal: options.signal });
    return this.parseOrRaise<Job>(response, [201]);
  }

  /** `GET /api/v2/jobs/{id}` (or an absolute self link). */
  async getJob(jobIdOrUrl: string, options: { signal?: AbortSignal } = {}): Promise<Job> {
    const path = looksLikePath(jobIdOrUrl) ? jobIdOrUrl : `/jobs/${encodeURIComponent(jobIdOrUrl)}`;
    const response = await this.request("GET", path, { signal: options.signal });
    return this.parseOrRaise<Job>(response, [200]);
  }

  /** `GET /api/v2/jobs/{id}/workflow` — the graph that produced this job. */
  async getJobWorkflow(
    jobIdOrUrl: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<JobWorkflowResult> {
    const response = await this.request("GET", `${jobBasePath(jobIdOrUrl)}/workflow`, {
      signal: options.signal,
    });
    return this.parseOrRaise<JobWorkflowResult>(response, [200]);
  }

  /**
   * `GET /api/v2/jobs/{id}/events` — raw live SSE iterator (escape hatch).
   * No reconnection here; a single connection's frames. `../sdk` adds the
   * reconnect loop. No default timeout: an idle stream must not time out
   * mid-job (pass `timeoutMs` to override).
   */
  async *getJobEvents(
    jobIdOrUrl: string,
    options: { signal?: AbortSignal; timeoutMs?: number | null } = {},
  ): AsyncGenerator<RawEvent, void, void> {
    const path = looksLikePath(jobIdOrUrl)
      ? jobIdOrUrl
      : `/jobs/${encodeURIComponent(jobIdOrUrl)}/events`;
    const response = await this.request("GET", path, {
      headers: { Accept: "text/event-stream" },
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? null,
    });
    if (response.status !== 200) {
      await this.parseOrRaise(response, [200]);
      return;
    }
    if (!response.body) return;
    yield* iterateSse(response.body);
  }

  /** `POST /api/v2/jobs/{id}/cancel` — idempotent. */
  async cancelJob(jobIdOrUrl: string, options: { signal?: AbortSignal } = {}): Promise<Job> {
    const path = looksLikePath(jobIdOrUrl)
      ? jobIdOrUrl
      : `/jobs/${encodeURIComponent(jobIdOrUrl)}/cancel`;
    const response = await this.request("POST", path, { signal: options.signal });
    return this.parseOrRaise<Job>(response, [200]);
  }
}

// The exact set of operationIds the transport must cover; the spec-coverage
// test asserts this equals the set of operationIds in spec/openapi.yaml.
export const OPERATION_IDS = [
  "postAssets",
  "assetFromHash",
  "headAssetByHash",
  "getAsset",
  "deleteAsset",
  "getAssetContent",
  "postJobs",
  "getJob",
  "getJobWorkflow",
  "getJobEvents",
  "cancelJob",
] as const;

// operationId -> transport method name.
export const OPERATION_METHODS: Record<(typeof OPERATION_IDS)[number], keyof ComfyLow> = {
  postAssets: "postAssets",
  assetFromHash: "assetFromHash",
  headAssetByHash: "headAssetByHash",
  getAsset: "getAsset",
  deleteAsset: "deleteAsset",
  getAssetContent: "getAssetContent",
  postJobs: "postJobs",
  getJob: "getJob",
  getJobWorkflow: "getJobWorkflow",
  getJobEvents: "getJobEvents",
  cancelJob: "cancelJob",
};
