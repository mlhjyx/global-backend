import { beforeEach, describe, expect, it, vi } from 'vitest';

const { continueAsNew } = vi.hoisted(() => ({ continueAsNew: vi.fn() }));
vi.mock('@temporalio/workflow', async () => ({
  ...(await import('./testing/temporal-workflow.mock')),
  continueAsNew,
}));

import { acts, resetActivities, setPatched } from './testing/temporal-workflow.mock';
import { rawRetentionSweepWorkflow } from './raw-retention.workflow';

beforeEach(() => {
  resetActivities();
  continueAsNew.mockReset();
});

describe('rawRetentionSweepWorkflow', () => {
  it('sweeps due workspaces in bounded batches and aggregates receipts', async () => {
    acts.listRawRetentionWorkspaces.mockResolvedValue({
      workspaceIds: ['ws-1', 'ws-2'],
      nextCursor: null,
    });
    acts.expireRawSourceRecords
      .mockResolvedValueOnce({ expired: 2, deferredForConflict: 1 })
      .mockResolvedValueOnce({ expired: 1, deferredForConflict: 0 });

    await expect(rawRetentionSweepWorkflow({ workspaceLimit: 20, batchSize: 10 })).resolves.toEqual({
      workspaces: 2,
      expired: 3,
      deferredForConflict: 1,
    });
    expect(acts.expireRawSourceRecords).toHaveBeenCalledTimes(2);
  });

  it('continues other workspaces but fails the sweep visibly when one workspace cannot be processed', async () => {
    acts.listRawRetentionWorkspaces.mockResolvedValue({
      workspaceIds: ['ws-1', 'ws-2'],
      nextCursor: null,
    });
    acts.expireRawSourceRecords.mockRejectedValueOnce(new Error('db unavailable')).mockResolvedValueOnce({
      expired: 1,
      deferredForConflict: 0,
    });

    await expect(rawRetentionSweepWorkflow()).rejects.toThrow('RAW_RETENTION_WORKSPACE_FAILURE:1');
    expect(acts.expireRawSourceRecords).toHaveBeenCalledTimes(2);
  });

  it('advances to later workspace pages even when the first page only has conflict-deferred raws', async () => {
    acts.listRawRetentionWorkspaces
      .mockResolvedValueOnce({ workspaceIds: ['ws-1'], nextCursor: 'ws-1' })
      .mockResolvedValueOnce({ workspaceIds: ['ws-2'], nextCursor: null });
    acts.expireRawSourceRecords
      .mockResolvedValueOnce({ expired: 0, deferredForConflict: 4 })
      .mockResolvedValueOnce({ expired: 2, deferredForConflict: 0 })
      .mockResolvedValueOnce({ expired: 0, deferredForConflict: 0 });

    await expect(rawRetentionSweepWorkflow({
      workspaceLimit: 1,
      batchSize: 2,
      workspacePagesPerRun: 2,
    })).resolves.toEqual({
      workspaces: 2,
      expired: 2,
      deferredForConflict: 4,
    });
    expect(acts.listRawRetentionWorkspaces).toHaveBeenNthCalledWith(2, {
      limit: 1,
      afterWorkspaceId: 'ws-1',
    });
    expect(acts.expireRawSourceRecords).toHaveBeenCalledWith({ workspaceId: 'ws-2', limit: 2 });
  });

  it('continues as new with a stable cursor and aggregates after the per-run page bound', async () => {
    acts.listRawRetentionWorkspaces.mockResolvedValue({
      workspaceIds: ['ws-1'],
      nextCursor: 'ws-1',
    });
    acts.expireRawSourceRecords.mockResolvedValue({ expired: 0, deferredForConflict: 3 });
    continueAsNew.mockResolvedValue(undefined);

    await rawRetentionSweepWorkflow({ workspaceLimit: 1, batchSize: 10, workspacePagesPerRun: 1 });

    expect(continueAsNew).toHaveBeenCalledWith({
      workspaceLimit: 1,
      batchSize: 10,
      workspacePagesPerRun: 1,
      afterWorkspaceId: 'ws-1',
      accumulated: { workspaces: 1, expired: 0, deferredForConflict: 3 },
    });
  });

  it('keeps the legacy single-page command sequence when replaying a pre-pagination history', async () => {
    setPatched(() => false);
    acts.listRawRetentionWorkspaces.mockResolvedValue({
      workspaceIds: ['ws-legacy'],
      nextCursor: 'ignored-by-legacy-history',
    });
    acts.expireRawSourceRecords.mockResolvedValue({ expired: 1, deferredForConflict: 0 });

    await expect(rawRetentionSweepWorkflow({ workspaceLimit: 10, batchSize: 10 })).resolves.toEqual({
      workspaces: 1,
      expired: 1,
      deferredForConflict: 0,
    });
    expect(acts.listRawRetentionWorkspaces).toHaveBeenCalledWith({ limit: 10 });
    expect(continueAsNew).not.toHaveBeenCalled();
  });
});
