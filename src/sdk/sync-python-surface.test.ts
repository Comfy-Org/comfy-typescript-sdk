/**
 * The retry in front of the one network call this repo's CI makes.
 *
 * `sdk-parity` is the only job that leaves the runner, and its whole value is
 * that a red means "the sibling SDK moved". A transient `ECONNRESET` from
 * `raw.githubusercontent.com` reddens it identically, which trains a reader to
 * re-run instead of to look — and the next real drift gets read as a flake
 * too. These tests pin the two halves of the rule that keeps the signal clean:
 * a blip is ridden out, and a definite answer is NOT retried into ambiguity.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchSource } from "../../scripts/sync-python-surface.mjs";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** A `fetch` that fails the first `failures` calls, then answers with `body`. */
function flakyFetch(failures: number, body: string, error: () => unknown) {
  let calls = 0;
  return vi.fn(() => {
    calls += 1;
    if (calls <= failures) return Promise.reject(error());
    return Promise.resolve(new Response(body, { status: 200 }));
  });
}

/** What `undici` actually throws on a reset TLS socket, shape included. */
function connectionReset() {
  return new TypeError("fetch failed", {
    cause: Object.assign(
      new Error("Client network socket disconnected before secure TLS connection was established"),
      { code: "ECONNRESET" },
    ),
  });
}

describe("fetchSource", () => {
  it("returns the body without retrying when the first attempt succeeds", async () => {
    const fetchMock = flakyFetch(0, "ok", connectionReset);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchSource("main", "src/comfy_sdk/models.py")).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rides out a transport blip and returns the body", async () => {
    // Three failures is the most the backoff schedule can absorb, so this
    // also pins that the loop really makes four attempts and not three.
    const fetchMock = flakyFetch(3, "recovered", connectionReset);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchSource("main", "src/comfy_sdk/models.py")).resolves.toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("gives up after the last attempt, naming the attempt count and the cause", async () => {
    const fetchMock = flakyFetch(Infinity, "", connectionReset);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchSource("main", "src/comfy_sdk/models.py")).rejects.toThrow(
      /failed after 4 attempts/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retries a 503, which is the server saying `not now`", async () => {
    let calls = 0;
    const fetchMock = vi.fn(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(new Response("", { status: 503 }));
      return Promise.resolve(new Response("ok", { status: 200 }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchSource("main", "src/comfy_sdk/models.py")).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 404, and says the file may have moved", async () => {
    // The whole point of the distinction: a 404 is a definite answer the
    // caller needs promptly, and four attempts arrive at the same one while
    // making a moved file look like a flaky network.
    const fetchMock = vi.fn(() => Promise.resolve(new Response("", { status: 404 })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchSource("main", "src/comfy_sdk/gone.py")).rejects.toThrow(
      /PYTHON_SOURCE_FILES/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
