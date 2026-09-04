/**
 * Local blake3 content hashing (via `hash-wasm`, which runs anywhere Node
 * runs — no native addon).
 *
 * The hash is computed client-side purely as a dedup hint — the server
 * always recomputes it from the received bytes and that value is
 * authoritative. Files are hashed by streaming in chunks so a multi-GB
 * input is never buffered whole. Mirrors `comfy_sdk._hashing` in the
 * Python SDK.
 */

import { createBLAKE3 } from "hash-wasm";

/** `blake3:<hex>` of an in-memory buffer. */
export async function hashBytes(data: Uint8Array): Promise<string> {
  const hasher = await createBLAKE3();
  hasher.init();
  hasher.update(data);
  return `blake3:${hasher.digest()}`;
}

/**
 * `blake3:<hex>` of a file on disk, streamed in chunks.
 *
 * Node-only. `node:fs` is imported here rather than at module scope so this
 * module carries no static Node built-in import and stays loadable in a
 * browser, where only {@link hashBytes} is reachable.
 */
export async function hashFile(path: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const hasher = await createBLAKE3();
  hasher.init();
  for await (const chunk of createReadStream(path)) {
    hasher.update(chunk as Buffer);
  }
  return `blake3:${hasher.digest()}`;
}
