import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StubServer } from "../../test/support/stub-server.js";
import { ComfyLow } from "../low/index.js";
import { abortableSleep } from "./abortable-sleep.js";
import { Forbidden, JobFailed, NotFound } from "./exceptions.js";
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

  it("getLogs() returns what the run printed", async () => {
    server.state.jobLogs = {
      text: "loading model\n",
      truncated: true,
      captured_at: "2026-07-10T18:21:00Z",
      complete: true,
    };
    const job = await jobs.get("job_01");
    const logs = await job.getLogs();
    expect(logs?.text).toBe("loading model\n");
    expect(logs?.truncated).toBe(true);
  });

  it("getLogs() is null, not an error, for a job with no log", async () => {
    // A 204 is the contract's ordinary answer for a job with nothing captured.
    const job = await jobs.get("job_01");
    expect(await job.getLogs()).toBeNull();
    expect(server.state.jobLogsCount).toBe(1);
  });

  it("getLogs() spends no request on a surface that offers no urls.logs link", async () => {
    // An absent link is the surface saying it captures no logs for any job.
    server.state.jobUrlsIncludeLogs = false;
    const job = await jobs.get("job_01");
    expect(await job.getLogs()).toBeNull();
    expect(server.state.jobLogsCount).toBe(0);
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
    // The server asked for 5s; a bare "paused longer than 300ms" assertion
    // would also pass on a 301ms pause that ignored the header entirely.
    expect(vi.mocked(abortableSleep)).toHaveBeenCalledWith(5_000, controller.signal);
    // One SSE attempt, one poll refresh (that precedes the pause) beyond
    // jobs.get()'s own poll above — at the old fixed 100ms cadence, a 300ms
    // window would have produced several of each. This is the
    // request-amplification assertion.
    expect(server.state.eventsConnectCount).toBe(1);
    expect(server.state.jobPollCount).toBe(2);
  }, 2000);

  it("events() uses the default backoff when a 429 omits Retry-After", async () => {
    server.state.eventsStatus = 429;
    server.state.eventsErrorCode = "too_many_streams";
    server.state.omitEventsRetryAfter = true;
    server.state.pollsToSucceed = 1_000_000;
    const job = await jobs.get("job_01");
    const controller = new AbortController();
    vi.mocked(abortableSleep).mockImplementationOnce((_ms, signal) => {
      controller.abort();
      return Promise.reject(signal?.reason);
    });

    await expect(job.events(controller.signal).next()).rejects.toBeTruthy();
    expect(abortableSleep).toHaveBeenCalledWith(2_000, controller.signal);
    expect(server.state.eventsConnectCount).toBe(1);
  });

  it.each(["-1", "NaN"])(
    "events() uses the default backoff for invalid Retry-After %s",
    async (value) => {
      server.state.eventsStatus = 429;
      server.state.eventsErrorCode = "too_many_streams";
      server.state.retryAfterHeader = value;
      server.state.pollsToSucceed = 1_000_000;
      const job = await jobs.get("job_01");
      const controller = new AbortController();
      vi.mocked(abortableSleep).mockImplementationOnce((_ms, signal) => {
        controller.abort();
        return Promise.reject(signal?.reason);
      });

      await expect(job.events(controller.signal).next()).rejects.toBeTruthy();
      expect(abortableSleep).toHaveBeenCalledWith(2_000, controller.signal);
      expect(server.state.eventsConnectCount).toBe(1);
    },
  );

  it("events() translates a non-retryable protocol error instead of reconnecting", async () => {
    server.state.eventsStatus = 403;
    server.state.eventsErrorCode = "forbidden";
    const job = await jobs.get("job_01");

    await expect(job.events().next()).rejects.toBeInstanceOf(Forbidden);
    expect(server.state.eventsConnectCount).toBe(1);
    expect(server.state.jobPollCount).toBe(1);
  });

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
  describe("model accessors", () => {
    // A running job as the server reports one: started, not finished, with a
    // live progress snapshot and a place in the queue.
    const RUNNING = {
      started_at: "2026-07-10T18:20:30Z",
      completed_at: null,
      queue_position: 3,
      progress: { value: 0.25, nodes_done: 1, nodes_total: 4, current_node: "13" },
    };

    it("exposes created_at and expires_at as Dates, not wire strings", async () => {
      const job = await jobs.get("job_01");
      expect(job.createdAt).toBeInstanceOf(Date);
      expect(job.createdAt.toISOString()).toBe("2026-07-10T18:20:00.000Z");
      expect(job.expiresAt).toBeInstanceOf(Date);
      expect(job.expiresAt.toISOString()).toBe("2026-07-11T18:20:00.000Z");
    });

    it("keeps the nullable timestamps null while the server reports none", async () => {
      server.state.pollsToSucceed = 1_000_000; // stays running, never terminal
      const job = await jobs.get("job_01");
      expect(job.startedAt).toBeNull();
      expect(job.completedAt).toBeNull();
      expect(job.progress).toBeNull();
    });

    it("adopts the timestamps, progress and queue position a refresh() pulled", async () => {
      server.state.pollsToSucceed = 1_000_000;
      const job = await jobs.get("job_01");
      expect(job.startedAt).toBeNull();
      expect(job.queuePosition).toBe(0);

      server.state.jobFieldOverrides = RUNNING;
      await job.refresh();

      expect(job.startedAt?.toISOString()).toBe("2026-07-10T18:20:30.000Z");
      expect(job.completedAt).toBeNull();
      expect(job.queuePosition).toBe(3);
      expect(job.progress).toEqual({
        value: 0.25,
        nodes_done: 1,
        nodes_total: 4,
        current_node: "13",
      });
    });

    it("gives a job's duration off completedAt/startedAt once it finishes", async () => {
      server.state.jobFieldOverrides = {
        started_at: "2026-07-10T18:20:30Z",
        completed_at: "2026-07-10T18:21:12Z",
      };
      const job = await jobs.get("job_01");
      await job.result();
      expect(job.status).toBe("succeeded");
      expect(job.completedAt).not.toBeNull();
      expect(job.startedAt).not.toBeNull();
      expect(job.completedAt!.getTime() - job.startedAt!.getTime()).toBe(42_000);
    });

    it("exposes queue_position as null when the server reports none", async () => {
      server.state.jobFieldOverrides = { queue_position: null };
      const job = await jobs.get("job_01");
      expect(job.queuePosition).toBeNull();
    });

    it("passes metrics through, and reports undefined on a surface that sends none", async () => {
      const job = await jobs.get("job_01");
      expect(job.metrics).toEqual({ queue_ms: 9000, execution_ms: null });

      // `metrics` is optional on the wire — absent, not null, is the shape a
      // surface that measures nothing sends.
      server.state.jobFieldOverrides = { metrics: undefined };
      await job.refresh();
      expect(job.metrics).toBeUndefined();
    });

    it("exposes the job's own links, including the optional logs one", async () => {
      const job = await jobs.get("job_01");
      expect(job.urls.self).toBe("/api/v2/jobs/job_01");
      expect(job.urls.events).toBe("/api/v2/jobs/job_01/events");
      expect(job.urls.cancel).toBe("/api/v2/jobs/job_01/cancel");
      expect(job.urls.logs).toBe("/api/v2/jobs/job_01/logs");
    });

    it("adopts created_at, expires_at and the links a refresh() pulled", async () => {
      const job = await jobs.get("job_01");
      expect(job.createdAt.toISOString()).toBe("2026-07-10T18:20:00.000Z");
      expect(job.urls.logs).toBe("/api/v2/jobs/job_01/logs");

      // Re-queued behind a retention extension, on a surface that stopped
      // offering a logs link — both are state the next poll carries.
      server.state.jobFieldOverrides = {
        created_at: "2026-07-10T19:00:00Z",
        expires_at: "2026-07-12T19:00:00Z",
      };
      server.state.jobUrlsIncludeLogs = false;
      await job.refresh();

      expect(job.createdAt.toISOString()).toBe("2026-07-10T19:00:00.000Z");
      expect(job.expiresAt.toISOString()).toBe("2026-07-12T19:00:00.000Z");
      expect(job.urls.logs).toBeUndefined();
    });

    it("hands back snapshots, so editing what an accessor returned cannot rewrite the handle", async () => {
      server.state.jobFieldOverrides = RUNNING;
      const job = await jobs.get("job_01");

      job.urls.self = "http://example.invalid/hijacked";
      job.urls.logs = undefined;
      job.progress!.value = 1;
      job.metrics!.queue_ms = -1;

      expect(job.urls.self).toBe("/api/v2/jobs/job_01");
      expect(job.urls.logs).toBe("/api/v2/jobs/job_01/logs");
      expect(job.progress?.value).toBe(0.25);
      expect(job.metrics?.queue_ms).toBe(9000);

      // The links the handle itself follows are the untouched ones.
      const before = server.state.jobPollCount;
      await job.refresh();
      expect(server.state.jobPollCount).toBe(before + 1);
    });
  });
});
