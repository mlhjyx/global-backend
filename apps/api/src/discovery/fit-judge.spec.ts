import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../model-runtime/structured-task-runtime-bridge', () => ({
  executeStructuredTaskWithRuntime: vi.fn(),
}));

import { executeStructuredTaskWithRuntime } from '../model-runtime/structured-task-runtime-bridge';
import { judgeFitCompany, loadIcpBrief } from './fit-judge';
import { getTask } from '../ai-tasks/task-registry';
import { BudgetOperationReplayError } from '../tools/budget-store';
import {
  projectModelResultForReplay,
  restoreModelResultFromReplay,
} from '../durable-results/model-result-replay';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';

const FIT_RECEIPT: DurableExecutionReceipt = Object.freeze({
  schemaVersion: 'durable-execution-receipt/v1',
  scopeKey: '10000000-0000-4000-8000-000000000001',
  authorityId: '20000000-0000-4000-8000-000000000001',
  accountId: '30000000-0000-4000-8000-000000000001',
  operationId: '40000000-0000-4000-8000-000000000001',
  operationKey: 'fit',
  resultStrategy: 'typed_projection',
  resultSchema: 'fit-judgment/v1',
  resultDigest: 'a'.repeat(64),
  artifactId: null,
  usage: { currency: 'USD', unit: 'microusd', callCount: 1, upperBoundMicrousd: '10000' },
  costBasis: 'estimated_upper_bound',
});

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

  it('propagates the durable receipt to the lead transaction consumer', async () => {
    executeTask.mockResolvedValue({
      provider: 'new-api', data: output, durableReceipt: FIT_RECEIPT,
    } as never);
    await expect(judgeFitCompany(
      {} as never,
      FIT_RECEIPT.scopeKey,
      { seller: 'Seller', seller_summary: null },
      company,
    )).resolves.toMatchObject({
      verdict: 'match', durableReceipt: FIT_RECEIPT,
    });
  });

  it('keeps the durable replay projector closed, bounded, and byte-identical for fractional cost facts', async () => {
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
      const projectedWithCost = projectModelResultForReplay('fit-judgment/v1', {
        data: output,
        provider: 'new-api',
        model: 'qualified-model',
        usage: { inputTokens: 11, outputTokens: 7, costUsd: 0.0017 },
      });
      expect(projectedWithCost.digest).not.toBe(projected.digest);
      expect(restoreModelResultFromReplay('fit-judgment/v1', projectedWithCost)).toEqual({
        data: output,
        provider: 'new-api',
        model: 'qualified-model',
        usage: { inputTokens: 11, outputTokens: 7, costUsd: 0.0017 },
      });
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

describe('Fit follows the ICP trade role (design §4 step 8)', () => {
  function icpTx(companyAttributes: unknown) {
    return {
      icpDefinition: {
        findUnique: vi.fn(async () => ({
          name: '德国工业泵分销商',
          companyAttributes,
          exclusions: [],
          targetMarkets: ['Germany'],
          company: { name: 'Seller Pumps Co.', summary: 'Chinese pump maker' },
        })),
      },
    };
  }

  it.each([
    [{ business_model: 'Großhandel / Distributor' }, 'distributor'],
    [{ trade_side: 'OEM manufacturer' }, 'manufacturer'],
    [{ industry: 'pumps' }, null],
  ])('puts the deterministic trade role of %o into the ICP brief', async (attributes, role) => {
    const brief = await loadIcpBrief(icpTx(attributes) as never, 'icp-1');

    expect(brief).toMatchObject({ icp_trade_role: role });
  });

  it('sends the trade role to the judge together with role-aware gate rules', async () => {
    executeTask.mockReset();
    executeTask.mockResolvedValue({ provider: 'stub', data: output } as never);
    const brief = await loadIcpBrief(icpTx({ business_model: 'distributor' }) as never, 'icp-1');

    await judgeFitCompany({} as never, '10000000-0000-4000-8000-000000000001', brief, company);

    const [, input] = executeTask.mock.calls[0]!;
    expect(input.prompt).toContain('"icp_trade_role": "distributor"');
    expect(input.system).toBe(getTask('discovery.qualify_fit')!.description);
  });

  it('shows the judge the capability keywords that carry reseller evidence', async () => {
    executeTask.mockReset();
    executeTask.mockResolvedValue({ provider: 'stub', data: output } as never);

    await judgeFitCompany({} as never, '10000000-0000-4000-8000-000000000001', { seller: 'S', seller_summary: null }, {
      ...company,
      attributes: { products: ['Kreiselpumpen'], keywords: ['Pumpen-Großhandel', 'Vertrieb Grundfos'] },
    });

    const [, input] = executeTask.mock.calls[0]!;
    expect(input.prompt).toContain('Pumpen-Großhandel');
    expect(input.prompt).toContain('Kreiselpumpen');
  });

  it('judges resellers as the target, not as intermediaries, when the ICP targets distributors', () => {
    const description = getTask('discovery.qualify_fit')!.description;

    expect(description).toContain('icp_trade_role');
    expect(description).toMatch(/distributor[^。]*分销商[^。]*pass/);
    expect(description).toMatch(/不适用[^。]*pass/);
  });

  it('shows the judge the website profile as direct evidence (G3 5.4b)', async () => {
    executeTask.mockReset();
    executeTask.mockResolvedValue({ provider: 'stub', data: output } as never);

    await judgeFitCompany({} as never, '10000000-0000-4000-8000-000000000001', { seller: 'S', seller_summary: null }, {
      ...company,
      attributes: {
        products: ['Kreiselpumpen'],
        website_profile: {
          trade_role: 'distributor',
          own_manufacturing: false,
          carried_brands: [{ name: 'Grundfos', country: 'dk' }, { name: 'Leo', country: 'cn' }],
          carries_chinese_brand: true,
          carries_foreign_brand: true,
          evidence: ['Großhandel für Pumpen'],
          vat_id: 'DE136695976',
        },
      },
    });

    const [, input] = executeTask.mock.calls[0]!;
    expect(input.prompt).toContain('"trade_role": "distributor"');
    expect(input.prompt).toContain('"carries_chinese_brand": true');
    expect(input.prompt).toContain('Großhandel für Pumpen');
    expect(input.prompt).not.toContain('DE136695976');
    expect(getTask('discovery.qualify_fit')!.description).toContain('website_profile');
  });
});

