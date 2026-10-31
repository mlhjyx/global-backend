import { describe, expect, it, vi } from 'vitest';
import { LeadService } from './lead.service';

/**
 * GET /leads 与 GET /icps/:id/lead-queues 必须能区分「fit 门预置的队列」与「已评分的队列」：
 * 每行带 scored（total_score 非空）与 queueBasis；队列汇总带 scored 与按依据的计数。
 */

const ctx = { workspaceId: 'ws-1', userId: 'user-1', roles: [] } as never;

function serviceWithTx(tx: unknown): LeadService {
  return new LeadService(
    { withWorkspace: async <T>(_workspaceId: string, callback: (client: unknown) => Promise<T>) => callback(tx) } as never,
    {} as never,
    {} as never,
  );
}

describe('LeadService.list — scored / queueBasis', () => {
  it('每行按 total_score 标 scored、按状态与 reject 裁决推导 queueBasis，探针用的 decisions 不进响应', async () => {
    const leads = [
      { id: 'preset', canonicalCompanyId: 'c1', status: 'DISCOVERED', queue: 'needs_review', totalScore: null, decisions: [] },
      { id: 'scored', canonicalCompanyId: 'c2', status: 'REVIEW', queue: 'recommended', totalScore: 0.7, decisions: [] },
      { id: 'accepted', canonicalCompanyId: 'c3', status: 'QUALIFIED', queue: 'recommended', totalScore: null, decisions: [] },
      {
        id: 'human-rejected',
        canonicalCompanyId: 'c4',
        status: 'REJECTED',
        queue: 'rejected',
        totalScore: null,
        decisions: [{ id: 'decision-1' }],
      },
      { id: 'score-rejected', canonicalCompanyId: 'c5', status: 'REJECTED', queue: 'rejected', totalScore: 0.1, decisions: [] },
    ];
    const tx = {
      lead: { findMany: vi.fn(async () => leads) },
      canonicalCompany: { findMany: vi.fn(async () => []) },
      fieldEvidence: { findMany: vi.fn(async () => []) },
    };

    const page = await serviceWithTx(tx).list(ctx, { limit: 10 });

    expect(page.data.map((row) => [row.id, row.scored, row.queueBasis])).toEqual([
      ['preset', false, 'fit_gate_preset'],
      ['scored', true, 'score'],
      ['accepted', false, 'human_accept'],
      ['human-rejected', false, 'human_reject'],
      ['score-rejected', true, 'score'],
    ]);
    for (const row of page.data) {
      expect(row).not.toHaveProperty('decisions');
      expect(row).toHaveProperty('company', null);
    }
    // 只取一条 reject 裁决作探针（有界），不把裁决历史拉进列表。
    expect(tx.lead.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: { decisions: { where: { action: 'reject' }, select: { id: true }, take: 1 } },
      }),
    );
  });

  it('旧形状的行（无 decisions、无 status）仍能列出：按预置处理', async () => {
    const tx = {
      lead: { findMany: vi.fn(async () => [{ id: 'legacy', canonicalCompanyId: 'c1' }]) },
      canonicalCompany: { findMany: vi.fn(async () => []) },
      fieldEvidence: { findMany: vi.fn(async () => []) },
    };

    await expect(serviceWithTx(tx).list(ctx, { limit: 1 })).resolves.toMatchObject({
      data: [{ id: 'legacy', scored: false, queueBasis: 'fit_gate_preset' }],
    });
  });
});

describe('LeadService.queueSummary — scored / queueBasis', () => {
  it('一条按 (queue, status) 分组的计数 + 一条人工拒绝聚合 → 五队列、scored、四种依据', async () => {
    const groupBy = vi.fn(async () => [
      { queue: 'needs_review', status: 'DISCOVERED', _count: { _all: 150, totalScore: 0 } },
      { queue: 'rejected', status: 'DISCOVERED', _count: { _all: 29, totalScore: 0 } },
    ]);
    const aggregate = vi.fn(async () => ({ _count: { _all: 0, totalScore: 0 } }));
    const tx = { lead: { groupBy, aggregate } };

    await expect(serviceWithTx(tx).queueSummary(ctx, 'icp-1')).resolves.toEqual({
      recommended: 0,
      needs_review: 150,
      rejected: 29,
      suppressed: 0,
      sanctions_hold: 0,
      scored: false,
      queueBasis: { fit_gate_preset: 179, score: 0, human_accept: 0, human_reject: 0 },
    });
    expect(groupBy).toHaveBeenCalledWith({
      by: ['queue', 'status'],
      where: { icpId: 'icp-1' },
      _count: { _all: true, totalScore: true },
    });
    expect(aggregate).toHaveBeenCalledWith({
      where: { icpId: 'icp-1', status: 'REJECTED', decisions: { some: { action: 'reject' } } },
      _count: { _all: true, totalScore: true },
    });
  });

  it('人工拒绝的计数从 score / fit_gate_preset 里扣除', async () => {
    const tx = {
      lead: {
        groupBy: vi.fn(async () => [
          { queue: 'recommended', status: 'REVIEW', _count: { _all: 5, totalScore: 5 } },
          { queue: 'rejected', status: 'REJECTED', _count: { _all: 3, totalScore: 2 } },
        ]),
        aggregate: vi.fn(async () => ({ _count: { _all: 2, totalScore: 1 } })),
      },
    };

    await expect(serviceWithTx(tx).queueSummary(ctx, 'icp-1')).resolves.toEqual({
      recommended: 5,
      needs_review: 0,
      rejected: 3,
      suppressed: 0,
      sanctions_hold: 0,
      scored: false,
      queueBasis: { fit_gate_preset: 0, score: 6, human_accept: 0, human_reject: 2 },
    });
  });
});
