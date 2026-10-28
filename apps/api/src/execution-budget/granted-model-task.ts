import type { AiContext, ModelResult } from '../model-gateway/types';
import type { TypedProjectionSchema } from '../durable-results/durable-result-strategy';
import type { BudgetStore } from '../tools/budget-store';
import type { ExecutionBudgetBinding } from './execution-budget-authority.service';

/**
 * Runs one granted structured model task: attest the consumed grant to the ledger,
 * then execute under the grant's account key so the ledger owns the durable result.
 * Shared by every workspace-granted model endpoint (ICP design, query plan, drafts).
 */
export async function executeGrantedModelTask<Output>(input: {
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
