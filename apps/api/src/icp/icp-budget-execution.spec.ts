import { describe, expect, it, vi } from 'vitest';
import { executeIcpBudgetedTask } from './icp-budget-execution';

describe('ICP product model budget execution', () => {
  it('validates the exact authority account, binds runId, and never opens a legacy cap account', async () => {
    const order: string[] = [];
    const requestSha256 = 'a'.repeat(64);
    const accountKey = `icp.design:company:30000000-0000-4000-8000-000000000003:${requestSha256}`;
    const budgetStore = {
      open: vi.fn(async () => { order.push('legacy-open'); }),
      attestAuthorized: vi.fn(async () => { order.push('authority-attest'); }),
      close: vi.fn(async () => { order.push('legacy-close'); }),
    };
    const execute = vi.fn(async (context) => {
      order.push('model');
      expect(context.runId).toBe(accountKey);
      expect(context.durableResultSchema).toBe('icp-design/v1');
      const result = { data: { name: 'ICP', weight: 0.75 }, provider: 'gateway', model: 'qualified' };
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
      durableResultSchema: 'icp-design/v1',
      execute,
    })).resolves.toMatchObject({ data: { name: 'ICP', weight: 0.75 } });
    expect(budgetStore.attestAuthorized).toHaveBeenCalledWith({
      authorityId: '20000000-0000-4000-8000-000000000002',
      scopeKey: '10000000-0000-4000-8000-000000000001',
      accountKey,
    });
    expect(budgetStore.open).not.toHaveBeenCalled();
    expect(budgetStore.close).not.toHaveBeenCalled();
    expect(order).toEqual(['authority-attest', 'model']);
  });
});
