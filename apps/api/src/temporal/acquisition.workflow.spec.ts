import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `acquisitionSweepWorkflow` 编排单测。复用 PR #73 hermetic proxyActivities-mock harness。
 * 守：逐源 acquire、单源失败 fail-safe 不阻断其余、limit 透传、空源早停。
 */
vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));

import { acts, resetActivities, setWorkflowInfo } from './testing/temporal-workflow.mock';
import { acquisitionSweepWorkflow } from './acquisition.workflow';
import { PLATFORM_SCHEDULE_AUTHORITY_SCOPES } from './platform-schedule-authority';

const scope = PLATFORM_SCHEDULE_AUTHORITY_SCOPES['acq-sweep'];
const executionBudget = {
  authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b', scopeKey: 'platform' as const,
  accountKey: `platform:${scope.requestSha256}:workflow-run-1`, ...scope,
  workflowRunId: 'workflow-run-1', admissionReplay: false,
};
const workflowInput = (limit?: number) => ({
  executionContractVersion: 1 as const, executionScope: scope,
  ...(limit === undefined ? {} : { limit }),
});

function acquireResult(sourceId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { sourceId, status: 'DONE', total: 10, added: 2, updated: 1, removed: 0, unchanged: 7, ...over };
}

beforeEach(() => {
  resetActivities();
  setWorkflowInfo({ runId: 'workflow-run-1' });
  acts.admitPlatformSchedule.mockResolvedValue(executionBudget);
});

describe('acquisitionSweepWorkflow', () => {
  it('happy：逐源 acquire、收集结果、swept=源数', async () => {
    acts.listDueSources.mockResolvedValue({ sourceIds: ['s1', 's2', 's3'] });
    acts.acquireSource.mockImplementation(async ({ sourceId }: { sourceId: string }) => acquireResult(sourceId));

    const out = await acquisitionSweepWorkflow(workflowInput());

    expect(acts.acquireSource).toHaveBeenCalledTimes(3);
    expect(out.swept).toBe(3);
    expect(out.results).toHaveLength(3);
    expect(out.results.map((r) => r.sourceId)).toEqual(['s1', 's2', 's3']);
    expect(out.results.every((r) => r.error === undefined)).toBe(true);
  });

  it('单源 acquire 抛错 → fail-safe FAILED 条目，其余仍处理', async () => {
    acts.listDueSources.mockResolvedValue({ sourceIds: ['s1', 's2'] });
    acts.acquireSource
      .mockRejectedValueOnce(new Error('acquire boom'))
      .mockImplementationOnce(async ({ sourceId }: { sourceId: string }) => acquireResult(sourceId));

    const out = await acquisitionSweepWorkflow(workflowInput());

    expect(out.swept).toBe(2);
    expect(out.results[0]).toMatchObject({ sourceId: 's1', status: 'FAILED', total: 0 });
    expect(out.results[0].error).toContain('acquire boom');
    expect(out.results[1].error).toBeUndefined();
  });

  it('limit 透传（默认 50）', async () => {
    acts.listDueSources.mockResolvedValue({ sourceIds: [] });
    await acquisitionSweepWorkflow(workflowInput(7));
    expect(acts.listDueSources).toHaveBeenCalledWith(expect.objectContaining({ limit: 7 }));
    await acquisitionSweepWorkflow(workflowInput());
    expect(acts.listDueSources).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 50 }));
  });

  it('无到期源 → swept 0、不调 acquireSource', async () => {
    acts.listDueSources.mockResolvedValue({ sourceIds: [] });
    const out = await acquisitionSweepWorkflow(workflowInput());
    expect(acts.acquireSource).not.toHaveBeenCalled();
    expect(out).toEqual({ swept: 0, results: [] });
  });
});
