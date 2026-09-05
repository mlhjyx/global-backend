import { describe, expect, it, vi } from "vitest";

import { loadVerifiedPlatformAuthorityPolicyAsset } from "./platform-authority-policy-asset";
import {
  PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1,
  type PlatformExecutionScheduleId,
} from "./platform-execution-contract";
import {
  PlatformAutomationReadinessService,
  type PlatformAutomationReadinessDependencies,
} from "./platform-automation-readiness";

const OK = Object.freeze({ status: "ok" as const });

function dependencies(
  override: Partial<PlatformAutomationReadinessDependencies> = {},
): PlatformAutomationReadinessDependencies {
  return {
    technicalContract: PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1,
    policyAsset: loadVerifiedPlatformAuthorityPolicyAsset(),
    quote: vi.fn(async () => OK),
    temporalProof: vi.fn(async () => OK),
    issuer: vi.fn(async () => OK),
    writer: vi.fn(async () => OK),
    revocationDelivery: vi.fn(async () => OK),
    egressFence: vi.fn(async () => OK),
    ...override,
  };
}

function failed(code: string) {
  return Object.freeze({ status: "failed" as const, code });
}

describe("PlatformAutomationReadinessService", () => {
  it("reports the four exact schedule identities without collapsing the acquisition rows by purpose", async () => {
    const report = await new PlatformAutomationReadinessService(
      dependencies(),
    ).inspect();

    expect(report).toEqual({
      status: "ready",
      rows: [
        {
          identity: {
            temporalNamespace: "platform-automation",
            scheduleId: "acq-sweep",
            purpose: "platform.acquisition",
            workflowType: "acquisitionSweepWorkflow",
            taskQueue: "understanding",
          },
          desiredMode: "ENABLED",
          state: "ISSUABLE",
          code: "PLATFORM_AUTOMATION_ACQ_SWEEP_ISSUABLE",
        },
        {
          identity: {
            temporalNamespace: "platform-automation",
            scheduleId: "patents-cache-refresh",
            purpose: "platform.acquisition",
            workflowType: "patentsCacheRefreshWorkflow",
            taskQueue: "understanding",
          },
          desiredMode: "INTENTIONALLY_DISABLED_NO_EGRESS",
          state: "INTENTIONALLY_DISABLED_NO_EGRESS",
          code: "PLATFORM_AUTOMATION_PATENTS_CACHE_REFRESH_INTENTIONALLY_DISABLED_NO_EGRESS",
        },
        {
          identity: {
            temporalNamespace: "platform-automation",
            scheduleId: "intent-sweep",
            purpose: "platform.intent_watch",
            workflowType: "intentSweepWorkflow",
            taskQueue: "understanding",
          },
          desiredMode: "ENABLED",
          state: "ISSUABLE",
          code: "PLATFORM_AUTOMATION_INTENT_SWEEP_ISSUABLE",
        },
        {
          identity: {
            temporalNamespace: "platform-automation",
            scheduleId: "sanctions-refresh",
            purpose: "platform.sanctions",
            workflowType: "sanctionsRefreshWorkflow",
            taskQueue: "understanding",
          },
          desiredMode: "ENABLED",
          state: "ISSUABLE",
          code: "PLATFORM_AUTOMATION_SANCTIONS_REFRESH_ISSUABLE",
        },
      ],
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.rows)).toBe(true);
    expect(Object.isFrozen(report.rows[0]?.identity)).toBe(true);
  });

  it.each([
    ["quote", "QUOTE_UNAVAILABLE"],
    ["temporalProof", "TEMPORAL_PROOF_UNAVAILABLE"],
    ["issuer", "ISSUER_UNAVAILABLE"],
    ["writer", "WRITER_UNAVAILABLE"],
    ["revocationDelivery", "REVOCATION_DELIVERY_UNAVAILABLE"],
    ["egressFence", "BLOCKED"],
  ] as const)(
    "maps a failed %s fact to the approved closed state for the exact schedule",
    async (dependency, expectedState) => {
      const deps = dependencies({
        [dependency]: vi.fn(async (identity?: { scheduleId?: string }) =>
          !identity || identity.scheduleId === "intent-sweep"
            ? failed(
                dependency === "egressFence"
                  ? "PLATFORM_EGRESS_FENCE_UNAVAILABLE"
                  : "DEPENDENCY_UNAVAILABLE",
              )
            : OK,
        ),
      });

      const report = await new PlatformAutomationReadinessService(
        deps,
      ).inspect();
      const intent = report.rows.find(
        (row) => row.identity.scheduleId === "intent-sweep",
      );

      expect(report.status).toBe("not_ready");
      expect(intent).toMatchObject({
        desiredMode: "ENABLED",
        state: expectedState,
        code: `PLATFORM_AUTOMATION_INTENT_SWEEP_${expectedState}`,
      });
    },
  );

  it("does not probe quote, Temporal, issuer, writer, revocation or egress for intentionally disabled patents", async () => {
    const deps = dependencies();

    await new PlatformAutomationReadinessService(deps).inspect();

    for (const key of [
      "quote",
      "temporalProof",
      "issuer",
      "revocationDelivery",
      "egressFence",
    ] as const) {
      expect(deps[key]).not.toHaveBeenCalledWith(
        expect.objectContaining({ scheduleId: "patents-cache-refresh" }),
      );
    }
    expect(deps.writer).toHaveBeenCalledTimes(3);
  });

  it("keeps both acquisition schedules independently visible when only acq-sweep is unavailable", async () => {
    const deps = dependencies({
      temporalProof: vi.fn(async (identity) =>
        identity.scheduleId === "acq-sweep"
          ? failed("TEMPORAL_PROOF_UNAVAILABLE")
          : OK,
      ),
    });

    const report = await new PlatformAutomationReadinessService(deps).inspect();

    expect(
      report.rows
        .filter((row) => row.identity.purpose === "platform.acquisition")
        .map((row) => [row.identity.scheduleId, row.state]),
    ).toEqual([
      ["acq-sweep", "TEMPORAL_PROOF_UNAVAILABLE"],
      ["patents-cache-refresh", "INTENTIONALLY_DISABLED_NO_EGRESS"],
    ]);
  });

  it("fails the exact row as policy drift without consulting runtime dependencies when its identity drifts", async () => {
    const contract = structuredClone(PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1);
    contract.rows[0]!.workflowType = "driftedWorkflow";
    const deps = dependencies({ technicalContract: contract as never });

    const report = await new PlatformAutomationReadinessService(deps).inspect();

    expect(report.rows[0]).toMatchObject({
      identity: { scheduleId: "acq-sweep", workflowType: "driftedWorkflow" },
      state: "POLICY_DRIFT",
      code: "PLATFORM_AUTOMATION_ACQ_SWEEP_POLICY_DRIFT",
    });
    for (const key of [
      "quote",
      "temporalProof",
      "issuer",
      "revocationDelivery",
      "egressFence",
    ] as const) {
      expect(deps[key]).not.toHaveBeenCalledWith(
        expect.objectContaining({ scheduleId: "acq-sweep" }),
      );
    }
  });

  it("treats patents enablement without a frozen metered price as QUOTE_UNAVAILABLE instead of healthy", async () => {
    const contract = structuredClone(PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1);
    const patents = contract.rows.find(
      (row) => row.scheduleId === "patents-cache-refresh",
    )!;
    patents.costMode = "tool_estimated_cents";
    patents.physicalWireSelection = "all_declared_wires";
    patents.providerRequirements[0]!.requiredEnablement = "ENABLED";
    const policyAsset = structuredClone(
      loadVerifiedPlatformAuthorityPolicyAsset(),
    );
    policyAsset.policy.rows[1]!.desired_mode = "ENABLED";
    const deps = dependencies({
      technicalContract: contract as never,
      policyAsset: policyAsset as never,
      quote: vi.fn(async (identity) =>
        identity.scheduleId === "patents-cache-refresh"
          ? failed("PLATFORM_EXECUTION_BUDGET_QUOTE_UNAVAILABLE")
          : OK,
      ),
    });

    const report = await new PlatformAutomationReadinessService(deps).inspect();

    expect(
      report.rows.find(
        (row) => row.identity.scheduleId === "patents-cache-refresh",
      ),
    ).toMatchObject({
      desiredMode: "ENABLED",
      state: "QUOTE_UNAVAILABLE",
    });
  });

  it("bounds thrown probes to their closed state and never exposes raw dependency details", async () => {
    const deps = dependencies({
      issuer: vi.fn(async (identity) => {
        if (identity.scheduleId === "sanctions-refresh") {
          throw new Error("Bearer must-never-leak");
        }
        return OK;
      }),
    });

    const report = await new PlatformAutomationReadinessService(deps).inspect();
    const sanctions = report.rows.find(
      (row) => row.identity.scheduleId === "sanctions-refresh",
    );

    expect(sanctions).toMatchObject({ state: "ISSUER_UNAVAILABLE" });
    expect(JSON.stringify(report)).not.toContain("must-never-leak");
  });

  it("evaluates every schedule from the immutable contract order", async () => {
    const seen: PlatformExecutionScheduleId[] = [];
    const deps = dependencies({
      quote: vi.fn(async (identity) => {
        seen.push(identity.scheduleId);
        return OK;
      }),
    });

    await new PlatformAutomationReadinessService(deps).inspect();

    expect(seen).toEqual(["acq-sweep", "intent-sweep", "sanctions-refresh"]);
  });
});
