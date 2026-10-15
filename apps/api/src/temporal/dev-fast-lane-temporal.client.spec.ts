import {
  Connection,
  ServiceError,
  WorkflowClient,
  WorkflowExecutionAlreadyStartedError,
} from "@temporalio/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDevFastLane } from "../runtime/dev-fast-lane";
import {
  DEV_FAST_LANE_CONNECT_TIMEOUT_MS,
  DEV_FAST_LANE_START_DEADLINE_MS,
  DEV_FAST_LANE_UNAVAILABLE_COOLDOWN_MS,
  DevFastLaneTemporalClient,
} from "./dev-fast-lane-temporal.client";

const WORKSPACE = "0f0e0d0c-0b0a-4908-8706-050403020100";
const lane = resolveDevFastLane("development", {
  RUNTIME_DEV_FAST_LANE_WORKSPACE_ID: WORKSPACE,
  RUNTIME_DEV_FAST_LANE_TEMPORAL_ADDRESS: "127.0.0.1:7233",
});
const OPTIONS = {
  taskQueue: `understanding-dev-fast-lane-${WORKSPACE}`,
  workflowId: "qualify-icp-1",
  args: [],
};

function fakeConnection(
  ensureConnected: () => Promise<void> = async () => undefined,
) {
  return {
    plugins: [],
    ensureConnected: vi.fn(ensureConnected),
    withDeadline: vi.fn(
      async (_deadline: number, fn: () => Promise<unknown>) => await fn(),
    ),
    withAbortSignal: vi.fn(
      async (_signal: AbortSignal, fn: () => Promise<unknown>) => await fn(),
    ),
    close: vi.fn(async () => undefined),
  };
}

function lazyConnections(...connections: ReturnType<typeof fakeConnection>[]) {
  const lazy = vi.spyOn(Connection, "lazy");
  for (const connection of connections) {
    lazy.mockReturnValueOnce(connection as unknown as Connection);
  }
  return lazy;
}

/** What @temporalio/client throws when a gRPC call fails with `code`. */
function grpcFailure(code: number): ServiceError {
  const cause = Object.assign(new Error(`${code} grpc failure`), {
    code,
    details: "grpc failure",
    metadata: {},
  });
  return new ServiceError("Failed to start Workflow", { cause });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DevFastLaneTemporalClient", () => {
  it("never connects anywhere when the lane is off", async () => {
    // Arrange
    const lazy = vi.spyOn(Connection, "lazy");
    const connect = vi.spyOn(Connection, "connect");
    const disabled = new DevFastLaneTemporalClient({ enabled: false });
    const unprovided = new DevFastLaneTemporalClient();
    const signal = new AbortController().signal;

    // Act + Assert
    await expect(disabled.start("qualify", OPTIONS, signal)).rejects.toThrow(
      "DEV_FAST_LANE_DISABLED",
    );
    await expect(unprovided.start("qualify", OPTIONS, signal)).rejects.toThrow(
      "DEV_FAST_LANE_DISABLED",
    );
    expect(disabled.route("DiscoveryRunRequested", WORKSPACE)).toBeNull();
    expect(unprovided.lane).toEqual({ enabled: false });
    expect(disabled.coolingDown()).toBe(false);
    expect(lazy).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("lazily opens one plaintext loopback connection, reuses it and bounds every start by a deadline and the caller's abort signal", async () => {
    // Arrange
    vi.useFakeTimers({ now: new Date("2026-10-14T08:00:00.000Z") });
    const connection = fakeConnection();
    const lazy = lazyConnections(connection);
    const start = vi
      .spyOn(WorkflowClient.prototype, "start")
      .mockResolvedValue({} as never);
    const client = new DevFastLaneTemporalClient(lane);
    const shutdown = new AbortController();
    const signal = shutdown.signal;

    // Act
    await Promise.all([
      client.start("qualify", OPTIONS, signal),
      client.start("qualify", OPTIONS, signal),
    ]);
    await client.start("discovery", OPTIONS, signal);

    // Assert
    expect(lazy).toHaveBeenCalledTimes(1);
    expect(lazy).toHaveBeenCalledWith({
      address: "127.0.0.1:7233",
      connectTimeout: DEV_FAST_LANE_CONNECT_TIMEOUT_MS,
    });
    expect(connection.ensureConnected).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(3);
    expect(start).toHaveBeenLastCalledWith("discovery", OPTIONS);
    expect(
      (start.mock.contexts[0] as WorkflowClient | undefined)?.options.namespace,
    ).toBe("default");
    // gRPC adds an abort listener per call and never removes it, so each start
    // gets its own signal that follows the long-lived caller's signal.
    const callSignals = connection.withAbortSignal.mock.calls.map(
      ([callSignal]) => callSignal,
    );
    expect(callSignals).toHaveLength(3);
    expect(new Set(callSignals).size).toBe(3);
    expect(callSignals).not.toContain(signal);
    shutdown.abort();
    expect(callSignals.every((callSignal) => callSignal.aborted)).toBe(true);
    expect(connection.withDeadline).toHaveBeenCalledWith(
      Date.now() + DEV_FAST_LANE_START_DEADLINE_MS,
      expect.any(Function),
    );
    expect(client.coolingDown()).toBe(false);
    expect(client.route("QualifyRequested", WORKSPACE)).toMatchObject({
      taskQueue: `understanding-dev-fast-lane-${WORKSPACE}`,
    });
  });

  it("closes a connection that failed to connect and refuses further connects until the cool-down ends", async () => {
    // Arrange
    vi.useFakeTimers({ now: new Date("2026-10-14T08:00:00.000Z") });
    const unreachable = fakeConnection(async () => {
      throw new Error("Failed to connect before the deadline");
    });
    const reachable = fakeConnection();
    const lazy = lazyConnections(unreachable, reachable);
    vi.spyOn(WorkflowClient.prototype, "start").mockResolvedValue({} as never);
    const client = new DevFastLaneTemporalClient(lane);
    const signal = new AbortController().signal;

    // Act + Assert: the failed channel is closed, not leaked
    await expect(client.start("qualify", OPTIONS, signal)).rejects.toThrow(
      "Failed to connect before the deadline",
    );
    expect(unreachable.close).toHaveBeenCalledTimes(1);
    expect(client.coolingDown()).toBe(true);

    // Act + Assert: during the cool-down a start fails at once without connecting
    await vi.advanceTimersByTimeAsync(
      DEV_FAST_LANE_UNAVAILABLE_COOLDOWN_MS - 1,
    );
    await expect(client.start("qualify", OPTIONS, signal)).rejects.toThrow(
      "DEV_FAST_LANE_TEMPORAL_UNAVAILABLE",
    );
    expect(lazy).toHaveBeenCalledTimes(1);

    // Act + Assert: after the cool-down the next start connects again
    await vi.advanceTimersByTimeAsync(1);
    expect(client.coolingDown()).toBe(false);
    await client.start("qualify", OPTIONS, signal);
    expect(lazy).toHaveBeenCalledTimes(2);
    expect(reachable.close).not.toHaveBeenCalled();
  });

  it("drops the connection and cools down when a start cannot reach the server, but not for other start failures", async () => {
    for (const code of [4, 14]) {
      // Arrange: 4 = DEADLINE_EXCEEDED, 14 = UNAVAILABLE
      const connection = fakeConnection();
      lazyConnections(connection);
      vi.spyOn(WorkflowClient.prototype, "start").mockRejectedValueOnce(
        grpcFailure(code),
      );
      const client = new DevFastLaneTemporalClient(lane);

      // Act
      await expect(
        client.start("qualify", OPTIONS, new AbortController().signal),
      ).rejects.toBeInstanceOf(ServiceError);

      // Assert
      expect(client.coolingDown(), String(code)).toBe(true);
      expect(connection.close, String(code)).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
    }

    for (const failure of [
      grpcFailure(3),
      new WorkflowExecutionAlreadyStartedError("started", "w", "qualify"),
    ]) {
      // Arrange: 3 = INVALID_ARGUMENT, a per-command failure
      const connection = fakeConnection();
      const lazy = lazyConnections(connection);
      vi.spyOn(WorkflowClient.prototype, "start")
        .mockRejectedValueOnce(failure)
        .mockResolvedValue({} as never);
      const client = new DevFastLaneTemporalClient(lane);
      const signal = new AbortController().signal;

      // Act
      await expect(client.start("qualify", OPTIONS, signal)).rejects.toBe(
        failure,
      );
      await client.start("qualify", OPTIONS, signal);

      // Assert
      expect(client.coolingDown()).toBe(false);
      expect(connection.close).not.toHaveBeenCalled();
      expect(lazy).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
    }
  });

  it("stops waiting for a pending connect when the caller aborts", async () => {
    // Arrange
    vi.useFakeTimers({ now: new Date("2026-10-14T08:00:00.000Z") });
    const slow = fakeConnection(
      () =>
        new Promise<void>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("Failed to connect before the deadline")),
            DEV_FAST_LANE_CONNECT_TIMEOUT_MS,
          );
        }),
    );
    lazyConnections(slow);
    const start = vi.spyOn(WorkflowClient.prototype, "start");
    const client = new DevFastLaneTemporalClient(lane);
    const shutdown = new AbortController();
    const started = client.start("qualify", OPTIONS, shutdown.signal);
    const settled = vi.fn();
    void started.catch(settled);

    // Act
    await vi.advanceTimersByTimeAsync(100);
    shutdown.abort();
    await vi.advanceTimersByTimeAsync(0);

    // Assert
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({ message: "DEV_FAST_LANE_START_ABORTED" }),
    );
    await expect(
      client.start("qualify", OPTIONS, shutdown.signal),
    ).rejects.toThrow("DEV_FAST_LANE_START_ABORTED");
    expect(start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEV_FAST_LANE_CONNECT_TIMEOUT_MS);
    expect(slow.close).toHaveBeenCalledTimes(1);
  });

  it("closes the connection on shutdown and refuses to start afterwards", async () => {
    // Arrange
    const connection = fakeConnection();
    lazyConnections(connection);
    vi.spyOn(WorkflowClient.prototype, "start").mockResolvedValue({} as never);
    const client = new DevFastLaneTemporalClient(lane);
    const signal = new AbortController().signal;
    await client.start("qualify", OPTIONS, signal);

    // Act
    await client.onModuleDestroy();

    // Assert
    expect(connection.close).toHaveBeenCalledTimes(1);
    await expect(client.start("qualify", OPTIONS, signal)).rejects.toThrow(
      "DEV_FAST_LANE_CLIENT_CLOSED",
    );
  });
});
