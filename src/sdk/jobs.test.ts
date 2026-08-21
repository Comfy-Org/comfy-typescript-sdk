import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StubServer } from "../../test/support/stub-server.js";
import { ComfyLow } from "../low/index.js";
import { abortableSleep } from "./abortable-sleep.js";
import { JobFailed, NotFound } from "./exceptions.js";
import { JobFactory } from "./jobs.js";

// Spies on (not replaces) abortableSleep by default, so every other test
// here still sleeps for real; only the clamp test below overrides a single
// call to avoid actually waiting out a clamped-but-still-long pause.
vi.mock("./abortable-sleep.js", { spy: true });

describe("Job", () => {
  let server: StubServer;
  let jobs: JobFactory;
  let low: ComfyLow;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
    low = new ComfyLow(server.baseUrl);
    jobs = new JobFactory(low);
  });

  afterEach(async () => {
    await server.stop();
    vi.mocked(abortableSleep).mockClear();
  });

  it("result() polls to a terminal state without ever touching SSE", async () => {
    server.state.pollsToSucceed = 3;
    const job = await jobs.get("job_01");
    await job.result();
    expect(job.status).toBe("succeeded");
    expect(job.outputs).toHaveLength(1);
    expect(server.state.jobPollCount).toBeGreaterThanOrEqual(3);
    expect(server.state.eventsConnectCount).toBe(0);
  });

  it("result() throws JobFailed for a non-success terminal state", async () => {
    server.state.terminalStatus = "failed";
    const job = await jobs.get("job_01");
    await expect(job.result()).rejects.toBeInstanceOf(JobFailed);
  });

  it("cancel() moves the job to canceling", async () => {
    const job = await jobs.get("job_01");
    await job.cancel();
    expect(job.status).toBe("canceling");
  });

  it("workflow() surfaces the executed graph with format 'api'", async () => {
    server.state.jobWorkflow = {
      workflow: { "1": { class_type: "KSampler", inputs: {} } },
      format: "api",
    };
    const job = await jobs.get("job_01");
    const result = await job.getWorkflow();
    expect(result.format).toBe("api");
    expect(result.workflow).toEqual({ "1": { class_type: "KSampler", inputs: {} } });
  });

  it("workflow() surfaces the pinned authoring graph with format 'save'", async () => {
    server.state.jobWorkflow = { workflow: { nodes: [], links: [] }, format: "save" };
    const job = await jobs.get("job_01");
    const result = await job.getWorkflow();
    expect(result.format).toBe("save");
    expect(result.workflow).toEqual({ nodes: [], links: [] });
  });

  it("workflow() raises the SDK's normal NotFound, not something bespoke, for a job with none recorded", async () => {
    const job = await jobs.get("job_01");
    await expect(job.getWorkflow()).rejects.toBeInstanceOf(NotFound);
  });

  it("events() consumes the full typed SSE frame sequence to terminal", async () => {
    const job = await jobs.get("job_01");
    const kinds: string[] = [];
    for await (const event of job.events()) {
      kinds.push(event.kind);
    }
    expect(kinds).toEqual(["statusChange", "progress", "outputReady", "statusChange"]);
  });

  it("events() reconnects after a mid-stream drop without replaying old frames", async () => {
    server.state.sseMode = "reconnect";
    server.state.pollsToSucceed = 100; // never resolves via poll during the gap
    const job = await jobs.get("job_01");
    const progressValues: number[] = [];
    let terminal = false;
    for await (const event of job.events()) {
      if (event.kind === "progress") progressValues.push(event.value);
      if (event.kind === "statusChange" && event.status === "succeeded") terminal = true;
    }
    expect(terminal).toBe(true);
    // Exactly one 0.4 from the dropped first connection, one 0.5 from the
    // second — no duplicate/replayed frame from the connection that dropped.
    expect(progressValues).toEqual([0.4, 0.5]);
    expect(server.state.eventsConnectCount).toBe(2);
  });

  it("events() settles from the poll backstop without a second SSE connection when the drop leaves the job already terminal", async () => {
    server.state.sseMode = "reconnect"; // first stream drops before a terminal frame
    server.state.pollsToSucceed = 1; // the very next poll already reports terminal
    const job = await jobs.get("job_01");
    let terminal = false;
    for await (const event of job.events()) {
      if (event.kind === "statusChange" && event.status === "succeeded") terminal = true;
    }
    expect(terminal).toBe(true);
    // The poll backstop resolved the terminal state, so no reconnect happened.
    expect(server.state.eventsConnectCount).toBe(1);
  });

  it("events() suppresses a progress value that regresses across a reconnect (monotonic)", async () => {
    server.state.sseMode = "reconnect";
    server.state.pollsToSucceed = 100; // force a real second SSE connection
    server.state.firstReconnectProgress = 0.5; // the dropped first stream is higher
    server.state.progressValue = 0.2; // the reconnected stream replays a LOWER value
    const job = await jobs.get("job_01");
    const progressValues: number[] = [];
    for await (const event of job.events()) {
      if (event.kind === "progress") progressValues.push(event.value);
    }
    // The regressed 0.2 is dropped — a consumer's progress never goes backwards.
    expect(progressValues).toEqual([0.5]);
    expect(server.state.eventsConnectCount).toBe(2);
  });

  it("wait() stops promptly when its AbortSignal aborts during the poll backoff, instead of hanging", async () => {
    server.state.pollsToSucceed = 1_000_000; // never terminal via polling
    const job = await jobs.get("job_01");
    const controller = new AbortController();
    const promise = job.wait(undefined, controller.signal);
    setTimeout(() => controller.abort(), 30);
    const start = Date.now();
    await expect(promise).rejects.toBeTruthy();
    // The first backoff step is 500ms; aborting mid-wait must interrupt
    // that sleep, not merely the in-flight fetch.
    expect(Date.now() - start).toBeLessThan(400);
  }, 2000);

  it("events() terminates on a 501 not_implemented instead of reconnect-storming", async () => {
    server.state.eventsStatus = 501;
    server.state.eventsErrorCode = "not_implemented";
    server.state.pollsToSucceed = 1_000_000; // never terminal via polling either
    const job = await jobs.get("job_01");
    const events: unknown[] = [];
    for await (const event of job.events()) {
      events.push(event);
    }
    // 501 ends the generator directly — no fabricated terminal frame, no
    // poll fallback, and exactly one SSE attempt (the whole point: the old
    // catch swallowed this into a 100ms reconnect loop for the job's life).
    expect(events).toEqual([]);
    expect(server.state.eventsConnectCount).toBe(1);
    // pollCount is 1 from jobs.get() above, not from events() — 501 must add none.
    expect(server.state.jobPollCount).toBe(1);
  });

  it("events() honours Retry-After on a 429, instead of the fixed reconnect cadence", async () => {
    server.state.eventsStatus = 429;
    server.state.eventsErrorCode = "too_many_streams";
    server.state.retryAfterHeader = "5"; // seconds — far longer than RECONNECT_PAUSE_MS (100ms)
    server.state.pollsToSucceed = 1_000_000; // poll backstop never resolves either
    const job = await jobs.get("job_01");
    const controller = new AbortController();
    const iterator = job.events(controller.signal);
    setTimeout(() => controller.abort(), 300);
    await expect(iterator.next()).rejects.toBeTruthy(); // aborted mid reconnect-pause
    // One SSE attempt, one poll refresh (that precedes the pause) beyond
    // jobs.get()'s own poll above — at the old fixed 100ms cadence, a 300ms
    // window would have produced several of each. This is the
    // request-amplification assertion.
    expect(server.state.eventsConnectCount).toBe(1);
    expect(server.state.jobPollCount).toBe(2);
  }, 2000);

  it("events() clamps an absurd SSE 429 Retry-After to MAX_RECONNECT_PAUSE_MS, instead of pausing for it verbatim", async () => {
    server.state.eventsStatus = 429;
    server.state.eventsErrorCode = "too_many_streams";
    server.state.retryAfterHeader = "86400"; // 24h — a malicious/misbehaving server value
    server.state.pollsToSucceed = 1_000_000; // poll backstop never resolves either
    // Only this one call is overridden to resolve instantly, matching the
    // client.ts clamp test; the loop's second (real) reconnect pause is
    // still interrupted promptly by the abort below, so this never actually
    // waits out the clamp — the clamp is verified from the captured value.
    vi.mocked(abortableSleep).mockImplementationOnce(() => Promise.resolve());
    const job = await jobs.get("job_01");
    const controller = new AbortController();
    const iterator = job.events(controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(iterator.next()).rejects.toBeTruthy();
    expect(abortableSleep).toHaveBeenCalled();
    const [ms] = vi.mocked(abortableSleep).mock.calls[0];
    // retryAfter * 1000 would be 86_400_000ms unclamped; MAX_RECONNECT_PAUSE_MS
    // is 60_000ms — the regression this guards against.
    expect(ms).toBe(60_000);
  }, 2000);

  it("events() stops promptly when its AbortSignal aborts during the reconnect pause", async () => {
    server.state.sseMode = "reconnect";
    server.state.pollsToSucceed = 1_000_000; // the poll fallback never reports terminal
    const job = await jobs.get("job_01");
    const controller = new AbortController();
    const iterator = job.events(controller.signal);

    // First frame comes from the connection that then drops mid-job.
    const first = await iterator.next();
    expect(first.value).toMatchObject({ kind: "progress" });

    // The generator is now doing its post-drop poll + reconnect pause
    // (100ms). Abort partway through that pause.
    const second = iterator.next();
    setTimeout(() => controller.abort(), 20);
    const start = Date.now();
    await expect(second).rejects.toBeTruthy();
    expect(Date.now() - start).toBeLessThan(500);
  }, 2000);
});
