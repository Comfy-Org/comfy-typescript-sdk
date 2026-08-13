/**
 * Content-addressed asset handles and their constructors.
 *
 * `client.assets.from*` returns a **lazy** {@link Asset} handle: no network
 * at construction. On first use (`commit`/`asReference`/submit) the handle
 * hashes its bytes locally with blake3, probes the server's dedup
 * fast-path (`HEAD by-hash` then `from-hash` mint over existing bytes), and
 * only streams a full multipart upload when the server does not already
 * have the bytes. Because the handle carries an idempotency key,
 * re-running a script re-uploads nothing whose bytes already made it to
 * the server. Mirrors `comfy_sdk.assets` in the Python SDK — folded to one
 * async class since JS is async-native (no separate sync variant).
 */

import { basename, extname } from "node:path";

import type { Asset as LowAsset, ComfyLow } from "../low/index.js";
import { ASSET_HANDLE, assetReference, newIdempotencyKey } from "./core.js";
import { translate } from "./exceptions.js";
import { hashBytes, hashFile } from "./hashing.js";

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

// A small, deliberately non-exhaustive extension -> MIME map: Node has no
// bundled equivalent of Python's `mimetypes.guess_type`, and pulling in a
// full MIME database for a handful of common asset kinds isn't worth the
// dependency. Anything unrecognized falls back to `application/octet-stream`
// (the server never trusts this — it is a convenience default only).
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".json": "application/json",
  ".txt": "text/plain",
  ".safetensors": "application/octet-stream",
};

function guessContentType(name: string | undefined): string {
  if (!name) return DEFAULT_CONTENT_TYPE;
  return EXTENSION_CONTENT_TYPES[extname(name).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}

type Hasher = () => Promise<string>;
type Opener = () => Promise<Blob>;

interface Source {
  contentType: string;
  filePath: string;
  hasher: Hasher;
  opener: Opener;
}

function noOpener(): Promise<Blob> {
  throw new Error("this asset is already committed; nothing to upload");
}

function fileSource(path: string): Source {
  const name = basename(path);
  return {
    contentType: guessContentType(name),
    filePath: name,
    hasher: () => hashFile(path),
    // `fs.openAsBlob` is a lazy, disk-backed Blob: reading it (by
    // `fetch`/undici, while encoding the multipart body) streams from disk
    // on demand instead of loading the whole file into memory up front —
    // this is what makes `postAssets` a genuine streaming upload.
    opener: async () => {
      const { openAsBlob } = await import("node:fs");
      return openAsBlob(path, { type: guessContentType(name) });
    },
  };
}

function bytesSource(data: Uint8Array, filename?: string, contentType?: string): Source {
  const name = filename ?? "upload.bin";
  return {
    contentType: contentType ?? guessContentType(filename),
    filePath: name,
    hasher: () => hashBytes(data),
    opener: async () => new Blob([data]),
  };
}

/**
 * A lazy handle to one input file.
 *
 * Nothing happens on construction: the bytes are hashed locally with blake3,
 * deduped against the server, and uploaded only on first use — either when
 * you {@link Asset.commit} explicitly, or when a workflow referencing it is
 * submitted. Assign one to a node input via `workflow.setInput(...)` and it
 * is substituted as a `core/ASSET` reference.
 */
export class Asset {
  readonly [ASSET_HANDLE] = true as const;

  private readonly low: ComfyLow;
  private readonly source: Source;
  private readonly idempotencyKey = newIdempotencyKey();
  private hashValue?: string;
  private idValue?: string;
  private createdNewValue: boolean | null = null;

  constructor(low: ComfyLow, source: Source) {
    this.low = low;
    this.source = source;
  }

  /** The asset UUID, or `undefined` while this handle is still uncommitted. */
  get id(): string | undefined {
    return this.idValue;
  }

  /** The `file_path` sent to the server — the original filename for a file source, a synthesized one for bytes. */
  get filePath(): string {
    return this.source.filePath;
  }

  /** After commit: `true` if these bytes were uploaded, `false` if the server deduped against an existing copy. `null` before commit. */
  get createdNew(): boolean | null {
    return this.createdNewValue;
  }

  /** The local blake3 (computed once, lazily). */
  async hash(): Promise<string> {
    this.hashValue ??= await this.source.hasher();
    return this.hashValue;
  }

  /**
   * Adopt a resolved `Asset` model's identity. Not part of the public
   * surface — used internally after a commit and by
   * {@link AssetFactory.get} to rehydrate an already-committed handle.
   */
  adopt(asset: LowAsset): void {
    this.idValue = asset.id;
    if (asset.hash) this.hashValue = asset.hash;
    this.createdNewValue = asset.created_new ?? null;
  }

  /** Force the hash/dedup/upload now; return the asset UUID. */
  async commit(signal?: AbortSignal): Promise<string> {
    if (this.idValue !== undefined) return this.idValue;
    const digest = await this.hash();
    const asset = await translate(async () => {
      if (await this.low.headAssetByHash(digest, { signal })) {
        return this.low.assetFromHash(digest, { filePath: this.source.filePath, signal });
      }
      const blob = await this.source.opener();
      return this.low.postAssets(blob, this.source.contentType, this.source.filePath, {
        expectedHash: digest,
        idempotencyKey: this.idempotencyKey,
        signal,
      });
    });
    this.adopt(asset);
    return this.idValue!;
  }

  /** The `core/ASSET` object (commits first if needed). */
  async asReference(signal?: AbortSignal) {
    await this.commit(signal);
    return assetReference(this.idValue!, { hash: this.hashValue, filePath: this.source.filePath });
  }

  /**
   * Delete this asset from storage. The handle has no id afterward, so a
   * further `commit()` would re-hash/re-upload as if this were a fresh
   * handle rather than raise. Throws if this handle was never committed —
   * there is nothing to delete yet.
   */
  async delete(signal?: AbortSignal): Promise<void> {
    if (this.idValue === undefined) {
      throw new Error("cannot delete an uncommitted asset");
    }
    await translate(() => this.low.deleteAsset(this.idValue!, { signal }));
    this.idValue = undefined;
  }
}

/** `client.assets` — alternative constructors for {@link Asset}. */
export class AssetFactory {
  private readonly low: ComfyLow;

  constructor(low: ComfyLow) {
    this.low = low;
  }

  /**
   * A lazy handle to a file on disk — the cheapest source, and the only one
   * that stays lazy end to end: nothing is read, hashed, or uploaded until
   * the asset is actually used.
   */
  fromFile(path: string): Asset {
    return new Asset(this.low, fileSource(path));
  }

  /**
   * A handle to bytes already in memory. Supply `filename`/`contentType` when
   * the server should see something more specific than the defaults.
   */
  fromBytes(data: Uint8Array, options: { filename?: string; contentType?: string } = {}): Asset {
    return new Asset(this.low, bytesSource(data, options.filename, options.contentType));
  }

  /**
   * Buffers the stream fully so the dedup probe can hash before upload
   * (the bytes must be re-readable for the upload itself). If the source
   * is a file, prefer {@link fromFile} — it stays lazy end to end.
   */
  async fromStream(
    stream: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
    options: { filename?: string; contentType?: string } = {},
  ): Promise<Asset> {
    const data = await bufferStream(stream);
    return new Asset(this.low, bytesSource(data, options.filename, options.contentType));
  }

  /** Client-side download (not a server-side fetch): the bytes must
   * transit the same blake3 -> dedup -> upload pipeline as every other
   * source. */
  async fromUrl(url: string): Promise<Asset> {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(`failed to download ${url}: HTTP ${response.status}`);
    }
    const data = new Uint8Array(await response.arrayBuffer());
    const filename = basename(new URL(url).pathname) || "download.bin";
    const contentType = response.headers.get("Content-Type")?.split(";")[0] || undefined;
    return new Asset(this.low, bytesSource(data, filename, contentType));
  }

  /** Rehydrate an already-committed asset by UUID. */
  async get(assetId: string): Promise<Asset> {
    const model = await translate(() => this.low.getAsset(assetId));
    const asset = new Asset(this.low, {
      contentType: model.content_type,
      filePath: model.file_path ?? assetId,
      hasher: async () => model.hash ?? "",
      opener: noOpener,
    });
    asset.adopt(model);
    return asset;
  }

  /** Delete an asset by UUID, without fetching it first. */
  async delete(assetId: string, signal?: AbortSignal): Promise<void> {
    await translate(() => this.low.deleteAsset(assetId, { signal }));
  }
}

async function bufferStream(
  stream: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
): Promise<Uint8Array> {
  if (Symbol.asyncIterator in stream) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
      total += chunk.length;
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  }
  throw new TypeError("stream must be async-iterable (a Node Readable or a web ReadableStream)");
}
