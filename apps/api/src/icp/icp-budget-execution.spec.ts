import { describe, expect, it, vi } from 'vitest';
import { executeIcpBudgetedTask } from './icp-budget-execution';

describe('ICP product model budget execution', () => {
  it('validates the exact authority account, binds runId, and never opens a legacy cap account', async () => {
    const order: string[] = [];
    const requestSha256 = 'a'.repeat(64);
    const accountKey = `icp.design:company:30000000-0000-4000-8000-000000000003:${requestSha256}`;
    const budgetStore = {
      open: vi.fn(async () => { order.push('legacy-open'); }),
      openAuthorized: vi.fn(async () => { order.push('authority-open'); }),
      close: vi.fn(async () => { order.push('legacy-close'); }),
    };
    const execute = vi.fn(async (context) => {
      order.push('model');
      expect(context.runId).toBe(accountKey);
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
        accountKey,
        purpose: 'icp.design',
        subjectType: 'company',
        subjectId: '30000000-0000-4000-8000-000000000003',
        requestSha256,
      },
      execute,
    })).resolves.toMatchObject({ data: { name: 'ICP', weight: 0.75 } });
    expect(budgetStore.openAuthorized).toHaveBeenCalledWith({
      authorityId: '20000000-0000-4000-8000-000000000002',
      scopeKey: '10000000-0000-4000-8000-000000000001',
      accountKey,
      replayScope: true,
    });
    expect(budgetStore.open).not.toHaveBeenCalled();
    expect(budgetStore.close).not.toHaveBeenCalled();
    expect(order).toEqual(['authority-open', 'model']);
  });
});
