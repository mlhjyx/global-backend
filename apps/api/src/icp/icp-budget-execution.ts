import type { ModelResult } from '../model-gateway/types';
import type { AiContext } from '../model-gateway/types';
import { runBudgetCents } from '../tools/budget';
import type { BudgetStore } from '../tools/budget-store';
import type { ExecutionBudgetBinding } from '../execution-budget/execution-budget-authority.service';

export async function executeIcpBudgetedTask<Output>(input: {
  budgetStore: BudgetStore;
  binding: ExecutionBudgetBinding;
  execute: (context: Pick<AiContext, 'runId' | 'genericReplay'>) => Promise<ModelResult<Output>>;
}): Promise<ModelResult<Output>> {
  await input.budgetStore.open({
    workspaceId: input.binding.scopeKey,
    accountKey: input.binding.accountKey,
    capCents: runBudgetCents(),
    replayScope: true,
  });
  try {
    return await input.execute({
      runId: input.binding.accountKey,
      genericReplay: {
        schema: 'icp-product-result/v1',
        project: (result) => ({
          json: JSON.stringify(result.data),
          provider: result.provider,
          model: result.model,
        }),
        restore: (value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('ICP_PRODUCT_REPLAY_INVALID');
          }
          const record = value as Record<string, unknown>;
          if (typeof record.json !== 'string' || typeof record.provider !== 'string' || typeof record.model !== 'string') {
            throw new Error('ICP_PRODUCT_REPLAY_INVALID');
          }
          return {
            data: JSON.parse(record.json) as Output,
            provider: record.provider,
            model: record.model,
          };
        },
      },
    });
  } finally {
    await input.budgetStore.close({
      workspaceId: input.binding.scopeKey,
      accountKey: input.binding.accountKey,
    });
  }
}
