import { describe, expect, it } from 'vitest';
import { MemorySemanticConfig } from './memory.contracts';
import { MemoryQueryService } from './memory-query.service';

const WORKSPACE_ID = '55555555-5555-4555-8555-555555555555';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const EPISODE_ID = '77777777-7777-4777-8777-777777777777';
const STAT_ID = '88888888-8888-4888-8888-888888888888';

const enabled: MemorySemanticConfig = {
  enabled: true,
  minN: 30,
  maxCiWidth: 0.2,
  briefMaxTokens: 2000,
};

class FakePrisma {
  constructor(
    private readonly episodes: unknown[] = [],
    private readonly stats: unknown[] = [],
  ) {}

  async withWorkspace<T>(
    _workspaceId: string,
    fn: (tx: {
      memRunEpisode: { findMany: () => Promise<unknown[]> };
      memKnowledgeStat: { findMany: () => Promise<unknown[]> };
    }) => Promise<T>,
  ): Promise<T> {
    return fn({
      memRunEpisode: { findMany: async () => this.episodes },
      memKnowledgeStat: { findMany: async () => this.stats },
    });
  }
}

function statRow(overrides: Record<string, unknown> = {}) {
  return {
    id: STAT_ID,
    scopeType: 'icp',
    scopeKey: '33333333-3333-4333-8333-333333333333',
    statKey: 'qualify_rate',
    successes: 40,
    failures: 10,
    validFrom: new Date('2026-11-01T00:00:00.000Z'),
    validTo: null,
    provenance: { source: 'lead' },
    ...overrides,
  };
}

describe('MemoryQueryService', () => {
  it('maps run episodes with their provenance', async () => {
    const service = new MemoryQueryService(
      new FakePrisma([
        {
          id: EPISODE_ID,
          phase: 'run_completed',
          occurredAt: new Date('2026-11-08T10:00:00.000Z'),
          sourceEventId: '44444444-4444-4444-8444-444444444444',
          payload: { status: 'DONE' },
          provenance: { eventType: 'DiscoveryRunCompleted' },
          privacyClassification: 'CONFIDENTIAL',
        },
      ]) as never,
      enabled,
    );
    const episodes = await service.getRunEpisodes(WORKSPACE_ID, {
      runId: RUN_ID,
    });
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      id: EPISODE_ID,
      phase: 'run_completed',
      occurredAt: '2026-11-08T10:00:00.000Z',
      sourceEventId: '44444444-4444-4444-8444-444444444444',
    });
  });

  it('returns no semantic rows while the kill switch is off', async () => {
    const service = new MemoryQueryService(
      new FakePrisma([], [statRow()]) as never,
      { ...enabled, enabled: false },
    );
    await expect(
      service.listKnowledgeStats(WORKSPACE_ID, {
        scopes: [{ type: 'icp', key: '33333333-3333-4333-8333-333333333333' }],
      }),
    ).resolves.toEqual([]);
  });

  it('keeps the latest valid version per scope and stat', async () => {
    const latest = statRow({
      id: '99999999-9999-4999-8999-999999999999',
      successes: 45,
      failures: 5,
      validFrom: new Date('2026-11-05T00:00:00.000Z'),
    });
    const service = new MemoryQueryService(
      new FakePrisma([], [latest, statRow()]) as never,
      enabled,
    );
    const stats = await service.listKnowledgeStats(
      WORKSPACE_ID,
      {
        scopes: [{ type: 'icp', key: '33333333-3333-4333-8333-333333333333' }],
      },
      new Date('2026-11-08T00:00:00.000Z'),
    );
    expect(stats).toHaveLength(1);
    expect(stats[0].id).toBe('99999999-9999-4999-8999-999999999999');
    expect(stats[0].n).toBe(50);
  });

  it('marks a statistic eligible only when the confidence gate passes', async () => {
    const service = new MemoryQueryService(
      new FakePrisma([], [statRow()]) as never,
      { ...enabled, minN: 10, maxCiWidth: 1 },
    );
    const [stat] = await service.listKnowledgeStats(
      WORKSPACE_ID,
      {
        scopes: [{ type: 'icp', key: '33333333-3333-4333-8333-333333333333' }],
      },
      new Date('2026-11-08T00:00:00.000Z'),
    );
    expect(stat.mayInfluenceStrategy).toBe(true);
    expect(stat.usage).toBe('eligible');

    const strict = new MemoryQueryService(
      new FakePrisma([], [statRow()]) as never,
      enabled,
    );
    const [hint] = await strict.listKnowledgeStats(
      WORKSPACE_ID,
      {
        scopes: [{ type: 'icp', key: '33333333-3333-4333-8333-333333333333' }],
      },
      new Date('2026-11-08T00:00:00.000Z'),
    );
    // n=50 but p=0.8 gives a Wilson width above 0.20 at 95%.
    expect(hint.mayInfluenceStrategy).toBe(false);
    expect(hint.usage).toBe('hint_only');
  });

  it('builds a cited brief and truncates past the token budget', async () => {
    const stats = Array.from({ length: 10 }, (_, index) =>
      statRow({
        id: `9999999${index}-9999-4999-8999-99999999999${index}`,
        statKey: `stat_${index}`,
        scopeKey: `scope-${index}`,
      }),
    );
    const service = new MemoryQueryService(
      new FakePrisma(
        [
          {
            id: EPISODE_ID,
            phase: 'run_completed',
            occurredAt: new Date('2026-11-08T10:00:00.000Z'),
            sourceEventId: '44444444-4444-4444-8444-444444444444',
            payload: { status: 'DONE', cost: 1.2 },
            provenance: {},
            privacyClassification: 'CONFIDENTIAL',
          },
        ],
        stats,
      ) as never,
      { ...enabled, briefMaxTokens: 200 },
    );
    const brief = await service.buildMemoryBrief(WORKSPACE_ID, {
      runId: RUN_ID,
      scopes: [{ type: 'icp', key: '33333333-3333-4333-8333-333333333333' }],
    });
    expect(brief.semanticEnabled).toBe(true);
    expect(brief.truncated).toBe(true);
    expect(brief.tokenEstimate).toBeLessThanOrEqual(200);
    expect(brief.text).toContain('mem_run_episode');
    expect(brief.citations.length).toBeGreaterThan(0);
    expect(brief.citations[0]).toMatchObject({
      table: 'mem_run_episode',
      id: EPISODE_ID,
    });
  });
});
