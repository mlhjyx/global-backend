import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  createIdempotentWorkerShutdown,
  startWorkerProcessSignalCoordinator,
  startWorkerLeaseHeartbeat,
} from "./worker-lease-heartbeat";

describe("startWorkerLeaseHeartbeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not permit polling when the initial READY lease cannot be published", async () => {
    const shutdown = vi.fn();
    await expect(
      startWorkerLeaseHeartbeat({
        leases: {
          heartbeat: vi.fn(async () => {
            throw new Error("writer unavailable");
          }),
        },
        worker: { shutdown },
        taskQueue: "understanding",
      }),
    ).rejects.toThrow("writer unavailable");
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("marks draining and shuts the worker down after a running lease is lost", async () => {
    const heartbeat = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("lease lost"))
      .mockResolvedValueOnce(undefined);
    const shutdown = vi.fn();
    const onLeaseLost = vi.fn();
    const handle = await startWorkerLeaseHeartbeat({
      leases: { heartbeat },
      worker: { shutdown },
      taskQueue: "understanding",
      onLeaseLost,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(heartbeat).toHaveBeenNthCalledWith(
      3,
      "WORKER",
      "DRAINING",
      "understanding",
    );
    expect(onLeaseLost).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(heartbeat).toHaveBeenCalledTimes(3);
    handle.stop();
  });
});

describe("controlled Worker process shutdown", () => {
  it("shares one idempotent Worker.shutdown across lease, dependency, and signal sources", () => {
    const events: string[] = [];
    const shutdown = createIdempotentWorkerShutdown({
      shutdown: () => events.push("shutdown"),
    });

    shutdown.shutdown();
    shutdown.shutdown();
    expect(events).toEqual([]);
    shutdown.markRunning();
    shutdown.shutdown();

    expect(events).toEqual(["shutdown"]);
  });

  it("contains an invalid raw Worker.shutdown without reopening duplicate shutdown", () => {
    const events: string[] = [];
    const shutdown = createIdempotentWorkerShutdown(
      {
        shutdown: () => {
          events.push("shutdown-attempt");
          throw new Error("already stopping");
        },
      },
      () => events.push("shutdown-contained"),
    );

    shutdown.markRunning();
    shutdown.shutdown();
    shutdown.shutdown();

    expect(events).toEqual(["shutdown-attempt", "shutdown-contained"]);
  });

  it("installs before STARTING and terminalizes a signal received before Worker attachment", async () => {
    const events: string[] = [];
    const signals = new EventEmitter();
    const handle = startWorkerProcessSignalCoordinator({
      leases: {
        heartbeat: async (_role, state) => {
          events.push(String(state));
        },
      },
      taskQueue: "understanding",
      signals,
      onEarlyExit: async (signal) => events.push(`exit:${signal}`),
    });

    await handle.registered;
    signals.emit("SIGTERM");
    await handle.stop();

    expect(events).toEqual(["STARTING", "DRAINING", "STOPPED", "exit:SIGTERM"]);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("waits for a late successful STARTING registration and terminalizes it before early exit", async () => {
    const events: string[] = [];
    const signals = new EventEmitter();
    let atomicallyStopped = false;
    const handle = startWorkerProcessSignalCoordinator({
      leases: {
        heartbeat: async (_role, state) => {
          events.push(`start:${state}`);
          if (state === "STARTING") {
            await new Promise<void>((resolve) => setTimeout(resolve, 15));
            if (atomicallyStopped) throw new Error("lease already stopped");
          }
          events.push(`end:${state}`);
        },
      },
      taskQueue: "understanding",
      signals,
      drainTimeoutMs: 5,
      terminalizeUncertainRegistration: async () => {
        atomicallyStopped = true;
        events.push("ATOMIC_STOPPED");
      },
      onEarlyExit: (signal) => events.push(`exit:${signal}`),
    });

    signals.emit("SIGTERM");
    await handle.stop();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(events).toEqual([
      "start:STARTING",
      "ATOMIC_STOPPED",
      "exit:SIGTERM",
    ]);
  });

  it("persists one DRAINING transition before an attached idempotent shutdown", async () => {
    const events: string[] = [];
    const signals = new EventEmitter();
    const handle = startWorkerProcessSignalCoordinator({
      leases: {
        heartbeat: async (_role, state) => {
          events.push(String(state));
        },
      },
      taskQueue: "understanding",
      signals,
      onEarlyExit: async () => events.push("unexpected-early-exit"),
    });
    await handle.registered;
    handle.attach({
      shutdown: { shutdown: () => events.push("shutdown") },
      stopHeartbeats: () => events.push("heartbeats-stopped"),
    });

    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    await handle.stop();

    expect(events).toEqual([
      "STARTING",
      "heartbeats-stopped",
      "DRAINING",
      "shutdown",
    ]);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("exits without a terminal lease when STARTING registration never succeeded", async () => {
    const events: string[] = [];
    const signals = new EventEmitter();
    const handle = startWorkerProcessSignalCoordinator({
      leases: {
        heartbeat: async (_role, state) => {
          events.push(String(state));
          throw new Error("registration unavailable");
        },
      },
      taskQueue: "understanding",
      signals,
      onEarlyExit: async (signal) => events.push(`exit:${signal}`),
    });
    await expect(handle.registered).rejects.toThrow("registration unavailable");

    signals.emit("SIGTERM");
    await handle.stop();

    expect(events).toEqual(["STARTING", "exit:SIGTERM"]);
  });

  it("removes signal handlers on a normal stop without inventing terminal state", async () => {
    const events: string[] = [];
    const signals = new EventEmitter();
    const handle = startWorkerProcessSignalCoordinator({
      leases: {
        heartbeat: async (_role, state) => events.push(String(state)),
      },
      taskQueue: "understanding",
      signals,
      onEarlyExit: async () => events.push("unexpected-exit"),
    });
    await handle.registered;

    await handle.stop();

    expect(events).toEqual(["STARTING"]);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("still requests attached shutdown when the DRAINING write fails", async () => {
    const events: string[] = [];
    const signals = new EventEmitter();
    const handle = startWorkerProcessSignalCoordinator({
      leases: {
        heartbeat: async (_role, state) => {
          events.push(String(state));
          if (state === "DRAINING") throw new Error("writer unavailable");
        },
      },
      taskQueue: "understanding",
      signals,
      onEarlyExit: async () => events.push("unexpected-exit"),
      onDrainLeaseFailure: () => events.push("drain-write-failed"),
    });
    await handle.registered;
    handle.attach({
      shutdown: { shutdown: () => events.push("shutdown") },
      stopHeartbeats: () => events.push("heartbeats-stopped"),
    });

    signals.emit("SIGTERM");
    await handle.stop();

    expect(events).toEqual([
      "STARTING",
      "heartbeats-stopped",
      "DRAINING",
      "drain-write-failed",
      "shutdown",
    ]);
  });

  it("runs the final early-exit action even when early cleanup rejects", async () => {
    const events: string[] = [];
    const signals = new EventEmitter();
    const coordinatorInput = {
      leases: {
        heartbeat: async (_role: string, state: string) =>
          events.push(String(state)),
      },
      taskQueue: "understanding",
      signals,
      onEarlyCleanup: async () => {
        events.push("cleanup");
        throw new Error("cleanup failed");
      },
      onEarlyExit: async (signal: NodeJS.Signals) =>
        events.push(`exit:${signal}`),
    };
    const handle = startWorkerProcessSignalCoordinator(coordinatorInput);
    await handle.registered;

    signals.emit("SIGTERM");
    await handle.stop();

    expect(events).toEqual([
      "STARTING",
      "DRAINING",
      "STOPPED",
      "cleanup",
      "exit:SIGTERM",
    ]);
  });

  it("bounds a hanging early cleanup and still executes the final exit action", async () => {
    const events: string[] = [];
    const signals = new EventEmitter();
    const coordinatorInput = {
      leases: {
        heartbeat: async (_role: string, state: string) =>
          events.push(String(state)),
      },
      taskQueue: "understanding",
      signals,
      drainTimeoutMs: 5,
      onEarlyCleanup: async () => {
        events.push("cleanup-started");
        await new Promise<void>(() => undefined);
      },
      onEarlyExit: async (signal: NodeJS.Signals) =>
        events.push(`exit:${signal}`),
      onDrainLeaseFailure: () => events.push("cleanup-timed-out"),
    };
    const handle = startWorkerProcessSignalCoordinator(coordinatorInput);
    await handle.registered;

    signals.emit("SIGTERM");
    const outcome = await Promise.race([
      handle.stop().then(() => "stopped"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("timed-out"), 25),
      ),
    ]);

    expect(outcome).toBe("stopped");
    expect(events).toEqual([
      "STARTING",
      "DRAINING",
      "STOPPED",
      "cleanup-started",
      "cleanup-timed-out",
      "exit:SIGTERM",
    ]);
  });

  it("bounds a hanging DRAINING write and still stops attached polling", async () => {
    const events: string[] = [];
    const signals = new EventEmitter();
    const coordinatorInput = {
      leases: {
        heartbeat: async (_role: string, state: string) => {
          events.push(String(state));
          if (state === "DRAINING") await new Promise<void>(() => undefined);
        },
      },
      taskQueue: "understanding",
      signals,
      drainTimeoutMs: 5,
      onEarlyExit: async () => events.push("unexpected-exit"),
      onDrainLeaseFailure: () => events.push("drain-write-timed-out"),
    };
    const handle = startWorkerProcessSignalCoordinator(coordinatorInput);
    await handle.registered;
    handle.attach({
      shutdown: { shutdown: () => events.push("shutdown") },
      stopHeartbeats: () => events.push("heartbeats-stopped"),
    });

    signals.emit("SIGTERM");
    const outcome = await Promise.race([
      handle.stop().then(() => "stopped"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("timed-out"), 25),
      ),
    ]);

    expect(outcome).toBe("stopped");
    expect(events).toEqual([
      "STARTING",
      "heartbeats-stopped",
      "DRAINING",
      "drain-write-timed-out",
      "shutdown",
    ]);
  });
});
