import { describe, expect, it } from 'vitest';
import { isLeadScored, leadQueueBasis, summarizeLeadQueues } from './lead-queue-basis';

/**
 * 队列依据（queue basis）：区分「fit 门预置的队列」与「评分/人工裁决得出的队列」。
 * 起因：xin 上 179 条 lead 六维分全 NULL，queue 只是 fit 阶段按 verdict 预置的值
 * （fit-judge.ts upsertLeadFit：mismatch→rejected、其余→needs_review），API 却无法区分。
 */

describe('isLeadScored', () => {
  it('为真当且仅当 total_score 非空（0 分也算已评分）', () => {
    expect(isLeadScored({ totalScore: 0 })).toBe(true);
    expect(isLeadScored({ totalScore: 0.55 })).toBe(true);
    expect(isLeadScored({ totalScore: null })).toBe(false);
    expect(isLeadScored({})).toBe(false);
  });
});

describe('leadQueueBasis', () => {
  it('fit_gate_preset：fit 门建行、评分从未跑过', () => {
    expect(leadQueueBasis({ status: 'DISCOVERED', totalScore: null }, false)).toBe('fit_gate_preset');
    expect(leadQueueBasis({ status: 'REJECTED', totalScore: null }, false)).toBe('fit_gate_preset');
  });

  it('score：评分阶段按六维总分（+ 制裁/禁联）算出的队列', () => {
    expect(leadQueueBasis({ status: 'REVIEW', totalScore: 0.4 }, false)).toBe('score');
    // 评分阶段自己也会写 status=REJECTED：没有 reject 裁决的 REJECTED 是评分结果。
    expect(leadQueueBasis({ status: 'REJECTED', totalScore: 0.1 }, false)).toBe('score');
    expect(leadQueueBasis({ status: 'SUPPRESSED', totalScore: 0 }, false)).toBe('score');
  });

  it('human_accept：QUALIFIED 只由 accept 裁决写入，重评分不覆盖', () => {
    expect(leadQueueBasis({ status: 'QUALIFIED', totalScore: null }, false)).toBe('human_accept');
    expect(leadQueueBasis({ status: 'QUALIFIED', totalScore: 0.9 }, false)).toBe('human_accept');
  });

  it('human_reject：REJECTED 且有 reject 裁决（评没评分都算）', () => {
    expect(leadQueueBasis({ status: 'REJECTED', totalScore: null }, true)).toBe('human_reject');
    expect(leadQueueBasis({ status: 'REJECTED', totalScore: 0.1 }, true)).toBe('human_reject');
  });

  it('reject 裁决已被后来的重评分改到别的队列 → 依据是评分', () => {
    expect(leadQueueBasis({ status: 'REVIEW', totalScore: 0.6 }, true)).toBe('score');
  });
});

describe('summarizeLeadQueues', () => {
  it('空 ICP：五队列全 0、scored=false、依据计数全 0', () => {
    expect(summarizeLeadQueues([], { _all: 0, totalScore: 0 })).toEqual({
      recommended: 0,
      needs_review: 0,
      rejected: 0,
      suppressed: 0,
      sanctions_hold: 0,
      scored: false,
      queueBasis: { fit_gate_preset: 0, score: 0, human_accept: 0, human_reject: 0 },
    });
  });

  it('xin 2026-10-14 的形态：179 条全是 fit 门预置，scored=false', () => {
    expect(
      summarizeLeadQueues(
        [
          { queue: 'needs_review', status: 'DISCOVERED', _count: { _all: 150, totalScore: 0 } },
          { queue: 'rejected', status: 'DISCOVERED', _count: { _all: 29, totalScore: 0 } },
        ],
        { _all: 0, totalScore: 0 },
      ),
    ).toEqual({
      recommended: 0,
      needs_review: 150,
      rejected: 29,
      suppressed: 0,
      sanctions_hold: 0,
      scored: false,
      queueBasis: { fit_gate_preset: 179, score: 0, human_accept: 0, human_reject: 0 },
    });
  });

  it('混合：人工裁决从评分/预置里扣除，四种依据之和等于总数', () => {
    const summary = summarizeLeadQueues(
      [
        { queue: 'recommended', status: 'REVIEW', _count: { _all: 10, totalScore: 10 } },
        { queue: 'needs_review', status: 'REVIEW', _count: { _all: 20, totalScore: 20 } },
        // 9 条 REJECTED 里 8 条有分；其中 4 条是人工拒绝（3 条有分、1 条无分）。
        { queue: 'rejected', status: 'REJECTED', _count: { _all: 9, totalScore: 8 } },
        // 4 条 accept，其中 1 条在评分前就被接受。
        { queue: 'recommended', status: 'QUALIFIED', _count: { _all: 4, totalScore: 3 } },
        { queue: 'sanctions_hold', status: 'REVIEW', _count: { _all: 2, totalScore: 2 } },
      ],
      { _all: 4, totalScore: 3 },
    );
    expect(summary).toEqual({
      recommended: 14,
      needs_review: 20,
      rejected: 9,
      suppressed: 0,
      sanctions_hold: 2,
      scored: false,
      queueBasis: { fit_gate_preset: 0, score: 37, human_accept: 4, human_reject: 4 },
    });
    const bases = Object.values(summary.queueBasis).reduce((sum, count) => sum + count, 0);
    expect(bases).toBe(45);
  });

  it('scored 只在每条 lead 都有分时为真', () => {
    expect(
      summarizeLeadQueues(
        [
          { queue: 'recommended', status: 'REVIEW', _count: { _all: 3, totalScore: 3 } },
          { queue: 'rejected', status: 'REJECTED', _count: { _all: 2, totalScore: 2 } },
        ],
        { _all: 0, totalScore: 0 },
      ),
    ).toMatchObject({ scored: true, queueBasis: { fit_gate_preset: 0, score: 5 } });
  });
});
