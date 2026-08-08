import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `acquisitionSweepWorkflow` 编排单测。复用 PR #73 hermetic proxyActivities-mock harness。
 * 守：逐源 acquire、单源失败 fail-safe 不阻断其余、limit 透传、空源早停。
 */
vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));

import { acts, resetActivities } from './testing/temporal-workflow.mock';
import { acquisitionSweepWorkflow } from './acquisition.workflow';

const SENSITIVE_ERROR =
  'Alice Buyer <alice@example.com> https://private.example/rfq secret=pilot-token';

function acquireResult(sourceId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { sourceId, status: 'DONE', total: 10, added: 2, updated: 1, removed: 0, unchanged: 7, ...over };
}

beforeEach(() => resetActivities());

describe('acquisitionSweepWorkflow', () => {
  it('happy：逐源 acquire、收集结果、swept=源数', async () => {
    acts.listDueSources.mockResolvedValue({ sourceIds: ['s1', 's2', 's3'] });
    acts.acquireSource.mockImplementation(async ({ sourceId }: { sourceId: string }) => acquireResult(sourceId));

    const out = await acquisitionSweepWorkflow({});

    expect(acts.acquireSource).toHaveBeenCalledTimes(3);
    expect(out.swept).toBe(3);
    expect(out.results).toHaveLength(3);
    expect(out.results.map((r) => r.sourceId)).toEqual(['s1', 's2', 's3']);
    expect(out.results.every((r) => r.error === undefined)).toBe(true);
  });

  it('单源 acquire 抛错 → 只返回闭合机器码且不把 PII/URL/secret 写进 workflow result', async () => {
    acts.listDueSources.mockResolvedValue({ sourceIds: ['s1', 's2'] });
    acts.acquireSource
      .mockRejectedValueOnce(new Error(SENSITIVE_ERROR))
      .mockImplementationOnce(async ({ sourceId }: { sourceId: string }) => acquireResult(sourceId));

    const out = await acquisitionSweepWorkflow({});

    expect(out.swept).toBe(2);
    expect(out.results[0]).toMatchObject({ sourceId: 's1', status: 'FAILED', total: 0 });
    expect(out.results[0].error).toBe('ACQUISITION_SOURCE_FAILED');
    expect(out.results[1].error).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain(SENSITIVE_ERROR);
  });

  it('activity 返回的 raw reason 也在 workflow 边界收敛，BudgetExceeded 保留显式语义', async () => {
    acts.listDueSources.mockResolvedValue({ sourceIds: ['s1', 's2'] });
    acts.acquireSource
      .mockResolvedValueOnce(acquireResult('s1', { status: 'FAILED', reason: SENSITIVE_ERROR }))
      .mockRejectedValueOnce({
        name: 'ActivityFailure',
        cause: { type: 'BudgetExceededError', message: SENSITIVE_ERROR },
      });

    const out = await acquisitionSweepWorkflow({});

    expect(out.results[0]).toMatchObject({
      sourceId: 's1',
      status: 'FAILED',
      reason: 'ACQUISITION_SOURCE_FAILED',
    });
    expect(out.results[1]).toMatchObject({
      sourceId: 's2',
      status: 'FAILED',
      error: 'BUDGET_EXCEEDED',
    });
    expect(JSON.stringify(out)).not.toContain(SENSITIVE_ERROR);
  });

  it('limit 透传（默认 50）', async () => {
    acts.listDueSources.mockResolvedValue({ sourceIds: [] });
    await acquisitionSweepWorkflow({ limit: 7 });
    expect(acts.listDueSources).toHaveBeenCalledWith({ limit: 7 });
    await acquisitionSweepWorkflow({});
    expect(acts.listDueSources).toHaveBeenLastCalledWith({ limit: 50 });
  });

  it('无到期源 → swept 0、不调 acquireSource', async () => {
    acts.listDueSources.mockResolvedValue({ sourceIds: [] });
    const out = await acquisitionSweepWorkflow({});
    expect(acts.acquireSource).not.toHaveBeenCalled();
    expect(out).toEqual({ swept: 0, results: [] });
  });
});
