import { describe, expect, it } from 'vitest';

import {
  REJUDGE_ESTIMATED_COST_MICROS_PER_COMPANY,
  RejudgePlanError,
  orderRejudgeCandidates,
  planRejudgeBatches,
  type RejudgeCandidate,
} from './rejudge-plan';

function candidate(
  id: string,
  overrides: Partial<RejudgeCandidate> = {},
): RejudgeCandidate {
  return {
    canonicalCompanyId: id,
    companyName: `Company ${id}`,
    domain: `${id}.example`,
    icpId: 'icp-1',
    ...overrides,
  };
}

describe('rejudge-plan 批次规划（P3 J21）', () => {
  it('有域名优先，其余按名称/ID 稳定排序', () => {
    const ordered = orderRejudgeCandidates([
      candidate('3', { domain: null, companyName: 'Alpha' }),
      candidate('2', { domain: 'b.example', companyName: 'Zeta' }),
      candidate('1', { domain: 'a.example', companyName: 'Beta' }),
    ]);
    expect(ordered.map((c) => c.canonicalCompanyId)).toEqual(['1', '2', '3']);
  });

  it('批次切分与成本估算（每批 ≤ batchSize，估算 = 家数 × 9900 micros）', () => {
    const plan = planRejudgeBatches(
      Array.from({ length: 7 }, (_, index) => candidate(String(index))),
      { batchSize: 3, costCapMicros: 1_000_000n },
    );
    expect(plan.batches.map((b) => b.candidates.length)).toEqual([3, 3, 1]);
    expect(plan.estimatedCostMicros).toBe(
      BigInt(7) * REJUDGE_ESTIMATED_COST_MICROS_PER_COMPANY,
    );
    expect(plan.batches[0]!.estimatedCostMicros).toBe(
      BigInt(3) * REJUDGE_ESTIMATED_COST_MICROS_PER_COMPANY,
    );
    expect(plan.skipped).toBe(0);
  });

  it('超帽拒绝规划（不静默截断），调低 maxCompanies 后通过', () => {
    const candidates = Array.from({ length: 10 }, (_, index) => candidate(String(index)));
    expect(() =>
      planRejudgeBatches(candidates, { costCapMicros: 50_000n }),
    ).toThrow(RejudgePlanError);
    const plan = planRejudgeBatches(candidates, {
      costCapMicros: 50_000n,
      maxCompanies: 5,
    });
    expect(plan.totalCandidates).toBe(5);
    expect(plan.skipped).toBe(5);
  });

  it('非法参数被拒：batchSize 越界、cap 非正', () => {
    expect(() =>
      planRejudgeBatches([candidate('1')], { batchSize: 0, costCapMicros: 1_000n }),
    ).toThrow(/batchSize/);
    expect(() =>
      planRejudgeBatches([candidate('1')], { batchSize: 500, costCapMicros: 1_000n }),
    ).toThrow(/batchSize/);
    expect(() =>
      planRejudgeBatches([candidate('1')], { costCapMicros: 0n }),
    ).toThrow(/costCapMicros/);
  });

  it('确定性：同输入两次规划结果相同', () => {
    const candidates = [candidate('b'), candidate('a', { domain: null })];
    const first = planRejudgeBatches(candidates, { costCapMicros: 1_000_000n });
    const second = planRejudgeBatches(candidates, { costCapMicros: 1_000_000n });
    expect(first).toEqual(second);
  });
});
