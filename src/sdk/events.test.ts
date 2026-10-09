import { describe, expect, it } from "vitest";

import type { RawEvent } from "../low/index.js";
import { eventFromRaw } from "./events.js";
import type { Output } from "./outputs.js";

describe("eventFromRaw", () => {
  const bindOutput = (data: Record<string, unknown>) => ({ __raw: data }) as unknown as Output;

  it("lifts a progress frame", () => {
    const raw: RawEvent = {
      event: "progress",
      data: {
        value: 0.5,
        nodes_done: 5,
        nodes_total: 10,
        current_node: "3",
        current_node_class: "KSampler",
        step: 1,
        steps: 20,
      },
    };
    const event = eventFromRaw(raw, bindOutput);
    expect(event).toEqual({
      kind: "progress",
      value: 0.5,
      message: null,
      nodesDone: 5,
      nodesTotal: 10,
      currentNode: "3",
      currentNodeClass: "KSampler",
      step: 1,
      steps: 20,
    });
  });

  it("lifts a preview frame, base64-decoding the data", () => {
    const raw: RawEvent = {
      event: "preview",
      data: {
        node_id: "7",
        content_type: "image/jpeg",
        data_base64: Buffer.from("hi").toString("base64"),
      },
    };
    const event = eventFromRaw(raw, bindOutput);
    expect(event?.kind).toBe("preview");
    if (event?.kind === "preview") {
      expect(event.nodeId).toBe("7");
      expect(event.contentType).toBe("image/jpeg");
      expect(Buffer.from(event.data).toString()).toBe("hi");
    }
  });

  it("lifts a status frame into statusChange", () => {
    const event = eventFromRaw(
      { event: "status", data: { status: "running", queue_position: 2 } },
      bindOutput,
    );
    expect(event).toEqual({ kind: "statusChange", status: "running", queuePosition: 2 });
  });

  it("lifts a log frame", () => {
    const event = eventFromRaw(
      { event: "log", data: { level: "warn", message: "slow node" } },
      bindOutput,
    );
    expect(event).toEqual({ kind: "log", level: "warn", message: "slow node" });
  });

  it("binds an output frame via the provided binder", () => {
    const event = eventFromRaw({ event: "output", data: { id: "asset_1" } }, bindOutput);
    expect(event?.kind).toBe("outputReady");
  });

  it("returns null for an unknown event name", () => {
    expect(eventFromRaw({ event: "mystery", data: {} }, bindOutput)).toBeNull();
  });
});
