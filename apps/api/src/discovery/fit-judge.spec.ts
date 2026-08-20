import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../model-runtime/structured-task-runtime-bridge', () => ({
  executeStructuredTaskWithRuntime: vi.fn(),
}));

import { executeStructuredTaskWithRuntime } from '../model-runtime/structured-task-runtime-bridge';
import { judgeFitCompany } from './fit-judge';

const executeTask = vi.mocked(executeStructuredTaskWithRuntime);
const company = {
  id: 'company-1',
  name: 'Acme',
  domain: 'acme.example',
  country: 'DE',
  industry: 'manufacturing',
  attributes: { products: ['valves'] },
};
const output = {
  verdict: 'match',
  material_gate: '材质匹配',
  role_gate: '角色匹配',
  process_gate: '工艺匹配',
  business_model_gate: '商业模式匹配',
  reasons: ['匹配'],
};

describe('judgeFitCompany provider-independent result semantics', () => {
  beforeEach(() => {
    executeTask.mockReset();
  });

  it.each(['new-api', 'stub'])(
    'maps an already validated %s result through the same judgment path',
    async (provider) => {
      executeTask.mockResolvedValue({ provider, data: output } as never);

      await expect(
        judgeFitCompany(
          {} as never,
          '10000000-0000-4000-8000-000000000001',
          { seller: 'Seller', seller_summary: null },
          company,
        ),
      ).resolves.toEqual({
        verdict: 'match',
        fitReasons: {
          material: '材质匹配',
          role: '角色匹配',
          process: '工艺匹配',
          business_model: '商业模式匹配',
          reasons: ['匹配'],
        },
      });
    },
  );

  it('keeps a provider/runtime failure retryable without persisting a fabricated judgment', async () => {
    executeTask.mockRejectedValue(new Error('provider unavailable'));

    await expect(
      judgeFitCompany(
        {} as never,
        '10000000-0000-4000-8000-000000000001',
        { seller: 'Seller', seller_summary: null },
        company,
      ),
    ).resolves.toBeNull();
  });
});
