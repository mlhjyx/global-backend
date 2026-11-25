import { describe, expect, it } from 'vitest';
import {
  createInitialStreamingProgress,
  readStreamingRunProgress,
  upsertStreamingCandidate,
} from './streaming-progress';

const RUN_ID = '20000000-0000-4000-8000-000000000002';

describe('streaming-progress projection', () => {
  it('initializes streaming progress and upserts recent candidates newest-first without duplicates', () => {
    const initial = createInitialStreamingProgress(RUN_ID, {
      queriesTotal: 4,
      topKCap: 15,
      now: '2026-11-26T00:00:00.000Z',
    });
    expect(initial.pipelineMode).toBe('streaming');
    expect(initial.currentStage).toBe('l0_recall');
    expect(initial.stages.l0Recall.queriesTotal).toBe(4);
    expect(initial.stages.l2TopKEnrich.topKCap).toBe(15);

    const updated = upsertStreamingCandidate(
      upsertStreamingCandidate(initial.recentCandidates, {
        companyId: 'c-1',
        name: 'Alpha Solar',
        domain: 'alpha-solar.it',
        country: 'IT',
        stage: 'l0_recalled',
        fitVerdict: null,
        fitScore: null,
        fetchMethod: null,
        channelsFound: { emails: 0, phones: 0, forms: 0, socials: 0 },
        reasonSummary: null,
        updatedAt: '2026-11-26T00:00:01.000Z',
      }),
      {
        companyId: 'c-1',
        name: 'Alpha Solar',
        domain: 'alpha-solar.it',
        country: 'IT',
        stage: 'l1_scored',
        fitVerdict: 'match',
        fitScore: 92,
        fetchMethod: 'raw_http',
        channelsFound: { emails: 2, phones: 1, forms: 1, socials: 1 },
        reasonSummary: 'Italian solar distributor',
        updatedAt: '2026-11-26T00:00:05.000Z',
      },
    );
    expect(updated).toHaveLength(1);
    expect(updated[0]!.stage).toBe('l1_scored');
    expect(updated[0]!.fitVerdict).toBe('match');
  });

  it('gracefully projects legacy discoveryWorkflow runs as pipelineMode=legacy', () => {
    const legacy = readStreamingRunProgress({
      id: RUN_ID,
      status: 'DONE',
      stats: {
        queriesTotal: 3,
        queriesSucceeded: 3,
        rawCount: 18,
        canonicalCount: 12,
        fitEvaluated: 10,
        fitMatch: 4,
        fitWeak: 3,
        fitMismatch: 3,
        watchesRegistered: 4,
      },
      createdAt: new Date('2026-11-25T10:00:00.000Z'),
      completedAt: new Date('2026-11-25T10:10:00.000Z'),
    });
    expect(legacy.pipelineMode).toBe('legacy');
    expect(legacy.currentStage).toBe('done');
    expect(legacy.stages.l0Recall.canonicalUpserted).toBe(12);
    expect(legacy.stages.l1ExtractFit.fitMatch).toBe(4);
    expect(legacy.stages.l2TopKEnrich.watchesRegistered).toBe(4);
  });
});
