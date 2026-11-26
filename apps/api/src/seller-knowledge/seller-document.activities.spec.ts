import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { KbIngestError } from '../site-builder/kb-errors';
import {
  createSellerDocumentActivities,
  resolveDoclingFilename,
  type SellerDocumentIngestInput,
} from './seller-document.activities';
import type { SellerDocumentsStorage } from './seller-documents.storage';

const INPUT: SellerDocumentIngestInput = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  companyId: '30000000-0000-4000-8000-000000000003',
  documentId: '40000000-0000-4000-8000-000000000004',
};

function fixture(options: {
  claimRows?: Array<{ filename?: string | null; object_key: string; mime: string; processing_attempt: number; uploaded_by?: string | null }>;
  currentStatus?: { status: string; deletedAt: Date | null } | null;
  content?: Buffer | Error;
  markdown?: string;
  doclingError?: Error;
  embedError?: Error;
  publishRows?: unknown[];
  claims?: { createAssistedDrafts: ReturnType<typeof vi.fn> };
} = {}) {
  const executeRaw = vi.fn(async () => 1);
  const deleteMany = vi.fn(async () => ({ count: 0 }));
  const tx = {
    $queryRaw: vi.fn(async (argument: unknown) => {
      const sql = typeof (argument as { sql?: unknown })?.sql === 'string'
        ? (argument as { sql: string }).sql
        : Array.isArray(argument) ? (argument as unknown[]).join('?') : '';
      if (sql.includes('RETURNING "parse_revision"'))
        return options.publishRows ?? [{ parse_revision: 1 }];
      return options.claimRows ?? [
        { filename: 'catalog.md', object_key: 'ws/k', mime: 'text/markdown', processing_attempt: 1, uploaded_by: '20000000-0000-4000-8000-000000000002' },
      ];
    }),
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
    convertToMarkdown: vi.fn(async () => {
      if (options.doclingError) throw options.doclingError;
      return { markdown: options.markdown ?? '# parsed' };
    }),
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
    ...(options.claims ? { claims: options.claims as never } : {}),
  });
  return { activities, prisma, tx, storage, docling, embeddings, executeRaw, deleteMany };
}

describe('resolveDoclingFilename', () => {
  it('保留合法扩展名，缺失或仅 UUID 时按 MIME 补齐扩展名', () => {
    expect(resolveDoclingFilename('doc-1', 'Liansheng_HJT_2026.pdf', 'application/pdf')).toBe('Liansheng_HJT_2026.pdf');
    expect(resolveDoclingFilename('doc-1', 'dir/sub/catalog.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('catalog.docx');
    expect(resolveDoclingFilename('doc-1', 'datasheet', 'application/pdf')).toBe('datasheet.pdf');
    expect(resolveDoclingFilename('doc-1', null, 'application/pdf')).toBe('doc-1.pdf');
  });
});

describe('createSellerDocumentActivities（Phase 2b ingest）', () => {
  it('文本资料：直读 → 分块 → 嵌入 → 写 chunk 并置 ready', async () => {
    const { activities, embeddings, deleteMany, executeRaw, tx } = fixture();
    const result = await activities.processSellerDocument(INPUT);
    expect(result.outcome).toBe('ready');
    expect(embeddings.embed).toHaveBeenCalled();
    expect(deleteMany).toHaveBeenCalledWith({ where: { documentId: INPUT.documentId } });
    // claim SQL 支持接管过期 processing 租约
    const claimSql = (tx.$queryRaw.mock.calls[0]?.[0] as { sql?: string } | undefined)?.sql ?? '';
    expect(claimSql).toContain(`"status" = 'processing'`);
    expect(claimSql).toContain('"lease_until"');
    // 每个 chunk 一个 INSERT；ready 与 parseRevision 在同一事务 UPDATE
    expect(executeRaw.mock.calls.length).toBeGreaterThan(0);
  });

  it('PDF 资料：传带扩展名的文件名给 Docling，而非裸 UUID', async () => {
    const { activities, docling } = fixture({
      claimRows: [{ filename: '光伏组件规格书.pdf', object_key: 'ws/k.pdf', mime: 'application/pdf', processing_attempt: 1 }],
      markdown: '# 光伏组件\n\nHJT 720W 规格参数说明。',
    });
    const result = await activities.processSellerDocument(INPUT);
    expect(result.outcome).toBe('ready');
    expect(docling.convertToMarkdown).toHaveBeenCalledWith('光伏组件规格书.pdf', expect.any(Buffer), undefined);
  });

  it('下载失败：按 attempt 退避回 queued（非终态）', async () => {
    const { activities } = fixture({ content: new Error('storage down') });
    const result = await activities.processSellerDocument(INPUT);
    expect(result.outcome).toBe('queued');
  });

  it('解析为空内容：立即标记 failed_terminal，不触发 8 次重试风暴', async () => {
    const { activities } = fixture({ content: Buffer.from('   \n  ') });
    const result = await activities.processSellerDocument(INPUT);
    expect(result.outcome).toBe('failed_terminal');
  });

  it('Docling 返回终态文档损坏错误（disposition=terminal）：立即标记 failed_terminal', async () => {
    const { activities } = fixture({
      claimRows: [{ filename: 'bad.pdf', object_key: 'ws/bad.pdf', mime: 'application/pdf', processing_attempt: 1 }],
      doclingError: new KbIngestError('KB_DOCUMENT_INVALID', 'terminal', 'parse', 'corrupt pdf'),
    });
    const result = await activities.processSellerDocument(INPUT);
    expect(result.outcome).toBe('failed_terminal');
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
    const { activities } = fixture({ publishRows: [] });
    const result = await activities.processSellerDocument(INPUT);
    expect(result.outcome).toBe('not_due');
  });

  it('ready 发布后自动触发 S2 辅助要点草稿抽取，且抽取异常不回滚 ready', async () => {
    const createAssistedDrafts = vi.fn(async () => ({
      documentId: INPUT.documentId,
      parseRevision: 1,
      scannedChunks: 2,
      droppedModelSuggestions: 0,
      drafts: [],
    }));
    const okFix = fixture({ claims: { createAssistedDrafts } });
    const okRes = await okFix.activities.processSellerDocument(INPUT);
    expect(okRes.outcome).toBe('ready');
    expect(createAssistedDrafts).toHaveBeenCalledTimes(1);
    expect(createAssistedDrafts).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: INPUT.workspaceId,
        userId: '20000000-0000-4000-8000-000000000002',
      }),
      INPUT.companyId,
      INPUT.documentId,
      expect.objectContaining({ maxChunks: 25, maxCandidates: 20 }),
    );

    const failingClaims = { createAssistedDrafts: vi.fn(async () => { throw new Error('extract boom'); }) };
    const resilientFix = fixture({ claims: failingClaims });
    const resilientRes = await resilientFix.activities.processSellerDocument(INPUT);
    expect(resilientRes.outcome).toBe('ready');
  });

  it('嵌入失败返回 retryAfterSeconds 供工作流按退避窗口自动重跑', async () => {
    const { activities } = fixture({ embedError: new Error('embed timeout') });
    const result = await activities.processSellerDocument(INPUT);
    expect(result.outcome).toBe('queued');
    expect(result.retryAfterSeconds).toBe(60);
  });
});
