import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  reconcileReviewState,
  screenMatchKey,
  matchesFromJson,
  SanctionsScreeningService,
} from './sanctions-screening.service';

/**
 * 复核态对账（re-screen 抑制）纯逻辑单测。红线：confirmed 恒留、cleared 仅当无新命中才留、出现新命中重开。
 */

const m = (sourceKey: string, externalId: string) => ({ sourceKey, externalId });

describe('reconcileReviewState', () => {
  it('无既有记录 → open', () => {
    expect(reconcileReviewState(null, [m('ofac_sdn', '36')])).toBe('open');
  });

  it('confirmed_true_hit 恒留（真命中永远隔离）', () => {
    expect(
      reconcileReviewState({ reviewState: 'confirmed_true_hit', matches: [m('ofac_sdn', '36')] }, [m('ofac_sdn', '99')]),
    ).toBe('confirmed_true_hit');
  });

  it('cleared_false_positive + 新命中 ⊆ 已清 → 保持 cleared（抑制复发）', () => {
    expect(
      reconcileReviewState({ reviewState: 'cleared_false_positive', matches: [m('ofac_sdn', '36'), m('eu_fsf', '7')] }, [
        m('ofac_sdn', '36'),
      ]),
    ).toBe('cleared_false_positive');
  });

  it('🔴 cleared_false_positive + 出现新条目 → 重开（名单新增疑似命中须重审）', () => {
    expect(
      reconcileReviewState({ reviewState: 'cleared_false_positive', matches: [m('ofac_sdn', '36')] }, [
        m('ofac_sdn', '36'),
        m('ofac_sdn', '900'), // 新条目
      ]),
    ).toBe('open');
  });

  it('open → open', () => {
    expect(reconcileReviewState({ reviewState: 'open', matches: [] }, [m('ofac_sdn', '36')])).toBe('open');
  });
});

describe('screenMatchKey / matchesFromJson', () => {
  it('抑制键 = 源:条目', () => {
    expect(screenMatchKey(m('ofac_sdn', '36'))).toBe('ofac_sdn:36');
  });
  it('Json → 最小形状（过滤非法项）', () => {
    const raw = [{ sourceKey: 'ofac_sdn', externalId: '36', score: 1 }, { sourceKey: 'x' }, 'junk', null];
    expect(matchesFromJson(raw)).toEqual([{ sourceKey: 'ofac_sdn', externalId: '36' }]);
    expect(matchesFromJson(null)).toEqual([]);
  });
});

describe('SanctionsScreeningService lifecycle and fail-open boundary', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('stays inactive when no source is enabled and reports not_screened', async () => {
    const prisma = {
      sanctionsSource: { findMany: vi.fn(async () => []) },
      sanctionsEntity: { findMany: vi.fn() },
    };
    const service = new SanctionsScreeningService(prisma as never);
    await service.rebuildIndex();
    expect(service.isActive()).toBe(false);
    expect(service.screen('Acme', 'DE')).toEqual({ status: 'not_screened', matches: [], listVersions: {} });
    expect(prisma.sanctionsEntity.findMany).not.toHaveBeenCalled();
  });

  it('indexes only present enabled sources, returns potential_match/clear, and honors a valid threshold override', async () => {
    vi.stubEnv('SANCTIONS_MATCH_THRESHOLD', '0.6');
    const prisma = {
      sanctionsSource: {
        findMany: vi.fn(async () => [
          { id: 's1', key: 'ofac', publishDate: new Date('2026-08-12T00:00:00.000Z') },
          { id: 's2', key: 'empty', publishDate: null },
        ]),
      },
      sanctionsEntity: {
        findMany: vi.fn(async () => [
          {
            externalId: '36',
            sourceId: 's1',
            primaryName: 'AEROCARIBBEAN AIRLINES',
            country: 'CU',
            listVersion: '2026-08-12',
            aliases: [{ name: 'AERO CARIBBEAN', quality: 'strong' }],
          },
        ]),
      },
    };
    const service = new SanctionsScreeningService(prisma as never);
    await service.rebuildIndex();

    expect(service.isActive()).toBe(true);
    expect(service.screen('AEROCARIBBEAN AIRLINES', 'CU')).toMatchObject({
      status: 'potential_match',
      listVersions: { ofac: '2026-08-12' },
    });
    expect(service.screen('Entirely Different GmbH', 'DE')).toEqual({
      status: 'clear',
      matches: [],
      listVersions: { ofac: '2026-08-12' },
    });
  });

  it('module initialization catches rebuild failure, schedules bounded refresh, and destroy clears it', async () => {
    vi.useFakeTimers();
    vi.stubEnv('SANCTIONS_INDEX_REBUILD_MS', '60000');
    const prisma = {
      sanctionsSource: { findMany: vi.fn().mockRejectedValue(new Error('catalog unavailable')) },
    };
    const service = new SanctionsScreeningService(prisma as never);

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(service.isActive()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(prisma.sanctionsSource.findMany).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(prisma.sanctionsSource.findMany).toHaveBeenCalledTimes(2);
  });
});
