import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));

import { acts, resetActivities } from './testing/temporal-workflow.mock';
import { kbRecoverySweepWorkflow } from './kb-recovery.workflow';

beforeEach(() => resetActivities());

describe('kbRecoverySweepWorkflow R2-A2', () => {
  it('有界列出 due/过期素材，并让单素材失败不阻断后续候选', async () => {
    const candidates = [
      { workspaceId: 'ws-1', siteId: 'site-1', assetId: 'asset-1' },
      { workspaceId: 'ws-2', siteId: 'site-2', assetId: 'asset-2' },
      { workspaceId: 'ws-3', siteId: 'site-3', assetId: 'asset-3' },
    ];
    acts.listKbRecoveryCandidates.mockResolvedValue(candidates);
    acts.processKbAsset
      .mockResolvedValueOnce({ assetId: 'asset-1', outcome: 'ready' })
      .mockRejectedValueOnce(new Error('worker unavailable'))
      .mockResolvedValueOnce({ assetId: 'asset-3', outcome: 'retry_scheduled' });

    const out = await kbRecoverySweepWorkflow({ limit: 20 });

    expect(acts.listKbRecoveryCandidates).toHaveBeenCalledWith({ limit: 20 });
    expect(acts.processKbAsset).toHaveBeenCalledTimes(3);
    expect(out).toMatchObject({
      scanned: 3,
      ready: 1,
      retryScheduled: 1,
      terminal: 0,
      skipped: 0,
    });
    expect(out.errors).toHaveLength(1);
  });
});
