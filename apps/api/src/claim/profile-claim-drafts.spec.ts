import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  buildProfileClaimDraftSpecs,
  normalizeClaimDraftStatement,
  synthesizeProfileClaimDrafts,
} from './profile-claim-drafts';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const COMPANY_ID = '30000000-0000-4000-8000-000000000003';

describe('buildProfileClaimDraftSpecs（档案 → 草稿映射）', () => {
  it('主营产品 → capability、行业 → company_fact、目标市场 → market（顺序稳定）', () => {
    expect(
      buildProfileClaimDraftSpecs({
        industry: '汽车零部件',
        targetMarkets: ['DE', 'FR'],
        offeringNames: ['真空吸塑成型', 'CNC 加工件'],
      }),
    ).toEqual([
      { type: 'capability', statement: '主营产品/服务：真空吸塑成型' },
      { type: 'capability', statement: '主营产品/服务：CNC 加工件' },
      { type: 'company_fact', statement: '所属行业：汽车零部件' },
      { type: 'market', statement: '目标出口市场：DE、FR' },
    ]);
  });

  it('空档案不产生任何草稿', () => {
    expect(buildProfileClaimDraftSpecs({})).toEqual([]);
    expect(
      buildProfileClaimDraftSpecs({ industry: '   ', targetMarkets: [], offeringNames: ['  '] }),
    ).toEqual([]);
  });

  it('同批重复语句只留一条（归一化后比较）', () => {
    expect(
      buildProfileClaimDraftSpecs({ offeringNames: ['精密轴承', ' 精密轴承 ', '  精密轴承'] }),
    ).toEqual([{ type: 'capability', statement: '主营产品/服务：精密轴承' }]);
  });

  it('normalizeClaimDraftStatement 折叠空白并小写', () => {
    expect(normalizeClaimDraftStatement('  CNC   加工件 ')).toBe('cnc 加工件');
  });
});

interface FakeClaimRow {
  id: string;
  statement: string;
}

function fixture(options: { existing?: FakeClaimRow[]; sourceExists?: boolean } = {}) {
  const claimFindMany = vi.fn(async () => (options.existing ?? []).map((row) => ({ statement: row.statement })));
  const claimCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: `claim-${String(data.type)}-${String(data.statement)}`,
    ...data,
  }));
  const evidenceCreate = vi.fn(async () => ({ id: 'evidence-1' }));
  const sourcesFindFirst = vi.fn(async () => (options.sourceExists === false ? null : { id: 'source-1' }));
  const sourcesCreate = vi.fn(async () => ({ id: 'source-new' }));
  const tx = {
    claim: { findMany: claimFindMany, create: claimCreate },
    evidence: { create: evidenceCreate },
    knowledgeSource: { findFirst: sourcesFindFirst, create: sourcesCreate },
  };
  return {
    tx: tx as unknown as Prisma.TransactionClient,
    claimFindMany,
    claimCreate,
    evidenceCreate,
    sourcesFindFirst,
    sourcesCreate,
  };
}

describe('synthesizeProfileClaimDrafts（幂等补齐草稿）', () => {
  it('为缺失语句建 NEEDS_REVIEW 草稿并写注册引导证据（无 originKey/factKey）', async () => {
    const f = fixture();
    const result = await synthesizeProfileClaimDrafts(f.tx, {
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      specs: [{ type: 'capability', statement: '主营产品/服务：精密轴承' }],
    });

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);
    expect(f.claimCreate).toHaveBeenCalledWith({
      data: {
        workspaceId: WORKSPACE_ID,
        companyId: COMPANY_ID,
        sourceId: 'source-1',
        type: 'capability',
        statement: '主营产品/服务：精密轴承',
        status: 'NEEDS_REVIEW',
        confidence: 1,
      },
      select: { id: true },
    });
    expect(f.claimCreate.mock.calls[0]![0].data).not.toHaveProperty('originKey');
    expect(f.claimCreate.mock.calls[0]![0].data).not.toHaveProperty('factKey');
    expect(f.evidenceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        snippet: '注册引导填写',
        confidence: 1,
      }),
    });
  });

  it('既有同文事实（大小写/空白不同）跳过；REVOKED 不在去重集合内', async () => {
    const f = fixture({
      existing: [{ id: 'c1', statement: '主营产品/服务：cnc 加工件' }],
    });
    const result = await synthesizeProfileClaimDrafts(f.tx, {
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      specs: [
        { type: 'capability', statement: '主营产品/服务：CNC  加工件' },
        { type: 'company_fact', statement: '所属行业：汽车零部件' },
      ],
    });
    expect(f.claimFindMany).toHaveBeenCalledWith({
      where: { companyId: COMPANY_ID, status: { not: 'REVOKED' } },
      select: { statement: true },
    });
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
    expect(f.claimCreate).toHaveBeenCalledTimes(1);
  });

  it('全部已存在时不创建知识来源也不写任何行', async () => {
    const f = fixture({ existing: [{ id: 'c1', statement: '所属行业：汽车零部件' }] });
    const result = await synthesizeProfileClaimDrafts(f.tx, {
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      specs: [{ type: 'company_fact', statement: '所属行业：汽车零部件' }],
    });
    expect(result).toEqual({ created: 0, skipped: 1, createdClaimIds: [] });
    expect(f.sourcesFindFirst).not.toHaveBeenCalled();
    expect(f.sourcesCreate).not.toHaveBeenCalled();
    expect(f.claimCreate).not.toHaveBeenCalled();
  });

  it('知识来源不存在时新建 onboarding 来源（ingestKey 幂等键）', async () => {
    const f = fixture({ sourceExists: false });
    await synthesizeProfileClaimDrafts(f.tx, {
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      specs: [{ type: 'market', statement: '目标出口市场：DE' }],
    });
    expect(f.sourcesCreate).toHaveBeenCalledWith({
      data: {
        workspaceId: WORKSPACE_ID,
        companyId: COMPANY_ID,
        type: 'onboarding',
        uri: `onboarding:${COMPANY_ID}`,
        status: 'PARSED',
        ingestKey: `claim-drafts:${COMPANY_ID}`,
      },
      select: { id: true },
    });
  });

  it('空规格直接返回，不触库', async () => {
    const f = fixture();
    const result = await synthesizeProfileClaimDrafts(f.tx, {
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      specs: [],
    });
    expect(result).toEqual({ created: 0, skipped: 0, createdClaimIds: [] });
    expect(f.claimFindMany).not.toHaveBeenCalled();
  });
});
