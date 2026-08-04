export type M1TextEvaluationTaskId =
  | "site_builder.design_spec"
  | "site_builder.copy"
  | "site_builder.assemble"
  | "site_builder.assembly_fix"
  | "site_builder.qa_summarize"
  | "site_builder.seo_review";

export type NativeProtocol = "openai-responses" | "anthropic-messages";

export interface M1TextEvaluationExecution {
  ordinal: number;
  taskId: M1TextEvaluationTaskId;
  executionKey: string;
  kind: "capability_probe" | "target";
  alias: string;
  protocol: NativeProtocol;
  fixtureId: string;
  attempt: number;
  maximumWireCalls: 2;
  maximumRepairCalls: 1;
}

export interface M1TextEvaluationPlan {
  schemaVersion: "site-builder-m1-minimal-text-evaluation-plan/v1";
  taskIds: readonly M1TextEvaluationTaskId[];
  manifestSha256: { designSpec: string; remainingText: string };
  fixedCommitSha: { designSpec: string; remainingText: string };
  executions: readonly M1TextEvaluationExecution[];
  executionCount: 206;
  maximumWireCallCount: 412;
  priceCalculation: "external_owner_observed";
}

export interface NativeTextResponse {
  rawText: string;
  reportedModel: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface M1TextEvaluationResult {
  executionId: string;
  taskId: M1TextEvaluationTaskId;
  executionKey: string;
  kind: "capability_probe" | "target";
  alias: string;
  protocol: NativeProtocol;
  fixtureId: string;
  attempt: number;
  outcome: "accepted" | "rejected";
  artifactSha256: string | null;
  assessment: {
    qualityPassed: boolean;
    structurePassed: boolean;
    factualityPassed: boolean;
    findingCodes: readonly string[];
  } | null;
  requestedModel: string;
  reportedModel: string | null;
  usage: { inputTokens: number; outputTokens: number; callCount: number };
  requestIds: readonly string[];
}

export interface M1TextEvaluationCandidateSummary {
  taskId: M1TextEvaluationTaskId;
  alias: string;
  protocol: NativeProtocol;
  rankable: boolean;
  executionCount: number;
  acceptedExecutionCount: number;
  stableFixtureCount: number;
  failureCount: number;
}
