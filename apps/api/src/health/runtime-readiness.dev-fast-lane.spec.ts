import { describe, expect, it, vi } from "vitest";
import { RuntimeReadinessService } from "./runtime-readiness.service";
import { customerWriteAdmission } from "../runtime/customer-write-admission";
import { resolveDevFastLane, type DevFastLane } from "../runtime/dev-fast-lane";

const MIGRATION = "20260816000000_runtime_process_lease";

function readiness(lane?: DevFastLane): RuntimeReadinessService {
  const transaction = {
    $executeRawUnsafe: vi.fn(async () => 0),
    $queryRawUnsafe: vi.fn(async (query: string) =>
      query === "SELECT 1" ? [{ ok: 1 }] : [{ migration_name: MIGRATION }],
    ),
  };
  return new RuntimeReadinessService(
    {
      $transaction: vi.fn(
        async (operation: (client: typeof transaction) => Promise<unknown>) =>
          operation(transaction),
      ),
    } as never,
    { probe: vi.fn(async () => ({ connected: true })) } as never,
    { current: vi.fn(() => ({ admitted: true })) } as never,
    {
      current: vi.fn(() => ({ attested: true, migration_revision: MIGRATION })),
    } as never,
    {
      inspectWorkerQueue: vi.fn(async () => ({ status: "ok" })),
      inspectRole: vi.fn(async () => ({ status: "ok" })),
    } as never,
    { check: vi.fn(async () => ({ status: "ok" })) } as never,
    lane,
  );
}

const lane = resolveDevFastLane("development", {
  RUNTIME_DEV_FAST_LANE_WORKSPACE_ID: "0f0e0d0c-0b0a-4908-8706-050403020100",
  RUNTIME_DEV_FAST_LANE_TEMPORAL_ADDRESS: "127.0.0.1:7233",
});
const LANE_CAPABILITY = {
  status: "not_proven",
  code: "DEV_FAST_LANE_UNATTESTED_ROUTING",
};

describe("readiness with the development fast lane", () => {
  it("reports the lane as an unproven capability on every refresh path without changing aggregate status", async () => {
    // Arrange
    const withLane = readiness(lane);
    const withoutLane = readiness();

    // Act
    const full = await withLane.check();
    const hard = await withLane.checkHardComponents();
    const paid = await withLane.checkSiteBuilderPaidCapability();
    const baseline = await withoutLane.check();

    // Assert
    for (const report of [full, hard, paid]) {
      expect(report.capabilities.dev_fast_lane).toEqual(LANE_CAPABILITY);
      expect(report.status).toBe(baseline.status);
      expect(report.components).toEqual(baseline.components);
    }
    expect(full.status).toBe("ready");
  });

  it("omits the capability when the lane is off or not provided", async () => {
    // Act
    const off = await readiness({ enabled: false }).check();
    const absent = await readiness().check();
    const initial = readiness(lane).current();

    // Assert
    expect("dev_fast_lane" in off.capabilities).toBe(false);
    expect("dev_fast_lane" in absent.capabilities).toBe(false);
    expect("dev_fast_lane" in initial.capabilities).toBe(false);
  });

  it("never closes customer writes: admission reads only status and hard components", async () => {
    // Arrange
    const report = await readiness(lane).check();

    // Act
    const admission = customerWriteAdmission(report);

    // Assert
    expect(report.capabilities.dev_fast_lane?.status).toBe("not_proven");
    expect(admission).toMatchObject({ open: true });
  });
});
