import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StubServer } from "../../test/support/stub-server.js";
import { ComfyLow } from "../low/index.js";
import { NotFound } from "./exceptions.js";
import { JobFactory } from "./jobs.js";

const CAPTURED = {
  text: "got prompt\nPrompt executed in 4.62 seconds\n",
  truncated: false,
  captured_at: "2026-07-10T18:25:00Z",
  complete: true,
};

// On-demand execution logs. The log is a resource of its own rather than a
// field on the job, so these cover the two things that follow from that: a
// job read never carries it, and "no log" is an ordinary answer.
describe("Job.getLogs", () => {
  let server: StubServer;
  let jobs: JobFactory;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
    jobs = new JobFactory(new ComfyLow(server.baseUrl));
  });

  afterEach(async () => {
    await server.stop();
  });

  it("returns what the run printed", async () => {
    server.state.jobLogs = CAPTURED;
    const job = await jobs.get("job_01");

    const logs = await job.getLogs();

    expect(logs).not.toBeNull();
    expect(logs?.text).toBe("got prompt\nPrompt executed in 4.62 seconds\n");
    // Read off the wire, not hardcoded: this is the whole log, so `truncated`
    // is false here and true in the shed-entirely case below.
    expect(logs?.truncated).toBe(false);
    expect(logs?.complete).toBe(true);
    expect(logs?.capturedAt).toBeInstanceOf(Date);
    expect(logs?.capturedAt.toISOString()).toBe("2026-07-10T18:25:00.000Z");
  });

  // The whole point of the resource: polling a job to terminal must not pay
  // for a log the caller did not ask for.
  it("is never fetched by polling a job to terminal", async () => {
    server.state.jobLogs = CAPTURED;
    server.state.pollsToSucceed = 3;
    const job = await jobs.get("job_01");

    await job.result();

    expect(server.state.jobLogsRequestCount).toBe(0);
  });

  it("is null when the job has no log", async () => {
    server.state.jobLogs = null;
    const job = await jobs.get("job_01");

    expect(await job.getLogs()).toBeNull();
    expect(server.state.jobLogsRequestCount).toBe(1);
  });

  // A surface that serves no logs at all omits urls.logs. The answer is known
  // from its absence, so the SDK must not construct the URL and ask anyway.
  it("is null without a link, and makes no request", async () => {
    server.state.omitLogsLink = true;
    server.state.jobLogs = CAPTURED;
    const job = await jobs.get("job_01");

    expect(await job.getLogs()).toBeNull();
    expect(server.state.jobLogsRequestCount).toBe(0);
  });

  // A server that serializes the absent optional link as "" rather than
  // omitting the key must not send the SDK to `/jobs//logs`, which would
  // surface as a NotFound for a job that exists.
  it("treats an empty link as no link, and makes no request", async () => {
    server.state.emptyLogsLink = true;
    server.state.jobLogs = CAPTURED;
    const job = await jobs.get("job_01");

    expect(await job.getLogs()).toBeNull();
    expect(server.state.jobLogsRequestCount).toBe(0);
  });

  // Proves the request addressed THIS job, not merely that a route-shaped URL
  // was hit — the stub answers any id, so without this a wrong-but-plausible
  // path would pass.
  it("asks for the job it was called on", async () => {
    server.state.jobLogs = CAPTURED;
    const job = await jobs.get("job_01");

    await job.getLogs();

    expect(server.state.lastJobLogsPath).toBe("/api/v2/jobs/job_01/logs");
  });

  // Deliberately uncached: an early null on a job that had not finished must
  // not mask the log it goes on to produce.
  it("re-reads on every call", async () => {
    server.state.jobLogs = null;
    const job = await jobs.get("job_01");
    expect(await job.getLogs()).toBeNull();

    server.state.jobLogs = CAPTURED;
    const logs = await job.getLogs();

    expect(logs?.text).toContain("got prompt");
    expect(server.state.jobLogsRequestCount).toBe(2);
  });

  it("rejects with the usual error for a missing job", async () => {
    server.state.jobLogsNotFound = true;
    const job = await jobs.get("job_01");

    await expect(job.getLogs()).rejects.toBeInstanceOf(NotFound);
  });

  // truncated with an empty text is how a log shed entirely to fit says so,
  // which is a different answer from never having had one.
  it("distinguishes a captured empty log from absence", async () => {
    server.state.jobLogs = {
      text: "",
      truncated: true,
      captured_at: "2026-07-10T18:25:00Z",
      complete: true,
    };
    const job = await jobs.get("job_01");

    const logs = await job.getLogs();

    expect(logs).not.toBeNull();
    expect(logs?.text).toBe("");
    expect(logs?.truncated).toBe(true);
  });
});
