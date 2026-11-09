import { describe, expect, it } from 'vitest';

import {
  GOLDEN_LABEL_SPLITS,
  GoldenLabelError,
  planPromotion,
  planRetirement,
  promotionDedupeKey,
  type GoldenLabelRow,
} from './golden-label';

const T0 = new Date('2026-11-01T00:00:00.000Z');

function row(id: string, overrides: Partial<GoldenLabelRow> = {}): GoldenLabelRow {
  return {
    id,
    workspaceId: 'ws-1',
    canonicalCompanyId: 'company-1',
    icpId: 'icp-1',
    label: 'FIT',
    rubricVersion: 'fit-v2',
    inputDigest: `digest-${id}`,
    split: 'candidate',
    labeledAt: new Date(T0.getTime() + Number(id.replace(/\D/gu, '') || 0) * 1000),
    ...overrides,
  };
}

describe('golden-label 晋升/退役规划（P3 J18）', () => {
  it('dedupe key：七个维度决定唯一性（含 split）', () => {
    const base = row('1');
    const key = promotionDedupeKey(base);
    expect(key).toBe(
      'ws-1|company-1|icp-1|digest-1|fit-v2|FIT|candidate',
    );
    expect(promotionDedupeKey({ ...base, split: 'test' })).not.toBe(key);
    expect(promotionDedupeKey({ ...base, label: 'NOT_FIT' })).not.toBe(key);
  });

  it('晋升按 labeledAt 升序取最早一批，limit 生效', () => {
    const plan = planPromotion([row('3'), row('1'), row('2')], new Set(), {
      to: 'test',
      limit: 2,
    });
    expect(plan.selected.map((r) => r.id)).toEqual(['1', '2']);
    expect(plan.skipped).toEqual([{ id: '3', reason: 'limit-reached' }]);
  });

  it('已在目标 split 出现的跳过（幂等），--ids 白名单只取指定行', () => {
    const redundant = row('2');
    const existing = new Set([
      promotionDedupeKey({ ...redundant, split: 'test' }),
    ]);
    const plan = planPromotion([row('1'), redundant, row('3')], existing, {
      to: 'test',
      ids: ['2', '3'],
    });
    expect(plan.selected.map((r) => r.id)).toEqual(['3']);
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        { id: '1', reason: 'not-requested' },
        { id: '2', reason: 'already-in-target' },
      ]),
    );
  });

  it('非 candidate 行不会被晋升；目标是 candidate 时抛错', () => {
    const plan = planPromotion([row('1', { split: 'test' })], new Set(), {
      to: 'calib',
    });
    expect(plan.selected).toEqual([]);
    expect(() =>
      planPromotion([row('1')], new Set(), { to: 'candidate' as never }),
    ).toThrow(GoldenLabelError);
  });

  it('退役保留最新 keep 行、其余进 retired；split 闭集完整', () => {
    const rows = [row('1'), row('2'), row('3'), row('4')];
    const plan = planRetirement(rows, { split: 'test', keep: 2 });
    expect(plan.keep.map((r) => r.id)).toEqual(['4', '3']);
    expect(plan.retire.map((r) => r.id)).toEqual(['2', '1']);
    expect([...GOLDEN_LABEL_SPLITS]).toEqual(['calib', 'test', 'candidate', 'retired']);
  });
});
