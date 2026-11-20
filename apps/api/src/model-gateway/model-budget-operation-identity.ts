import type { AiContext } from "./types";
import { paidOperationKey } from "../site-builder/site-build-cost-ledger";

export interface ModelBudgetOperationIdentityInput {
  readonly task: string;
  readonly model?: string;
  readonly prompt?: string;
  readonly system?: string;
  readonly schema?: Readonly<Record<string, unknown>>;
  readonly messages?: readonly unknown[];
  readonly tools?: readonly unknown[];
  readonly maxTokens?: number;
  readonly maxCostCents?: number;
}

/** Exact ordinary-workspace key sequence; paid, vision and platform fence paths remain separate. */
export function modelBudgetOperationKey(
  operation: string,
  input: ModelBudgetOperationIdentityInput,
  context: AiContext,
): string {
  const accountKey = context.runId ?? context.workspaceId;
  return paidOperationKey([
    accountKey,
    "model-budget",
    operation,
    input.task,
    input.model ?? "",
    context.correlationId ?? "",
    input.prompt ?? "",
    input.system ?? "",
    input.schema ? JSON.stringify(input.schema) : "",
    input.messages ? JSON.stringify(input.messages) : "",
    input.tools ? JSON.stringify(input.tools) : "",
  ]);
}
