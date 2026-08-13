import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StubServer } from "../../test/support/stub-server.js";
import { ComfyLow } from "../low/index.js";
import { JobFailed, NotFound } from "./exceptions.js";
import { JobFactory } from "./jobs.js";

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
