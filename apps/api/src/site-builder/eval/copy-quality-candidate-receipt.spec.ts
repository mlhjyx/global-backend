import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalDigest,
  stableSerialize,
} from "../../model-runtime/context-engine";
import { DurableModelExecutionRuntime } from "../../model-runtime/durable-model-execution-runtime";
import {
  RealModelExecutionLedger,
  type RealModelExecutionAuthorization,
} from "../../model-runtime/real-model-execution-ledger";
import type { ModelExecutionCampaignContract } from "../../model-runtime/model-execution-ledger";
import type { ModelExecutionResult } from "../../model-runtime/types";
import type { CopyTaskOutput } from "../agents/copy";
import {
  COPY_ASSEMBLY_EVAL_FIXTURES,
  prepareCopyAssemblyEvalFixture,
} from "./copy-assembly-eval";
import {
  COPY_QUALITY_ACCEPTED_REPLAY_WORKSPACE_ID,
  createCopyQualityAcceptedReplayArtifact,
  createCopyQualityCandidateReceipt,
  type CopyQualityCandidateReceipt,
  type CopyQualityCandidateRuntimeBinding,
} from "./copy-quality-accepted-replay";
import {
  COPY_QUALITY_MATRIX_PLAN,
  createCopyQualityMatrixExecutionPlan,
} from "./copy-quality-matrix-runner";

const directories: string[] = [];
let sequence = 0;

const digest = (character: string) => character.repeat(64);

function sharedCampaignBinding(binding: CopyQualityCandidateRuntimeBinding) {
  return Object.freeze({
    schemaVersion: "real-model-shared-campaign-binding/2026-08-07-v1" as const,
    purpose: "site_builder_copy_quality_matrix" as const,
    ledgerTopology: "shared_campaign_ledger" as const,
    taskId: "site_builder.copy" as const,
    planDigest: canonicalDigest(COPY_QUALITY_MATRIX_PLAN),
    fixedSourceCommit: binding.fixedSourceCommit,
    sourceBundleDigest: binding.sourceBundleDigest,
    manifestDigest: binding.manifestDigest,
    admissionDigest: binding.admissionDigest,
    credentialAttestationDigest: binding.credentialAttestationDigest,
    settlementObserverDigest: binding.settlementObserverDigest,
    compiledRuntimeDigest: binding.compiledRuntimeDigest,
    compiledBindingDigest: binding.compiledBindingDigest,
    maximumExecutions: COPY_QUALITY_MATRIX_PLAN.plannedExecutions,
    maximumWireCalls: COPY_QUALITY_MATRIX_PLAN.maximumWireCalls,
    maximumRepairCallsPerExecution: 1,
  });
}

async function realCandidate() {
  sequence += 1;
  const execution = COPY_QUALITY_MATRIX_PLAN.executions[0];
  if (!execution) throw new Error("test execution missing");
  const campaignId = `copy-quality-receipt-${sequence}`;
  const plan = createCopyQualityMatrixExecutionPlan({
    executionKey: execution.executionKey,
    campaignId,
    workspaceId: COPY_QUALITY_ACCEPTED_REPLAY_WORKSPACE_ID,
  });
  const prepared = prepareCopyAssemblyEvalFixture(
    COPY_ASSEMBLY_EVAL_FIXTURES.find(
      (fixture) => fixture.fixtureId === execution.fixtureId,
    )!,
  );
  const output = structuredClone(prepared.fixture.expectedOutput);
  const directory = await mkdtemp(join(tmpdir(), "copy-quality-receipt-"));
  directories.push(directory);
  const ledgerPath = join(directory, "ledger.jsonl");
  const authorizationClaimPath = join(directory, "claim.jsonl");
  const campaign: ModelExecutionCampaignContract = Object.freeze({
    campaignId,
    taskId: "site_builder.copy",
    planDigest: canonicalDigest(COPY_QUALITY_MATRIX_PLAN),
    maximumExecutions: COPY_QUALITY_MATRIX_PLAN.plannedExecutions,
    maximumWireCalls: COPY_QUALITY_MATRIX_PLAN.maximumWireCalls,
  });
  const binding: CopyQualityCandidateRuntimeBinding = Object.freeze({
    schemaVersion: "site-builder-copy-quality-runtime-binding/2026-08-07-v1",
    fixedSourceCommit: "a".repeat(40),
    sourceBundleDigest: digest("6"),
    manifestDigest: digest("1"),
    admissionDigest: digest("7"),
    credentialAttestationDigest: digest("2"),
    settlementObserverDigest: digest("3"),
    compiledRuntimeDigest: digest("a"),
    compiledBindingDigest: digest("b"),
  });
  const authorization: RealModelExecutionAuthorization = Object.freeze({
    authorizationId: `copy-quality-receipt-authorization-${sequence}`,
    reservationId: `copy-quality-receipt-reservation-${sequence}`,
    manifestDigest: binding.manifestDigest,
    credentialAttestationDigest: binding.credentialAttestationDigest,
    settlementObserverDigest: binding.settlementObserverDigest,
    ledgerIdentityDigest: digest("4"),
    reservationDigest: digest("5"),
    maximumExecutions: COPY_QUALITY_MATRIX_PLAN.plannedExecutions,
    maximumWireCalls: COPY_QUALITY_MATRIX_PLAN.maximumWireCalls,
    maximumRepairCallsPerExecution: 1,
    sharedCampaignBinding: sharedCampaignBinding(binding),
  });
  const ledger = await RealModelExecutionLedger.open({
    ledgerPath,
    authorizationClaimPath,
    campaign,
    authorization,
  });
  const runtime = new DurableModelExecutionRuntime({
    ledger,
    expectedEvidenceClass: "gateway_settlement_claim_only",
    transport: {
      dispatch: async () => ({
        output,
        requestedAlias: execution.alias,
        resolvedAlias: execution.alias,
        reportedModel: execution.alias,
        protocol: execution.protocol,
        usage: { inputTokens: 11, outputTokens: 17 },
        usageComplete: true as const,
        requestId: `copy-quality-receipt-request-${sequence}`,
        settlement: "known" as const,
        settlementProof: {
          requestId: `copy-quality-receipt-request-${sequence}`,
          alias: execution.alias,
          protocol: execution.protocol,
          channelId: 17,
          quota: 29,
          inputTokens: 11,
          outputTokens: 17,
          receiptDigest: digest("c"),
          resolverId: "copy-quality-test-resolver",
        },
        warnings: [] as const,
      }),
    },
  });
  const result = (await runtime.execute(
    plan,
  )) as ModelExecutionResult<CopyTaskOutput>;
  const receipt = await createCopyQualityCandidateReceipt({
    result,
    ledger,
    binding,
  });
  return { ledger, receipt, output, execution, binding, result };
}

function mutateReceipt(
  receipt: CopyQualityCandidateReceipt,
  changes: Record<string, unknown>,
): CopyQualityCandidateReceipt {
  return { ...receipt, ...changes } as CopyQualityCandidateReceipt;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Copy quality candidate receipt", () => {
  it("builds an exact digest-only quality receipt from a trusted real execution", async () => {
    const candidate = await realCandidate();

    expect(candidate.receipt).toMatchObject({
      classification: "COPY_QUALITY_GATEWAY_SETTLEMENT_CANDIDATE",
      evidenceClass: "gateway_settlement_claim_only",
      evidenceKind: "quality_matrix",
      taskId: "site_builder.copy",
      executionKey: candidate.execution.executionKey,
      fixtureId: candidate.execution.fixtureId,
      repeatIndex: candidate.execution.repeatIndex,
      alias: candidate.execution.alias,
      protocol: candidate.execution.protocol,
      reasoning: candidate.execution.reasoning,
      outputByteLength: Buffer.byteLength(stableSerialize(candidate.output)),
      outputBytesSha256: canonicalDigest(candidate.output),
    });
    expect(Object.isFrozen(candidate.receipt)).toBe(true);
    expect(Buffer.from(candidate.receipt.outputBytesBase64, "base64")).toEqual(
      Buffer.from(stableSerialize(candidate.output), "utf8"),
    );
    expect(JSON.stringify(candidate.receipt).toLowerCase()).not.toMatch(
      /bearertoken|apikey|tokenfingerprint|rawrequestid|rawprovider|ledgerpath|authorizationclaimpath/u,
    );
  });

  it("rejects process-local fake/raw results before making a receipt", async () => {
    const candidate = await realCandidate();
    await expect(
      createCopyQualityCandidateReceipt({
        result: structuredClone(
          candidate.output,
        ) as unknown as ModelExecutionResult<CopyTaskOutput>,
        ledger: candidate.ledger,
        binding: candidate.binding,
      }),
    ).rejects.toThrow("COPY_QUALITY_REPLAY_RUNTIME_RESULT_UNTRUSTED");
    await expect(
      createCopyQualityCandidateReceipt({
        result: {} as ModelExecutionResult<CopyTaskOutput>,
        ledger: {} as RealModelExecutionLedger,
        binding: candidate.binding,
      }),
    ).rejects.toThrow("COPY_QUALITY_REPLAY_LEDGER_UNTRUSTED");
  });

  it.each([
    ["fixed source", "fixedSourceCommit", "b".repeat(40)],
    ["source bundle", "sourceBundleDigest", digest("8")],
    ["admission", "admissionDigest", digest("8")],
    ["compiled runtime", "compiledRuntimeDigest", digest("8")],
    ["compiled binding", "compiledBindingDigest", digest("8")],
  ] as const)(
    "rejects caller-supplied %s provenance not bound by the shared campaign",
    async (_name, field, value) => {
      const candidate = await realCandidate();
      await expect(
        createCopyQualityCandidateReceipt({
          result: candidate.result,
          ledger: candidate.ledger,
          binding: { ...candidate.binding, [field]: value },
        }),
      ).rejects.toThrow("COPY_QUALITY_REPLAY_RUNTIME_BINDING_INVALID");
    },
  );

  it("rejects a quality receipt without the hash-chained shared campaign binding", async () => {
    const candidate = await realCandidate();
    const { sharedCampaignBinding: _removed, ...authorization } =
      candidate.receipt.ledgerAuthorization;
    expect(() =>
      createCopyQualityAcceptedReplayArtifact({
        artifactId: `copy-quality-unbound-${sequence}`,
        receipt: mutateReceipt(candidate.receipt, {
          ledgerAuthorization: authorization,
          ledgerAuthorizationDigest: canonicalDigest(authorization),
        }),
      }),
    ).toThrow("COPY_QUALITY_REPLAY_RECEIPT_SHAPE_INVALID");
  });

  it("rejects subset-capacity ledgers as production quality-matrix receipts", async () => {
    const candidate = await realCandidate();
    const sharedCampaignBinding = {
      ...candidate.receipt.ledgerAuthorization.sharedCampaignBinding!,
      maximumExecutions: 12,
      maximumWireCalls: 24,
    };
    const ledgerAuthorization = {
      ...candidate.receipt.ledgerAuthorization,
      maximumExecutions: 12,
      maximumWireCalls: 24,
      sharedCampaignBinding,
    };
    expect(() =>
      createCopyQualityAcceptedReplayArtifact({
        artifactId: `copy-quality-subset-cap-${sequence}`,
        receipt: mutateReceipt(candidate.receipt, {
          ledgerCampaign: {
            ...candidate.receipt.ledgerCampaign,
            maximumExecutions: 12,
            maximumWireCalls: 24,
          },
          ledgerAuthorization,
          ledgerAuthorizationDigest: canonicalDigest(ledgerAuthorization),
        }),
      }),
    ).toThrow("COPY_QUALITY_REPLAY_RECEIPT_BINDING_MISMATCH");
  });

  it.each([
    ["unknown field", { surprise: true }],
    ["secret-like field", { apiKey: "forbidden" }],
    ["capability evidence", { evidenceKind: "capability_pilot" }],
    ["fake evidence class", { evidenceClass: "fake_gateway_contract_only" }],
    ["fixture drift", { fixtureId: "copy-unknown-fixture" }],
    ["repeat drift", { repeatIndex: 2 }],
    ["matrix plan drift", { matrixPlanDigest: digest("f") }],
    ["execution plan drift", { executionPlanDigest: digest("f") }],
  ])("rejects %s in the artifact receipt", async (_name, changes) => {
    const candidate = await realCandidate();
    expect(() =>
      createCopyQualityAcceptedReplayArtifact({
        artifactId: `copy-quality-invalid-${sequence}`,
        receipt: mutateReceipt(candidate.receipt, changes),
      }),
    ).toThrow(/COPY_QUALITY_REPLAY_/u);
  });
});
