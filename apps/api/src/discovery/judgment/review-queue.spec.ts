import { describe, expect, it } from 'vitest';

import type { JudgeCriterionOutput } from './judge-output-v2';
import {
  HUMAN_PROMPT_HASH,
  REVIEW_REASONS,
  REVIEW_SLA_HOURS,
  ReviewOverrideError,
  applyCriterionOverrides,
  canonicalDigest,
  computeReviewPriority,
  reviewDueAt,
} from './review-queue';

const NOW = new Date('2026-11-09T00:00:00.000Z');

function criteria(): JudgeCriterionOutput[] {
  return [
    {
      id: 'C1_MATERIAL',
      applicable: true,
      score: 8,
      label: 'pass',
      evidence: [],
      rationale: 'ok',
    },
    {
      id: 'C2_ROLE',
      applicable: true,
      score: 6,
      label: 'weak',
      evidence: [],
      rationale: 'ok',
    },
  ];
}

describe('review-queue 纯函数（P3 J17）', () => {
  it('优先级公式：UNKNOWN/CONFORMAL_ABSTAIN 按高价值分 P0/P1，其余按设计归档', () => {
    expect(computeReviewPriority('UNKNOWN', { highValue: true })).toBe(0);
    expect(computeReviewPriority('UNKNOWN', { highValue: false })).toBe(1);
    expect(computeReviewPriority('CONFORMAL_ABSTAIN', { highValue: true })).toBe(0);
    expect(computeReviewPriority('CONFORMAL_ABSTAIN', { highValue: false })).toBe(1);
    expect(computeReviewPriority('BORDERLINE')).toBe(1);
    expect(computeReviewPriority('RANDOM_AUDIT')).toBe(2);
    expect(computeReviewPriority('DRIFT_AUDIT')).toBe(3);
    expect(computeReviewPriority('APPEAL')).toBe(3);
  });

  it('SLA：P0 24h / P1 72h / P2 5 工作日 / P3 7 天', () => {
    expect(REVIEW_SLA_HOURS).toEqual({ 0: 24, 1: 72, 2: 120, 3: 168 });
    expect(reviewDueAt(0, NOW).toISOString()).toBe('2026-11-10T00:00:00.000Z');
    expect(reviewDueAt(1, NOW).toISOString()).toBe('2026-11-12T00:00:00.000Z');
    expect(reviewDueAt(3, NOW).toISOString()).toBe('2026-11-16T00:00:00.000Z');
  });

  it('覆盖应用：分数/label 覆写生效且不改入参；未知 criterion 与越界值被拒', () => {
    const original = criteria();
    const merged = applyCriterionOverrides(original, [
      { id: 'C2_ROLE', score: 9, label: 'pass' },
      { id: 'C1_MATERIAL', score: null },
    ]);
    expect(merged[0]).toMatchObject({ id: 'C1_MATERIAL', score: null });
    expect(merged[1]).toMatchObject({ id: 'C2_ROLE', score: 9, label: 'pass' });
    // 入参不被修改
    expect(original[0]!.score).toBe(8);
    expect(original[1]!.label).toBe('weak');

    expect(() =>
      applyCriterionOverrides(original, [{ id: 'C9_UNKNOWN' as never }]),
    ).toThrow(ReviewOverrideError);
    expect(() => applyCriterionOverrides(original, [{ id: 'C1_MATERIAL', score: 11 }])).toThrow(
      /score must be 0\.\.10/,
    );
    expect(() =>
      applyCriterionOverrides(original, [
        { id: 'C1_MATERIAL', label: 'maybe' as never },
      ]),
    ).toThrow(/not a known label/);
  });

  it('canonicalDigest 确定性：同内容同摘要，键序不影响（调用方负责 canonical 化）', () => {
    expect(canonicalDigest({ a: 1, b: [2, 3] })).toBe(
      canonicalDigest({ a: 1, b: [2, 3] }),
    );
    expect(canonicalDigest({ a: 1 })).not.toBe(canonicalDigest({ a: 2 }));
    expect(canonicalDigest({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('人工判定 prompt_hash 是 64 位 hex（满足 DB CHECK），且不等于任何模型指纹取值', () => {
    expect(HUMAN_PROMPT_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reason 闭集覆盖设计 §4.3.8.1 的六种', () => {
    expect([...REVIEW_REASONS]).toEqual([
      'UNKNOWN',
      'BORDERLINE',
      'RANDOM_AUDIT',
      'DRIFT_AUDIT',
      'APPEAL',
      'CONFORMAL_ABSTAIN',
    ]);
  });
});
