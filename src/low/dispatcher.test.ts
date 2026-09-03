/**
 * undici's `headersTimeout`/`bodyTimeout` used to cap every request at 300 s
 * whatever deadline the caller asked for. The proof is deliberately not five
 * real minutes of waiting: a server that withholds response headers behaves
 * identically at 250 ms and at 300 s, so the wall-clock tests run against a
 * tiny limit and the 300 s boundary itself is covered by asserting the limit
 * each deadline derives.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  delegateWithLimits,
  inactivityLimitMs,
  withInactivityLimits,
  type InactivityDispatcher,
} from "./dispatcher.js";
import { ComfyLow } from "./transport.js";

/** undici's own default for both limits — the wall this module removes. */
const UNDICI_DEFAULT_MS = 300_000;

/** The process-wide undici dispatcher this module delegates to. */
const GLOBAL_DISPATCHER_KEY = Symbol.for("undici.globalDispatcher.1");

/**
 * A server that accepts the connection and then never writes anything — the
 * shape of a Comfy Router call that polls a provider inside the request, where
 * not even the response headers arrive until the generation is done.
 */
class SilentServer {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  baseUrl = "";

  constructor() {
    this.server = createServer(() => {
      // Deliberately no response, ever.
    });
    this.server.on("connection", (socket) => this.sockets.add(socket));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${String(port)}`;
  }

  async stop(): Promise<void> {
    // A withheld response leaves the socket open on both ends; `close()` alone
    // would wait for a request that never finishes.
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** The `cause.code` undici attaches when one of its own timers fires. */
function causeCode(error: unknown): unknown {
  return (error as { cause?: { code?: unknown } }).cause?.code;
}

describe("inactivityLimitMs", () => {
  // The 300s boundary in both directions: below it undici's default was never
  // the binding constraint, above it the default silently was.
  const cases: [label: string, deadlineMs: number | null, expected: number][] = [
    ["the transport's own default", 30_000, 60_000],
    ["just under undici's default", 299_000, 329_000],
    ["just over undici's default", 300_001, 330_001],
    ["the models.run default deadline", 600_000, 630_000],
    ["a long video budget", 660_000, 690_000],
    ["a deadline already elapsed", 0, 30_000],
    ["a negative remaining budget", -5_000, 30_000],
    ["no deadline at all", null, 0],
  ];

  it.each(cases)("derives the limit for %s", (_label, deadlineMs, expected) => {
    expect(inactivityLimitMs(deadlineMs)).toBe(expected);
  });

  it("always leaves the deadline room to fire first", () => {
    for (const [, deadlineMs] of cases) {
      if (deadlineMs === null) continue;
      expect(inactivityLimitMs(deadlineMs)).toBeGreaterThan(deadlineMs);
    }
  });

  it("lifts the limit above undici's 300s default exactly when the deadline is", () => {
    expect(inactivityLimitMs(299_000)).toBeGreaterThan(UNDICI_DEFAULT_MS);
    expect(inactivityLimitMs(300_001)).toBeGreaterThan(UNDICI_DEFAULT_MS);
    expect(inactivityLimitMs(660_000)).toBeGreaterThan(UNDICI_DEFAULT_MS);
  });

  it("imposes no limit at all rather than one a timer would wrap around", () => {
    // A limit clamped to the timer ceiling would sit BELOW such a deadline,
    // which is the defect over again.
    expect(inactivityLimitMs(2_147_453_647)).toBe(2_147_483_647); // the last expressible one
    expect(inactivityLimitMs(2_147_453_648)).toBe(0);
    expect(inactivityLimitMs(Number.MAX_SAFE_INTEGER)).toBe(0);
    expect(inactivityLimitMs(Number.POSITIVE_INFINITY)).toBe(0);
    expect(inactivityLimitMs(Number.NaN)).toBe(0);
  });
});

describe("delegateWithLimits", () => {
  it("forwards to the inner dispatcher with both limits applied", () => {
    const seen: Record<string, unknown>[] = [];
    const inner = {
      dispatch(options: Record<string, unknown>) {
        seen.push(options);
        return true;
      },
    };
    const handler = {};

    const delegate = delegateWithLimits(inner, 690_000);
    expect(delegate.dispatch({ method: "POST", path: "/run" }, handler)).toBe(true);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      method: "POST",
      path: "/run",
      headersTimeout: 690_000,
      bodyTimeout: 690_000,
    });
    // Both, not just headers: `bodyTimeout` governs inter-chunk inactivity, so
    // raising only `headersTimeout` would relocate the wall rather than
    // remove it.
    expect(delegate.headersTimeout).toBe(690_000);
    expect(delegate.bodyTimeout).toBe(690_000);
  });

  it("overrides a limit the caller's own options carried", () => {
    let seen: Record<string, unknown> | undefined;
    const inner = {
      dispatch(options: Record<string, unknown>) {
        seen = options;
        return false;
      },
    };
    delegateWithLimits(inner, 0).dispatch({ headersTimeout: 300_000, bodyTimeout: 300_000 }, {});
    expect(seen).toEqual({ headersTimeout: 0, bodyTimeout: 0 });
  });
});

describe("withInactivityLimits", () => {
  it("attaches a dispatcher carrying the derived limits, leaving the rest of the init alone", () => {
    const signal = AbortSignal.timeout(1_000);
    const init = withInactivityLimits({ method: "POST", signal }, 660_000);
    expect(init.method).toBe("POST");
    expect(init.signal).toBe(signal);
    const dispatcher = init.dispatcher as unknown as InactivityDispatcher;
    expect(dispatcher.headersTimeout).toBe(690_000);
    expect(dispatcher.bodyTimeout).toBe(690_000);
  });

  it("delegates to the dispatcher the process already uses rather than pooling its own", () => {
    // Nothing here constructs an `Agent`: the host's connection pools — and
    // any proxy agent it installed — are what actually carry the request.
    const inner = (globalThis as unknown as Record<symbol, unknown>)[GLOBAL_DISPATCHER_KEY];
    expect(inner).toBeDefined();
    const first = withInactivityLimits({}, 600_000).dispatcher;
    const second = withInactivityLimits({}, 600_000).dispatcher;
    expect(first).not.toBe(second);
  });
});

describe("undici's inactivity limits against a server that withholds headers", () => {
  let server: SilentServer;

  beforeEach(async () => {
    server = new SilentServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("really is undici's clock: a tiny limit ends the request as a headers timeout", async () => {
    // The load-bearing runtime assumption, asserted rather than believed —
    // that `fetch` accepts this delegate and that the limits it injects are
    // the ones undici enforces. Without it the rest of this file would pass
    // against a dispatcher `fetch` quietly ignored.
    const inner = (globalThis as unknown as Record<symbol, never>)[GLOBAL_DISPATCHER_KEY];
    const dispatcher = delegateWithLimits(inner, 250);
    const error = await fetch(server.baseUrl, { dispatcher } as RequestInit).then(
      () => undefined,
      (exc: unknown) => exc,
    );
    expect(causeCode(error)).toBe("UND_ERR_HEADERS_TIMEOUT");
  }, 10_000);

  it("aborts on the caller's deadline, not on a headers timeout", async () => {
    // A short deadline stands in for a long one: the server withholds headers
    // for as long as either clock cares to wait, so which clock fires is the
    // only thing under test.
    const low = new ComfyLow(server.baseUrl, undefined, { timeoutMs: 300 });
    const startedAt = Date.now();
    const error = await low.getJob("job_01").then(
      () => undefined,
      (exc: unknown) => exc,
    );
    // Both halves matter: the deadline is what fired, and it fired on time.
    expect((error as Error).name).toBe("TimeoutError");
    expect(causeCode(error)).not.toBe("UND_ERR_HEADERS_TIMEOUT");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  }, 10_000);
});

describe("ComfyLow hands every request limits derived from its own deadline", () => {
  // Table-driven across undici's 300s default, which is the point: the same
  // code path has to reach a dispatcher limit above the wall for a long
  // deadline and below it for a short one.
  const cases: [label: string, timeoutMs: number | null | undefined, expected: number][] = [
    ["the client default when the caller passes none", undefined, 60_000],
    ["a deadline under undici's default", 120_000, 150_000],
    ["a deadline over undici's default", 400_000, 430_000],
    ["a long video budget", 660_000, 690_000],
    ["no deadline at all", null, 0],
  ];

  it.each(cases)("uses %s", async (_label, timeoutMs, expected) => {
    let seen: RequestInit | undefined;
    const low = new ComfyLow("http://127.0.0.1:1", undefined, {
      fetch: (_url, init) => {
        seen = init;
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
    });

    await low.request("GET", "/jobs/job_01", { timeoutMs });

    const dispatcher = seen?.dispatcher as unknown as InactivityDispatcher;
    expect(dispatcher.headersTimeout).toBe(expected);
    expect(dispatcher.bodyTimeout).toBe(expected);
    if (typeof timeoutMs === "number") {
      expect(dispatcher.headersTimeout).toBeGreaterThan(timeoutMs);
    }
  });
});
