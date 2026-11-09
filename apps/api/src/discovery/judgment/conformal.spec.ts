import { describe, expect, it } from 'vitest';

import {
  clopperPearsonUpper,
  conformalAbstain,
  conformalScore,
  fitConformalThreshold,
  type ConformalSample,
} from './conformal';

describe('conformal 数学（P3 J15）', () => {
  it('自洽分数：k=3 时 s ∈ {0, 1/3, 2/3, 1}', () => {
    expect(conformalScore(3, 3)).toBe(0);
    expect(conformalScore(2, 3)).toBeCloseTo(1 / 3, 10);
    expect(conformalScore(1, 3)).toBeCloseTo(2 / 3, 10);
    expect(conformalScore(0, 3)).toBe(1);
    expect(() => conformalScore(4, 3)).toThrow(/fitVotes/);
    expect(() => conformalScore(1, 0)).toThrow(/k must be/);
  });

  it('Clopper–Pearson 上界：0 错误时闭式 1−δ^{1/n}，n=59 首次 ≤5%', () => {
    const upper = (n: number) => clopperPearsonUpper(0, n, 0.05);
    expect(upper(59)).toBeLessThanOrEqual(0.05);
    expect(upper(58)).toBeGreaterThan(0.05);
    expect(upper(300)).toBeCloseTo(1 - Math.pow(0.05, 1 / 300), 12);
    expect(upper(1)).toBeCloseTo(0.95, 2);
  });

  it('Clopper–Pearson 上界：E=1,n=100 的 95% 单侧上界 ≈ 0.0466；E=n 时为 1', () => {
    expect(clopperPearsonUpper(1, 100, 0.05)).toBeCloseTo(0.0466, 3);
    expect(clopperPearsonUpper(100, 100, 0.05)).toBe(1);
  });

  it('上界随错误数单调不减', () => {
    const values = [0, 1, 2, 5, 10, 20].map((errors) =>
      clopperPearsonUpper(errors, 100, 0.05),
    );
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
    }
  });

  it('阈值拟合：300 例全 FIT 且 s=0 → τ=0，CP 上界约 1%', () => {
    const samples: ConformalSample[] = Array.from({ length: 300 }, () => ({
      isFit: true,
      score: 0,
    }));
    const result = fitConformalThreshold(samples);
    expect(result.threshold).toBe(0);
    expect(result.accepted).toBe(300);
    expect(result.upper).toBeCloseTo(1 - Math.pow(0.05, 1 / 300), 6);
  });

  it('阈值拟合：把低分 NOT_FIT 排除在安全接受集外（1 错 + 99 对 → τ=1/3）', () => {
    const samples: ConformalSample[] = [
      { isFit: false, score: 0 },
      ...Array.from({ length: 99 }, () => ({ isFit: true, score: 1 / 3 })),
    ];
    const result = fitConformalThreshold(samples);
    expect(result.threshold).toBeCloseTo(1 / 3, 10);
    expect(result.accepted).toBe(100);
    expect(result.acceptedErrors).toBe(1);
    expect(result.upper!).toBeLessThanOrEqual(0.05);
  });

  it('样本不足时全部弃权（10 例 1 错 → 无安全阈值）', () => {
    const samples: ConformalSample[] = [
      { isFit: false, score: 0 },
      ...Array.from({ length: 9 }, () => ({ isFit: true, score: 0 })),
    ];
    expect(fitConformalThreshold(samples).threshold).toBeNull();
    expect(fitConformalThreshold([]).threshold).toBeNull();
  });

  it('弃权判定：无阈值恒弃权；s > τ 弃权、s ≤ τ 接受', () => {
    expect(conformalAbstain(0, null)).toBe(true);
    expect(conformalAbstain(0, 0)).toBe(false);
    expect(conformalAbstain(1 / 3, 0)).toBe(true);
    expect(conformalAbstain(1 / 3, 1 / 3)).toBe(false);
  });
});
