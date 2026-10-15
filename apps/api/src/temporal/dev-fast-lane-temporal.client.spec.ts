import { Connection } from "@temporalio/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDevFastLane } from "../runtime/dev-fast-lane";
import { DevFastLaneTemporalClient } from "./dev-fast-lane-temporal.client";

const WORKSPACE = "0f0e0d0c-0b0a-4908-8706-050403020100";
const lane = resolveDevFastLane("development", {
  RUNTIME_DEV_FAST_LANE_WORKSPACE_ID: WORKSPACE,
  RUNTIME_DEV_FAST_LANE_TEMPORAL_ADDRESS: "127.0.0.1:7233",
});

function fakeConnection() {
  return { plugins: [], close: vi.fn(async () => undefined) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DevFastLaneTemporalClient", () => {
  it("never connects anywhere when the lane is off", async () => {
    // Arrange
    const connect = vi.spyOn(Connection, "connect");
    const disabled = new DevFastLaneTemporalClient({ enabled: false });
    const unprovided = new DevFastLaneTemporalClient();

    // Act + Assert
    await expect(disabled.workflow()).rejects.toThrow("DEV_FAST_LANE_DISABLED");
    await expect(unprovided.workflow()).rejects.toThrow(
      "DEV_FAST_LANE_DISABLED",
    );
    expect(disabled.route("DiscoveryRunRequested", WORKSPACE)).toBeNull();
    expect(unprovided.lane).toEqual({ enabled: false });
    expect(connect).not.toHaveBeenCalled();
  });

  it("lazily opens one plaintext loopback connection and reuses it", async () => {
    // Arrange
    const connection = fakeConnection();
    const connect = vi
      .spyOn(Connection, "connect")
      .mockResolvedValue(connection as unknown as Connection);
    const client = new DevFastLaneTemporalClient(lane);

    // Act
    const [first, second] = await Promise.all([
      client.workflow(),
      client.workflow(),
    ]);
    const third = await client.workflow();

    // Assert
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith({
      address: "127.0.0.1:7233",
      connectTimeout: "5 seconds",
    });
    expect(first).toBe(second);
    expect(third).toBe(first);
    expect(first.options.namespace).toBe("default");
    expect(client.route("QualifyRequested", WORKSPACE)).toMatchObject({
      taskQueue: `understanding-dev-fast-lane-${WORKSPACE}`,
    });
  });

  it("retries after a failed connection and closes on shutdown", async () => {
    // Arrange
    const connection = fakeConnection();
    const connect = vi
      .spyOn(Connection, "connect")
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue(connection as unknown as Connection);
    const client = new DevFastLaneTemporalClient(lane);

    // Act
    await expect(client.workflow()).rejects.toThrow("ECONNREFUSED");
    await client.workflow();
    await client.onModuleDestroy();

    // Assert
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connection.close).toHaveBeenCalledTimes(1);
    await expect(client.workflow()).rejects.toThrow(
      "DEV_FAST_LANE_CLIENT_CLOSED",
    );
  });
});
