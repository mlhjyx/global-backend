import { describe, expect, it, vi } from "vitest";
import {
  isRuntimeLeaseMaintenanceEnabled,
  purgeExpiredRuntimeLeases,
  resolveRuntimeLeaseMaintenanceConfig,
  startRuntimeLeaseMaintenance,
} from "./runtime-lease-maintenance";

describe("runtime-lease-maintenance", () => {
  it("parses env settings with safe bounded defaults", () => {
    expect(isRuntimeLeaseMaintenanceEnabled({})).toBe(true);
    expect(isRuntimeLeaseMaintenanceEnabled({ RUNTIME_LEASE_MAINTENANCE_ENABLED: "off" })).toBe(
      false,
    );
    expect(resolveRuntimeLeaseMaintenanceConfig({})).toEqual({
      enabled: true,
      retentionDays: 7,
      staleSeconds: 300,
      batchSize: 200,
      intervalMs: 3_600_000,
    });
    expect(
      resolveRuntimeLeaseMaintenanceConfig({
        RUNTIME_LEASE_RETENTION_DAYS: "999",
        RUNTIME_LEASE_STALE_SECONDS: "5",
        RUNTIME_LEASE_SWEEP_BATCH: "50000",
      }),
    ).toMatchObject({
      retentionDays: 90,
      staleSeconds: 60,
      batchSize: 2000,
    });
  });

  it("reclaims stale non-STOPPED zombie leases and deletes old STOPPED rows in bounded batches", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const executeRaw = vi
      .fn()
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(11);

    const res = await purgeExpiredRuntimeLeases(
      { $executeRaw: executeRaw },
      { retentionDays: 7, staleSeconds: 300, batchSize: 100, now: () => now },
    );

    expect(res).toEqual({
      status: "ok",
      staleReclaimed: 3,
      expiredDeleted: 11,
    });
    expect(executeRaw).toHaveBeenCalledTimes(2);
    const updateSql = executeRaw.mock.calls[0]![0].strings.join("?");
    const deleteSql = executeRaw.mock.calls[1]![0].strings.join("?");
    expect(updateSql).toContain("UPDATE public.runtime_process_lease");
    expect(updateSql).toContain("state <> 'STOPPED'");
    expect(updateSql).toContain("LIMIT");
    expect(deleteSql).toContain("DELETE FROM public.runtime_process_lease");
    expect(deleteSql).toContain("state = 'STOPPED'");
    expect(deleteSql).toContain("LIMIT");
  });

  it("degrades cleanly to skipped_permission on least-privilege app_user connections", async () => {
    const executeRaw = vi
      .fn()
      .mockRejectedValueOnce(new Error("ERROR: 42501: permission denied for table runtime_process_lease"));

    const res = await purgeExpiredRuntimeLeases({ $executeRaw: executeRaw });
    expect(res).toEqual({
      status: "skipped_permission",
      staleReclaimed: 0,
      expiredDeleted: 0,
    });
  });

  it("does not run when disabled via RUNTIME_LEASE_MAINTENANCE_ENABLED=off", () => {
    const executeRaw = vi.fn(async () => 0);
    const handle = startRuntimeLeaseMaintenance(
      { $executeRaw: executeRaw },
      { RUNTIME_LEASE_MAINTENANCE_ENABLED: "off" },
    );
    expect(executeRaw).not.toHaveBeenCalled();
    handle.stop();
  });
});
