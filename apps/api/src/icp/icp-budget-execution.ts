import type { ModelResult } from '../model-gateway/types';
import type { TypedProjectionSchema } from '../durable-results/durable-result-strategy';
import type { BudgetStore } from '../tools/budget-store';
import type { ExecutionBudgetBinding } from '../execution-budget/execution-budget-authority.service';
import { executeGrantedModelTask } from '../execution-budget/granted-model-task';

/** ICP-side name of the shared granted-model-task runner (kept for existing callers). */
export function executeIcpBudgetedTask<Output>(input: {
  budgetStore: BudgetStore;
  binding: ExecutionBudgetBinding;
  durableResultSchema: TypedProjectionSchema;
  execute: Parameters<typeof executeGrantedModelTask<Output>>[0]['execute'];
}): Promise<ModelResult<Output>> {
  return executeGrantedModelTask<Output>(input);
}
