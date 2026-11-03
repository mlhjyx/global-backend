import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { createSellerDocumentActivities, type SellerDocumentIngestInput } from './seller-document.activities';
import type { SellerDocumentsStorage } from './seller-documents.storage';

const INPUT: SellerDocumentIngestInput = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  companyId: '30000000-0000-4000-8000-000000000003',
  documentId: '40000000-0000-4000-8000-000000000004',
};

function fixture(options: {
  claimRows?: Array<{ object_key: string; mime: string; processing_attempt: number }>;
  currentStatus?: { status: string; deletedAt: Date | null } | null;
  content?: Buffer | Error;
  markdown?: string;
  embedError?: Error;
  finalizeUpdated?: number;
} = {}) {
  const executeRaw = vi.fn(async () => options.finalizeUpdated ?? 1);
  const deleteMany = vi.fn(async () => ({ count: 0 }));
  const tx = {
    $queryRaw: vi.fn(async () =>
      options.claimRows ?? [
        { object_key: 'ws/k', mime: 'text/markdown', processing_attempt: 1 },
      ],
    ),
    $executeRaw: executeRaw,
    sellerDocument: {
      findFirst: vi.fn(async () =>
        options.currentStatus === undefined
          ? { status: 'queued', deletedAt: null }
          : options.currentStatus,
      ),
    },
    sellerDocumentChunk: { deleteMany },
  };
  const prisma = {
    withWorkspace: vi.fn(async (_ws: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const storage = {
    getBufferBounded: vi.fn(async () => {
      if (options.content instanceof Error) throw options.content;
      return options.content ?? Buffer.from('# 产品目录\n\n## 精密轴承\n\n' + '轴承规格说明。'.repeat(400));
    }),
  };
  const docling = {
    convertToMarkdown: vi.fn(async () => ({ markdown: options.markdown ?? '# parsed' })),
  };
  const embeddings = {
    model: 'bge-m3',
    version: 'test',
    embed: vi.fn(async (texts: string[]) => {
      if (options.embedError) throw options.embedError;
      return texts.map(() => [0.1, 0.2, 0.3]);
    }),
  };
  const activities = createSellerDocumentActivities({
    prisma: prisma as unknown as PrismaService,
    storage: storage as unknown as SellerDocumentsStorage,
    docling: docling as never,
    embeddings: embeddings as never,
  });
  return { activities, prisma, tx, storage, docling, embeddings, executeRaw, deleteMany };
}

describe('createSellerDocumentActivities（Phase 2b ingest）', () => {
  it('文本资料：直读 → 分块 → 嵌入 → 写 chunk 并置 ready', async () => {
    const { activities, embeddings, deleteMany, executeRaw } = fixture();
    const result = await activities.processSellerDocument(INPUT);
    expect(result.outcome).toBe('ready');
    expect(embeddings.embed).toHaveBeenCalled();
    expect(deleteMany).toHaveBeenCalledWith({ where: { documentId: INPUT.documentId } });
    // 每次 chunk 一个 INSERT + 一次 finalize
    expect(executeRaw.mock.calls.length).toBeGreaterThan(1);
  });

  it('下载失败：按 attempt 退避回 queued（非终态）', async () => {
    const { activities } = fixture({ content: new Error('storage down') });
    const result = await activities.processSellerDocument(INPUT);
    expect(result.outcome).toBe('queued');
  });

  it('解析为空内容：回 queued 并记录错误码', async () => {
    const { activities } = fixture({ content: Buffer.from('   \n  ') });
    const result = await activities.processSellerDocument(INPUT);
    expect(result.outcome).toBe('queued');
  });

  it('嵌入失败：回 queued，不写 chunk', async () => {
    const { activities, deleteMany } = fixture({ embedError: new Error('embed down') });
    const result = await activities.processSellerDocument(INPUT);
    expect(result.outcome).toBe('queued');
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('非 queued（已 ready/已删）时返回 not_due/gone，不触碰存储', async () => {
    const { activities, storage } = fixture({
      claimRows: [],
      currentStatus: { status: 'ready', deletedAt: null },
    });
    const result = await activities.processSellerDocument(INPUT);
    expect(result.outcome).toBe('not_due');
    expect(storage.getBufferBounded).not.toHaveBeenCalled();

    const gone = fixture({ claimRows: [], currentStatus: { status: 'deleted', deletedAt: new Date() } });
    expect((await gone.activities.processSellerDocument(INPUT)).outcome).toBe('gone');
  });

  it('finalize 丢租约（被新 attempt 接管）时不覆盖真值', async () => {
    const { activities } = fixture({ finalizeUpdated: 0 });
    const result = await activities.processSellerDocument(INPUT);
    expect(result.outcome).toBe('not_due');
  });
});
