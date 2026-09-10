/**
 * Server-Sent-Events decoding over a `fetch` response body.
 *
 * Deliberately built on `eventsource-parser` over the raw fetch stream, not
 * the `EventSource` global: the global can't send headers (no
 * `Authorization`/`Accept`) and can't be aborted per-request, both of which
 * this transport needs. Mirrors the wire-format contract of `comfy_low.sse`
 * in the Python SDK (a `RawEvent` per frame, `event` defaults to `message`),
 * but the parsing itself is delegated to `eventsource-parser` rather than
 * hand-rolled, since JS has no sans-IO decoder to share between a sync and
 * an async transport the way Python's dual sync/async layers did.
 */

import { EventSourceParserStream } from "eventsource-parser/stream";

export interface RawEvent {
  event: string;
  data: Record<string, unknown>;
}

function parseData(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { raw };
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return { value: parsed };
}

/**
 * Default read-idle timeout for the SSE byte stream. The server sends keepalive
 * comments well within this window, so no *bytes at all* for this long means a
 * silently-stalled ("zombie") connection — open but delivering nothing, not
 * legitimately idle. We error the stream in that case so the caller's
 * reconnect/poll fallback runs (see `Job.events`) instead of hanging forever.
 * The timeout is at the byte level, not the parsed-message level, so keepalive
 * comments (which `eventsource-parser` drops) still count as liveness.
 */
export const SSE_IDLE_TIMEOUT_MS = 45_000;

/** A pass-through stream that errors if no chunk arrives within `ms`. */
function idleTimeout(
  ms: number,
): TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
  };
  const arm = (controller: TransformStreamDefaultController<Uint8Array<ArrayBuffer>>) => {
    clear();
    timer = setTimeout(
      () => controller.error(new Error(`SSE idle timeout: no data for ${ms}ms`)),
      ms,
    );
  };
  return new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    start: arm,
    transform(chunk, controller) {
      arm(controller);
      controller.enqueue(chunk);
    },
    flush: clear,
    cancel: clear,
  });
}

/**
 * Decode a fetch response body into a stream of {@link RawEvent}s.
 *
 * No cursor/replay support by design — the contract carries no `id`/
 * `Last-Event-ID`; a blank `data:` frame (no payload) is dropped, matching
 * the Python decoder. A read-idle timeout (default {@link SSE_IDLE_TIMEOUT_MS})
 * errors a silently-stalled connection instead of blocking forever.
 */
export async function* iterateSse(
  // Over a plain `ArrayBuffer`, not `ArrayBufferLike`: that is what a fetch
  // body is, and what `TextDecoderStream` accepts once the two are told apart
  // (`@types/node` >= 26).
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  options: { idleTimeoutMs?: number } = {},
): AsyncGenerator<RawEvent, void, void> {
  const stream = body
    .pipeThrough(idleTimeout(options.idleTimeoutMs ?? SSE_IDLE_TIMEOUT_MS))
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream());

  for await (const message of stream) {
    if (message.data === "") {
      continue;
    }
    yield { event: message.event || "message", data: parseData(message.data) };
  }
}
