import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertDesignSpecFullRestartCreateOnlyTargetsAvailable,
  buildDesignSpecFullRestartPrep,
  buildDesignSpecFullRestartRunBinding,
  DESIGN_SPEC_FULL_RESTART_PREFLIGHT_SOURCE_BUNDLE_ID,
  renderDesignSpecFullRestartDecisionCard,
} from "./design-spec-full-restart-prep";

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
  const [manifest, resume, stopped, reconciliation] = await Promise.all([
    evidence("m1-g-design-spec-evaluation-manifest-v1.json"),
    evidence("m1-g-design-spec-resume-prep-v1.json"),
    evidence("m1-g-design-spec-real-evidence-v1.json"),
    evidence("m1-g-design-spec-settlement-reconciliation-v1.json"),
  ]);
  const preparedFixedCommitSha = "a".repeat(40);
  return {
    preparedFixedCommitSha,
    manifest,
    resume,
    stopped,
    reconciliation,
    runnerSourceBundle: {
      commitSha: preparedFixedCommitSha,
      contractId: DESIGN_SPEC_FULL_RESTART_PREFLIGHT_SOURCE_BUNDLE_ID,
      sha256: "b".repeat(64),
      files: [
        {
          path: "apps/api/scripts/run-site-builder-design-spec-real-evidence.mts",
          sha256: "c".repeat(64),
        },
      ],
    },
  };
}

describe("design_spec zero-model full canonical restart preparation", () => {
  it("freezes a new 73-execution campaign and excludes prior evidence", async () => {
    const report = buildDesignSpecFullRestartPrep(await inputs());

    expect(report).toMatchObject({
      schemaVersion: "site-builder-design-spec-full-restart-prep/v1",
      status: "READY_FOR_CREDENTIAL_PREFLIGHT",
      productDecision: "FULL_CANONICAL_CAMPAIGN_RESTART",
      priorCampaign: {
        executionsStarted: 17,
        evidenceReusableForRanking: false,
        ledgerReusable: false,
      },
      restart: {
        campaignId: "design-spec-full-restart-20260802-v1",
        dispatchExecutions: 73,
        probeExecutions: 1,
        matrixExecutions: 72,
        maximumWireCalls: 146,
        mechanicalHardCeilingCents: 2920,
        requiredQuotaPoints: 14_600_000,
        currentCanonicalRunnerCanExecute: true,
        scopedResumeRunnerRequired: false,
      },
      credentialGate: {
        status: "FRESH_FINITE_EXACT_CREDENTIAL_REQUIRED",
        exactAliases: ["claude-sonnet-5", "gpt-5.5", "gpt-5.6-terra"],
        quotaCapPoints: 14_600_000,
        remainingQuotaPoints: 14_600_000,
      },
      dispatchAuthorization: "NOT_AUTHORIZED",
      actualNetworkCalls: 0,
      actualModelWireCalls: 0,
      actualModelCostCents: 0,
      promotion: "NOT_AUTHORIZED",
    });
    expect(report.restart.executionKeys).toHaveLength(73);
    expect(new Set(report.restart.executionKeys)).toHaveLength(73);
    expect(report.restart.targetExecutionsByAlias).toEqual({
      "claude-sonnet-5": 24,
      "gpt-5.5": 24,
      "gpt-5.6-terra": 24,
    });
  });

  it("rejects any attempt to reuse prior campaign evidence", async () => {
    const source = await inputs();
    const resume = structuredClone(source.resume.value) as {
      priorCampaign: { authorizationReusable: boolean };
    };
    resume.priorCampaign.authorizationReusable = true;

    expect(() =>
      buildDesignSpecFullRestartPrep({
        ...source,
        resume: { ...source.resume, value: resume },
      }),
    ).toThrow("prior campaign must remain non-reusable");
  });

  it("rejects canonical manifest count or alias drift", async () => {
    const source = await inputs();
    const manifest = structuredClone(source.manifest.value) as {
      maximumWireCallCount: number;
      executions: { alias: string }[];
    };
    manifest.maximumWireCallCount = 144;
    manifest.executions[2]!.alias = "retired-model";

    expect(() =>
      buildDesignSpecFullRestartPrep({
        ...source,
        manifest: { ...source.manifest, value: manifest },
      }),
    ).toThrow("canonical full-restart manifest is invalid");
  });

  it("rejects price authority, alias, protocol, or currency drift", async () => {
    const source = await inputs();
    const resume = structuredClone(source.resume.value) as {
      pricingSnapshot: { entries: { currency: string }[] };
    };
    resume.pricingSnapshot.entries[0]!.currency = "CNY";

    expect(() =>
      buildDesignSpecFullRestartPrep({
        ...source,
        resume: { ...source.resume, value: resume },
      }),
    ).toThrow("frozen OpenOx reference is invalid");
  });

  it("builds unique safe bindings for a future fresh preflight and ledger", () => {
    expect(
      buildDesignSpecFullRestartRunBinding({
        campaignId: "design-spec-full-restart-20260802-v1",
        preflightPath:
          "docs/evidence/site-builder/m1-g-design-spec-full-restart-preflight-v1.json",
        executionPreflightOutputPath:
          "docs/evidence/site-builder/m1-g-design-spec-full-restart-execution-preflight-v1.json",
        outputPath:
          "docs/evidence/site-builder/m1-g-design-spec-full-restart-real-evidence-v1.json",
        probeOutputPath:
          "docs/evidence/site-builder/m1-g-design-spec-full-restart-capability-probe-v1.json",
      }),
    ).toEqual({
      campaignId: "design-spec-full-restart-20260802-v1",
      preflightPath:
        "docs/evidence/site-builder/m1-g-design-spec-full-restart-preflight-v1.json",
      executionPreflightOutputPath:
        "docs/evidence/site-builder/m1-g-design-spec-full-restart-execution-preflight-v1.json",
      outputPath:
        "docs/evidence/site-builder/m1-g-design-spec-full-restart-real-evidence-v1.json",
      probeOutputPath:
        "docs/evidence/site-builder/m1-g-design-spec-full-restart-capability-probe-v1.json",
      ledgerId:
        "design-spec-real-evidence-ledger/design-spec-full-restart-20260802-v1",
      credentialAttestationId:
        "design-spec-evaluation-credential/design-spec-full-restart-20260802-v1",
      pricingSnapshotId:
        "openox-design-spec-prices/design-spec-full-restart-20260802-v1",
    });
  });

  it("rejects unsafe, colliding, or legacy campaign bindings", () => {
    expect(() =>
      buildDesignSpecFullRestartRunBinding({
        campaignId: "../legacy",
        preflightPath:
          "docs/evidence/site-builder/m1-g-design-spec-full-restart-preflight-v1.json",
        executionPreflightOutputPath:
          "docs/evidence/site-builder/m1-g-design-spec-full-restart-execution-preflight-v1.json",
        outputPath:
          "docs/evidence/site-builder/m1-g-design-spec-full-restart-real-evidence-v1.json",
        probeOutputPath:
          "docs/evidence/site-builder/m1-g-design-spec-full-restart-capability-probe-v1.json",
      }),
    ).toThrow("campaign id is invalid");

    expect(() =>
      buildDesignSpecFullRestartRunBinding({
        campaignId: "design-spec-full-restart-20260802-v1",
        preflightPath:
          "docs/evidence/site-builder/m1-g-design-spec-full-restart-preflight-v1.json",
        executionPreflightOutputPath:
          "docs/evidence/site-builder/m1-g-design-spec-full-restart-execution-preflight-v1.json",
        outputPath:
          "docs/evidence/site-builder/m1-g-design-spec-full-restart-preflight-v1.json",
        probeOutputPath:
          "docs/evidence/site-builder/m1-g-design-spec-full-restart-capability-probe-v1.json",
      }),
    ).toThrow("evidence paths must be distinct");

    expect(() =>
      buildDesignSpecFullRestartRunBinding({
        campaignId: "design-spec-full-restart-20260802-v1",
        preflightPath:
          "docs/evidence/site-builder/m1-g-design-spec-evidence-preflight-v4.json",
        executionPreflightOutputPath:
          "docs/evidence/site-builder/m1-g-design-spec-full-restart-execution-preflight-v1.json",
        outputPath:
          "docs/evidence/site-builder/m1-g-design-spec-full-restart-real-evidence-v1.json",
        probeOutputPath:
          "docs/evidence/site-builder/m1-g-design-spec-full-restart-capability-probe-v1.json",
      }),
    ).toThrow("full-restart evidence binding drifted");
  });

  it("rejects an existing create-only evidence target before dispatch", () => {
    const binding = buildDesignSpecFullRestartRunBinding({
      campaignId: "design-spec-full-restart-20260802-v1",
      preflightPath:
        "docs/evidence/site-builder/m1-g-design-spec-full-restart-preflight-v1.json",
      executionPreflightOutputPath:
        "docs/evidence/site-builder/m1-g-design-spec-full-restart-execution-preflight-v1.json",
      outputPath:
        "docs/evidence/site-builder/m1-g-design-spec-full-restart-real-evidence-v1.json",
      probeOutputPath:
        "docs/evidence/site-builder/m1-g-design-spec-full-restart-capability-probe-v1.json",
    });

    expect(() =>
      assertDesignSpecFullRestartCreateOnlyTargetsAvailable(
        binding,
        (path) => path === binding.probeOutputPath,
      ),
    ).toThrow("create-only evidence target already exists");
  });

  it("renders a non-authorizing decision card without credential material", async () => {
    const card = renderDesignSpecFullRestartDecisionCard(
      buildDesignSpecFullRestartPrep(await inputs()),
    );

    expect(card).toContain("FULL_CANONICAL_CAMPAIGN_RESTART");
    expect(card).toContain("73 executions");
    expect(card).toContain("146 wire calls");
    expect(card).toContain("$29.20");
    expect(card).toContain("NOT_AUTHORIZED");
    expect(card).toContain("CNY 0.206539");
    expect(card).not.toMatch(/Bearer|password|token id|token fingerprint/i);
  });
});
