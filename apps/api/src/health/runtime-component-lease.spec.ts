import { describe, expect, it, vi } from "vitest";
import { RuntimeComponentLease } from "./runtime-component-lease";

describe("RuntimeComponentLease", () => {
  it("persists RUNNING on start/renew and STOPPED on graceful shutdown", async () => {
    const db = { $executeRawUnsafe: vi.fn(async () => 1) };
    const lease = new RuntimeComponentLease(db as never, "WORKER", {
      instanceId: "11111111-1111-4111-8111-111111111111",
      now: () => new Date("2026-08-12T08:00:00.000Z"),
    });

    await lease.start({ temporal_state: "RUNNING" });
    await lease.renew({ temporal_state: "RUNNING" });
    await lease.stop({ temporal_state: "STOPPED" });

    expect(db.$executeRawUnsafe).toHaveBeenCalledTimes(3);
    expect(db.$executeRawUnsafe.mock.calls[0]).toEqual([
      expect.stringContaining("runtime_component_heartbeat"),
      "WORKER",
      "11111111-1111-4111-8111-111111111111",
      "RUNNING",
      new Date("2026-08-12T08:00:00.000Z"),
      new Date("2026-08-12T08:00:00.000Z"),
      JSON.stringify({ temporal_state: "RUNNING" }),
    ]);
    expect(db.$executeRawUnsafe.mock.calls[2][3]).toBe("STOPPED");
  });

  it("does not renew a lease before it has started or after it has stopped", async () => {
    const db = { $executeRawUnsafe: vi.fn(async () => 1) };
    const lease = new RuntimeComponentLease(db as never, "OUTBOX_RELAY");

    await lease.renew();
    await lease.start();
    await lease.stop();
    await lease.renew();

    expect(db.$executeRawUnsafe).toHaveBeenCalledTimes(2);
  });
});
