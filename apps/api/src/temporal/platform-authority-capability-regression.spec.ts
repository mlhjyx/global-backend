import { describe, expect, it, vi } from "vitest";
import { assertPlatformAuthorityReady } from "./platform-authority-readiness-gate";
import { PlatformAutomationReadinessService } from "../platform-authority/platform-automation-readiness";
import { PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1 } from "../platform-authority/platform-execution-contract";
import { loadVerifiedPlatformAuthorityPolicyAsset } from "../platform-authority/platform-authority-policy-asset";
import { startWorkerDependencyHeartbeat } from "../runtime/worker-dependency-heartbeat";
import { checkPlatformAuthorityReady } from "./platform-authority-readiness-gate";

function capabilities(temporalReady = true) {
  const ready = async () => ({ status: "ok" as const });
  return new PlatformAutomationReadinessService({
    technicalContract: PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1,
    policyAsset: loadVerifiedPlatformAuthorityPolicyAsset(),
    quote: ready, issuer: ready, writer: ready, revocationDelivery: ready, egressFence: ready,
    temporalProof: async () => temporalReady ? { status: "ok" } : { status: "failed", code: "TEMPORAL_UNAVAILABLE" },
  });
}

describe("platform authority capability regression", () => {
  it("drains the worker when a previously available issuance capability disappears", async () => {
    vi.useFakeTimers();
    let available = true;
    const shutdown = vi.fn();
    const heartbeat = vi.fn(async () => undefined);
    const blocked = vi.fn();
    let handle: Awaited<ReturnType<typeof startWorkerDependencyHeartbeat>> | undefined;
    try {
      handle = await startWorkerDependencyHeartbeat({
        check: () => checkPlatformAuthorityReady(() => capabilities(available).inspect()),
        leases: { heartbeat } as never,
        worker: { shutdown }, taskQueue: "understanding", intervalMs: 100,
        onBlocked: blocked,
      });
      expect(handle.admitted).toBe(true);
      available = false;
      await vi.advanceTimersByTimeAsync(100);
      expect(heartbeat).toHaveBeenCalledWith("WORKER", "DRAINING", "understanding");
      expect(shutdown).toHaveBeenCalledOnce();
      expect(blocked).toHaveBeenCalledWith("PLATFORM_BUDGET_AUTHORITY_NOT_READY");
    } finally {
      handle?.stop();
      vi.useRealTimers();
    }
  });
  it("admits a complete capability report without a prior grant", async () => {
    await expect(assertPlatformAuthorityReady(() => capabilities().inspect())).resolves.toBeUndefined();
  });
  it("rejects real SQL lifecycle rows even when old grants are active", async () => {
    const inspect = vi.fn(async () => [
      { purpose: "platform.acquisition", state: "active" },
      { purpose: "platform.intent_watch", state: "active" },
      { purpose: "platform.sanctions", state: "active" },
    ]);
    await expect(assertPlatformAuthorityReady(inspect)).rejects.toThrow("PLATFORM_BUDGET_AUTHORITY_NOT_READY");
    expect(inspect).toHaveBeenCalledOnce();
  });
  it("rechecks capability after a missing proof", async () => {
    await expect(assertPlatformAuthorityReady(() => capabilities(false).inspect())).rejects.toThrow("PLATFORM_BUDGET_AUTHORITY_NOT_READY");
    await expect(assertPlatformAuthorityReady(() => capabilities().inspect())).resolves.toBeUndefined();
  });
  it("rejects a ready flag with missing or duplicated schedule identities", async () => {
    const report = await capabilities().inspect();
    for (const rows of [report.rows.slice(1), [report.rows[0], ...report.rows.slice(0, 3)]]) {
      await expect(assertPlatformAuthorityReady(async () => ({ status: "ready", rows }))).rejects.toThrow("PLATFORM_BUDGET_AUTHORITY_NOT_READY");
    }
  });
  it("bounds probe errors without exposing transport details", async () => {
    await expect(assertPlatformAuthorityReady(async () => { throw new Error("private transport detail"); })).rejects.toThrow(/^PLATFORM_BUDGET_AUTHORITY_NOT_READY$/);
  });
});
