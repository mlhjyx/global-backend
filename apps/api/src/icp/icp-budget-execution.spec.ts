import { describe, expect, it, vi } from 'vitest';
import { executeIcpBudgetedTask } from './icp-budget-execution';

describe('ICP product model budget execution', () => {
  it('opens a stable replay scope, binds runId, preserves fractional business output, and closes', async () => {
    const order: string[] = [];
    const budgetStore = {
      open: vi.fn(async () => { order.push('open'); }),
      close: vi.fn(async () => { order.push('close'); }),
    };
    const execute = vi.fn(async (context) => {
      order.push('model');
      expect(context.runId).toBe('icp:design:request-digest');
      const result = { data: { name: 'ICP', weight: 0.75 }, provider: 'gateway', model: 'qualified' };
      const projected = context.genericReplay.project(result);
      expect(context.genericReplay.restore(projected)).toEqual(result);
      return result;
    });

    await expect(executeIcpBudgetedTask({
      budgetStore: budgetStore as never,
      binding: {
        authorityId: '20000000-0000-4000-8000-000000000002',
        replay: false,
        scopeKey: '10000000-0000-4000-8000-000000000001',
        accountKey: 'icp:design:request-digest',
        purpose: 'icp.design',
        subjectType: 'company',
        subjectId: '30000000-0000-4000-8000-000000000003',
      },
      execute,
    })).resolves.toMatchObject({ data: { name: 'ICP', weight: 0.75 } });
    expect(budgetStore.open).toHaveBeenCalledWith(expect.objectContaining({
      accountKey: 'icp:design:request-digest', replayScope: true,
    }));
    expect(budgetStore.close).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['open', 'model', 'close']);
  });
});
