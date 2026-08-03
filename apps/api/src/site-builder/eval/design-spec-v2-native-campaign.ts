import type { ModelCandidateProtocol } from "../agents/model-candidate-baseline";
import {
  buildTaskEvaluationPlan,
  type TaskEvaluationCandidate,
} from "./model-evaluation-harness";
import type {
  DesignSpecV2NativeExecutionResult,
  DesignSpecV2NativeExecutionRunner,
} from "./design-spec-v2-native-execution";
import { isTrustedDesignSpecV2NativeExecutionRunner } from "./design-spec-v2-native-execution";

const CAMPAIGN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EXACT_TARGETS = Object.freeze([
  Object.freeze({ alias: "gpt-5.6-terra", protocol: "openai-responses" }),
  Object.freeze({ alias: "gpt-5.5", protocol: "openai-responses" }),
  Object.freeze({ alias: "claude-sonnet-5", protocol: "anthropic-messages" }),
] as const);

type NativeTargetProtocol = Extract<
  ModelCandidateProtocol,
  "openai-responses" | "anthropic-messages"
>;

export type DesignSpecV2NativeCampaignRunner = Pick<
  DesignSpecV2NativeExecutionRunner,
  "execute" | "abort"
>;

export interface DesignSpecV2NativeCandidateSummary {
  alias: string;
  protocol: NativeTargetProtocol;
  rankable: boolean;
  executionCount: number;
  acceptedExecutionCount: number;
  stableFixtureCount: number;
  failureCount: number;
  settlementCurrencies: readonly ("CNY" | "USD")[];
}

export interface DesignSpecV2NativeCampaignResult {
  schemaVersion: "site-builder-design-spec-v2-native-campaign/v1";
  campaignId: string;
  taskId: "site_builder.design_spec";
  capabilityProbe: DesignSpecV2NativeExecutionResult;
  matrixExecutions: readonly DesignSpecV2NativeExecutionResult[];
  executions: readonly DesignSpecV2NativeExecutionResult[];
  candidates: readonly DesignSpecV2NativeCandidateSummary[];
}

export interface DesignSpecV2NativeCampaignExecution {
  executionId: string;
  phase: "probe" | "matrix";
  alias: string;
  protocol: NativeTargetProtocol;
  fixtureId: string;
  attempt: number;
}

function targetCandidates(
  candidates: readonly TaskEvaluationCandidate[],
): readonly (TaskEvaluationCandidate & {
  expectedProtocol: NativeTargetProtocol;
})[] {
  const targets = candidates.filter(
    (
      candidate,
    ): candidate is TaskEvaluationCandidate & {
      expectedProtocol: NativeTargetProtocol;
    } =>
      candidate.expectedProtocol === "openai-responses" ||
      candidate.expectedProtocol === "anthropic-messages",
  );
  if (
    targets.length !== EXACT_TARGETS.length ||
    !EXACT_TARGETS.every((expected) =>
      targets.some(
        (candidate) =>
          candidate.alias === expected.alias &&
          candidate.expectedProtocol === expected.protocol,
      ),
    )
  ) {
    throw new Error("design_spec native campaign candidate matrix is invalid");
  }
  return Object.freeze([...targets]);
}

function executionId(input: {
  campaignId: string;
  phase: "probe" | "matrix";
  alias: string;
  fixtureId: string;
  attempt: number;
}): string {
  return [
    "design-spec-native",
    input.campaignId,
    input.phase,
    input.alias,
    input.fixtureId,
    input.attempt,
  ].join(":");
}

export function buildDesignSpecV2NativeCampaignExecutions(input: {
  campaignId: string;
}): readonly DesignSpecV2NativeCampaignExecution[] {
  if (!input || !CAMPAIGN_ID.test(input.campaignId)) {
    throw new Error("design_spec native campaign id is invalid");
  }
  const plan = buildTaskEvaluationPlan("site_builder.design_spec");
  if (
    plan.dispatchAdmission !== "task_evaluation_ready" ||
    !plan.evaluationSuite ||
    plan.evaluationSuite.repeats !== 2
  ) {
    throw new Error("design_spec native campaign suite is unavailable");
  }
  const candidates = targetCandidates(plan.candidates);
  const probeCandidate = candidates.find(
    (candidate) =>
      candidate.alias === "gpt-5.5" &&
      candidate.preflight === "capability_probe",
  );
  const probeFixtureId = plan.evaluationSuite.fixtureIds[0];
  if (!probeCandidate || !probeFixtureId) {
    throw new Error(
      "design_spec native campaign capability probe is unavailable",
    );
  }
  const executions: DesignSpecV2NativeCampaignExecution[] = [
    Object.freeze({
      executionId: executionId({
        campaignId: input.campaignId,
        phase: "probe",
        alias: probeCandidate.alias,
        fixtureId: probeFixtureId,
        attempt: 1,
      }),
      phase: "probe" as const,
      alias: probeCandidate.alias,
      protocol: probeCandidate.expectedProtocol,
      fixtureId: probeFixtureId,
      attempt: 1,
    }),
  ];
  for (const candidate of candidates) {
    for (const fixtureId of plan.evaluationSuite.fixtureIds) {
      for (
        let attempt = 1;
        attempt <= plan.evaluationSuite.repeats;
        attempt += 1
      ) {
        executions.push(
          Object.freeze({
            executionId: executionId({
              campaignId: input.campaignId,
              phase: "matrix",
              alias: candidate.alias,
              fixtureId,
              attempt,
            }),
            phase: "matrix" as const,
            alias: candidate.alias,
            protocol: candidate.expectedProtocol,
            fixtureId,
            attempt,
          }),
        );
      }
    }
  }
  if (executions.length !== 73) {
    throw new Error("design_spec native campaign execution count is invalid");
  }
  return Object.freeze(executions);
}

function isCanonicalSettledResult(input: {
  result: DesignSpecV2NativeExecutionResult;
  executionId: string;
  candidate: TaskEvaluationCandidate & {
    expectedProtocol: NativeTargetProtocol;
  };
  fixtureId: string;
  attempt: number;
}): boolean {
  const { result, candidate } = input;
  return (
    result.executionId === input.executionId &&
    result.alias === candidate.alias &&
    result.protocol === candidate.expectedProtocol &&
    result.fixtureId === input.fixtureId &&
    result.attempt === input.attempt &&
    (result.outcome === "accepted" || result.outcome === "rejected") &&
    result.artifactRetention === "digest_only" &&
    (result.artifactSha256 === null ||
      (typeof result.artifactSha256 === "string" &&
        SHA256.test(result.artifactSha256))) &&
    result.actualProtocol === candidate.expectedProtocol &&
    result.requestedModel === candidate.alias &&
    result.reportedModel === candidate.alias &&
    result.resolvedModel === candidate.alias &&
    result.modelResolutionSource === "upstream_response" &&
    Number.isSafeInteger(result.usage.inputTokens) &&
    result.usage.inputTokens >= 0 &&
    Number.isSafeInteger(result.usage.outputTokens) &&
    result.usage.outputTokens >= 0 &&
    Number.isSafeInteger(result.usage.callCount) &&
    result.usage.callCount >= 1 &&
    result.usage.callCount <= 2 &&
    result.costSettlement.state === "settled" &&
    result.costSettlement.executionId === input.executionId &&
    result.costSettlement.currency ===
      (candidate.alias === "claude-sonnet-5" ? "USD" : "CNY")
  );
}

function isAcceptedCanonicalResult(input: {
  result: DesignSpecV2NativeExecutionResult;
  executionId: string;
  candidate: TaskEvaluationCandidate & {
    expectedProtocol: NativeTargetProtocol;
  };
  fixtureId: string;
  attempt: number;
}): boolean {
  const { result } = input;
  return (
    isCanonicalSettledResult(input) &&
    result.outcome === "accepted" &&
    result.artifactSha256 !== null &&
    result.assessment !== null &&
    result.assessment.qualityPassed &&
    result.assessment.structurePassed &&
    result.assessment.factualityPassed
  );
}

function candidateSummary(input: {
  candidate: TaskEvaluationCandidate & {
    expectedProtocol: NativeTargetProtocol;
  };
  executions: readonly DesignSpecV2NativeExecutionResult[];
  fixtureIds: readonly string[];
  repeats: number;
}): DesignSpecV2NativeCandidateSummary {
  const executions = input.executions.filter(
    (execution) => execution.alias === input.candidate.alias,
  );
  const accepted = executions.filter(
    (execution) => execution.outcome === "accepted",
  );
  let stableFixtureCount = 0;
  for (const fixtureId of input.fixtureIds) {
    const fixtureRuns = executions.filter(
      (execution) => execution.fixtureId === fixtureId,
    );
    if (
      fixtureRuns.length === input.repeats &&
      fixtureRuns.every(
        (execution) =>
          execution.outcome === "accepted" &&
          execution.artifactSha256 === fixtureRuns[0]?.artifactSha256,
      )
    ) {
      stableFixtureCount += 1;
    }
  }
  const settlementCurrencies = [
    ...new Set(
      executions.flatMap((execution) =>
        execution.costSettlement.state === "settled"
          ? [execution.costSettlement.currency]
          : [],
      ),
    ),
  ].sort();
  const expectedExecutionCount = input.fixtureIds.length * input.repeats;
  return Object.freeze({
    alias: input.candidate.alias,
    protocol: input.candidate.expectedProtocol,
    rankable:
      executions.length === expectedExecutionCount &&
      accepted.length === expectedExecutionCount &&
      stableFixtureCount === input.fixtureIds.length,
    executionCount: executions.length,
    acceptedExecutionCount: accepted.length,
    stableFixtureCount,
    failureCount: executions.length - accepted.length,
    settlementCurrencies: Object.freeze(settlementCurrencies),
  });
}

/**
 * Runs exactly the native-currency `design_spec` probe plus canonical matrix.
 * It never receives a bearer token and retains only runner-produced digests.
 */
export async function runDesignSpecV2NativeCampaign(input: {
  campaignId: string;
  runner: DesignSpecV2NativeCampaignRunner;
}): Promise<DesignSpecV2NativeCampaignResult> {
  if (!input || !CAMPAIGN_ID.test(input.campaignId) || !input.runner) {
    throw new Error("design_spec native campaign input is invalid");
  }
  if (!isTrustedDesignSpecV2NativeExecutionRunner(input.runner)) {
    throw new Error("trusted native design_spec execution runner is required");
  }
  const plan = buildTaskEvaluationPlan("site_builder.design_spec");
  if (!plan.evaluationSuite) {
    throw new Error("design_spec native campaign suite is unavailable");
  }
  const candidates = targetCandidates(plan.candidates);
  const plannedExecutions = buildDesignSpecV2NativeCampaignExecutions({
    campaignId: input.campaignId,
  });
  const [probeInput, ...matrixInputs] = plannedExecutions;
  if (!probeInput || probeInput.phase !== "probe") {
    throw new Error(
      "design_spec native campaign capability probe is unavailable",
    );
  }
  const probeCandidate = candidates.find(
    (candidate) => candidate.alias === probeInput.alias,
  );
  if (!probeCandidate) {
    throw new Error("design_spec native campaign capability probe is invalid");
  }
  let capabilityProbe: DesignSpecV2NativeExecutionResult;
  try {
    capabilityProbe = await input.runner.execute(probeInput);
  } catch (error) {
    input.runner.abort();
    throw error;
  }
  if (
    !isAcceptedCanonicalResult({
      result: capabilityProbe,
      ...probeInput,
      candidate: probeCandidate,
    })
  ) {
    input.runner.abort();
    throw new Error("design_spec capability probe was not accepted");
  }

  const matrixExecutions: DesignSpecV2NativeExecutionResult[] = [];
  for (const executionInput of matrixInputs) {
    if (executionInput.phase !== "matrix") {
      input.runner.abort();
      throw new Error("design_spec native campaign matrix is invalid");
    }
    const candidate = candidates.find(
      (entry) => entry.alias === executionInput.alias,
    );
    if (!candidate) {
      input.runner.abort();
      throw new Error("design_spec native campaign candidate is invalid");
    }
    let result: DesignSpecV2NativeExecutionResult;
    try {
      result = await input.runner.execute(executionInput);
    } catch (error) {
      input.runner.abort();
      throw error;
    }
    if (!isCanonicalSettledResult({ result, ...executionInput, candidate })) {
      input.runner.abort();
      throw new Error("design_spec matrix execution is not settled evidence");
    }
    matrixExecutions.push(result);
  }
  const frozenMatrixExecutions = Object.freeze([...matrixExecutions]);
  return Object.freeze({
    schemaVersion: "site-builder-design-spec-v2-native-campaign/v1" as const,
    campaignId: input.campaignId,
    taskId: "site_builder.design_spec" as const,
    capabilityProbe,
    matrixExecutions: frozenMatrixExecutions,
    executions: Object.freeze([capabilityProbe, ...frozenMatrixExecutions]),
    candidates: Object.freeze(
      candidates.map((candidate) =>
        candidateSummary({
          candidate,
          executions: frozenMatrixExecutions,
          fixtureIds: plan.evaluationSuite!.fixtureIds,
          repeats: plan.evaluationSuite!.repeats,
        }),
      ),
    ),
  });
}
