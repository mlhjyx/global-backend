import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildCanonicalModelEvaluationCase,
  buildTaskEvaluationPlan,
} from "./model-evaluation-harness";
import {
  SITE_BUILDER_MODEL_EVALUATION_COST_SAFETY_ID,
  type ModelEvaluationCostSafetyInput,
} from "./model-evaluation-cost-safety";
import { sha256CanonicalJson } from "./eval-provenance";
import {
  MODEL_EVALUATION_UNVERIFIED_PLANNING_UPPER_BOUND,
  buildModelEvaluationEvidencePlanningManifest,
  createModelEvaluationEvidencePrepBundle,
  createTrustedModelEvaluationEvidencePrepSnapshots,
  writeModelEvaluationEvidencePrepBundleCreateOnly,
} from "./model-evaluation-evidence-prep";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function exactCostSafetyInput(): ModelEvaluationCostSafetyInput {
  const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
  const legacyAliases = plan.evaluationSuite!.legacyComparatorAliases;
  const allowedDispatches = [
    ...plan.candidates.map((candidate) => ({
      mode: "target" as const,
      alias: candidate.alias,
      protocol: candidate.expectedProtocol,
    })),
    ...legacyAliases.map((alias) => ({
      mode: "legacy_comparator" as const,
      alias,
      protocol: "openai-chat-completions" as const,
    })),
  ];
  return {
    contractId: SITE_BUILDER_MODEL_EVALUATION_COST_SAFETY_ID,
    authorization: {
      authorizationId: "brand-profile-evidence-approval/2026-07-29-v1",
      ledgerId: "brand-profile-evidence-ledger/2026-07-29-v1",
      ledgerDirectorySha256: "a".repeat(64),
      approvedAt: "2026-07-29T00:00:00.000Z",
      approvedCampaignBudgetCents: 10_000,
      approvedDispatchExecutions: 61,
      preparedFixedCommitSha: "e".repeat(40),
      preparedSuiteId: plan.evaluationSuite!.suiteId,
      preparedSourceBundleContractId:
        plan.evaluationSuite!.sourceBundleContractId,
      preparedSourceBundleSha256: buildCanonicalModelEvaluationCase(
        plan,
        plan.evaluationSuite!.fixtureIds[0],
      ).contract.sourceBundleSha256,
    },
    credential: {
      attestationId: "brand-profile-evidence-credential/2026-07-29-v1",
      observedAt: "2026-07-29T00:00:00.000Z",
      snapshotSha256: "b".repeat(64),
      bearerTokenSha256: "c".repeat(64),
      gatewayOrigin: "https://evaluation-gateway.example.invalid",
      purpose: "site_builder_model_evaluation",
      quotaMode: "limited",
      scopeExact: true,
      quotaCapCents: 10_000,
      remainingQuotaCents: 10_000,
      allowedDispatches,
    },
    pricing: {
      snapshotId: "brand-profile-evidence-pricing/2026-07-29-v1",
      snapshotSha256: "d".repeat(64),
      basis: "frozen_unit_price_snapshot",
      defaultOrUnconfiguredRatioAllowed: false,
      resolverId: "brand-profile-evidence-settlement/v1",
      entries: allowedDispatches.map(({ alias, protocol }) => ({
        alias,
        protocol,
        inputCentsPerMillionTokens: 1,
        outputCentsPerMillionTokens: 2,
      })),
    },
    limits: {
      campaignBudgetCents: 10_000,
      maxDispatchExecutions: 61,
      maxWireCalls: 122,
      maxPromptUtf8BytesPerCall: 65_536,
      maxOutputTokensPerCall: 12_000,
    },
    settlement: {
      requestIdentityField: "executionId",
      requireVerifiedRequestSettlement: true,
      unknownSettlementPolicy: "freeze_campaign",
    },
    media: {
      genericChannelTest: "forbidden",
      allowedDispatches: [],
    },
  };
}

function trustedSnapshots(input = exactCostSafetyInput()) {
  return createTrustedModelEvaluationEvidencePrepSnapshots(
    safeSnapshotEnvelope(input),
  );
}

function safeSnapshotEnvelope(input = exactCostSafetyInput()) {
  const { snapshotSha256: _credentialDigest, ...credentialSnapshot } =
    input.credential;
  const { snapshotSha256: _pricingDigest, ...pricingSnapshot } = input.pricing;
  input.credential.snapshotSha256 = sha256CanonicalJson(credentialSnapshot);
  input.pricing.snapshotSha256 = sha256CanonicalJson(pricingSnapshot);
  return {
    schemaVersion: "site-builder-model-evaluation-safe-snapshots/v1",
    authorizationSnapshot: structuredClone(input.authorization),
    credentialSnapshot,
    pricingSnapshot,
    costSafety: input,
  } as const;
}

describe("model evaluation evidence preparation", () => {
  it("derives the exact 61-execution and 122-wire-call manifest from canonical contracts", () => {
    const manifest = buildModelEvaluationEvidencePlanningManifest();
    const byKind = Object.groupBy(
      manifest.executions,
      (execution) => execution.kind,
    );

    expect(manifest.executionCount).toBe(61);
    expect(manifest.maximumWireCallCount).toBe(122);
    expect(byKind.capability_probe).toHaveLength(1);
    expect(byKind.target).toHaveLength(36);
    expect(byKind.legacy_comparator).toHaveLength(24);
    expect(
      new Set(manifest.executions.map((item) => item.executionKey)).size,
    ).toBe(61);
    expect(
      manifest.executions.every(
        (item) =>
          item.maximumWireCalls === 2 &&
          item.wireCalls[1]?.purpose === "schema_repair_if_required",
      ),
    ).toBe(true);
    expect(manifest.unverifiedPlanningUpperBound).toEqual(
      MODEL_EVALUATION_UNVERIFIED_PLANNING_UPPER_BOUND,
    );
    expect(manifest.promptUtf8Bytes.maximumCanonicalInitial).toBeGreaterThan(0);
    expect(manifest.promptUtf8Bytes.maximumCanonicalRepair).toBeGreaterThan(
      manifest.promptUtf8Bytes.maximumCanonicalInitial,
    );
    expect(
      manifest.sourceFiles.every(
        (source) =>
          !source.path.includes("/dist/") &&
          !source.path.startsWith("/") &&
          !source.path.split("/").includes(".."),
      ),
    ).toBe(true);
  });

  it("contains only the BrandProfile canonical suite and admitted text dispatches", () => {
    const manifest = buildModelEvaluationEvidencePlanningManifest();

    expect(new Set(manifest.executions.map((item) => item.alias))).toEqual(
      new Set([
        "gpt-5.6-terra",
        "claude-sonnet-5",
        "gpt-5.5",
        "deepseek-v4-pro",
        "glm-5.2",
      ]),
    );
    expect(
      manifest.executions.some((item) =>
        [
          "gemini-3.5-flash",
          "gpt-image-2",
          "seedance-2-5s",
          "site-builder-bge-m3-local",
        ].includes(item.alias),
      ),
    ).toBe(false);
  });

  it("consumes an exact trusted cost attestation and emits a redacted non-dispatchable decision bundle", () => {
    const snapshots = trustedSnapshots();
    const bundle = createModelEvaluationEvidencePrepBundle({
      fixedCommitSha: "e".repeat(40),
      snapshots,
    });
    const serialized = JSON.stringify(bundle);

    expect(bundle.decisionCard).toMatchObject({
      status: "READY_FOR_PRODUCT_DECISION",
      dispatchAuthorization: "NOT_AUTHORIZED",
      executionCount: 61,
      maximumWireCallCount: 122,
    });
    expect(bundle.credentialEvidence).toMatchObject({
      bearerTokenSha256: "c".repeat(64),
      balanceSampledAt: "2026-07-29T00:00:00.000Z",
      quotaMode: "limited",
      scopeExact: true,
    });
    expect(bundle.pricingEvidence.billingUnit).toBe("cents_per_million_tokens");
    expect(bundle.authorizationEvidence).toMatchObject({
      authorizationId: "brand-profile-evidence-approval/2026-07-29-v1",
      ledgerId: "brand-profile-evidence-ledger/2026-07-29-v1",
      approvedDispatchExecutions: 61,
    });
    expect(bundle.authorizationEvidence.costSafetyAttestationSha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(bundle.authorizationEvidence.safeSnapshotEnvelopeSha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(bundle.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(serialized).not.toContain("Bearer ");
    expect(serialized).not.toContain("responseBody");
    expect(serialized).not.toContain("customer");
    expect(serialized).not.toContain("personalData");
  });

  it("rejects undeclared or non-reproducing safe snapshot data", () => {
    const extra = {
      ...safeSnapshotEnvelope(),
      responseBody: "must never be accepted",
    };
    expect(() =>
      createTrustedModelEvaluationEvidencePrepSnapshots(extra as never),
    ).toThrow("undeclared or missing fields");

    const mismatched = safeSnapshotEnvelope();
    mismatched.credentialSnapshot.remainingQuotaCents -= 1;
    expect(() =>
      createTrustedModelEvaluationEvidencePrepSnapshots(mismatched),
    ).toThrow("do not reproduce");
  });

  it("rejects untrusted, overbroad, or non-exact cost safety before producing a bundle", () => {
    const input = exactCostSafetyInput();
    const trusted = trustedSnapshots(input);
    expect(() =>
      createModelEvaluationEvidencePrepBundle({
        fixedCommitSha: "e".repeat(40),
        snapshots: structuredClone(trusted),
      }),
    ).toThrow("trusted fixed snapshot evidence required");

    input.authorization.approvedDispatchExecutions = 62;
    input.limits.maxDispatchExecutions = 62;
    const drifted = trustedSnapshots(input);
    expect(() =>
      createModelEvaluationEvidencePrepBundle({
        fixedCommitSha: "e".repeat(40),
        snapshots: drifted,
      }),
    ).toThrow("does not exactly match the frozen evidence manifest");
  });

  it("rejects invalid fixed commits and a priced maximum above finite funds", () => {
    const input = exactCostSafetyInput();
    const snapshots = trustedSnapshots(input);
    expect(() =>
      createModelEvaluationEvidencePrepBundle({
        fixedCommitSha: "main",
        snapshots,
      }),
    ).toThrow("full lowercase SHA-1");
    expect(() =>
      createModelEvaluationEvidencePrepBundle({
        fixedCommitSha: "d".repeat(40),
        snapshots,
      }),
    ).toThrow("not bound to the fixed evidence commit");

    input.pricing.entries = input.pricing.entries.map((entry) => ({
      ...entry,
      inputCentsPerMillionTokens: 100_000,
      outputCentsPerMillionTokens: 100_000,
    }));
    const expensive = trustedSnapshots(input);
    expect(() =>
      createModelEvaluationEvidencePrepBundle({
        fixedCommitSha: "e".repeat(40),
        snapshots: expensive,
      }),
    ).toThrow("exceeds priced cost safety");

    const undersizedPrompt = exactCostSafetyInput();
    undersizedPrompt.limits.maxPromptUtf8BytesPerCall = 1;
    expect(() =>
      createModelEvaluationEvidencePrepBundle({
        fixedCommitSha: "e".repeat(40),
        snapshots: trustedSnapshots(undersizedPrompt),
      }),
    ).toThrow("exceeds cost safety scope");
  });

  it("writes create-only with no overwrite path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "model-evidence-prep-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "nested", "prep.json");
    const bundle = createModelEvaluationEvidencePrepBundle({
      fixedCommitSha: "e".repeat(40),
      snapshots: trustedSnapshots(),
    });

    await writeModelEvaluationEvidencePrepBundleCreateOnly(
      directory,
      "nested/prep.json",
      bundle,
    );
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(bundle);
    await expect(
      writeModelEvaluationEvidencePrepBundleCreateOnly(
        directory,
        "nested/prep.json",
        bundle,
      ),
    ).rejects.toMatchObject({ code: "EEXIST" });

    await writeFile(join(directory, "untouched"), "user data");
    expect(await readFile(join(directory, "untouched"), "utf8")).toBe(
      "user data",
    );
  });

  it("rejects untrusted bundles and parent-directory symlink escapes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "model-evidence-root-"));
    const outside = await mkdtemp(join(tmpdir(), "model-evidence-outside-"));
    temporaryDirectories.push(directory, outside);
    const bundle = createModelEvaluationEvidencePrepBundle({
      fixedCommitSha: "e".repeat(40),
      snapshots: trustedSnapshots(),
    });

    await expect(
      writeModelEvaluationEvidencePrepBundleCreateOnly(
        directory,
        "forged.json",
        structuredClone(bundle),
      ),
    ).rejects.toThrow("trusted evidence preparation bundle required");

    const { symlink } = await import("node:fs/promises");
    await symlink(outside, join(directory, "escape"));
    await expect(
      writeModelEvaluationEvidencePrepBundleCreateOnly(
        directory,
        "escape/prep.json",
        bundle,
      ),
    ).rejects.toThrow("parent must be a real directory");
    await expect(
      readFile(join(outside, "prep.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
