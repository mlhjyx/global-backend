import { describe, expect, it } from 'vitest';

import {
  bootstrapPercentileCI,
  cohenKappa,
  confusionMatrix,
  evaluateCalibration,
  roganGladen,
  wilsonInterval,
  type LabeledVerdict,
} from './calibration';

function rows(
  spec: Array<[LabeledVerdict['actual'], LabeledVerdict['predicted'], number]>,
): LabeledVerdict[] {
  const out: LabeledVerdict[] = [];
  for (const [actual, predicted, count] of spec) {
    for (let i = 0; i < count; i += 1) out.push({ actual, predicted });
  }
  return out;
}

describe('校准数学（P3 J14）', () => {
  it('混淆矩阵：UNKNOWN 计入「未自动通过」', () => {
    const matrix = confusionMatrix(
      rows([
        ['FIT', 'FIT', 30],
        ['FIT', 'UNKNOWN', 10],
        ['NOT_FIT', 'FIT', 5],
        ['NOT_FIT', 'NOT_FIT', 55],
      ]),
    );
    expect(matrix).toEqual({ tp: 30, fn: 10, fp: 5, tn: 55 });
  });

  it('Wilson 95% CI：73/100 落在已知区间，n=0 返回 [0,1]', () => {
    const [lo, hi] = wilsonInterval(73, 100);
    expect(lo).toBeCloseTo(0.635, 2);
    expect(hi).toBeCloseTo(0.808, 2);
    expect(wilsonInterval(0, 0)).toEqual([0, 1]);
  });

  it("Cohen's kappa：完全一致 =1；经典 2×2 例子 =0.4", () => {
    expect(cohenKappa({ tp: 10, fp: 0, tn: 10, fn: 0 })).toBe(1);
    expect(cohenKappa({ tp: 20, fp: 5, tn: 15, fn: 10 })).toBeCloseTo(0.4, 10);
  });

  it('Rogan–Gladen：设计 §4.3.6.3 的两个演算例子逐位对上', () => {
    const first = roganGladen(0.4, 0.9, 0.9);
    expect(first.prevalence!).toBeCloseTo(0.375, 10);
    expect(first.ppv!).toBeCloseTo(0.84375, 10);

    const wider = roganGladen(0.4, 0.9, 0.8);
    expect(wider.prevalence!).toBeCloseTo(2 / 7, 10);
    expect(wider.ppv!).toBeCloseTo(0.642857, 5);
  });

  it('Rogan–Gladen 的失败边界：分类器不优于随机（TPR+TNR≤1）或校正越界 → null', () => {
    expect(roganGladen(0.4, 0.5, 0.5)).toEqual({ prevalence: null, ppv: null });
    const outOfRange = roganGladen(0.02, 0.95, 0.95);
    expect(outOfRange.prevalence).toBeLessThan(0);
    expect(outOfRange.ppv).toBeNull();
  });

  it('evaluateCalibration：比率与 CI 齐全，FNR = 1−TPR', () => {
    const result = evaluateCalibration(
      rows([
        ['FIT', 'FIT', 40],
        ['FIT', 'NOT_FIT', 10],
        ['NOT_FIT', 'FIT', 6],
        ['NOT_FIT', 'NOT_FIT', 44],
      ]),
    );
    expect(result.matrix).toEqual({ tp: 40, fn: 10, fp: 6, tn: 44 });
    expect(result.tpr.value).toBeCloseTo(0.8, 10);
    expect(result.fnr.value).toBeCloseTo(0.2, 10);
    expect(result.tpr.ci[0]).toBeLessThan(result.tpr.value);
    expect(result.tpr.ci[1]).toBeGreaterThan(result.tpr.value);
  });

  it('bootstrap：同种子完全复算；完全一致的样本 kappa CI 收敛在 1', () => {
    const sample = rows([
      ['FIT', 'FIT', 20],
      ['NOT_FIT', 'NOT_FIT', 20],
    ]);
    const stat = (subset: readonly LabeledVerdict[]) =>
      cohenKappa(confusionMatrix(subset));
    const first = bootstrapPercentileCI(sample, stat, { b: 200, seed: 7 });
    const second = bootstrapPercentileCI(sample, stat, { b: 200, seed: 7 });
    expect(first).toEqual(second);
    expect(first[0]).toBeCloseTo(1, 10);
    expect(first[1]).toBeCloseTo(1, 10);
  });
});
