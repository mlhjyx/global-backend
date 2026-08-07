import type { ModelProtocol, ReasoningLevel } from "../../model-runtime";

export interface CopyEvaluationV2Candidate {
  alias: string;
  providerFamily: "openai" | "anthropic";
  protocol: ModelProtocol;
  reasoning: ReasoningLevel;
}

export const COPY_EVALUATION_V2_CANDIDATES = Object.freeze([
  Object.freeze({
    alias: "gpt-5.6-terra",
    providerFamily: "openai" as const,
    protocol: "openai_chat_completions" as const,
    reasoning: "medium" as const,
  }),
  Object.freeze({
    alias: "gpt-5.6-sol",
    providerFamily: "openai" as const,
    protocol: "openai_chat_completions" as const,
    reasoning: "high" as const,
  }),
  Object.freeze({
    alias: "claude-sonnet-5",
    providerFamily: "anthropic" as const,
    protocol: "anthropic_messages" as const,
    reasoning: "medium" as const,
  }),
] satisfies readonly CopyEvaluationV2Candidate[]);
