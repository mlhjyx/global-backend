import { describe, expect, it } from "vitest";
import { chapmanEstimate } from "./chapman";

describe("Chapman 双源捕获-再捕获估计", () => {
  it("已知数值：n1=80, n2=70, m=30 → N̂=(81·71)/31−1", () => {
    const result = chapmanEstimate({ n1: 80, n2: 70, overlap: 30 });
    expect(result.estimable).toBe(true);
    if (!result.estimable) return;
    const expected = (81 * 71) / 31 - 1;
    expect(result.estimate).toBeCloseTo(expected, 9);
    expect(result.observedUnion).toBe(120);
    // 方差公式逐项复算
    const variance = (81 * 71 * 50 * 40) / (31 * 31 * 32);
    expect(result.variance).toBeCloseTo(variance, 9);
    const halfWidth = 1.96 * Math.sqrt(variance);
    expect(result.ciHigh).toBeCloseTo(expected + halfWidth, 9);
    // 下界不低于观测并集
    expect(result.ciLow).toBeGreaterThanOrEqual(result.observedUnion);
    expect(result.ciLow).toBeLessThanOrEqual(result.estimate);
    expect(result.warning).toBeNull();
    // 召回 = 观测并集 / N̂
    expect(result.recallEstimate).toBeCloseTo(120 / expected, 9);
    expect(result.recallEstimate).toBeLessThanOrEqual(1);
  });

  it("零重叠（m=0）：公式有定义、照常给点估计，但标记 ZERO_OVERLAP", () => {
    const result = chapmanEstimate({ n1: 10, n2: 8, overlap: 0 });
    expect(result.estimable).toBe(true);
    if (!result.estimable) return;
    // (11·9)/1 − 1 = 98
    expect(result.estimate).toBeCloseTo(98, 9);
    expect(result.warning).toBe("ZERO_OVERLAP");
    expect(result.ciLow).toBeGreaterThanOrEqual(result.observedUnion);
    expect(result.ciHigh).toBeGreaterThan(result.estimate);
  });

  it("一边为空（n1=0）：不可估计，estimate/CI 为 null 且说明原因", () => {
    const result = chapmanEstimate({ n1: 0, n2: 25, overlap: 0 });
    expect(result.estimable).toBe(false);
    if (result.estimable) return;
    expect(result.reason).toBe("EMPTY_SOURCE");
    expect(result.estimate).toBeNull();
    expect(result.ciLow).toBeNull();
    expect(result.ciHigh).toBeNull();
    expect(result.observedUnion).toBe(25);
  });

  it("两边都空：同样不可估计（不以 0 冒充）", () => {
    const result = chapmanEstimate({ n1: 0, n2: 0, overlap: 0 });
    expect(result.estimable).toBe(false);
    expect(result.observedUnion).toBe(0);
  });

  it("完全重叠（m=min(n1,n2)）：估计退化为并集，区间不越界", () => {
    const result = chapmanEstimate({ n1: 12, n2: 20, overlap: 12 });
    expect(result.estimable).toBe(true);
    if (!result.estimable) return;
    expect(result.estimate).toBeGreaterThanOrEqual(20);
    expect(result.ciLow).toBeGreaterThanOrEqual(20);
    expect(result.ciLow).toBeLessThanOrEqual(result.estimate);
  });

  it("输入不合法直接拒绝：负数、非整数、重叠大于较小样本", () => {
    expect(() => chapmanEstimate({ n1: -1, n2: 5, overlap: 0 })).toThrow(/non-negative integer/);
    expect(() => chapmanEstimate({ n1: 1.5, n2: 5, overlap: 1 })).toThrow(/non-negative integer/);
    expect(() => chapmanEstimate({ n1: 3, n2: 5, overlap: 4 })).toThrow(/cannot exceed/);
  });

  it("CI 下界钳制在观测并集：极小样本下区间仍然有序", () => {
    const result = chapmanEstimate({ n1: 1, n2: 1, overlap: 1 });
    expect(result.estimable).toBe(true);
    if (!result.estimable) return;
    expect(result.observedUnion).toBe(1);
    expect(result.ciLow).toBe(1);
    expect(result.estimate).toBe(1);
    expect(result.ciHigh).toBeGreaterThanOrEqual(result.estimate);
  });
});
