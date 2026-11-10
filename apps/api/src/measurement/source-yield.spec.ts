import { describe, expect, it } from "vitest";
import { shapeSourceYieldBucket } from "./source-yield";
import { reconcileSides } from "./billing-reconciliation";

describe("源边际产出：桶派生值", () => {
  it("每新增合格公司的美元成本 = microusd / 1e6 / 新增合格数", () => {
    const bucket = shapeSourceYieldBucket({
      bucket: "2026-11-09",
      providerKey: "public_web",
      recordCount: 1200,
      newQualifiedCount: 8,
      costMicrousd: 2_400_000, // $2.40
    });
    expect(bucket.costPerNewQualifiedUsd).toBeCloseTo(0.3, 6);
  });

  it("零产出：成本/产出为 null，不写 0 冒充", () => {
    const bucket = shapeSourceYieldBucket({
      bucket: "2026-11-09",
      providerKey: "directory",
      recordCount: 0,
      newQualifiedCount: 0,
      costMicrousd: 150_000,
    });
    expect(bucket.costPerNewQualifiedUsd).toBeNull();
    expect(bucket.costMicrousd).toBe(150_000);
  });

  it("结果四舍五入到 6 位小数（与 microusd 精度对齐）", () => {
    const bucket = shapeSourceYieldBucket({
      bucket: "2026-11-09",
      providerKey: "ted",
      recordCount: 10,
      newQualifiedCount: 3,
      costMicrousd: 1,
    });
    // 1 microusd / 3 ≈ 0.000000333… → 0.000000（6 位）
    expect(bucket.costPerNewQualifiedUsd).toBe(0);
  });
});

describe("三方对账：差额口径", () => {
  it("delta = usage − settled（正 = 记账多于结算，负 = 反之）", () => {
    expect(reconcileSides({ usageMicrousd: 5_000_000, settledMicrousd: 4_500_000 })).toEqual({
      deltaMicrousd: 500_000,
    });
    expect(reconcileSides({ usageMicrousd: 0, settledMicrousd: 120 })).toEqual({
      deltaMicrousd: -120,
    });
  });

  it("两侧相等时差额为 0", () => {
    expect(reconcileSides({ usageMicrousd: 42, settledMicrousd: 42 }).deltaMicrousd).toBe(0);
  });
});
