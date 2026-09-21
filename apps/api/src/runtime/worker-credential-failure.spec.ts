import { describe, expect, it } from "vitest";
import { createWorkerCredentialFailure } from "./worker-lease-heartbeat";

describe("worker credential expiry readiness", () => {
  it("stops READY publication and marks the actual role DRAINING before shutdown, at most once", () => {
    const events: string[] = [];
    const failure = createWorkerCredentialFailure({
      role: "PLATFORM_WORKER",
      taskQueue: "understanding",
      leases: {
        heartbeat: async (role, state) => {
          events.push(`${role}:${state}`);
        },
      },
      heartbeat: {
        stop: () => {
          events.push("stop-ready");
        },
      },
      worker: {
        shutdown: () => {
          events.push("shutdown");
        },
      },
    });
    expect(failure.available()).toBe(true);
    failure.fail();
    failure.fail();
    expect(failure.available()).toBe(false);
    expect(events).toEqual([
      "stop-ready",
      "PLATFORM_WORKER:DRAINING",
      "shutdown",
    ]);
  });
});
