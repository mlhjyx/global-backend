import { describe, expect, it } from 'vitest';

import {
  EVAL_RECEIPT_SCHEMA_VERSION,
  EvalReceiptError,
  assertEvalReceipt,
  buildEvalReceipt,
} from './eval-receipt';

const HEX = 'a'.repeat(64);

function input(overrides: Partial<Parameters<typeof buildEvalReceipt>[0]> = {}) {
  return {
    datasetSha256: HEX,
    rubricVersion: 'fit-v2',
    promptHash: 'b'.repeat(64),
    modelResolved: 'deepseek-v4-pro',
    runAt: '2026-11-09T00:00:00.000Z',
    cases: { total: 300, passed: 300, failed: 0 },
    metrics: {
      kappa: { value: 0.72, n: 300, ci: [0.66, 0.78] as [number, number] },
      tpr: { value: 0.9, n: 200, ci: [0.85, 0.94] as [number, number] },
      tnr: { value: 0.88, n: 100, ci: [0.8, 0.93] as [number, number] },
    },
    thresholds: {},
    ...overrides,
  };
}

describe('eval-receipt/v1（P3 J19）', () => {
  it('构建回执：门限默认值生效，全达标 → passed=true', () => {
    const receipt = buildEvalReceipt(input());
    expect(receipt.schemaVersion).toBe(EVAL_RECEIPT_SCHEMA_VERSION);
    expect(receipt.gate.passed).toBe(true);
    expect(receipt.gate.thresholds).toEqual({ kappa: 0.6, tpr: 0.75, tnr: 0.75 });
    expect(() => assertEvalReceipt(receipt)).not.toThrow();
  });

  it('kappa 低于 0.6 或存在失败用例 → passed=false（发布门阻断）', () => {
    const lowKappa = buildEvalReceipt(
      input({
        metrics: {
          kappa: { value: 0.5, n: 300, ci: [0.44, 0.56] },
          tpr: { value: 0.9, n: 200, ci: [0.85, 0.94] },
          tnr: { value: 0.88, n: 100, ci: [0.8, 0.93] },
        },
      }),
    );
    expect(lowKappa.gate.passed).toBe(false);

    const withFailures = buildEvalReceipt(
      input({ cases: { total: 300, passed: 298, failed: 2 } }),
    );
    expect(withFailures.gate.passed).toBe(false);
  });

  it('自定义阈值覆盖默认（例如分层收紧 tnr）', () => {
    const receipt = buildEvalReceipt(input({ thresholds: { tnr: 0.95 } }));
    expect(receipt.gate.thresholds.tnr).toBe(0.95);
    expect(receipt.gate.passed).toBe(false);
  });

  it('结构校验 fail-closed：坏 hash、坏时间、cases 不一致、指标越界都抛错', () => {
    const base = buildEvalReceipt(input());
    expect(() =>
      assertEvalReceipt({ ...base, datasetSha256: 'xyz' }),
    ).toThrow(EvalReceiptError);
    expect(() =>
      assertEvalReceipt({ ...base, runAt: 'yesterday' }),
    ).toThrow(/ISO/);
    expect(() =>
      assertEvalReceipt({
        ...base,
        cases: { total: 10, passed: 5, failed: 4 },
      }),
    ).toThrow(/consistent/);
    expect(() =>
      assertEvalReceipt({
        ...base,
        metrics: { ...base.metrics, kappa: { value: 1.2, n: 3, ci: [0, 1] } },
      }),
    ).toThrow(/\[0,1\]/);
    expect(() =>
      assertEvalReceipt({ ...base, schemaVersion: 'eval-receipt/v0' }),
    ).toThrow(/schemaVersion/);
  });
});
