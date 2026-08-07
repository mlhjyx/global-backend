import { canonicalDigest } from "../../model-runtime/context-engine";
import {
  assertGitReviewedEvidenceAcceptanceCurrent,
  createGitReviewedEvidenceAcceptanceArtifact,
  getGitReviewedEvidenceAcceptanceAttestation,
  GIT_REVIEWED_EVIDENCE_ACCEPTANCE_SCHEMA_VERSION,
  type GitReviewedEvidenceAcceptanceArtifact,
  type GitReviewedEvidenceAcceptanceSubject,
  type VerifiedGitReviewedEvidenceAcceptance,
} from "../../model-runtime/git-reviewed-evidence-acceptance";
import { RealModelExecutionLedger } from "../../model-runtime/real-model-execution-ledger";
import type { CopyTaskOutput } from "../agents/copy";
import {
  COPY_ASSEMBLY_EVAL_FIXTURES,
  evaluateCopyAssemblyOutput,
  prepareCopyAssemblyEvalFixture,
  type PreparedCopyAssemblyEvalFixture,
} from "./copy-assembly-eval";
import { COPY_EVALUATION_V2_CANDIDATES } from "./copy-evaluation-v2-candidates";
import {
  type CopyQualityCandidateReceipt,
  validateCopyQualityCandidateReceipt,
} from "./copy-quality-candidate-receipt";

export {
  COPY_QUALITY_ACCEPTED_REPLAY_WORKSPACE_ID,
  COPY_QUALITY_CANDIDATE_RECEIPT_SCHEMA_VERSION,
  createCopyQualityCandidateReceipt,
  type CopyQualityCandidateReceipt,
  type CopyQualityCandidateRuntimeBinding,
} from "./copy-quality-candidate-receipt";

export const COPY_QUALITY_ACCEPTED_REPLAY_SCHEMA_VERSION =
  "site-builder-copy-quality-accepted-output-replay/2026-08-07-v1" as const;

const HANDLE_CLASSIFICATION =
  "GIT_REVIEWED_COPY_QUALITY_OUTPUT_REPLAY" as const;
const REOPEN_INPUT_KEYS = Object.freeze([
  "ledgerPath",
  "authorizationClaimPath",
  "acceptance",
] as const);
const ARTIFACT_INPUT_KEYS = Object.freeze(["artifactId", "receipt"] as const);

const CANONICAL_DIGEST = canonicalDigest;
const GET_GIT_ACCEPTANCE = getGitReviewedEvidenceAcceptanceAttestation;
const ASSERT_GIT_ACCEPTANCE_CURRENT =
  assertGitReviewedEvidenceAcceptanceCurrent;
const ARRAY_IS_ARRAY = Array.isArray.bind(Array);
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf.bind(Object);
const OBJECT_VALUES = Object.values.bind(Object);
const OBJECT_FREEZE = Object.freeze.bind(Object);
const REFLECT_OWN_KEYS = Reflect.ownKeys.bind(Reflect);
const STRUCTURED_CLONE = structuredClone;

export interface CopyQualityAcceptedExecution {
  readonly __opaque?: never;
}

export interface CopyQualityAcceptedExecutionAttestation {
  schemaVersion: typeof COPY_QUALITY_ACCEPTED_REPLAY_SCHEMA_VERSION;
  classification: typeof HANDLE_CLASSIFICATION;
  evidenceClass: "git_reviewed_gateway_settlement_accepted";
  evidenceKind: "quality_matrix";
  acceptanceId: string;
  artifactDigest: string;
  artifactCommit: string;
  mergeCommit: string;
  pullRequestNumber: number;
  candidateReceiptDigest: string;
  candidateLedgerDigest: string;
  evidenceLedgerDigest: string;
  alias: string;
  providerFamily: CopyQualityCandidateReceipt["providerFamily"];
  fixtureId: string;
  repeatIndex: 0 | 1;
  executionId: string;
  outputDigest: string;
  output: CopyTaskOutput;
}

export interface CopyQualityAcceptedExecutionObservation {
  candidateAlias: string;
  providerFamily: CopyQualityCandidateReceipt["providerFamily"];
  prepared: PreparedCopyAssemblyEvalFixture;
  output: CopyTaskOutput;
  repeatIndex: 0 | 1;
  executionId: string;
  evidenceClass: "git_reviewed_gateway_settlement_accepted";
  ledgerDigest: string;
}

const ACCEPTED_EXECUTIONS = new WeakMap<
  object,
  CopyQualityAcceptedExecutionAttestation
>();
const GET_ACCEPTED_EXECUTION =
  ACCEPTED_EXECUTIONS.get.bind(ACCEPTED_EXECUTIONS);
const SET_ACCEPTED_EXECUTION =
  ACCEPTED_EXECUTIONS.set.bind(ACCEPTED_EXECUTIONS);

function fail(code: string): never {
  throw new Error("COPY_QUALITY_REPLAY_" + code);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of OBJECT_VALUES(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    OBJECT_FREEZE(value);
  }
  return value;
}

function immutableClone<T>(value: T): T {
  return deepFreeze(STRUCTURED_CLONE(value));
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== "object" || ARRAY_IS_ARRAY(value)) {
    return false;
  }
  const prototype = OBJECT_GET_PROTOTYPE_OF(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!plainRecord(value)) return false;
  const keys = REFLECT_OWN_KEYS(value);
  if (keys.length !== expected.length) return false;
  for (const key of keys) {
    if (typeof key !== "string" || !expected.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return false;
  }
  return true;
}

function acceptanceSubject(
  receipt: CopyQualityCandidateReceipt,
): GitReviewedEvidenceAcceptanceSubject {
  return OBJECT_FREEZE({
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
  });
}

export function createCopyQualityAcceptedReplayArtifact(input: {
  artifactId: string;
  receipt: CopyQualityCandidateReceipt;
}): GitReviewedEvidenceAcceptanceArtifact {
  if (!exactKeys(input, ARTIFACT_INPUT_KEYS)) {
    return fail("ARTIFACT_INPUT_INVALID");
  }
  const { receipt } = validateCopyQualityCandidateReceipt(input.receipt);
  return createGitReviewedEvidenceAcceptanceArtifact({
    artifactId: input.artifactId,
    acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted",
    taskId: "site_builder.copy",
    evidenceKind: "quality_matrix",
    candidateReceipt: receipt as unknown as Readonly<Record<string, unknown>>,
    subject: acceptanceSubject(receipt),
  });
}

export async function reopenCopyQualityAcceptedExecution(input: {
  ledgerPath: string;
  authorizationClaimPath: string;
  acceptance: VerifiedGitReviewedEvidenceAcceptance;
}): Promise<CopyQualityAcceptedExecution> {
  if (!exactKeys(input, REOPEN_INPUT_KEYS)) {
    return fail("REOPEN_INPUT_INVALID");
  }
  const accepted = GET_GIT_ACCEPTANCE(input.acceptance);
  if (!accepted) return fail("GIT_ACCEPTANCE_REQUIRED");
  const validated = validateCopyQualityCandidateReceipt(
    accepted.candidateReceipt,
  );
  const { receipt, output, outputBytes } = validated;
  let candidateReceiptDigest: string;
  try {
    candidateReceiptDigest = CANONICAL_DIGEST(receipt);
  } catch {
    return fail("RECEIPT_DIGEST_INVALID");
  }
  if (
    accepted.schemaVersion !==
      GIT_REVIEWED_EVIDENCE_ACCEPTANCE_SCHEMA_VERSION ||
    accepted.acceptedEvidenceClass !==
      "git_reviewed_gateway_settlement_accepted" ||
    accepted.taskId !== "site_builder.copy" ||
    accepted.evidenceKind !== "quality_matrix" ||
    accepted.candidateReceiptDigest !== candidateReceiptDigest ||
    CANONICAL_DIGEST(accepted.subject) !==
      CANONICAL_DIGEST(acceptanceSubject(receipt))
  ) {
    return fail("GIT_ACCEPTANCE_BINDING_MISMATCH");
  }
  await ASSERT_GIT_ACCEPTANCE_CURRENT(input.acceptance);
  let ledger: RealModelExecutionLedger;
  try {
    ledger = await RealModelExecutionLedger.reopen({
      ledgerPath: input.ledgerPath,
      authorizationClaimPath: input.authorizationClaimPath,
      campaign: receipt.ledgerCampaign,
      authorization: receipt.ledgerAuthorization,
    });
  } catch {
    return fail("LEDGER_REOPEN_MISMATCH");
  }
  let snapshot;
  try {
    snapshot = await ledger.completedExecutionSnapshot(
      receipt.executionId,
      receipt.executionPlanDigest,
    );
  } catch {
    return fail("LEDGER_COMPLETION_MISMATCH");
  }
  if (
    snapshot.completionSequence !== receipt.completionSequence ||
    snapshot.planDigest !== receipt.executionPlanDigest ||
    snapshot.outputDigest !== receipt.outputDigest ||
    snapshot.ledgerDigest !== receipt.ledgerDigest ||
    snapshot.knownSettlementDigest !== receipt.knownSettlementDigest ||
    snapshot.alias !== receipt.alias ||
    snapshot.protocol !== receipt.protocol ||
    snapshot.wireCount !== receipt.wireCount
  ) {
    return fail("LEDGER_COMPLETION_MISMATCH");
  }
  const evidenceLedgerDigest = await ledger.consumeGitAcceptedOutputReplay({
    acceptanceId: accepted.artifactId,
    artifactDigest: accepted.artifactDigest,
    artifactCommit: accepted.artifactCommit,
    mergeCommit: accepted.mergeCommit,
    pullRequestNumber: accepted.pullRequestNumber,
    acceptedEvidenceClass: accepted.acceptedEvidenceClass,
    evidenceKind: accepted.evidenceKind,
    candidateReceiptDigest,
    executionId: receipt.executionId,
    planDigest: receipt.executionPlanDigest,
    outputDigest: receipt.outputDigest,
    candidateLedgerDigest: receipt.ledgerDigest,
    fixedSourceCommit: receipt.fixedSourceCommit,
    sourceBundleDigest: receipt.sourceBundleDigest,
    manifestDigest: receipt.manifestDigest,
    admissionDigest: receipt.admissionDigest,
    compiledRuntimeDigest: receipt.compiledRuntimeDigest,
    compiledBindingDigest: receipt.compiledBindingDigest,
    settlementObserverDigest: receipt.settlementObserverDigest,
    knownSettlementDigest: receipt.knownSettlementDigest,
    alias: receipt.alias,
    protocol: receipt.protocol,
    reasoning: receipt.reasoning,
    completionSequence: receipt.completionSequence,
    fixtureId: receipt.fixtureId,
    repeatIndex: receipt.repeatIndex,
    outputBytesDigest: receipt.outputBytesSha256,
    outputByteLength: receipt.outputByteLength,
    outputBytes,
  });
  const handle = OBJECT_FREEZE({}) as CopyQualityAcceptedExecution;
  SET_ACCEPTED_EXECUTION(
    handle,
    deepFreeze({
      schemaVersion: COPY_QUALITY_ACCEPTED_REPLAY_SCHEMA_VERSION,
      classification: HANDLE_CLASSIFICATION,
      evidenceClass: "git_reviewed_gateway_settlement_accepted" as const,
      evidenceKind: "quality_matrix" as const,
      acceptanceId: accepted.artifactId,
      artifactDigest: accepted.artifactDigest,
      artifactCommit: accepted.artifactCommit,
      mergeCommit: accepted.mergeCommit,
      pullRequestNumber: accepted.pullRequestNumber,
      candidateReceiptDigest,
      candidateLedgerDigest: receipt.ledgerDigest,
      evidenceLedgerDigest,
      alias: receipt.alias,
      providerFamily: receipt.providerFamily,
      fixtureId: receipt.fixtureId,
      repeatIndex: receipt.repeatIndex,
      executionId: receipt.executionId,
      outputDigest: receipt.outputDigest,
      output: immutableClone(output),
    }),
  );
  return handle;
}

export function getCopyQualityAcceptedExecutionAttestation(
  execution: CopyQualityAcceptedExecution,
): CopyQualityAcceptedExecutionAttestation | undefined {
  return GET_ACCEPTED_EXECUTION(execution);
}

function acceptedExecutionReviewError(
  code: "UNTRUSTED" | "INADMISSIBLE",
): never {
  throw new Error(`COPY_QUALITY_REVIEW_ACCEPTED_EXECUTION_${code}`);
}

export function materializeCopyQualityAcceptedExecution(
  execution: CopyQualityAcceptedExecution,
): CopyQualityAcceptedExecutionObservation {
  const accepted = GET_ACCEPTED_EXECUTION(execution);
  if (!accepted) return acceptedExecutionReviewError("UNTRUSTED");
  const candidate = COPY_EVALUATION_V2_CANDIDATES.find(
    (entry) =>
      entry.alias === accepted.alias &&
      entry.providerFamily === accepted.providerFamily,
  );
  const source = COPY_ASSEMBLY_EVAL_FIXTURES.find(
    (fixture) => fixture.fixtureId === accepted.fixtureId,
  );
  if (
    accepted.classification !== HANDLE_CLASSIFICATION ||
    accepted.evidenceClass !== "git_reviewed_gateway_settlement_accepted" ||
    accepted.evidenceKind !== "quality_matrix" ||
    !candidate ||
    !source ||
    ![0, 1].includes(accepted.repeatIndex) ||
    typeof accepted.executionId !== "string" ||
    accepted.executionId.length === 0 ||
    !/^[0-9a-f]{64}$/u.test(accepted.outputDigest) ||
    !/^[0-9a-f]{64}$/u.test(accepted.candidateLedgerDigest) ||
    !/^[0-9a-f]{64}$/u.test(accepted.evidenceLedgerDigest)
  ) {
    return acceptedExecutionReviewError("INADMISSIBLE");
  }
  const prepared = prepareCopyAssemblyEvalFixture(source);
  const output = immutableClone(accepted.output);
  try {
    const hardGate = evaluateCopyAssemblyOutput(prepared, output);
    if (
      !hardGate.hardGatePassed ||
      !hardGate.productionValidationPassed ||
      !hardGate.factualSlotContentMatches ||
      CANONICAL_DIGEST(output) !== accepted.outputDigest
    ) {
      return acceptedExecutionReviewError("INADMISSIBLE");
    }
  } catch {
    return acceptedExecutionReviewError("INADMISSIBLE");
  }
  return OBJECT_FREEZE({
    candidateAlias: candidate.alias,
    providerFamily: candidate.providerFamily,
    prepared,
    output,
    repeatIndex: accepted.repeatIndex,
    executionId: accepted.executionId,
    evidenceClass: accepted.evidenceClass,
    ledgerDigest: accepted.evidenceLedgerDigest,
  });
}
