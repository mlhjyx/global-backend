import { DESIGN_SPEC_TASK } from "../design/design-brief-producer";
import {
  SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID,
  buildCanonicalModelEvaluationCase,
  buildTaskEvaluationPlan,
} from "./model-evaluation-harness";
import {
  modelEvaluationInitialPromptUtf8Bytes,
  modelEvaluationRepairPromptUtf8BytesUpperBound,
} from "./model-evaluation-executor";
import { sha256CanonicalJson } from "./eval-provenance";
import { writeRepositoryJsonCreateOnly } from "./create-only-json";

export const DESIGN_SPEC_EVALUATION_SUITE_PREP_ID =
  "site-builder-design-spec-evaluation-suite-prep/2026-07-30-v1" as const;
export const DESIGN_SPEC_EVALUATION_SUITE_PREP_SCHEMA_VERSION =
  "site-builder-design-spec-evaluation-suite-prep/v1" as const;

export const DESIGN_SPEC_EVALUATION_STOP_CONDITIONS = Object.freeze([
  "fixed_commit_or_source_bundle_drift",
  "fixture_matrix_or_prompt_drift",
  "candidate_alias_or_protocol_drift",
  "retired_or_deferred_alias_present",
  "execution_or_wire_call_manifest_exhausted",
  "missing_openox_price_or_price_drift",
  "missing_limited_credential_attestation",
  "missing_separate_real_cost_authorization",
  "unknown_or_over_budget_settlement",
] as const);

export interface DesignSpecEvaluationExecutionPlan {
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

export interface DesignSpecDeterministicComparatorCase {
  ordinal: number;
  comparatorId: "deterministic-catalog-selection/v1";
  fixtureId: string;
  attempt: number;
  wireCalls: 0;
  costCents: 0;
}

export interface DesignSpecEvaluationSuitePrepManifest {
  schemaVersion: typeof DESIGN_SPEC_EVALUATION_SUITE_PREP_SCHEMA_VERSION;
  prepId: typeof DESIGN_SPEC_EVALUATION_SUITE_PREP_ID;
  harnessId: typeof SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID;
  taskId: "site_builder.design_spec";
  fixedCommitSha: string;
  createOnly: true;
  dispatchAuthorization: "NOT_AUTHORIZED";
  actualNetworkCalls: 0;
  actualModelCostCents: 0;
  suite: {
    suiteId: string;
    fixtureSetId: string;
    fixtureCount: 12;
    repeats: 2;
    candidateCount: 3;
    sourceBundleContractId: string;
    sourceBundleSha256: string;
    sourceFiles: readonly {
      role: string;
      path: string;
      sha256: string;
    }[];
  };
  repair: {
    enabled: true;
    maximumRepairCallsPerExecution: 1;
    maximumWireCallsPerExecution: 2;
  };
  promptUtf8Bytes: {
    maximumCanonicalInitial: number;
    maximumCanonicalRepair: number;
  };
  executions: readonly DesignSpecEvaluationExecutionPlan[];
  executionCount: 73;
  maximumWireCallCount: 146;
  deterministicComparator: {
    comparatorId: "deterministic-catalog-selection/v1";
    modelAliases: readonly [];
    cases: readonly DesignSpecDeterministicComparatorCase[];
    caseCount: 24;
    wireCallCount: 0;
    costCents: 0;
  };
  planningHardUpperBound: {
    basis: "per_wire_call_task_hard_cap";
    perWireCallCents: 20;
    maximumWireCalls: 146;
    amountCents: 2_920;
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
    "other_five_text_tasks",
    "runtime_route_change",
    "promotion",
    "m2_publish",
  ];
  stopConditions: typeof DESIGN_SPEC_EVALUATION_STOP_CONDITIONS;
  manifestSha256: string;
}

function executionKey(input: {
  kind: DesignSpecEvaluationExecutionPlan["kind"];
  alias: string;
  protocol: string;
  fixtureId: string;
  attempt: number;
}): string {
  return [
    input.kind,
    input.alias,
    input.protocol,
    input.fixtureId,
    input.attempt,
  ].join("/");
}

export function buildDesignSpecEvaluationSuitePrepManifest(
  fixedCommitSha: string,
): DesignSpecEvaluationSuitePrepManifest {
  if (!/^[a-f0-9]{40}$/.test(fixedCommitSha)) {
    throw new Error("design_spec suite prep requires a 40-character commit");
  }
  const plan = buildTaskEvaluationPlan("site_builder.design_spec");
  const suite = plan.evaluationSuite;
  if (
    plan.dispatchAdmission !== "task_evaluation_ready" ||
    !suite ||
    suite.fixtureIds.length !== 12 ||
    suite.repeats !== 2 ||
    plan.candidates.length !== 3 ||
    plan.envelope.perCallCostCapCents !== 20
  ) {
    throw new Error("design_spec suite matrix is not canonical");
  }
  const cases = suite.fixtureIds.map((fixtureId) =>
    buildCanonicalModelEvaluationCase(plan, fixtureId),
  );
  const sourceFiles = cases[0]!.payload.sourceFiles;
  if (
    cases.some(
      ({ payload }) =>
        sha256CanonicalJson(payload.sourceFiles) !==
        sha256CanonicalJson(sourceFiles),
    )
  ) {
    throw new Error("design_spec source bundle changes across fixtures");
  }
  const probeCandidate = plan.candidates.find(
    ({ preflight }) => preflight === "capability_probe",
  );
  if (
    !probeCandidate ||
    probeCandidate.alias !== "gpt-5.5" ||
    probeCandidate.expectedProtocol !== "openai-responses"
  ) {
    throw new Error("design_spec GPT-5.5 capability probe is not canonical");
  }
  const executions: DesignSpecEvaluationExecutionPlan[] = [
    {
      ordinal: 1,
      executionKey: executionKey({
        kind: "capability_probe",
        alias: probeCandidate.alias,
        protocol: probeCandidate.expectedProtocol,
        fixtureId: suite.fixtureIds[0]!,
        attempt: 1,
      }),
      kind: "capability_probe",
      alias: probeCandidate.alias,
      protocol: probeCandidate.expectedProtocol,
      fixtureId: suite.fixtureIds[0]!,
      attempt: 1,
      maximumWireCalls: 2,
      maximumRepairCalls: 1,
    },
  ];
  for (const candidate of plan.candidates) {
    if (
      candidate.expectedProtocol !== "openai-responses" &&
      candidate.expectedProtocol !== "anthropic-messages"
    ) {
      throw new Error(
        `design_spec target protocol is not admitted: ${candidate.expectedProtocol}`,
      );
    }
    for (const fixtureId of suite.fixtureIds) {
      for (let attempt = 1; attempt <= suite.repeats; attempt += 1) {
        executions.push({
          ordinal: executions.length + 1,
          executionKey: executionKey({
            kind: "target",
            alias: candidate.alias,
            protocol: candidate.expectedProtocol,
            fixtureId,
            attempt,
          }),
          kind: "target",
          alias: candidate.alias,
          protocol: candidate.expectedProtocol,
          fixtureId,
          attempt,
          maximumWireCalls: 2,
          maximumRepairCalls: 1,
        });
      }
    }
  }
  const deterministicCases: DesignSpecDeterministicComparatorCase[] = [];
  for (const fixtureId of suite.fixtureIds) {
    for (let attempt = 1; attempt <= suite.repeats; attempt += 1) {
      deterministicCases.push({
        ordinal: deterministicCases.length + 1,
        comparatorId: "deterministic-catalog-selection/v1",
        fixtureId,
        attempt,
        wireCalls: 0,
        costCents: 0,
      });
    }
  }
  if (executions.length !== 73 || deterministicCases.length !== 24) {
    throw new Error("design_spec suite execution matrix count drifted");
  }
  const promptUtf8Bytes = {
    maximumCanonicalInitial: Math.max(
      ...cases.map(({ payload }) =>
        modelEvaluationInitialPromptUtf8Bytes(
          payload.prompt,
          DESIGN_SPEC_TASK.outputSchema,
          "site_builder.design_spec",
        ),
      ),
    ),
    maximumCanonicalRepair: Math.max(
      ...cases.map(({ payload }) =>
        modelEvaluationRepairPromptUtf8BytesUpperBound(
          payload.prompt,
          DESIGN_SPEC_TASK.outputSchema,
          "site_builder.design_spec",
        ),
      ),
    ),
  };
  const withoutDigest = {
    schemaVersion: DESIGN_SPEC_EVALUATION_SUITE_PREP_SCHEMA_VERSION,
    prepId: DESIGN_SPEC_EVALUATION_SUITE_PREP_ID,
    harnessId: SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID,
    taskId: "site_builder.design_spec",
    fixedCommitSha,
    createOnly: true,
    dispatchAuthorization: "NOT_AUTHORIZED",
    actualNetworkCalls: 0,
    actualModelCostCents: 0,
    suite: {
      suiteId: suite.suiteId,
      fixtureSetId: suite.fixtureSetId,
      fixtureCount: 12,
      repeats: 2,
      candidateCount: 3,
      sourceBundleContractId: suite.sourceBundleContractId,
      sourceBundleSha256: cases[0]!.contract.sourceBundleSha256,
      sourceFiles,
    },
    repair: {
      enabled: true,
      maximumRepairCallsPerExecution: 1,
      maximumWireCallsPerExecution: 2,
    },
    promptUtf8Bytes,
    executions,
    executionCount: 73,
    maximumWireCallCount: 146,
    deterministicComparator: {
      comparatorId: "deterministic-catalog-selection/v1",
      modelAliases: [] as const,
      cases: deterministicCases,
      caseCount: 24,
      wireCallCount: 0,
      costCents: 0,
    },
    planningHardUpperBound: {
      basis: "per_wire_call_task_hard_cap",
      perWireCallCents: 20,
      maximumWireCalls: 146,
      amountCents: 2_920,
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
      "other_five_text_tasks",
      "runtime_route_change",
      "promotion",
      "m2_publish",
    ] as const,
    stopConditions: DESIGN_SPEC_EVALUATION_STOP_CONDITIONS,
  } as const;
  return Object.freeze({
    ...withoutDigest,
    manifestSha256: sha256CanonicalJson(withoutDigest),
  });
}

export async function writeDesignSpecEvaluationSuitePrepManifestCreateOnly(
  repositoryRoot: string,
  repositoryRelativePath: string,
  manifest: DesignSpecEvaluationSuitePrepManifest,
): Promise<void> {
  if (
    manifest.manifestSha256 !==
      sha256CanonicalJson(
        Object.fromEntries(
          Object.entries(manifest).filter(([key]) => key !== "manifestSha256"),
        ),
      ) ||
    manifest.dispatchAuthorization !== "NOT_AUTHORIZED" ||
    manifest.actualNetworkCalls !== 0 ||
    manifest.actualModelCostCents !== 0
  ) {
    throw new Error("trusted zero-cost design_spec suite manifest required");
  }
  await writeRepositoryJsonCreateOnly(
    repositoryRoot,
    repositoryRelativePath,
    manifest,
  );
}
