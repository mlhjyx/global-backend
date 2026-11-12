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
  const offeringUpdate = vi.fn(async () => ({}));
  const offeringFindMany = vi.fn(async () => [
    { id: 'offering-1', name: '既有产品', attributes: {} },
  ]);
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
      update: offeringUpdate,
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
    prisma,
    tx,
    update,
    offeringUpsert,
    offeringUpdate,
    offeringFindMany,
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
  it('受控行业码校验后回填标签，产品 upsert 并把未勾选的旧产品标记为未选中', async () => {
    const { service, update, offeringUpsert, offeringUpdate, claimCreate } = fixture(READY);
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
    // 勾选的产品带 selectedByUser:true 落库（create 分支带 workspaceId，不跨租户）。
    expect(offeringUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          workspaceId: CTX.workspaceId,
          companyId: COMPANY_ID,
          source: 'onboarding',
          attributes: expect.objectContaining({ selectedByUser: true }),
        }),
      }),
    );
    // 未勾选的既有产品不删除，改为撤销选择标记（理解抽取仍可审计）。
    expect(offeringUpdate).toHaveBeenCalledWith({
      where: { id: 'offering-1' },
      data: { attributes: expect.objectContaining({ selectedByUser: false }) },
    });
    // 事实 → Claim 草稿（产品×2 + 行业 + 市场 = 4 条）。
    expect(claimCreate).toHaveBeenCalledTimes(4);
    expect(company).toMatchObject({ industryCode: '25' });
  });

  it('取消勾选的产品被标记 false；重新勾选后恢复 true 且不再打 false', async () => {
    const { service, offeringUpsert, offeringUpdate, offeringFindMany } = fixture(READY);
    offeringFindMany.mockResolvedValue([
      { id: 'offering-a', name: 'A', attributes: { selectedByUser: true } },
      { id: 'offering-b', name: 'B', attributes: { selectedByUser: true } },
    ]);
    await service.apply(CTX, COMPANY_ID, { products: ['A'] });
    expect(offeringUpsert).toHaveBeenCalledTimes(1);
    expect(offeringUpdate).toHaveBeenCalledWith({
      where: { id: 'offering-b' },
      data: { attributes: expect.objectContaining({ selectedByUser: false }) },
    });

    // 重新勾选 B：upsert 写回 true，B 不再被标记 false。
    offeringUpsert.mockClear();
    offeringUpdate.mockClear();
    offeringFindMany.mockResolvedValue([
      { id: 'offering-a', name: 'A', attributes: { selectedByUser: true } },
      { id: 'offering-b', name: 'B', attributes: { selectedByUser: false } },
    ]);
    await service.apply(CTX, COMPANY_ID, { products: ['A', 'B'] });
    expect(offeringUpsert).toHaveBeenCalledTimes(2);
    expect(offeringUpdate).not.toHaveBeenCalled();
    const reselected = offeringUpsert.mock.calls.find(
      ([call]) => (call as { where: { companyId_name: { name: string } } }).where.companyId_name.name === 'B',
    );
    expect(reselected?.[0]).toMatchObject({
      update: { attributes: expect.objectContaining({ selectedByUser: true }) },
    });
  });

  it('显式空数组=取消全部选择；缺省 products=本次不改动选择', async () => {
    const { service, prisma, offeringUpsert, offeringUpdate, offeringFindMany } = fixture(READY);
    offeringFindMany.mockResolvedValue([
      { id: 'offering-a', name: 'A', attributes: { selectedByUser: true } },
    ]);
    await service.apply(CTX, COMPANY_ID, { products: [] });
    expect(offeringUpsert).not.toHaveBeenCalled();
    expect(offeringUpdate).toHaveBeenCalledWith({
      where: { id: 'offering-a' },
      data: { attributes: expect.objectContaining({ selectedByUser: false }) },
    });

    // 缺省（undefined）不是「取消全部」：一个 Offering 行都不动。
    offeringUpdate.mockClear();
    await service.apply(CTX, COMPANY_ID, { name: '新名字' });
    expect(offeringUpsert).not.toHaveBeenCalled();
    expect(offeringUpdate).not.toHaveBeenCalled();
    // 跨租户：所有读写都被包在调用者的 workspace 事务里。
    expect(
      prisma.withWorkspace.mock.calls.every(([workspace]) => workspace === CTX.workspaceId),
    ).toBe(true);
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
