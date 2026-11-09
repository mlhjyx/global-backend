import { beforeEach, describe, expect, it, vi } from 'vitest';

/** `recallAuditWorkflow` 编排单测（hermetic proxyActivities mock）。 */
vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));

import { acts, resetActivities } from './testing/temporal-workflow.mock';
import { recallAuditWorkflow } from './recall-audit.workflow';

const WS = '11111111-1111-4111-8111-111111111111';
const RUN = '33333333-3333-4333-8333-333333333333';

const frameExport = (entities: Array<{ scheme: string; regNumber: string }>) => ({
  schemaVersion: 'recall-frame-export/v1',
  manifest: {
    frameKey: 'fr_sirene',
    snapshotId: '44444444-4444-4444-8444-444444444444',
    sha256: 'f'.repeat(64),
    rowCount: entities.length,
    exportedAt: '2026-11-10T09:00:00.000Z',
  },
  entities: entities.map((entity) => ({
    scheme: entity.scheme,
    regNumber: entity.regNumber,
    country: 'FR',
    name: 'X SAS',
    nace: null,
    employeeBand: '50-249',
  })),
});

const poolExport = (rows: Array<{ scheme: string; number: string }>) => ({
  schemaVersion: 'recall-pool-export/v1',
  manifest: {
    runId: RUN,
    workspaceId: WS,
    sha256: 'a'.repeat(64),
    rowCount: rows.length,
    exportedAt: '2026-11-10T09:00:00.000Z',
  },
  pool: rows.map((row) => ({
    name: 'X SAS',
    registryScheme: row.scheme,
    registryNumber: row.number,
    domain: 'x.example',
    contactFound: false,
    contacts: 0,
  })),
});

beforeEach(() => {
  resetActivities();
});

describe('recallAuditWorkflow', () => {
  it('exports both inputs, runs the estimate with the threaded sample parameters and returns the manifests', async () => {
    acts.exportRecallFrameForAudit.mockResolvedValue(
      frameExport([
        { scheme: 'fr_siren', regNumber: '529990001' },
        { scheme: 'fr_siren', regNumber: '529990002' },
      ]),
    );
    acts.exportRecallPoolForAudit.mockResolvedValue(poolExport([{ scheme: 'fr_siren', number: '529990001' }]));
    acts.runRecallAuditEstimate.mockImplementation(async (input: { frame: unknown[]; pool: unknown[] }) => ({
      strata: [
        {
          stratumKey: 'FR:50-249',
          N: 2,
          n: 2,
          found: 1,
          domainResolved: 1,
          contactFound: 0,
          recall: { estimate: 0.5, low: 0.1, high: 0.9 },
          domainRate: null,
          domainRateOfFound: null,
          contactRate: null,
          census: true,
        },
      ],
      totals: { N: 2, n: 2, found: 1, domainResolved: 1, contactFound: 0, recall: null, domainRate: null },
      sample: { size: 384, seed: 's1', sampled: false },
      missedKeys: ['fr_siren:529990002'],
    }));

    const result = await recallAuditWorkflow({
      frameKey: 'fr_sirene',
      workspaceId: WS,
      runId: RUN,
      sampleSize: 384,
      seed: 's1',
    });

    expect(acts.exportRecallFrameForAudit).toHaveBeenCalledWith({ frameKey: 'fr_sirene', snapshotId: null });
    expect(acts.exportRecallPoolForAudit).toHaveBeenCalledWith({ workspaceId: WS, runId: RUN });
    expect(acts.runRecallAuditEstimate).toHaveBeenCalledWith(
      expect.objectContaining({ sampleSize: 384, seed: 's1' }),
    );
    // 活动间传递的是导出的实体/池（不是再查库），manifest 原样返回。
    const estimateArg = acts.runRecallAuditEstimate.mock.calls[0]![0] as { frame: unknown[]; pool: unknown[] };
    expect(estimateArg.frame).toHaveLength(2);
    expect(estimateArg.pool).toHaveLength(1);
    expect(result.frame.rowCount).toBe(2);
    expect(result.pool.rowCount).toBe(1);
    expect(result.audit.totals.found).toBe(1);
  });

  it('passes a snapshot override through to the frame export', async () => {
    const snapshotId = '55555555-5555-4555-8555-555555555555';
    acts.exportRecallFrameForAudit.mockResolvedValue(frameExport([{ scheme: 'fr_siren', regNumber: '1' }]));
    acts.exportRecallPoolForAudit.mockResolvedValue(poolExport([]));
    acts.runRecallAuditEstimate.mockResolvedValue({
      strata: [],
      totals: { N: 0, n: 0, found: 0, domainResolved: 0, contactFound: 0, recall: null, domainRate: null },
      sample: { size: null, seed: null, sampled: false },
      missedKeys: [],
    });
    await recallAuditWorkflow({ frameKey: 'fr_sirene', snapshotId, workspaceId: WS, runId: RUN });
    expect(acts.exportRecallFrameForAudit).toHaveBeenCalledWith({ frameKey: 'fr_sirene', snapshotId });
  });

  it('fails closed on bad input before any activity', async () => {
    await expect(
      recallAuditWorkflow({ frameKey: '', workspaceId: WS, runId: RUN }),
    ).rejects.toThrow(/frameKey/u);
    await expect(
      recallAuditWorkflow({ frameKey: 'fr_sirene', workspaceId: '', runId: RUN }),
    ).rejects.toThrow(/workspaceId/u);
    await expect(
      recallAuditWorkflow({ frameKey: 'fr_sirene', workspaceId: WS, runId: RUN, sampleSize: 0 }),
    ).rejects.toThrow(/sampleSize/u);
    expect(acts.exportRecallFrameForAudit).not.toHaveBeenCalled();
  });

  it('propagates gate and payload errors from activities', async () => {
    acts.exportRecallFrameForAudit.mockRejectedValue(
      Object.assign(new Error('frame 冻结实体 9000 行超过 workflow 上限'), { name: 'RecallAuditWorkflowError', code: 'FRAME_TOO_LARGE' }),
    );
    await expect(
      recallAuditWorkflow({ frameKey: 'fr_sirene', workspaceId: WS, runId: RUN }),
    ).rejects.toThrow(/上限/u);
    expect(acts.exportRecallPoolForAudit).not.toHaveBeenCalled();
  });
});
