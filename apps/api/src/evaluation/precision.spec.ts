import { describe, expect, it } from "vitest";
import { precisionAtK } from "./precision";

describe("precision@k", () => {
  it("标准口径：命中数 / 实际评估深度", () => {
    const result = precisionAtK(
      ["POSITIVE", "NEGATIVE", "POSITIVE", "NEGATIVE", "POSITIVE"],
      3,
    );
    expect(result.evaluated).toBe(3);
    expect(result.hits).toBe(2);
    expect(result.negatives).toBe(1);
    expect(result.unlabeled).toBe(0);
    expect(result.precisionAtK).toBeCloseTo(2 / 3, 9);
    expect(result.precisionAtLabeledK).toBeCloseTo(2 / 3, 9);
  });

  it("候选不足 k 条时按实际条数计（不用 k 硬凑分母）", () => {
    const result = precisionAtK(["POSITIVE", "NEGATIVE"], 10);
    expect(result.evaluated).toBe(2);
    expect(result.precisionAtK).toBe(0.5);
  });

  it("未标注候选：计入分母记为非命中，另单列 precisionAtLabeledK", () => {
    const result = precisionAtK(["POSITIVE", null, null, "NEGATIVE"], 4);
    expect(result.hits).toBe(1);
    expect(result.negatives).toBe(1);
    expect(result.unlabeled).toBe(2);
    expect(result.precisionAtK).toBe(0.25);
    expect(result.precisionAtLabeledK).toBe(0.5);
  });

  it("全部未标注：precisionAtK=0，precisionAtLabeledK=null（不写 0 冒充）", () => {
    const result = precisionAtK([null, null], 2);
    expect(result.precisionAtK).toBe(0);
    expect(result.precisionAtLabeledK).toBeNull();
  });

  it("没有候选：两个 precision 均为 null", () => {
    const result = precisionAtK([], 10);
    expect(result.evaluated).toBe(0);
    expect(result.precisionAtK).toBeNull();
    expect(result.precisionAtLabeledK).toBeNull();
  });

  it("k 只截断前 k 条，之后的正例不计入", () => {
    const result = precisionAtK(["NEGATIVE", "POSITIVE"], 1);
    expect(result.evaluated).toBe(1);
    expect(result.hits).toBe(0);
    expect(result.precisionAtK).toBe(0);
  });

  it("k 必须是正整数", () => {
    expect(() => precisionAtK([], 0)).toThrow(/positive integer/);
    expect(() => precisionAtK([], 2.5)).toThrow(/positive integer/);
  });
});
