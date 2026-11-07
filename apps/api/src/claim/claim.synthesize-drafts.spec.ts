import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import { ClaimService } from './claim.service';

const CTX = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  userId: 'reviewer-42',
  roles: [],
};
const COMPANY_ID = '55555555-5555-4555-8555-555555555555';

function makeService(options: { companyExists?: boolean; existingStatements?: string[] } = {}) {
  const existing = options.existingStatements ?? [];
  const claimCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: `claim-${String(data.type)}`,
    workspaceId: data.workspaceId,
    companyId: data.companyId,
    sourceId: data.sourceId,
    type: data.type,
    statement: data.statement,
    status: data.status,
    confidence: data.confidence,
    createdAt: new Date('2026-11-08T00:00:00Z'),
    evidence: [{ snippet: '注册引导填写' }],
  }));
  const claimFindMany = vi.fn(async (args: Record<string, unknown>) => {
    if ('include' in args) {
      return claimCreate.mock.results.map((result) => result.value);
    }
    return existing.map((statement) => ({ statement }));
  });
  const tx = {
    $queryRaw: vi.fn(async () => (options.companyExists === false ? [] : [{ id: COMPANY_ID }])),
    companyProfile: {
      findUniqueOrThrow: vi.fn(async () => ({
        industry: '汽车零部件',
        targetMarkets: ['DE', 'FR'],
      })),
    },
    offering: {
      findMany: vi.fn(async () => [{ name: '精密轴承' }]),
    },
    claim: { findMany: claimFindMany, create: claimCreate },
    knowledgeSource: {
      findFirst: vi.fn(async () => ({ id: 'source-1' })),
      create: vi.fn(async () => ({ id: 'source-new' })),
    },
    evidence: { create: vi.fn(async () => ({ id: 'evidence-1' })) },
  };
  const prisma = {
    withWorkspace: vi.fn(async (_ws: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const service = new ClaimService(prisma as unknown as PrismaService);
  return { service, tx, prisma, claimCreate, claimFindMany };
}

describe('ClaimService.synthesizeDrafts（P5：存量空间补齐草稿）', () => {
  it('企业不存在或属于别的 workspace 时 404，且不加锁后的任何读写', async () => {
    const { service, claimCreate } = makeService({ companyExists: false });
    await expect(service.synthesizeDrafts(CTX as never, COMPANY_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(claimCreate).not.toHaveBeenCalled();
  });

  it('从档案（产品/行业/目标市场）生成 NEEDS_REVIEW 草稿并返回新建行', async () => {
    const { service, claimCreate } = makeService();
    const result = await service.synthesizeDrafts(CTX as never, COMPANY_ID);

    expect(result.created).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.claims).toHaveLength(3);
    expect(claimCreate).toHaveBeenCalledTimes(3);
    expect(claimCreate.mock.calls.map((call) => call[0].data.statement)).toEqual([
      '主营产品/服务：精密轴承',
      '所属行业：汽车零部件',
      '目标出口市场：DE、FR',
    ]);
    expect(claimCreate.mock.calls.every((call) => call[0].data.status === 'NEEDS_REVIEW')).toBe(true);
  });

  it('重复调用幂等：语句已存在时不新增，skipped 反映去重数', async () => {
    const { service, claimCreate } = makeService({
      existingStatements: ['主营产品/服务：精密轴承', '所属行业：汽车零部件', '目标出口市场：DE、FR'],
    });
    const result = await service.synthesizeDrafts(CTX as never, COMPANY_ID);
    expect(result).toEqual({ created: 0, skipped: 3, claims: [] });
    expect(claimCreate).not.toHaveBeenCalled();
  });
});
