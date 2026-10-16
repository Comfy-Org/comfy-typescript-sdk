/**
 * Output handles — typed, range-aware download over an asset id.
 *
 * An output is an asset: the bytes are retrievable via `getAssetContent`
 * (which serves directly or redirects to a signed URL) for as long as the
 * job is retained. `toFile` streams to disk; `toBytes` buffers. Mirrors
 * `comfy_sdk.outputs` in the Python SDK.
 */

import type { ComfyLow, Output as LowOutput } from "../low/index.js";
import { translate } from "./exceptions.js";

/**
 * One file produced by one node of a finished job.
 *
 * Obtained from {@link Job.outputs} or {@link Job.getOutputs}, never
 * constructed directly. The bytes are fetched on demand — nothing is
 * downloaded until you call {@link Output.toFile}, {@link Output.toBytes},
 * or hand {@link Output.getDownloadUrl} to someone else.
 */
export class Output {
  private readonly model: LowOutput;
  private readonly low: ComfyLow;

  constructor(model: LowOutput, low: ComfyLow) {
    this.model = model;
    this.low = low;
  }

  /** The graph node that produced this output. */
  get nodeId(): string {
    return this.model.node_id;
  }

  /** Server-assigned filename, e.g. `ComfyUI_00001_.png`. */
  get name(): string {
    return this.model.name;
  }

  /** Output kind — `image`, `video`, `audio`, `text`, … */
  get type(): LowOutput["type"] {
    return this.model.type;
  }

  /** This output's asset UUID; also accepted by `client.assets.get()`. */
  get id(): string {
    return this.model.id;
  }

  /** Full size of the output, independent of any `range` you request. */
  get sizeBytes(): number {
    return this.model.size_bytes;
  }

  /** MIME type reported by the server, e.g. `image/png`. */
  get contentType(): string {
    return this.model.content_type;
  }

  /** ID of the job that produced this output. */
  get jobId(): string | undefined {
    return this.model.job_id ?? undefined;
  }

  /**
   * Stream this output to `path` and resolve to that same path.
   *
   * Bytes are piped straight to disk, so an output larger than memory is
   * fine. `range: [first, last]` fetches only that slice and is **inclusive
   * of both ends** (HTTP `Range: bytes=first-last`), so `[0, 4]` yields the
   * first five bytes. No default timeout, so a large download is not killed
   * mid-transfer; pass `timeoutMs`/`signal` to bound or cancel it.
   *
   * Node-only. In a browser use {@link Output.toBytes} and hand the bytes to
   * a Blob download.
   */
  async toFile(
    path: string,
    options: {
      range?: readonly [number, number];
      signal?: AbortSignal;
      timeoutMs?: number | null;
    } = {},
  ): Promise<string> {
    const response = await translate(() =>
      this.low.getAssetContent(this.model.id, {
        range: options.range,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      }),
    );
    if (!response.body) throw new Error(`empty response body for asset ${this.model.id}`);
    const [{ createWriteStream }, { Readable }, { pipeline }] = await Promise.all([
      import("node:fs"),
      import("node:stream"),
      import("node:stream/promises"),
    ]);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
    return path;
  }

  /**
   * Resolve to this output's bytes in memory.
   *
   * Convenient for small outputs; prefer {@link Output.toFile} for large
   * ones, since this buffers the whole body. `range` is inclusive — see
   * {@link Output.toFile}, including the no-default-timeout behavior.
   */
  async toBytes(
    options: {
      range?: readonly [number, number];
      signal?: AbortSignal;
      timeoutMs?: number | null;
    } = {},
  ): Promise<Uint8Array> {
    const response = await translate(() =>
      this.low.getAssetContent(this.model.id, {
        range: options.range,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      }),
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * A directly-fetchable URL for this output's bytes — a short-lived,
   * self-authorizing bearer credential (readable until `expiresAt`) — so a
   * caller (e.g. a serverless/Cloudflare Worker) can hand the URL to a
   * downstream consumer instead of streaming the bytes through itself. On an
   * object-storage backend (Cloud/serverless) this is a signed URL and
   * `expiresAt` is set; on a self-hosted proxy (which serves the bytes
   * inline) it's this asset's own content URL and `expiresAt` is `null`.
   * Works on every backend; a genuine failure maps to the usual typed error.
   */
  async getDownloadUrl(): Promise<{ url: string; expiresAt: Date | null }> {
    return translate(() => this.low.getAssetContentUrl(this.model.id));
  }
}
