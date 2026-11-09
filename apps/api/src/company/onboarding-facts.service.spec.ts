import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { OnboardingFactsService } from './onboarding-facts.service';

const CTX: RequestContext = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  roles: ['MEMBER'],
  scopes: ['acquisition:read', 'acquisition:write'],
};
const COMPANY_ID = '30000000-0000-4000-8000-000000000003';

function fixture(company: Record<string, unknown> | null, options: { industryNode?: unknown } = {}) {
  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    ...(company ?? {}),
    ...data,
  }));
  const offeringUpsert = vi.fn(async () => ({}));
  const offeringDeleteMany = vi.fn(async () => ({ count: 0 }));
  const offeringFindMany = vi.fn(async () => [{ name: '既有产品' }]);
  const claimFindMany = vi.fn(async () => []);
  const claimCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: `claim-${String(data.type)}`,
    ...data,
  }));
  const tx = {
    companyProfile: {
      findUnique: vi.fn(async () => company),
      update,
    },
    canonicalTaxonomy: {
      findUnique: vi.fn(async () =>
        options.industryNode === undefined
          ? { code: '25', labelEn: 'Manufacture of fabricated metal products', labels: { zh: '金属制品制造' } }
          : options.industryNode,
      ),
    },
    offering: {
      upsert: offeringUpsert,
      deleteMany: offeringDeleteMany,
      findMany: offeringFindMany,
    },
    claim: { findMany: claimFindMany, create: claimCreate },
    evidence: { create: vi.fn(async () => ({ id: 'evidence-1' })) },
    knowledgeSource: {
      findFirst: vi.fn(async () => ({ id: 'source-1' })),
      create: vi.fn(async () => ({ id: 'source-new' })),
    },
  };
  const prisma = {
    withWorkspace: vi.fn(async (_ws: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const service = new OnboardingFactsService(prisma as unknown as PrismaService);
  return {
    service,
    tx,
    update,
    offeringUpsert,
    offeringDeleteMany,
    claimCreate,
  };
}

const DRAFT = {
  id: COMPANY_ID,
  workspaceId: CTX.workspaceId,
  name: 'acme-test',
  website: 'https://acme.test',
  status: 'DRAFT',
  industry: null,
  industryCode: null,
  targetMarkets: [],
  businessEmail: null,
  summary: null,
  understandingFailedAt: null,
  deletedAt: null,
};

/** 预览已就绪（理解完成）的档案：完成路径的主用例。 */
const READY = { ...DRAFT, status: 'REVIEW' };

/** 最近一次理解失败、留在 DRAFT 的档案：手动填写出口。 */
const FAILED = { ...DRAFT, understandingFailedAt: new Date('2026-11-10T07:00:00Z') };

describe('OnboardingFactsService', () => {
  it('受控行业码校验后回填标签，产品 upsert 并清理旧的手填产品', async () => {
    const { service, update, offeringUpsert, offeringDeleteMany, claimCreate } = fixture(READY);
    const company = await service.apply(CTX, COMPANY_ID, {
      name: '具安科技',
      industryCode: '25',
      industry: '金属制品制造',
      targetMarkets: ['DE'],
      products: ['钣金件', '激光切割件'],
      businessEmail: 'sales@acme.test',
    });
    expect(update).toHaveBeenCalledOnce();
    const data = update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).toMatchObject({
      name: '具安科技',
      industry: '金属制品制造',
      industryCode: '25',
      targetMarkets: ['DE'],
      businessEmail: 'sales@acme.test',
    });
    expect(offeringUpsert).toHaveBeenCalledTimes(2);
    expect(offeringDeleteMany).toHaveBeenCalledWith({
      where: { companyId: COMPANY_ID, source: 'onboarding', name: { notIn: ['钣金件', '激光切割件'] } },
    });
    // 事实 → Claim 草稿（产品×2 + 行业 + 市场 = 4 条）。
    expect(claimCreate).toHaveBeenCalledTimes(4);
    expect(company).toMatchObject({ industryCode: '25' });
  });

  it('只给自由文本行业时清空旧受控码', async () => {
    const { service, update } = fixture({ ...READY, industryCode: '25', industry: '金属制品制造' });
    await service.apply(CTX, COMPANY_ID, { industry: '精密机械' });
    const data = update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.industry).toBe('精密机械');
    expect(data.industryCode).toBeNull();
  });

  it('ENRICHING 期间拒绝写入，避免理解回填覆盖客户选择', async () => {
    const { service } = fixture({ ...DRAFT, status: 'ENRICHING' });
    await expect(
      service.apply(CTX, COMPANY_ID, { products: ['A'] }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('DRAFT + 官网 + 无失败标记（排队中）拒绝写入，避免 extract_profile 稍后覆盖行业', async () => {
    const { service } = fixture(DRAFT);
    await expect(
      service.apply(CTX, COMPANY_ID, { products: ['A'] }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('失败过的 DRAFT 允许手动写回（重试前的兜底出口）', async () => {
    const { service, update } = fixture(FAILED);
    await service.apply(CTX, COMPANY_ID, { products: ['A'], targetMarkets: ['DE'] });
    expect(update).toHaveBeenCalledOnce();
  });

  it('JSON null 字段返回 400（@IsOptional 会放行 null）', async () => {
    const { service } = fixture(READY);
    await expect(
      service.apply(CTX, COMPANY_ID, { products: null } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('词表之外的行业码 400', async () => {
    const { service, tx } = fixture(READY);
    tx.canonicalTaxonomy.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.apply(CTX, COMPANY_ID, { industryCode: 'does-not-exist' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('档案不存在返回 404', async () => {
    const { service } = fixture(null);
    await expect(service.apply(CTX, COMPANY_ID, { name: 'X' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
