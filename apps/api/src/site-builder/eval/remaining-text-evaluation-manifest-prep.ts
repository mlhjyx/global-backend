import {
  SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID,
  buildCanonicalModelEvaluationCase,
  buildTaskEvaluationPlan,
} from "./model-evaluation-harness";
import {
  assertDesignSpecFixedSourceCommitOnMain,
  assertDesignSpecSourceBundleAtFixedCommit,
} from "./design-spec-evaluation-manifest-prep";
import { sha256CanonicalJson } from "./eval-provenance";
import { writeRepositoryJsonCreateOnly } from "./create-only-json";

export const REMAINING_TEXT_EVALUATION_MANIFEST_PREP_ID =
  "site-builder-remaining-text-evaluation-manifest-prep/2026-08-04-v1" as const;
export const REMAINING_TEXT_EVALUATION_MANIFEST_PREP_SCHEMA_VERSION =
  "site-builder-remaining-text-evaluation-manifest-prep/v1" as const;

const REMAINING_TEXT_TASK_IDS = Object.freeze([
  "site_builder.copy",
  "site_builder.assemble",
  "site_builder.assembly_fix",
  "site_builder.qa_summarize",
  "site_builder.seo_review",
] as const);

const RETIRED_ALIASES = new Set([
  "minimax-m3",
  "doubao-seed-2.0-pro",
  "doubao-seed-2.0-lite",
]);

export interface RemainingTextEvaluationExecutionPlan {
  ordinal: number;
  executionKey: string;
  kind: "capability_probe" | "target";
  alias: string;
  protocol: "openai-responses" | "anthropic-messages";
  fixtureId: string;
  attempt: number;
  maximumWireCalls: 2;
  maximumRepairCalls: 1;
}

export interface RemainingTextEvaluationManifestTask {
  taskId: (typeof REMAINING_TEXT_TASK_IDS)[number];
  suiteId: string;
  fixtureSetId: string;
  fixtureCount: number;
  repeats: number;
  sourceBundleContractId: string;
  sourceBundleSha256: string;
  sourceFiles: readonly { role: string; path: string; sha256: string }[];
  candidates: readonly {
    alias: string;
    protocol: "openai-responses" | "anthropic-messages";
    preflight: "none" | "capability_probe";
  }[];
  legacyComparatorAliases: readonly [];
  deterministicComparator: {
    applicable: false;
    caseCount: 0;
    wireCallCount: 0;
    costCents: 0;
  };
  executions: readonly RemainingTextEvaluationExecutionPlan[];
  executionCount: number;
  maximumWireCallCount: number;
}

export interface RemainingTextEvaluationManifestPrepManifest {
  schemaVersion: typeof REMAINING_TEXT_EVALUATION_MANIFEST_PREP_SCHEMA_VERSION;
  prepId: typeof REMAINING_TEXT_EVALUATION_MANIFEST_PREP_ID;
  harnessId: typeof SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID;
  taskIds: typeof REMAINING_TEXT_TASK_IDS;
  fixedCommitSha: string;
  createOnly: true;
  dispatchAuthorization: "NOT_AUTHORIZED";
  actualNetworkCalls: 0;
  actualModelCostCents: 0;
  tasks: readonly RemainingTextEvaluationManifestTask[];
  executionCount: number;
  maximumWireCallCount: number;
  planningHardUpperBound: {
    basis: "per_wire_call_task_hard_cap";
    perWireCallCents: 20;
    maximumWireCalls: number;
    amountCents: number;
    authorization: "NOT_GRANTED";
    expectedCost: "NOT_CALCULATED";
  };
  pricingGate: {
    amountBasis: "frozen_openox_public_price_snapshot_required";
    newApiPriceAllowed: false;
    status: "BLOCKED_UNTIL_SEPARATE_EVIDENCE_PR";
  };
  excludedAliases: readonly [
    "minimax-m3",
    "doubao-seed-2.0-pro",
    "doubao-seed-2.0-lite",
  ];
  deferredScope: readonly [
    "gemini_text",
    "image",
    "video",
    "runtime_route_change",
    "promotion",
    "m2_publish",
  ];
  manifestSha256: string;
}

function executionKey(
  input: Pick<
    RemainingTextEvaluationExecutionPlan,
    "kind" | "alias" | "protocol" | "fixtureId" | "attempt"
  >,
): string {
  return [
    input.kind,
    input.alias,
    input.protocol,
    input.fixtureId,
    input.attempt,
  ].join("/");
}

function buildTaskManifest(
  taskId: (typeof REMAINING_TEXT_TASK_IDS)[number],
): RemainingTextEvaluationManifestTask {
  const plan = buildTaskEvaluationPlan(taskId);
  const suite = plan.evaluationSuite;
  if (
    plan.dispatchAdmission !== "task_evaluation_ready" ||
    !suite ||
    suite.fixtureIds.length === 0 ||
    suite.repeats < 1 ||
    plan.candidates.length === 0 ||
    plan.envelope.perCallCostCapCents !== 20 ||
    suite.legacyComparatorAliases.length !== 0 ||
    suite.compiledContractsRuntimeBinding !== null
  ) {
    throw new Error(`remaining text task suite is not canonical: ${taskId}`);
  }
  const cases = suite.fixtureIds.map((fixtureId) =>
    buildCanonicalModelEvaluationCase(plan, fixtureId),
  );
  const firstCase = cases[0]!;
  if (
    cases.some(
      ({ contract, payload }) =>
        contract.sourceBundleContractId !==
          firstCase.contract.sourceBundleContractId ||
        contract.sourceBundleSha256 !== firstCase.contract.sourceBundleSha256 ||
        sha256CanonicalJson(payload.sourceFiles) !==
          sha256CanonicalJson(firstCase.payload.sourceFiles),
    )
  ) {
    throw new Error(`remaining text task source bundle drifted: ${taskId}`);
  }
  const candidates = plan.candidates.map((candidate) => {
    if (
      RETIRED_ALIASES.has(candidate.alias) ||
      (candidate.expectedProtocol !== "openai-responses" &&
        candidate.expectedProtocol !== "anthropic-messages") ||
      (candidate.preflight !== "none" &&
        candidate.preflight !== "capability_probe")
    ) {
      throw new Error(
        `remaining text task candidate is not admitted: ${taskId}`,
      );
    }
    return {
      alias: candidate.alias,
      protocol: candidate.expectedProtocol,
      preflight: candidate.preflight,
    } as const;
  });
  const executions: RemainingTextEvaluationExecutionPlan[] = [];
  for (const candidate of candidates) {
    if (candidate.preflight === "capability_probe") {
      const fixtureId = suite.fixtureIds[0]!;
      executions.push({
        ordinal: executions.length + 1,
        executionKey: executionKey({
          kind: "capability_probe",
          alias: candidate.alias,
          protocol: candidate.protocol,
          fixtureId,
          attempt: 1,
        }),
        kind: "capability_probe",
        alias: candidate.alias,
        protocol: candidate.protocol,
        fixtureId,
        attempt: 1,
        maximumWireCalls: 2,
        maximumRepairCalls: 1,
      });
    }
  }
  for (const candidate of candidates) {
    for (const fixtureId of suite.fixtureIds) {
      for (let attempt = 1; attempt <= suite.repeats; attempt += 1) {
        executions.push({
          ordinal: executions.length + 1,
          executionKey: executionKey({
            kind: "target",
            alias: candidate.alias,
            protocol: candidate.protocol,
            fixtureId,
            attempt,
          }),
          kind: "target",
          alias: candidate.alias,
          protocol: candidate.protocol,
          fixtureId,
          attempt,
          maximumWireCalls: 2,
          maximumRepairCalls: 1,
        });
      }
    }
  }
  const expectedExecutions =
    candidates.length * suite.fixtureIds.length * suite.repeats +
    candidates.filter(({ preflight }) => preflight === "capability_probe")
      .length;
  if (
    executions.length !== expectedExecutions ||
    new Set(executions.map(({ executionKey: key }) => key)).size !==
      executions.length
  ) {
    throw new Error(`remaining text task execution matrix drifted: ${taskId}`);
  }
  return Object.freeze({
    taskId,
    suiteId: suite.suiteId,
    fixtureSetId: suite.fixtureSetId,
    fixtureCount: suite.fixtureIds.length,
    repeats: suite.repeats,
    sourceBundleContractId: firstCase.contract.sourceBundleContractId,
    sourceBundleSha256: firstCase.contract.sourceBundleSha256,
    sourceFiles: firstCase.payload.sourceFiles,
    candidates: Object.freeze(candidates),
    legacyComparatorAliases: [] as const,
    deterministicComparator: {
      applicable: false as const,
      caseCount: 0 as const,
      wireCallCount: 0 as const,
      costCents: 0 as const,
    },
    executions: Object.freeze(executions),
    executionCount: executions.length,
    maximumWireCallCount: executions.length * 2,
  });
}

export function buildRemainingTextEvaluationPrepManifest(
  fixedCommitSha: string,
): RemainingTextEvaluationManifestPrepManifest {
  if (!/^[a-f0-9]{40}$/.test(fixedCommitSha)) {
    throw new Error("remaining text suite prep requires a 40-character commit");
  }
  const tasks = REMAINING_TEXT_TASK_IDS.map(buildTaskManifest);
  const executionCount = tasks.reduce(
    (total, task) => total + task.executionCount,
    0,
  );
  const maximumWireCallCount = tasks.reduce(
    (total, task) => total + task.maximumWireCallCount,
    0,
  );
  const withoutDigest = {
    schemaVersion: REMAINING_TEXT_EVALUATION_MANIFEST_PREP_SCHEMA_VERSION,
    prepId: REMAINING_TEXT_EVALUATION_MANIFEST_PREP_ID,
    harnessId: SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID,
    taskIds: REMAINING_TEXT_TASK_IDS,
    fixedCommitSha,
    createOnly: true,
    dispatchAuthorization: "NOT_AUTHORIZED",
    actualNetworkCalls: 0,
    actualModelCostCents: 0,
    tasks,
    executionCount,
    maximumWireCallCount,
    planningHardUpperBound: {
      basis: "per_wire_call_task_hard_cap",
      perWireCallCents: 20,
      maximumWireCalls: maximumWireCallCount,
      amountCents: maximumWireCallCount * 20,
      authorization: "NOT_GRANTED",
      expectedCost: "NOT_CALCULATED",
    },
    pricingGate: {
      amountBasis: "frozen_openox_public_price_snapshot_required",
      newApiPriceAllowed: false,
      status: "BLOCKED_UNTIL_SEPARATE_EVIDENCE_PR",
    },
    excludedAliases: [
      "minimax-m3",
      "doubao-seed-2.0-pro",
      "doubao-seed-2.0-lite",
    ] as const,
    deferredScope: [
      "gemini_text",
      "image",
      "video",
      "runtime_route_change",
      "promotion",
      "m2_publish",
    ] as const,
  } as const;
  return Object.freeze({
    ...withoutDigest,
    manifestSha256: sha256CanonicalJson(withoutDigest),
  });
}

export async function writeRemainingTextEvaluationPrepManifestCreateOnly(
  repositoryRoot: string,
  repositoryRelativePath: string,
  manifest: RemainingTextEvaluationManifestPrepManifest,
): Promise<void> {
  const { manifestSha256, ...withoutDigest } = manifest;
  if (
    manifest.createOnly !== true ||
    manifest.dispatchAuthorization !== "NOT_AUTHORIZED" ||
    manifest.actualNetworkCalls !== 0 ||
    manifest.actualModelCostCents !== 0 ||
    manifest.taskIds.length !== REMAINING_TEXT_TASK_IDS.length ||
    manifest.taskIds.some(
      (taskId, index) => taskId !== REMAINING_TEXT_TASK_IDS[index],
    ) ||
    manifestSha256 !== sha256CanonicalJson(withoutDigest)
  ) {
    throw new Error("trusted zero-cost remaining text task manifest required");
  }
  const canonical = buildRemainingTextEvaluationPrepManifest(
    manifest.fixedCommitSha,
  );
  if (sha256CanonicalJson(canonical) !== sha256CanonicalJson(manifest)) {
    throw new Error(
      "canonical zero-cost remaining text task manifest required",
    );
  }
  assertDesignSpecFixedSourceCommitOnMain(
    repositoryRoot,
    manifest.fixedCommitSha,
  );
  for (const task of manifest.tasks) {
    assertDesignSpecSourceBundleAtFixedCommit(
      repositoryRoot,
      manifest.fixedCommitSha,
      task.sourceFiles,
    );
  }
  await writeRepositoryJsonCreateOnly(
    repositoryRoot,
    repositoryRelativePath,
    manifest,
  );
}
