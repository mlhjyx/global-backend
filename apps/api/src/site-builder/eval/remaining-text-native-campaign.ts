import type { ModelCandidateProtocol } from "../agents/model-candidate-baseline";
import {
  buildTaskEvaluationPlan,
  type TaskEvaluationCandidate,
} from "./model-evaluation-harness";
import type { RemainingTextNativeFeeCardTaskId } from "./remaining-text-native-fee-card";

const CAMPAIGN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const REMAINING_TEXT_NATIVE_CAMPAIGN_ID =
  "site-builder-remaining-text-native-campaign/2026-08-04-v1" as const;

export type RemainingTextNativeCampaignTaskId =
  RemainingTextNativeFeeCardTaskId;
type NativeProtocol = Extract<
  ModelCandidateProtocol,
  "openai-responses" | "anthropic-messages"
>;

export interface RemainingTextNativeCampaignExecution {
  executionId: string;
  taskId: RemainingTextNativeCampaignTaskId;
  phase: "probe" | "matrix";
  alias: string;
  protocol: NativeProtocol;
  fixtureId: string;
  attempt: number;
}

const TASK_EXECUTION_COUNTS = Object.freeze({
  "site_builder.copy": 13,
  "site_builder.assemble": 48,
  "site_builder.assembly_fix": 48,
  "site_builder.qa_summarize": 12,
  "site_builder.seo_review": 12,
} as const satisfies Record<RemainingTextNativeCampaignTaskId, number>);

function nativeCandidates(
  candidates: readonly TaskEvaluationCandidate[],
): readonly (TaskEvaluationCandidate & { expectedProtocol: NativeProtocol })[] {
  const native = candidates.filter(
    (
      candidate,
    ): candidate is TaskEvaluationCandidate & {
      expectedProtocol: NativeProtocol;
    } =>
      candidate.expectedProtocol === "openai-responses" ||
      candidate.expectedProtocol === "anthropic-messages",
  );
  if (native.length !== candidates.length || native.length < 2) {
    throw new Error(
      "remaining text native campaign candidate matrix is invalid",
    );
  }
  return Object.freeze([...native]);
}

function executionId(input: {
  campaignId: string;
  taskId: RemainingTextNativeCampaignTaskId;
  phase: "probe" | "matrix";
  alias: string;
  fixtureId: string;
  attempt: number;
}): string {
  return [
    "remaining-text-native",
    input.campaignId,
    input.taskId,
    input.phase,
    input.alias,
    input.fixtureId,
    input.attempt,
  ].join(":");
}

export function buildRemainingTextNativeCampaignExecutions(input: {
  campaignId: string;
  taskId: RemainingTextNativeCampaignTaskId;
}): readonly RemainingTextNativeCampaignExecution[] {
  if (
    !input ||
    !CAMPAIGN_ID.test(input.campaignId) ||
    !(input.taskId in TASK_EXECUTION_COUNTS)
  ) {
    throw new Error("remaining text native campaign input is invalid");
  }
  const plan = buildTaskEvaluationPlan(input.taskId);
  if (
    plan.dispatchAdmission !== "task_evaluation_ready" ||
    !plan.evaluationSuite ||
    plan.evaluationSuite.fixtureIds.length < 1 ||
    plan.evaluationSuite.repeats !== 2
  ) {
    throw new Error("remaining text native campaign suite is unavailable");
  }
  const candidates = nativeCandidates(plan.candidates);
  const executions: RemainingTextNativeCampaignExecution[] = [];
  for (const candidate of candidates) {
    if (candidate.preflight !== "capability_probe") continue;
    const fixtureId = plan.evaluationSuite.fixtureIds[0]!;
    executions.push(
      Object.freeze({
        executionId: executionId({
          campaignId: input.campaignId,
          taskId: input.taskId,
          phase: "probe",
          alias: candidate.alias,
          fixtureId,
          attempt: 1,
        }),
        taskId: input.taskId,
        phase: "probe" as const,
        alias: candidate.alias,
        protocol: candidate.expectedProtocol,
        fixtureId,
        attempt: 1,
      }),
    );
  }
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
              taskId: input.taskId,
              phase: "matrix",
              alias: candidate.alias,
              fixtureId,
              attempt,
            }),
            taskId: input.taskId,
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
  if (executions.length !== TASK_EXECUTION_COUNTS[input.taskId]) {
    throw new Error(
      "remaining text native campaign execution count is invalid",
    );
  }
  return Object.freeze(executions);
}
