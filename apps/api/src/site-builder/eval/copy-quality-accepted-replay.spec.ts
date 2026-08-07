import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DurableModelExecutionRuntime } from "../../model-runtime/durable-model-execution-runtime";
import {
  createGitReviewedEvidenceAcceptanceArtifact,
  verifyGitReviewedEvidenceAcceptanceArtifact,
  writeGitReviewedEvidenceAcceptanceArtifact,
  type GitReviewedEvidenceAcceptanceArtifact,
} from "../../model-runtime/git-reviewed-evidence-acceptance";
import {
  RealModelExecutionLedger,
  type RealModelExecutionAuthorization,
} from "../../model-runtime/real-model-execution-ledger";
import {
  canonicalDigest,
  stableSerialize,
} from "../../model-runtime/context-engine";
import type { ModelExecutionCampaignContract } from "../../model-runtime/model-execution-ledger";
import type { ModelExecutionResult } from "../../model-runtime/types";
import type { CopyTaskOutput } from "../agents/copy";
import {
  COPY_ASSEMBLY_EVAL_FIXTURES,
  prepareCopyAssemblyEvalFixture,
} from "./copy-assembly-eval";
import { COPY_EVALUATION_V2_CANDIDATES } from "./copy-evaluation-v2-candidates";
import {
  COPY_QUALITY_ACCEPTED_REPLAY_WORKSPACE_ID,
  createCopyQualityAcceptedReplayArtifact,
  createCopyQualityCandidateReceipt,
  getCopyQualityAcceptedExecutionAttestation,
  reopenCopyQualityAcceptedExecution,
  type CopyQualityCandidateReceipt,
  type CopyQualityCandidateRuntimeBinding,
} from "./copy-quality-accepted-replay";
import {
  COPY_QUALITY_MATRIX_PLAN,
  createCopyQualityMatrixExecutionPlan,
} from "./copy-quality-matrix-runner";
import {
  aggregateCopyCandidateQuality,
  evaluateCopyQualityReview,
  evaluateCopyRepeatStability,
  observeCopyQualityAcceptedExecution,
  observeCopyQualityExecution,
  type CopyQualityExecutionReceipt,
} from "./copy-quality-evaluator";
import {
  COPY_QUALITY_REVIEW_SCHEMA_VERSION,
  COPY_QUALITY_RUBRIC_VERSION,
} from "./copy-quality-rubric";

const directories: string[] = [];
let sequence = 0;

const digest = (character: string) => character.repeat(64);

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

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

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function realCandidate(input?: {
  executionKey?: string;
  output?: CopyTaskOutput;
}) {
  sequence += 1;
  const execution = input?.executionKey
    ? COPY_QUALITY_MATRIX_PLAN.executions.find(
        (candidate) => candidate.executionKey === input.executionKey,
      )
    : COPY_QUALITY_MATRIX_PLAN.executions[0];
  if (!execution) throw new Error("test execution missing");
  const campaignId = `copy-quality-replay-${sequence}`;
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
  const output =
    input?.output ?? structuredClone(prepared.fixture.expectedOutput);
  const directory = await mkdtemp(join(tmpdir(), "copy-quality-replay-"));
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
    authorizationId: `copy-quality-authorization-${sequence}`,
    reservationId: `copy-quality-reservation-${sequence}`,
    manifestDigest: digest("1"),
    credentialAttestationDigest: digest("2"),
    settlementObserverDigest: digest("3"),
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
        requestId: `copy-quality-request-${sequence}`,
        settlement: "known" as const,
        settlementProof: {
          requestId: `copy-quality-request-${sequence}`,
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
  return {
    ledger,
    ledgerPath,
    authorizationClaimPath,
    receipt,
    output,
    execution,
    binding,
    result,
    prepared,
  };
}

async function sharedRealCandidates(
  executions: readonly (typeof COPY_QUALITY_MATRIX_PLAN.executions)[number][],
) {
  sequence += 1;
  const sharedSequence = sequence;
  const campaignId = `copy-quality-shared-${sharedSequence}`;
  const directory = await mkdtemp(join(tmpdir(), "copy-quality-shared-"));
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
    authorizationId: `copy-quality-shared-authorization-${sharedSequence}`,
    reservationId: `copy-quality-shared-reservation-${sharedSequence}`,
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
  const outputs = new Map(
    executions.map((execution) => {
      const prepared = prepareCopyAssemblyEvalFixture(
        COPY_ASSEMBLY_EVAL_FIXTURES.find(
          ({ fixtureId }) => fixtureId === execution.fixtureId,
        )!,
      );
      return [
        execution.executionKey,
        structuredClone(prepared.fixture.expectedOutput),
      ] as const;
    }),
  );
  const runtime = new DurableModelExecutionRuntime({
    ledger,
    expectedEvidenceClass: "gateway_settlement_claim_only",
    transport: {
      dispatch: async (plan) => {
        const execution = executions.find(
          ({ executionKey }) => executionKey === plan.executionId,
        );
        const output = outputs.get(plan.executionId);
        if (!execution || !output) throw new Error("shared execution missing");
        const requestId = `copy-quality-shared-${sharedSequence}-${plan.executionId}`;
        return {
          output,
          requestedAlias: execution.alias,
          resolvedAlias: execution.alias,
          reportedModel: execution.alias,
          protocol: execution.protocol,
          usage: { inputTokens: 11, outputTokens: 17 },
          usageComplete: true as const,
          requestId,
          settlement: "known" as const,
          settlementProof: {
            requestId,
            alias: execution.alias,
            protocol: execution.protocol,
            channelId: 17,
            quota: 29,
            inputTokens: 11,
            outputTokens: 17,
            receiptDigest: sha256(plan.executionId),
            resolverId: "copy-quality-test-resolver",
          },
          warnings: [] as const,
        };
      },
    },
  });
  const receipts: CopyQualityCandidateReceipt[] = [];
  for (const execution of executions) {
    const plan = createCopyQualityMatrixExecutionPlan({
      executionKey: execution.executionKey,
      campaignId,
      workspaceId: COPY_QUALITY_ACCEPTED_REPLAY_WORKSPACE_ID,
    });
    const result = (await runtime.execute(
      plan,
    )) as ModelExecutionResult<CopyTaskOutput>;
    receipts.push(
      await createCopyQualityCandidateReceipt({ result, ledger, binding }),
    );
  }
  return { ledger, ledgerPath, authorizationClaimPath, receipts, outputs };
}

function reviewFor(receipt: CopyQualityExecutionReceipt) {
  return {
    schemaVersion: COPY_QUALITY_REVIEW_SCHEMA_VERSION,
    rubricVersion: COPY_QUALITY_RUBRIC_VERSION,
    fixtureId: receipt.fixtureId,
    repeatIndex: receipt.repeatIndex,
    executionId: receipt.executionId,
    outputDigest: receipt.outputDigest,
    reviewer: {
      kind: "human_blind" as const,
      identityDigest: digest("d"),
      providerFamily: null,
    },
    findings: [],
  };
}

function acceptanceSubject(receipt: CopyQualityCandidateReceipt) {
  return {
    executionId: receipt.executionId,
    outputDigest: receipt.outputDigest,
    candidateLedgerDigest: receipt.ledgerDigest,
    fixedSourceCommit: receipt.fixedSourceCommit,
    sourceBundleDigest: receipt.sourceBundleDigest,
    manifestDigest: receipt.manifestDigest,
    compiledRuntimeDigest: receipt.compiledRuntimeDigest,
    compiledBindingDigest: receipt.compiledBindingDigest,
    settlementObserverDigest: receipt.settlementObserverDigest,
    knownSettlementDigest: receipt.knownSettlementDigest,
    alias: receipt.alias,
    protocol: receipt.protocol,
    reasoning: receipt.reasoning,
  };
}

function genericArtifact(
  receipt: CopyQualityCandidateReceipt,
  input?: { artifactId?: string; evidenceKind?: string },
) {
  return createGitReviewedEvidenceAcceptanceArtifact({
    artifactId:
      input?.artifactId ?? `copy-quality-acceptance-${sequence}-${Date.now()}`,
    acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted",
    taskId: "site_builder.copy",
    evidenceKind: input?.evidenceKind ?? "quality_matrix",
    candidateReceipt: receipt as unknown as Readonly<Record<string, unknown>>,
    subject: acceptanceSubject(receipt),
  });
}

async function verifiedAcceptance(
  artifact: GitReviewedEvidenceAcceptanceArtifact,
) {
  const root = await mkdtemp(join(tmpdir(), "copy-quality-accepted-git-"));
  directories.push(root);
  await mkdir(join(root, "docs", "evidence"), { recursive: true });
  const artifactPath = join(root, "docs", "evidence", "acceptance.json");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "copy-quality@example.test");
  git(root, "config", "user.name", "Copy Quality Test");
  await mkdir(join(root, "base"), { recursive: true });
  await writeFile(join(root, "base", "README.md"), "base\n", "utf8");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "acceptance/copy-quality");
  await writeGitReviewedEvidenceAcceptanceArtifact({ artifactPath, artifact });
  git(root, "add", "docs/evidence/acceptance.json");
  git(root, "commit", "-qm", "test: add Copy quality acceptance");
  git(root, "checkout", "-q", "main");
  git(
    root,
    "merge",
    "--no-ff",
    "acceptance/copy-quality",
    "-m",
    `Merge pull request #${400 + sequence} from test/copy-quality`,
  );
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  return verifyGitReviewedEvidenceAcceptanceArtifact({
    repositoryRoot: root,
    artifactPath,
  });
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

describe("Copy quality accepted output replay", () => {
  it("replays multiple executions from one shared ledger without a singular authorization evidence binding", async () => {
    const shared = await sharedRealCandidates(
      COPY_QUALITY_MATRIX_PLAN.executions.slice(0, 2),
    );
    expect(shared.receipts).toHaveLength(2);
    expect(
      shared.receipts.every(
        ({ ledgerAuthorization }) =>
          ledgerAuthorization.evidenceBinding === undefined &&
          ledgerAuthorization.sharedCampaignBinding?.maximumExecutions === 36 &&
          ledgerAuthorization.sharedCampaignBinding.maximumWireCalls === 72,
      ),
    ).toBe(true);

    for (const [index, receipt] of shared.receipts.entries()) {
      const acceptance = await verifiedAcceptance(
        genericArtifact(receipt, {
          artifactId: `copy-quality-shared-${sequence}-${index}`,
        }),
      );
      const handle = await reopenCopyQualityAcceptedExecution({
        ledgerPath: shared.ledgerPath,
        authorizationClaimPath: shared.authorizationClaimPath,
        acceptance,
      });
      expect(
        getCopyQualityAcceptedExecutionAttestation(handle)?.outputDigest,
      ).toBe(receipt.outputDigest);
    }
    expect((await shared.ledger.summary()).gitAcceptedOutputReplays).toBe(2);
  });

  it("passes one candidate's complete replay-backed 6x2 quality coverage while keeping route adoption separate", async () => {
    const candidateAlias = COPY_EVALUATION_V2_CANDIDATES[0]!.alias;
    const executions = COPY_QUALITY_MATRIX_PLAN.executions.filter(
      ({ alias }) => alias === candidateAlias,
    );
    const shared = await sharedRealCandidates(executions);
    const observed: CopyQualityExecutionReceipt[] = [];
    for (const [index, receipt] of shared.receipts.entries()) {
      const acceptance = await verifiedAcceptance(
        genericArtifact(receipt, {
          artifactId: `copy-quality-complete-${sequence}-${index}`,
        }),
      );
      observed.push(
        observeCopyQualityAcceptedExecution(
          await reopenCopyQualityAcceptedExecution({
            ledgerPath: shared.ledgerPath,
            authorizationClaimPath: shared.authorizationClaimPath,
            acceptance,
          }),
        ),
      );
    }
    const reviews = observed.map((receipt) =>
      evaluateCopyQualityReview(receipt, reviewFor(receipt)),
    );
    const stability = COPY_ASSEMBLY_EVAL_FIXTURES.map(({ fixtureId }) => {
      const first = observed.find(
        (receipt) =>
          receipt.fixtureId === fixtureId && receipt.repeatIndex === 0,
      );
      const second = observed.find(
        (receipt) =>
          receipt.fixtureId === fixtureId && receipt.repeatIndex === 1,
      );
      if (!first || !second) throw new Error("replay pair missing");
      return evaluateCopyRepeatStability(first, second);
    });
    const outcome = aggregateCopyCandidateQuality({
      candidateAlias,
      reviews,
      stability,
      hardGateFailures: 0,
    });

    expect(reviews).toHaveLength(12);
    expect(stability).toHaveLength(6);
    expect(outcome.scoredQualityGatePassed).toBe(true);
    expect(outcome.qualityGatePassed).toBe(true);
    expect(outcome.blockers).not.toContain(
      "DURABLE_ACCEPTED_ARTIFACT_REPLAY_REQUIRED",
    );
    expect(outcome.routeAdoptionAuthorized).toBe(false);

    const localFirst = await realCandidate({
      executionKey: executions[0]!.executionKey,
    });
    const localSecond = await realCandidate({
      executionKey: executions[1]!.executionKey,
    });
    const processLocalFirst = observeCopyQualityExecution({
      prepared: localFirst.prepared,
      result: localFirst.result,
      repeatIndex: localFirst.execution.repeatIndex,
    });
    const processLocalSecond = observeCopyQualityExecution({
      prepared: localSecond.prepared,
      result: localSecond.result,
      repeatIndex: localSecond.execution.repeatIndex,
    });
    const localReview = evaluateCopyQualityReview(
      processLocalFirst,
      reviewFor(processLocalFirst),
    );
    const mixedReviewOutcome = aggregateCopyCandidateQuality({
      candidateAlias,
      reviews: [localReview, ...reviews.slice(1)],
      stability,
      hardGateFailures: 0,
    });
    expect(mixedReviewOutcome.blockers).toContain(
      "DURABLE_ACCEPTED_ARTIFACT_REPLAY_REQUIRED",
    );

    const localStability = evaluateCopyRepeatStability(
      processLocalFirst,
      processLocalSecond,
    );
    const mixedStabilityOutcome = aggregateCopyCandidateQuality({
      candidateAlias,
      reviews,
      stability: [localStability, ...stability.slice(1)],
      hardGateFailures: 0,
    });
    expect(mixedStabilityOutcome.blockers).toContain(
      "DURABLE_ACCEPTED_ARTIFACT_REPLAY_REQUIRED",
    );
  }, 20_000);

  it.each([
    [
      "non-canonical base64",
      (receipt: CopyQualityCandidateReceipt) =>
        mutateReceipt(receipt, {
          outputBytesBase64: `${receipt.outputBytesBase64}!`,
        }),
    ],
    [
      "fatal UTF-8",
      (receipt: CopyQualityCandidateReceipt) => {
        const bytes = Buffer.from([0xc3, 0x28]);
        return mutateReceipt(receipt, {
          outputBytesBase64: bytes.toString("base64"),
          outputByteLength: bytes.length,
          outputBytesSha256: sha256(bytes),
        });
      },
    ],
    [
      "invalid JSON",
      (receipt: CopyQualityCandidateReceipt) => {
        const bytes = Buffer.from("not-json", "utf8");
        return mutateReceipt(receipt, {
          outputBytesBase64: bytes.toString("base64"),
          outputByteLength: bytes.length,
          outputBytesSha256: sha256(bytes),
          outputDigest: sha256(bytes),
        });
      },
    ],
    [
      "non-canonical JSON",
      (receipt: CopyQualityCandidateReceipt) => {
        const value = JSON.parse(
          Buffer.from(receipt.outputBytesBase64, "base64").toString("utf8"),
        );
        const bytes = Buffer.from(JSON.stringify(value, null, 2), "utf8");
        return mutateReceipt(receipt, {
          outputBytesBase64: bytes.toString("base64"),
          outputByteLength: bytes.length,
          outputBytesSha256: sha256(bytes),
          outputDigest: sha256(bytes),
        });
      },
    ],
    [
      "length drift",
      (receipt: CopyQualityCandidateReceipt) =>
        mutateReceipt(receipt, {
          outputByteLength: receipt.outputByteLength + 1,
        }),
    ],
    [
      "digest drift",
      (receipt: CopyQualityCandidateReceipt) =>
        mutateReceipt(receipt, { outputBytesSha256: digest("f") }),
    ],
    [
      "oversized bytes",
      (receipt: CopyQualityCandidateReceipt) => {
        const bytes = Buffer.alloc(64 * 1024 + 1, 0x20);
        return mutateReceipt(receipt, {
          outputBytesBase64: bytes.toString("base64"),
          outputByteLength: bytes.length,
          outputBytesSha256: sha256(bytes),
          outputDigest: sha256(bytes),
        });
      },
    ],
  ])("rejects accepted artifact output %s", async (_name, mutate) => {
    const candidate = await realCandidate();
    const malformed = mutate(candidate.receipt);
    const acceptance = await verifiedAcceptance(genericArtifact(malformed));

    await expect(
      reopenCopyQualityAcceptedExecution({
        ledgerPath: candidate.ledgerPath,
        authorizationClaimPath: candidate.authorizationClaimPath,
        acceptance,
      }),
    ).rejects.toThrow(/COPY_QUALITY_REPLAY_/u);
  });

  it("rejects canonical but different Copy output bytes against the completed snapshot", async () => {
    const candidate = await realCandidate();
    const changed = structuredClone(candidate.output);
    const slotKey = Object.keys(changed.slots)[0]!;
    changed.slots[slotKey]!.content =
      `${changed.slots[slotKey]!.content} changed`;
    const bytes = Buffer.from(stableSerialize(changed), "utf8");
    const drifted = mutateReceipt(candidate.receipt, {
      outputBytesBase64: bytes.toString("base64"),
      outputByteLength: bytes.length,
      outputBytesSha256: sha256(bytes),
      outputDigest: sha256(bytes),
    });
    const acceptance = await verifiedAcceptance(genericArtifact(drifted));

    await expect(
      reopenCopyQualityAcceptedExecution({
        ledgerPath: candidate.ledgerPath,
        authorizationClaimPath: candidate.authorizationClaimPath,
        acceptance,
      }),
    ).rejects.toThrow(/COPY_QUALITY_REPLAY_/u);
  });

  it("rejects a Git-verified capability-pilot acceptance", async () => {
    const candidate = await realCandidate();
    const capabilityReceipt = mutateReceipt(candidate.receipt, {
      evidenceKind: "capability_pilot",
    });
    const acceptance = await verifiedAcceptance(
      genericArtifact(capabilityReceipt, { evidenceKind: "capability_pilot" }),
    );

    await expect(
      reopenCopyQualityAcceptedExecution({
        ledgerPath: candidate.ledgerPath,
        authorizationClaimPath: candidate.authorizationClaimPath,
        acceptance,
      }),
    ).rejects.toThrow(/COPY_QUALITY_REPLAY_/u);
  });

  it("reopens without network, consumes once idempotently, and returns an opaque output handle", async () => {
    const candidate = await realCandidate();
    const artifact = createCopyQualityAcceptedReplayArtifact({
      artifactId: `copy-quality-valid-${sequence}`,
      receipt: candidate.receipt,
    });
    const acceptance = await verifiedAcceptance(artifact);
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = (async () => {
      networkCalls += 1;
      throw new Error("network forbidden");
    }) as typeof fetch;
    let first;
    let second;
    try {
      first = await reopenCopyQualityAcceptedExecution({
        ledgerPath: candidate.ledgerPath,
        authorizationClaimPath: candidate.authorizationClaimPath,
        acceptance,
      });
      second = await reopenCopyQualityAcceptedExecution({
        ledgerPath: candidate.ledgerPath,
        authorizationClaimPath: candidate.authorizationClaimPath,
        acceptance,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const firstAttestation = getCopyQualityAcceptedExecutionAttestation(first)!;
    const secondAttestation =
      getCopyQualityAcceptedExecutionAttestation(second)!;
    expect(networkCalls).toBe(0);
    expect(Object.keys(first)).toEqual([]);
    expect(firstAttestation).toMatchObject({
      classification: "GIT_REVIEWED_COPY_QUALITY_OUTPUT_REPLAY",
      evidenceClass: "git_reviewed_gateway_settlement_accepted",
      evidenceKind: "quality_matrix",
      alias: candidate.receipt.alias,
      providerFamily: candidate.receipt.providerFamily,
      fixtureId: candidate.receipt.fixtureId,
      repeatIndex: candidate.receipt.repeatIndex,
      executionId: candidate.receipt.executionId,
      outputDigest: candidate.receipt.outputDigest,
      candidateLedgerDigest: candidate.receipt.ledgerDigest,
      output: candidate.output,
    });
    expect(secondAttestation.evidenceLedgerDigest).toBe(
      firstAttestation.evidenceLedgerDigest,
    );
    expect(
      getCopyQualityAcceptedExecutionAttestation(structuredClone(first)),
    ).toBeUndefined();
    expect((await candidate.ledger.summary()).gitAcceptedOutputReplays).toBe(1);
    expect(await readFile(candidate.ledgerPath, "utf8")).not.toContain(
      candidate.receipt.outputBytesBase64,
    );
  });

  it("rejects a conflicting second Git acceptance for one completed execution", async () => {
    const candidate = await realCandidate();
    const first = await verifiedAcceptance(
      genericArtifact(candidate.receipt, {
        artifactId: `copy-quality-first-${sequence}`,
      }),
    );
    const second = await verifiedAcceptance(
      genericArtifact(candidate.receipt, {
        artifactId: `copy-quality-second-${sequence}`,
      }),
    );

    await reopenCopyQualityAcceptedExecution({
      ledgerPath: candidate.ledgerPath,
      authorizationClaimPath: candidate.authorizationClaimPath,
      acceptance: first,
    });
    await expect(
      reopenCopyQualityAcceptedExecution({
        ledgerPath: candidate.ledgerPath,
        authorizationClaimPath: candidate.authorizationClaimPath,
        acceptance: second,
      }),
    ).rejects.toThrow(/ALREADY_CONSUMED/u);
  });
});
