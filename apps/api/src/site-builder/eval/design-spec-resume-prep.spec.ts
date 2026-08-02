import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildDesignSpecResumePrep,
  renderDesignSpecResumeDecisionCard,
} from "./design-spec-resume-prep";

const EVIDENCE_ROOT = join(
  __dirname,
  "../../../../../docs/evidence/site-builder",
);

async function evidence(name: string): Promise<{
  value: unknown;
  sha256: string;
}> {
  const bytes = await readFile(join(EVIDENCE_ROOT, name));
  return {
    value: JSON.parse(bytes.toString("utf8")) as unknown,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function inputs() {
  const [manifest, preflight, stopped, probe, reconciliation] =
    await Promise.all([
      evidence("m1-g-design-spec-evaluation-manifest-v1.json"),
      evidence("m1-g-design-spec-evidence-preflight-v5.json"),
      evidence("m1-g-design-spec-real-evidence-v1.json"),
      evidence("m1-g-design-spec-capability-probe-v1.json"),
      evidence("m1-g-design-spec-settlement-reconciliation-v1.json"),
    ]);
  return {
    preparedFixedCommitSha: "a".repeat(40),
    manifest,
    preflight,
    stopped,
    probe,
    reconciliation,
  };
}

describe("design_spec zero-model resume preparation", () => {
  it("freezes 56 missing matrix executions plus one unavoidable new probe", async () => {
    const report = buildDesignSpecResumePrep(await inputs());

    expect(report).toMatchObject({
      schemaVersion: "site-builder-design-spec-resume-prep/v1",
      status: "READY_FOR_PRODUCT_DECISION",
      priorCampaign: {
        executionsStarted: 17,
        probeExecutions: 1,
        matrixExecutionsConsumed: 16,
        authorizationReusable: false,
      },
      resume: {
        remainingMatrixExecutions: 56,
        newProcessProbeExecutions: 1,
        minimumFutureDispatchExecutions: 57,
        maximumFutureWireCalls: 114,
        mechanicalHardCeilingCents: 2280,
        priorProbeReusable: false,
        currentRunnerCanResumeAsIs: false,
      },
      dispatchAuthorization: "NOT_AUTHORIZED",
      actualNetworkCalls: 0,
      actualModelWireCalls: 0,
      actualModelCostCents: 0,
      promotion: "NOT_AUTHORIZED",
      pricingSnapshot: {
        authority: "openox_model_marketplace",
        capturedAt: "2026-08-02T11:00:07.348Z",
        revalidation: "REQUIRED_BEFORE_COST_AUTHORIZATION",
      },
    });
    expect(report.executions).toHaveLength(57);
    expect(report.executions[0]).toMatchObject({
      resumeOrdinal: 1,
      kind: "capability_probe",
      alias: "gpt-5.5",
    });
    expect(report.executions.slice(1)).toHaveLength(56);
    expect(
      report.executions.some(
        ({ executionKey }) =>
          executionKey ===
          "target/gpt-5.6-terra/openai-responses/premium-innovation-sparse/2",
      ),
    ).toBe(false);
  });

  it("rejects a gap in the stopped target prefix", async () => {
    const source = await inputs();
    const stopped = structuredClone(source.stopped.value) as {
      runs: { runs: unknown[] }[];
    };
    stopped.runs[0]!.runs.splice(3, 1);

    expect(() =>
      buildDesignSpecResumePrep({
        ...source,
        stopped: { ...source.stopped, value: stopped },
      }),
    ).toThrow("contiguous manifest prefix");
  });

  it("does not count an unknown settlement without exact late reconciliation", async () => {
    const source = await inputs();
    const reconciliation = structuredClone(source.reconciliation.value) as {
      lateSettlement: { fixtureId: string };
    };
    reconciliation.lateSettlement.fixtureId = "wrong-fixture";

    expect(() =>
      buildDesignSpecResumePrep({
        ...source,
        reconciliation: {
          ...source.reconciliation,
          value: reconciliation,
        },
      }),
    ).toThrow("late settlement reconciliation");
  });

  it("rejects an attempt to treat the persisted probe as reusable", async () => {
    const source = await inputs();
    const reconciliation = structuredClone(source.reconciliation.value) as {
      ledger: { reusable: boolean };
    };
    reconciliation.ledger.reusable = true;

    expect(() =>
      buildDesignSpecResumePrep({
        ...source,
        reconciliation: {
          ...source.reconciliation,
          value: reconciliation,
        },
      }),
    ).toThrow("original authorization must remain non-reusable");
  });

  it("rejects raw response material in stopped evidence", async () => {
    const source = await inputs();
    const stopped = structuredClone(source.stopped.value) as {
      runs: { runs: Record<string, unknown>[] }[];
    };
    stopped.runs[0]!.runs[0]!.artifact = { private: "raw-response" };

    expect(() =>
      buildDesignSpecResumePrep({
        ...source,
        stopped: { ...source.stopped, value: stopped },
      }),
    ).toThrow("stopped run contains response material");
  });

  it("renders a non-authorizing decision card without credential material", async () => {
    const card = renderDesignSpecResumeDecisionCard(
      buildDesignSpecResumePrep(await inputs()),
    );

    expect(card).toContain("57 executions");
    expect(card).toContain("114 wire calls");
    expect(card).toContain("$22.80");
    expect(card).toContain("NOT_AUTHORIZED");
    expect(card).toContain("CNY 0.206539");
    expect(card).not.toMatch(/Bearer|password|token id|token fingerprint/i);
  });
});
