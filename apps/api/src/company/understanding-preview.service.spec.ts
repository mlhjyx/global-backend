import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { UnderstandingPreviewService } from './understanding-preview.service';

const CTX: RequestContext = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  roles: ['MEMBER'],
  scopes: ['acquisition:read', 'acquisition:write'],
};
const COMPANY_ID = '30000000-0000-4000-8000-000000000003';

const INDUSTRY_NODES = [
  {
    code: '25',
    labelEn: 'Manufacture of fabricated metal products',
    labels: { zh: '金属制品制造', de: 'Herstellung von Metallerzeugnissen' },
    parentCode: 'C',
    crosswalks: { nace: ['25'] },
  },
  {
    code: '28',
    labelEn: 'Manufacture of machinery and equipment n.e.c.',
    labels: { zh: '通用及专用设备制造', de: 'Maschinenbau' },
    parentCode: 'C',
    crosswalks: { nace: ['28'] },
  },
];

function fixture(company: Record<string, unknown> | null) {
  const tx = {
    companyProfile: { findUnique: vi.fn(async () => company) },
    knowledgeSource: {
      findMany: vi.fn(async () => [
        { uri: 'https://acme.test/' },
        { uri: 'https://acme.test/products' },
        { uri: 'https://acme.test/about' },
      ]),
    },
    canonicalTaxonomy: {
      findMany: vi.fn(async (args: { where: { kind: string } }) =>
        args.where.kind === 'industry'
          ? INDUSTRY_NODES
          : [
              { code: 'DE', labelEn: 'Germany', labels: { zh: '德国' } },
              { code: 'FR', labelEn: 'France', labels: { zh: '法国' } },
            ],
      ),
    },
    termAlias: {
      findMany: vi.fn(async (args: { where: { kind: string } }) =>
        args.where.kind === 'industry'
          ? [
              { term: '机械制造', code: '28' },
              { term: 'metal fabrication', code: '25' },
            ]
          : [
              { term: 'deutschland', code: 'DE' },
              { term: 'frankreich', code: 'FR' },
              { term: 'us', code: 'US' },
            ],
      ),
    },
    offering: {
      findMany: vi.fn(async () => [
        {
          name: 'CNC 精密加工件',
          source: 'understanding',
          sourceUrl: 'https://acme.test/products',
          evidence: 'CNC precision parts',
        },
      ]),
    },
    claim: {
      findMany: vi.fn(async () => [
        {
          type: 'market',
          statement: 'Wir exportieren nach Deutschland und Frankreich.',
          evidence: [{ sourceUrl: 'https://acme.test/about' }],
        },
        {
          type: 'value_prop',
          statement: 'Contact us for a quote.',
          evidence: [{ sourceUrl: 'https://acme.test/contact' }],
        },
      ]),
    },
  };
  const prisma = {
    withWorkspace: vi.fn(async (_ws: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const service = new UnderstandingPreviewService(prisma as unknown as PrismaService);
  return { service, tx };
}

describe('UnderstandingPreviewService', () => {
  it('ready：归一行业建议、产品与市场候选只收有证据的命中', async () => {
    const { service } = fixture({
      id: COMPANY_ID,
      workspaceId: CTX.workspaceId,
      name: '具安科技',
      website: 'https://acme.test',
      status: 'REVIEW',
      industry: '精密机械制造',
      industryCode: null,
      summary: null,
      understandingFailedAt: null,
      understandingLastError: null,
      updatedAt: new Date('2026-11-10T08:00:00Z'),
    });
    const preview = await service.get(CTX, COMPANY_ID);
    expect(preview.state).toBe('ready');
    expect(preview.pagesAnalyzed).toBe(3);
    // 子串命中「机械制造」→ ISIC 28；标签用词表中文名。
    expect(preview.industry.suggested).toMatchObject({
      code: '28',
      label: '通用及专用设备制造',
      matched: true,
    });
    expect(preview.industry.options.map((row) => row.code)).toEqual(['25', '28']);
    expect(preview.products).toHaveLength(1);
    expect(preview.products[0]).toMatchObject({
      name: 'CNC 精密加工件',
      sourceUrl: 'https://acme.test/products',
    });
    expect(preview.markets.map((row) => row.code).sort()).toEqual(['DE', 'FR']);
    expect(preview.markets[0]!.evidence.length).toBeGreaterThan(0);
    // 2 字母 "us" 不产生美国候选（contact us 这类误报必须被挡住）。
    expect(preview.markets.some((row) => row.code === 'US')).toBe(false);
  });

  it('failed：解析 stage:code 失败标签', async () => {
    const { service } = fixture({
      id: COMPANY_ID,
      workspaceId: CTX.workspaceId,
      name: '具安科技',
      website: 'https://acme.test',
      status: 'DRAFT',
      industry: null,
      industryCode: null,
      summary: null,
      understandingFailedAt: new Date('2026-11-10T08:00:00Z'),
      understandingLastError: 'extract:ProviderHttpError',
      updatedAt: new Date('2026-11-10T08:00:00Z'),
    });
    const preview = await service.get(CTX, COMPANY_ID);
    expect(preview.state).toBe('failed');
    expect(preview.failure).toEqual({ stage: 'extract', code: 'ProviderHttpError' });
  });

  it('queued / not_started：按官网是否已提交区分', async () => {
    const base = {
      id: COMPANY_ID,
      workspaceId: CTX.workspaceId,
      name: '具安科技',
      status: 'DRAFT',
      industry: null,
      industryCode: null,
      summary: null,
      understandingFailedAt: null,
      understandingLastError: null,
      updatedAt: new Date('2026-11-10T08:00:00Z'),
    };
    const queued = await fixture({ ...base, website: 'https://acme.test' }).service.get(CTX, COMPANY_ID);
    expect(queued.state).toBe('queued');
    const manual = await fixture({ ...base, website: null }).service.get(CTX, COMPANY_ID);
    expect(manual.state).toBe('not_started');
  });

  it('已删除或跨租户档案返回 404', async () => {
    const { service } = fixture(null);
    await expect(service.get(CTX, COMPANY_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});
