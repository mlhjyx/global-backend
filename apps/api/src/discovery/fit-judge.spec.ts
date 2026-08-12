import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTask } from '../ai-tasks/task-registry';
import { executeStructuredTaskWithRuntime } from '../model-runtime/structured-task-runtime-bridge';
import { BudgetExceededError } from '../tools/budget';
import { judgeFitCompany, loadIcpBrief, upsertLeadFit } from './fit-judge';

vi.mock('../ai-tasks/task-registry', () => ({ getTask: vi.fn() }));
vi.mock('../model-runtime/structured-task-runtime-bridge', () => ({ executeStructuredTaskWithRuntime: vi.fn() }));

const contract = {
  id: 'discovery.qualify_fit',
  description: 'qualify fit',
  model: 'fake-model',
  outputSchema: { type: 'object' },
};
const company = {
  id: 'company-1',
  name: 'Acme GmbH',
  domain: 'acme.example',
  country: 'DE',
  industry: 'Industrial machinery',
  attributes: { products: ['Pumps'] },
};
const output = {
  verdict: 'match',
  material_gate: 'material fits',
  role_gate: 'buyer fits',
  process_gate: 'process fits',
  business_model_gate: 'business model fits',
  reasons: ['verified public evidence'],
};

describe('fit judge persistence and model boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTask).mockReturnValue(contract as never);
  });

  it('persists mismatch into the rejected queue and increments an existing lead version', async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const judgment = {
      verdict: 'mismatch' as const,
      fitReasons: {
        material: 'no',
        role: 'no',
        process: 'no',
        business_model: 'no',
        reasons: ['outside ICP'],
      },
    };

    await upsertLeadFit({ lead: { upsert } } as never, 'ws-1', 'icp-1', 'company-1', judgment);

    expect(upsert).toHaveBeenCalledWith({
      where: {
        workspaceId_icpId_canonicalCompanyId: {
          workspaceId: 'ws-1',
          icpId: 'icp-1',
          canonicalCompanyId: 'company-1',
        },
      },
      update: {
        fitVerdict: 'mismatch',
        fitReasons: judgment.fitReasons,
        version: { increment: 1 },
      },
      create: {
        workspaceId: 'ws-1',
        icpId: 'icp-1',
        canonicalCompanyId: 'company-1',
        fitVerdict: 'mismatch',
        fitReasons: judgment.fitReasons,
        queue: 'rejected',
      },
    });
  });

  it('loads a bounded ICP brief and returns an empty object for a missing ICP', async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        name: 'German pump buyers',
        companyAttributes: { industry: 'pumps' },
        exclusions: ['consumer'],
        targetMarkets: ['DE'],
        company: { name: 'Seller GmbH', summary: 'Makes valves' },
      });
    const tx = { icpDefinition: { findUnique } } as never;

    await expect(loadIcpBrief(tx, 'missing')).resolves.toEqual({});
    await expect(loadIcpBrief(tx, 'icp-1')).resolves.toEqual({
      seller: 'Seller GmbH',
      seller_summary: 'Makes valves',
      icp_name: 'German pump buyers',
      company_attributes: { industry: 'pumps' },
      exclusions: ['consumer'],
      target_markets: ['DE'],
    });
  });

  it('maps the structured result and forwards runtime authorization and telemetry', async () => {
    const authorizeExternalAction = vi.fn().mockResolvedValue(true);
    const runtimeTelemetry = { emit: vi.fn() };
    vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValue({
      data: output,
      provider: 'gateway',
    } as never);

    await expect(
      judgeFitCompany({} as never, 'ws-1', { seller: 'Seller', seller_summary: null }, company, {
        runId: 'run-1',
        runtimeTelemetry,
        authorizeExternalAction,
      }),
    ).resolves.toEqual({
      verdict: 'match',
      fitReasons: {
        material: 'material fits',
        role: 'buyer fits',
        process: 'process fits',
        business_model: 'business model fits',
        reasons: ['verified public evidence'],
      },
    });
    expect(executeStructuredTaskWithRuntime).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        task: 'discovery.qualify_fit',
        model: 'fake-model',
        prompt: expect.stringContaining('Acme GmbH'),
      }),
      { workspaceId: 'ws-1', runId: 'run-1', authorizeExternalAction },
      { telemetry: runtimeTelemetry },
    );
  });

  it('normalizes an unknown verdict to weak without fabricating gate content', async () => {
    vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValue({
      data: { ...output, verdict: 'unexpected' },
      provider: 'gateway',
    } as never);

    await expect(judgeFitCompany({} as never, 'ws-1', {}, company)).resolves.toMatchObject({ verdict: 'weak' });
  });

  it('rejects stub output and fail-safely skips ordinary model errors', async () => {
    vi.mocked(executeStructuredTaskWithRuntime)
      .mockResolvedValueOnce({ data: output, provider: 'stub' } as never)
      .mockRejectedValueOnce(new Error('provider unavailable'));

    await expect(judgeFitCompany({} as never, 'ws-1', {}, company)).resolves.toBeNull();
    await expect(judgeFitCompany({} as never, 'ws-1', {}, company)).resolves.toBeNull();
  });

  it('propagates budget exhaustion so the caller can stop the entire batch', async () => {
    const exhausted = new BudgetExceededError('run-1', 10, 0);
    vi.mocked(executeStructuredTaskWithRuntime).mockRejectedValue(exhausted);

    await expect(judgeFitCompany({} as never, 'ws-1', {}, company)).rejects.toBe(exhausted);
  });
});
