import { describe, expect, it } from 'vitest';
import { reconcileReviewState, screenMatchKey, matchesFromJson } from './sanctions-screening.service';

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
