import { describe, expect, it, vi } from 'vitest';
import {
  reconcileReviewState,
  screenMatchKey,
  matchesFromJson,
  storedScreeningBlocks,
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

/**
 * accept、周报导出与 qualify 共用的「库里的筛查结果是否仍拦交付」。(q) 的根因是 qualify 自己另算一套：
 * live 无命中时队列不 hold，accept 却按库里的命中硬拦，lead 卡在 recommended 却永远 accept 不了。
 */
describe('storedScreeningBlocks', () => {
  it.each([
    ['open', true],
    ['confirmed_true_hit', true],
    ['cleared_false_positive', false],
  ])('potential_match + %s → %s', (reviewState, blocks) => {
    expect(storedScreeningBlocks({ status: 'potential_match', reviewState })).toBe(blocks);
  });

  it('没有记录、或记录不是 potential_match → 不拦', () => {
    expect(storedScreeningBlocks(null)).toBe(false);
    expect(storedScreeningBlocks(undefined)).toBe(false);
    expect(storedScreeningBlocks({ status: 'clear', reviewState: 'open' })).toBe(false);
  });
});

describe('SanctionsScreeningService.listFreshness（ch08 §3.1.12）', () => {
  it('reads ENABLED sources only and evaluates freshness against env thresholds', async () => {
    const findMany = vi.fn(async () => [
      {
        key: 'ofac_sdn',
        lastRefreshedAt: new Date('2026-11-06T12:00:00.000Z'),
        lastFetchStatus: 'DONE',
      },
    ]);
    const service = new SanctionsScreeningService({
      sanctionsSource: { findMany },
    } as never);

    const result = await service.listFreshness(new Date('2026-11-09T12:00:00.000Z'));

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'ENABLED' } }),
    );
    expect(result).toMatchObject({
      active: true,
      ageDays: 3,
      stale: false,
      blocked: false,
      reason: 'fresh',
    });
  });

  it('is inactive when no source is ENABLED (gate not in force)', async () => {
    const service = new SanctionsScreeningService({
      sanctionsSource: { findMany: vi.fn(async () => []) },
    } as never);

    await expect(service.listFreshness()).resolves.toMatchObject({
      active: false,
      stale: false,
      blocked: false,
    });
  });
});
