import type { AiContext } from '../model-gateway/types';
import type { ModelResult } from '../model-gateway/types';
import type { TypedProjectionSchema } from '../durable-results/durable-result-strategy';
import type { BudgetStore } from '../tools/budget-store';
import type { ExecutionBudgetBinding } from '../execution-budget/execution-budget-authority.service';

export async function executeIcpBudgetedTask<Output>(input: {
  budgetStore: BudgetStore;
  binding: ExecutionBudgetBinding;
  durableResultSchema: TypedProjectionSchema;
  execute: (context: Pick<AiContext, 'runId' | 'durableResultSchema'>) => Promise<ModelResult<Output>>;
}): Promise<ModelResult<Output>> {
  await input.budgetStore.attestAuthorized({
    authorityId: input.binding.authorityId,
    scopeKey: input.binding.scopeKey,
    accountKey: input.binding.accountKey,
  });
  return input.execute({
    runId: input.binding.accountKey,
    durableResultSchema: input.durableResultSchema,
  });
}
