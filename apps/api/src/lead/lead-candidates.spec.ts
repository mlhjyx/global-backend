import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { LeadService } from './lead.service';
import type { DataRightsService } from '../compliance/data-rights.service';
import type { SanctionsScreeningService } from '../sanctions/sanctions-screening.service';

const CTX = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  roles: ['MEMBER'],
};
const ICP = '20000000-0000-4000-8000-000000000002';
const COMPANY_A = '30000000-0000-4000-8000-00000000000a';
const COMPANY_B = '30000000-0000-4000-8000-00000000000b';
const LEAD_A = '40000000-0000-4000-8000-00000000000a';
const LEAD_B = '40000000-0000-4000-8000-00000000000b';

function lead(over: Record<string, unknown> = {}) {
  return {
    id: LEAD_A,
    workspaceId: CTX.workspaceId,
    icpId: ICP,
    canonicalCompanyId: COMPANY_A,
    status: 'REVIEW',
    queue: 'recommended',
    fitVerdict: 'match',
    totalScore: 0.72,
    scoredAt: new Date('2026-11-08T01:00:00.000Z'),
    scoreDetail: { ruleVersion: 'additive-6dim-v3', candidateBatchRef: 'qualify:run-1:0' },
    ...over,
  };
}

function fixture(rows: Array<Record<string, unknown>>) {
  const leadFindMany = vi.fn(async (_args: unknown) => rows);
  const companyFindMany = vi.fn(async () => [
    {
      id: COMPANY_A,
      name: 'Pumpen Handel GmbH',
      domain: 'pumpen-handel.example',
      country: 'DE',
      industry: 'industrial pumps',
      employeeCount: 42,
    },
  ]);
  const tx = {
    lead: { findMany: leadFindMany },
    canonicalCompany: { findMany: companyFindMany },
  };
  const prisma = {
    withWorkspace: vi.fn(async (_ws: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const service = new LeadService(
    prisma as unknown as PrismaService,
    {} as DataRightsService,
    {} as SanctionsScreeningService,
  );
  return { service, leadFindMany, companyFindMany };
}

describe('LeadService.listCandidates（M2 步 10：机器候选只读视图）', () => {
  it('runId → 按 score_detail.candidateBatchRef 前缀过滤，返回候选投影（含 company 摘要与批次引用）', async () => {
    const f = fixture([lead()]);
    const page = await f.service.listCandidates(CTX as never, { runId: 'run-1', limit: 50 });

    expect(f.leadFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scoreDetail: { path: ['candidateBatchRef'], string_starts_with: 'qualify:run-1:' },
        }),
      }),
    );
    expect(page.data).toEqual([
      {
        lead_id: LEAD_A,
        icp_id: ICP,
        canonical_company_id: COMPANY_A,
        company: expect.objectContaining({ id: COMPANY_A, name: 'Pumpen Handel GmbH' }),
        queue: 'recommended',
        fit_verdict: 'match',
        total_score: 0.72,
        scored_at: '2026-11-08T01:00:00.000Z',
        status: 'REVIEW',
        candidate_batch_ref: 'qualify:run-1:0',
      },
    ]);
    expect(page.hasMore).toBe(false);
  });

  it('不传 runId 时不加批次过滤（可按 icpId/queue 浏览全部候选）', async () => {
    const f = fixture([lead()]);
    await f.service.listCandidates(CTX as never, { icpId: ICP, queue: 'needs_review', limit: 20 });

    const where = f.leadFindMany.mock.calls[0]![0].where as Record<string, unknown>;
    expect(where.icpId).toBe(ICP);
    expect(where.queue).toBe('needs_review');
    expect(where.scoreDetail).toBeUndefined();
  });

  it('未评分/旧数据（scoreDetail 为空）→ candidate_batch_ref null；公司摘要缺失 → company null', async () => {
    const f = fixture([
      lead({ id: LEAD_B, canonicalCompanyId: COMPANY_B, status: 'DISCOVERED', scoreDetail: null, scoredAt: null }),
    ]);
    const page = await f.service.listCandidates(CTX as never, { limit: 20 });
    expect(page.data[0]).toMatchObject({
      lead_id: LEAD_B,
      company: null,
      scored_at: null,
      candidate_batch_ref: null,
    });
  });

  it('游标分页：limit+1 探测 hasMore 并给出 nextCursor', async () => {
    const f = fixture([lead(), lead({ id: LEAD_B })]);
    const page = await f.service.listCandidates(CTX as never, { limit: 1 });
    expect(page.data).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(LEAD_A);
  });
});
