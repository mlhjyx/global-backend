import { describe, expect, it, vi } from 'vitest';
import type { ModelGateway } from '../model-gateway/model-gateway';
import type { PrismaService } from '../prisma/prisma.service';
import {
  analyzeSellerDocumentTextChunks,
  analyzeSellerDocumentVisionPages,
  persistSellerDocumentAiFindings,
  selectHighSignalChunks,
} from './seller-document-ai-analyzer';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const COMPANY_ID = '30000000-0000-4000-8000-000000000003';
const DOCUMENT_ID = '40000000-0000-4000-8000-000000000004';
const VALID_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);

describe('seller-document-ai-analyzer（L2 文本提取 + L3 视觉兜底 + 落库保护）', () => {
  it('selectHighSignalChunks 优先保留含表格、认证与规格参数的高信号分块并按 seq 升序输出', () => {
    const chunks = [
      { seq: 0, text: '封面目录' },
      { seq: 1, text: '关于我们 '.repeat(30) },
      { seq: 2, text: '| 型号 | 功率 |\n| G12-0BB 750W | 750W |\n通过 IEC 61215 与 TÜV 认证，MOQ 100 pcs' },
    ];
    const picked = selectHighSignalChunks(chunks, 150);
    expect(picked.some((c) => c.seq === 2)).toBe(true);
    expect(picked.map((c) => c.seq)).toEqual([...picked.map((c) => c.seq)].sort((a, b) => a - b));
  });

  it('L2 文本提取过滤导航噪声产品并按 chunkSeq 分组模型原句建议', async () => {
    const gateway = {
      generateStructured: vi.fn(async () => ({
        data: {
          industry: '太阳能光伏组件制造',
          summary: '专注高效 HJT 异质结光伏组件与户用储能系统。',
          products: [
            {
              name: 'G12-0BB 天王星 Pro 750W',
              description: '高效 HJT 异质结组件，转换效率 24.5%',
              attributes: { moq: '1 container', certifications: ['IEC 61215', 'TÜV'] },
              evidence: 'G12-0BB 天王星 Pro 750W 效率达 24.5%',
              confidence: 0.94,
            },
            { name: 'Contact Us', description: '噪声词应被过滤', confidence: 0.9 },
          ],
          claims: [
            {
              chunkSeq: 0,
              type: 'certification',
              statement: '通过 IEC 61215 与 TÜV 认证',
              quote: '已通过 IEC 61215 与 TÜV 认证',
              confidence: 0.92,
            },
            {
              chunkSeq: 99, // 不在输入分块内，丢弃
              type: 'param',
              statement: '越界分块',
              quote: '不存在',
              confidence: 0.8,
            },
          ],
        },
        provider: 'gateway',
        model: 'gpt-6-luna',
      })),
    } as unknown as ModelGateway;

    const result = await analyzeSellerDocumentTextChunks({
      gateway,
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      filename: 'brochure.pdf',
      chunks: [
        { seq: 0, text: 'G12-0BB 天王星 Pro 750W 效率达 24.5%，已通过 IEC 61215 与 TÜV 认证。' },
      ],
    });

    expect(result.skipped).toBe(false);
    expect(result.industry).toBe('太阳能光伏组件制造');
    expect(result.products).toHaveLength(1);
    expect(result.products[0]?.name).toBe('G12-0BB 天王星 Pro 750W');
    expect(result.modelSuggestionsByChunk.get(0)).toHaveLength(1);
    expect(result.modelSuggestionsByChunk.has(99)).toBe(false);
  });

  it('旧预算账户未开通（enforce 过渡期）时 L2 优雅降级跳过而不抛错', async () => {
    const err = Object.assign(new Error('ACCOUNT_UNAVAILABLE'), { name: 'BudgetAccountUnavailableError' });
    const gateway = {
      generateStructured: vi.fn(async () => {
        throw err;
      }),
    } as unknown as ModelGateway;

    const result = await analyzeSellerDocumentTextChunks({
      gateway,
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      filename: 'brochure.pdf',
      chunks: [{ seq: 0, text: 'HJT 720W 规格书' }],
    });

    expect(result.skipped).toBe(true);
    expect(result.products).toEqual([]);
  });

  it('L3 多模态视觉兜底按每批最多 3 页送审并汇总产品与转写 Markdown', async () => {
    const reviewVision = vi.fn(async () => ({
      data: {
        transcribedMarkdown: '### 户用 10kWh 储能系统\n支持 CE / IEC 62619 认证，交期 15 天。',
        products: [
          {
            name: '户用 10kWh 储能系统',
            description: '壁挂式磷酸铁锂家储',
            confidence: 0.9,
          },
        ],
        claims: [],
      },
      provider: 'gateway',
      model: 'gemini-3.8-flash',
    }));
    const gateway = { reviewVision } as unknown as ModelGateway;

    const res = await analyzeSellerDocumentVisionPages({
      gateway,
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      filename: 'scan-catalog.pdf',
      pageImages: [
        { pageNo: 1, pngBytes: VALID_PNG },
        { pageNo: 2, pngBytes: VALID_PNG },
        { pageNo: 3, pngBytes: VALID_PNG },
        { pageNo: 4, pngBytes: VALID_PNG },
      ],
      resizePng: async (buf) => buf,
    });

    expect(reviewVision).toHaveBeenCalledTimes(2);
    expect(res.visionUsed).toBe(true);
    expect(res.products.map((p) => p.name)).toEqual(['户用 10kWh 储能系统']);
    expect(res.transcribedMarkdown).toContain('户用 10kWh 储能系统');
  });

  it('persistSellerDocumentAiFindings 保留既有人工勾选标记，且绝不覆盖已有行业或简介', async () => {
    const upserts: unknown[] = [];
    const profileUpdates: unknown[] = [];
    const tx = {
      offering: {
        findMany: vi.fn(async () => [
          {
            name: 'HJT 720W',
            description: '官网已写简介',
            source: 'understanding',
            attributes: { selectedByUser: true, selectedAt: '2026-11-26T00:00:00.000Z' },
          },
        ]),
        upsert: vi.fn(async (arg: unknown) => {
          upserts.push(arg);
          return arg;
        }),
      },
      companyProfile: {
        findUnique: vi.fn(async () => ({ industry: '已有行业', summary: null })),
        update: vi.fn(async (arg: unknown) => {
          profileUpdates.push(arg);
          return arg;
        }),
      },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_ws: string, fn: (t: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaService;

    const res = await persistSellerDocumentAiFindings(prisma, {
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      products: [
        { name: 'HJT 720W', description: '画册新简介不应覆盖', attributes: { moq: '100' }, confidence: 0.9 },
        { name: '户储 10kWh', description: '全新产品', confidence: 0.85 },
      ],
      industry: '不应覆盖的新行业',
      summary: '空简介应被画册回填',
    });

    expect(res.offeringsUpserted).toBe(2);
    const firstUpsert = upserts[0] as { update: { description?: string; attributes?: Record<string, unknown> } };
    expect(firstUpsert.update.description).toBeUndefined();
    expect(firstUpsert.update.attributes).toMatchObject({
      moq: '100',
      selectedByUser: true,
      selectedAt: '2026-11-26T00:00:00.000Z',
    });
    expect(profileUpdates).toHaveLength(1);
    expect(profileUpdates[0]).toEqual({
      where: { id: COMPANY_ID },
      data: { summary: '空简介应被画册回填' },
    });
  });
});
