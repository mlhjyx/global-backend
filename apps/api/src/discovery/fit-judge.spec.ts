import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../model-runtime/structured-task-runtime-bridge', () => ({
  executeStructuredTaskWithRuntime: vi.fn(),
}));

import { executeStructuredTaskWithRuntime } from '../model-runtime/structured-task-runtime-bridge';
import { judgeFitCompany } from './fit-judge';
import { BudgetOperationReplayError } from '../tools/budget-store';
import {
  projectModelResultForReplay,
  restoreModelResultFromReplay,
} from '../durable-results/model-result-replay';

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

  it('never downgrades a missing durable replay into a null fit judgment', async () => {
    executeTask.mockRejectedValue(new BudgetOperationReplayError('fit-op'));
    await expect(
      judgeFitCompany(
        {} as never,
        '10000000-0000-4000-8000-000000000001',
        { seller: 'Seller', seller_summary: null },
        company,
        { runId: 'run-1' },
      ),
    ).rejects.toBeInstanceOf(BudgetOperationReplayError);
  });

  it('recursively preserves an authority control wrapped by Temporal/runtime failures', async () => {
    const failure = {
      name: 'ActivityFailure',
      message: 'Activity task failed',
      cause: {
        type: 'ApplicationFailure',
        cause: { code: 'EXECUTION_BUDGET_AUTHORITY_REVOKED' },
      },
    };
    executeTask.mockRejectedValue(failure);

    await expect(
      judgeFitCompany(
        {} as never,
        '10000000-0000-4000-8000-000000000001',
        { seller: 'Seller', seller_summary: null },
        company,
        { runId: 'run-1' },
      ),
    ).rejects.toBe(failure);
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

  it('keeps the durable replay projector closed, bounded, and independent from fractional cost facts', async () => {
    executeTask.mockImplementation(async (_gateway, _input, context) => {
      expect(context.durableResultSchema).toBe('fit-judgment/v1');
      const projected = projectModelResultForReplay('fit-judgment/v1', {
        data: output,
        provider: 'new-api',
        model: 'qualified-model',
      });
      expect(restoreModelResultFromReplay('fit-judgment/v1', projected)).toEqual({
        data: output,
        provider: 'new-api',
        model: 'qualified-model',
      });
      expect(projectModelResultForReplay('fit-judgment/v1', {
        data: output,
        provider: 'new-api',
        model: 'qualified-model',
        usage: { inputTokens: 11, outputTokens: 7, costUsd: 0.0017 },
      }).digest).toBe(projected.digest);
      expect(() =>
        restoreModelResultFromReplay('taxonomy-code/v1', projected),
      ).toThrow('MODEL_RESULT_REPLAY_INVALID');
      return { provider: 'new-api', data: output } as never;
    });

    await expect(
      judgeFitCompany(
        {} as never,
        '10000000-0000-4000-8000-000000000001',
        { seller: 'Seller', seller_summary: null },
        company,
        { runId: 'run-1' },
      ),
    ).resolves.toMatchObject({ verdict: 'match' });
  });

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
