import { describe, expect, it } from "vitest";

import { iterateSse, type RawEvent } from "./sse.js";

function streamOfBytes(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function streamOf(...texts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return streamOfBytes(texts.map((t) => enc.encode(t)));
}

async function collect(body: ReadableStream<Uint8Array>): Promise<RawEvent[]> {
  const out: RawEvent[] = [];
  for await (const event of iterateSse(body)) out.push(event);
  return out;
}

describe("iterateSse", () => {
  it("joins multiple data: lines in one frame with newlines", async () => {
    const events = await collect(streamOf("event: log\ndata: line one\ndata: line two\n\n"));
    expect(events).toEqual([{ event: "log", data: { raw: "line one\nline two" } }]);
  });

  it("ignores comment/keepalive lines but keeps surrounding events in order", async () => {
    const events = await collect(
      streamOf('event: a\ndata: {"x":1}\n\n', ": keepalive\n\n", 'event: b\ndata: {"y":2}\n\n'),
    );
    expect(events.map((e) => e.event)).toEqual(["a", "b"]);
    expect(events[0].data).toEqual({ x: 1 });
    expect(events[1].data).toEqual({ y: 2 });
  });

  it("drops a frame that has an event name but no data line", async () => {
    expect(await collect(streamOf("event: ping\n\n"))).toEqual([]);
  });

  it("keeps an `error` frame whose data line is empty, but drops any other empty one", async () => {
    const events = await collect(streamOf("event: ping\ndata:\n\n", "event: error\ndata:\n\n"));
    expect(events).toEqual([{ event: "error", data: { raw: "" } }]);
  });

  it("reassembles a frame split across chunk boundaries, including mid-UTF-8", async () => {
    const enc = new TextEncoder();
    const frame = enc.encode('event: message\ndata: {"m":"\u{1F600}ok"}\n\n');
    // Split into 3-byte chunks, guaranteeing a break inside the 4-byte emoji.
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < frame.length; i += 3) chunks.push(frame.subarray(i, i + 3));
    const events = await collect(streamOfBytes(chunks));
    expect(events).toEqual([{ event: "message", data: { m: "\u{1F600}ok" } }]);
  });

  it("wraps non-object JSON in {value} and non-JSON in {raw}", async () => {
    const events = await collect(streamOf("data: 42\n\n", "data: not json at all\n\n"));
    expect(events[0].data).toEqual({ value: 42 });
    expect(events[1].data).toEqual({ raw: "not json at all" });
  });

  it("defaults a frame with no event field to the 'message' type", async () => {
    const events = await collect(streamOf('data: {"ok":true}\n\n'));
    expect(events).toEqual([{ event: "message", data: { ok: true } }]);
  });

  it("errors on a silently-stalled ('zombie') stream instead of hanging", async () => {
    const enc = new TextEncoder();
    // Emit two frames, then hold the stream open and silent forever (no close,
    // no keepalive) — the "zombie" a long-job SSE connection can become.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('event: status\ndata: {"status":"running"}\n\n'));
        controller.enqueue(enc.encode('event: progress\ndata: {"value":0.3}\n\n'));
      },
    });
    const got: RawEvent[] = [];
    const t0 = Date.now();
    await expect(
      (async () => {
        for await (const ev of iterateSse(body, { idleTimeoutMs: 100 })) got.push(ev);
      })(),
    ).rejects.toThrow(/idle timeout/i);
    // Delivered the pre-stall frames, then errored quickly (didn't block).
    expect(got.length).toBe(2);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
