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

    expect(acts.listKbRecoveryCandidates).toHaveBeenCalledWith({ limit: 10 });
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

  it('把调用方 limit 钳制为 10，并以最多 5 条受控并发处理', async () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      workspaceId: `ws-${i}`,
      siteId: `site-${i}`,
      assetId: `asset-${i}`,
    }));
    acts.listKbRecoveryCandidates.mockResolvedValue(candidates);

    let inFlight = 0;
    let maxInFlight = 0;
    let releaseFirstWave!: () => void;
    const firstWave = new Promise<void>((resolve) => {
      releaseFirstWave = resolve;
    });
    acts.processKbAsset.mockImplementation(async (candidate: { assetId: string }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (Number(candidate.assetId.slice('asset-'.length)) < 5) await firstWave;
      inFlight -= 1;
      return { assetId: candidate.assetId, outcome: 'ready' };
    });

    const pending = kbRecoverySweepWorkflow({ limit: 100 });
    await vi.waitFor(() => expect(acts.processKbAsset).toHaveBeenCalledTimes(5));
    expect(maxInFlight).toBe(5);
    releaseFirstWave();

    const out = await pending;

    expect(acts.listKbRecoveryCandidates).toHaveBeenCalledWith({ limit: 10 });
    expect(acts.processKbAsset).toHaveBeenCalledTimes(10);
    expect(maxInFlight).toBe(5);
    expect(out).toMatchObject({ scanned: 10, ready: 10, errors: [] });
  });
});
