import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StubServer } from "../../test/support/stub-server.js";
import { ComfyLow } from "../low/index.js";
import { AssetFactory } from "./assets.js";
import { HashMismatch, NotFound } from "./exceptions.js";

describe("AssetFactory / Asset", () => {
  let server: StubServer;
  let assets: AssetFactory;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
    assets = new AssetFactory(new ComfyLow(server.baseUrl));
  });

  afterEach(async () => {
    await server.stop();
  });

  it("is lazy: constructing an asset handle does no network I/O", () => {
    const asset = assets.fromBytes(new Uint8Array([1, 2, 3]));
    expect(asset.id).toBeUndefined();
    expect(server.state.uploadCount + server.state.headCount + server.state.fromHashCount).toBe(0);
  });

  it("dedup fast-path: a known hash mints via from-hash, never uploads", async () => {
    server.state.serverHash = `blake3:${"cc".repeat(32)}`;
    const data = new Uint8Array([9, 9, 9]);
    const asset = assets.fromBytes(data, { filename: "x.bin" });
    const digest = await asset.hash();
    server.state.knownHashes.add(digest);

    const id = await asset.commit();

    expect(id).toBe("asset_dedup_01");
    expect(server.state.headCount).toBe(1);
    expect(server.state.fromHashCount).toBe(1);
    expect(server.state.uploadCount).toBe(0);
  });

  it("jobId and expiresAt are absent for an uploaded asset (no producing job)", async () => {
    const asset = assets.fromBytes(new Uint8Array([1, 2, 3]), { filename: "x.bin" });
    expect(asset.jobId).toBeUndefined();
    expect(asset.expiresAt).toBeUndefined();
    await asset.commit();
    expect(asset.jobId).toBeUndefined();
    expect(asset.expiresAt).toBeUndefined();
  });

  it("file uploads stream a disk-backed Blob (fromFile stays lazy end to end)", async () => {
    // The real "not buffered whole" guarantee is exercised at the transport
    // level (transport.test.ts asserts the server sees multiple `data`
    // events for a multi-MB body); this checks the asset layer wires a
    // disk-backed `fs.openAsBlob()` Blob through rather than reading the
    // file into a Buffer first.
    const dir = await mkdtemp(join(tmpdir(), "comfy-sdk-"));
    const path = join(dir, "photo.png");
    const size = 256 * 1024;
    await writeFile(path, Buffer.alloc(size, 5));
    try {
      const asset = assets.fromFile(path);
      const id = await asset.commit();
      expect(id).toBe("asset_uploaded_01");
      expect(asset.createdNew).toBe(true);
      expect(server.state.lastUploadContentLength).toBeGreaterThanOrEqual(size);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("hash_mismatch is surfaced as a typed error without a blind retry", async () => {
    server.state.rejectHashMismatch = true;
    const asset = assets.fromBytes(new Uint8Array([1, 2, 3]), { filename: "x.bin" });
    await expect(asset.commit()).rejects.toBeInstanceOf(HashMismatch);
    expect(server.state.uploadCount).toBe(1);
    // A second commit() attempt does not silently retry past the failure —
    // the handle never adopted an id, so a fresh commit() re-attempts once,
    // not in a retry loop.
    server.state.rejectHashMismatch = false;
    const id = await asset.commit();
    expect(id).toBe("asset_uploaded_01");
    expect(server.state.uploadCount).toBe(2);
  });

  it("asReference() commits first, then returns the core/ASSET object", async () => {
    const asset = assets.fromBytes(new Uint8Array([4, 5, 6]), { filename: "y.bin" });
    const ref = await asset.asReference();
    expect(ref.__type).toBe("core/ASSET");
    expect(ref.info.id).toBe(asset.id);
  });

  it("get() rehydrates an already-committed asset without an opener", async () => {
    const asset = await assets.get("asset_existing");
    expect(asset.id).toBe("asset_existing");
    expect(asset.createdNew).toBe(false);
  });

  it("get() rehydrates a model with no recorded hash: hash() resolves to an empty string, not a real hash", async () => {
    // `adopt()` only sets the cached hash when the server model carries one
    // (`if (asset.hash) ...`); this pins what happens when it does not — the
    // rehydrated handle has no bytes to hash locally, so `hash()` must
    // resolve via the model's (empty) value instead of throwing or trying
    // to open a file/stream that was never opener'd in the first place.
    server.state.getAssetHashOverride = null;
    const asset = await assets.get("asset_existing");
    expect(asset.id).toBe("asset_existing");
    await expect(asset.hash()).resolves.toBe("");
  });

  it("fromStream buffers a Node Readable, then commits like any other source", async () => {
    const { Readable } = await import("node:stream");
    const stream = Readable.from([Buffer.from("chunk-1-"), Buffer.from("chunk-2")]);
    const asset = await assets.fromStream(stream, { filename: "s.bin" });
    const id = await asset.commit();
    expect(id).toBe("asset_uploaded_01");
  });

  it("fromUrl downloads bytes client-side and runs them through the same pipeline", async () => {
    server.state.contentBytes = Buffer.from("downloaded-bytes");
    const asset = await assets.fromUrl(`${server.baseUrl}/api/v2/assets/whatever/content`);
    const id = await asset.commit();
    expect(id).toBe("asset_uploaded_01");
    // Multipart framing adds overhead on top of the raw payload bytes.
    expect(server.state.lastUploadContentLength).toBeGreaterThanOrEqual(
      Buffer.byteLength("downloaded-bytes"),
    );
  });

  it("fromUrl routes the download through the client's injected fetch, not a raw global fetch", async () => {
    server.state.contentBytes = Buffer.from("downloaded-bytes");
    let injectedFetchCalls = 0;
    const countingFetch: typeof fetch = (...args) => {
      injectedFetchCalls += 1;
      return fetch(...args);
    };
    const injectedAssets = new AssetFactory(
      new ComfyLow(server.baseUrl, undefined, { fetch: countingFetch }),
    );
    await injectedAssets.fromUrl(`${server.baseUrl}/api/v2/assets/whatever/content`);
    // Checked before any commit()/upload call, so this isolates the download
    // itself — a raw global `fetch(...)` in `fromUrl` would leave this at 0.
    expect(injectedFetchCalls).toBeGreaterThan(0);
  });

  it("fromUrl attaches the bearer token same-origin but not to a third-party origin", async () => {
    // Ported from transport.test.ts's cross-origin urls.self/events/cancel
    // coverage — fromUrl's own routing through low.request (not a raw
    // fetch) needs the same regression pin, so moving it back to a raw
    // fetch later trips a test. Asserting the positive (same-origin) case
    // too proves the negative isn't just vacuously true.
    const thirdParty = new StubServer();
    await thirdParty.start();
    try {
      server.state.contentBytes = Buffer.from("same-origin-bytes");
      thirdParty.state.contentBytes = Buffer.from("third-party-bytes");
      const authedAssets = new AssetFactory(new ComfyLow(server.baseUrl, "top-secret-key"));

      // Same-origin download (the client's own baseUrl): the key IS sent.
      await authedAssets.fromUrl(`${server.baseUrl}/api/v2/assets/whatever/content`);
      expect(server.state.lastAuthorizationHeader).toBe("Bearer top-secret-key");

      // Downloading from a third-party origin crosses origins — the key
      // must NOT follow it there.
      await authedAssets.fromUrl(`${thirdParty.baseUrl}/api/v2/assets/whatever/content`);
      expect(thirdParty.state.lastAuthorizationHeader).toBeNull();
    } finally {
      await thirdParty.stop();
    }
  });

  // -- delete -----------------------------------------------------------

  it("delete() removes a committed asset and clears its id", async () => {
    const asset = assets.fromBytes(new Uint8Array([1, 2, 3]), { filename: "z.bin" });
    const id = await asset.commit();
    await asset.delete();
    expect(asset.id).toBeUndefined();
    expect(server.state.deleteCount).toBe(1);
    expect(server.state.deletedAssets.has(id)).toBe(true);
  });

  it("delete() on an uncommitted asset throws without calling the server", async () => {
    const asset = assets.fromBytes(new Uint8Array([1]), { filename: "z.bin" });
    await expect(asset.delete()).rejects.toThrow(/uncommitted/);
    expect(server.state.deleteCount).toBe(0);
  });

  it("assets.delete(id) deletes by id without fetching first", async () => {
    await assets.delete("asset_existing");
    expect(server.state.deleteCount).toBe(1);
    expect(server.state.deletedAssets.has("asset_existing")).toBe(true);
  });

  it("a repeat delete of the same id surfaces the typed NotFound error", async () => {
    await assets.delete("asset_gone");
    await expect(assets.delete("asset_gone")).rejects.toBeInstanceOf(NotFound);
  });
});
