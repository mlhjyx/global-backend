import { describe, expect, it, vi } from 'vitest';
import { DoclingClient, type DoclingConvertOptions } from '../infra-clients/docling.client';
import type { PrismaService } from '../prisma/prisma.service';
import { KbIngestError } from '../site-builder/kb-errors';
import { SellerDocumentDto } from './dto/seller-document.dto';
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
  claimRows?: Array<{ filename?: string | null; object_key: string; mime: string; processing_attempt: number; uploaded_by?: string | null; docling_tasks?: unknown }>;
  currentStatus?: { status: string; deletedAt: Date | null; retryAt?: Date | null; leaseUntil?: Date | null } | null;
  content?: Buffer | Error;
  markdown?: string;
  doclingError?: Error;
  doclingClient?: DoclingClient;
  convertToMarkdown?: DoclingClient['convertToMarkdown'];
  embedError?: Error;
  publishRows?: unknown[];
  claims?: { createAssistedDrafts: ReturnType<typeof vi.fn> };
} = {}) {
  const executeRaw = vi.fn(async (_sql: unknown) => 1);
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
    convertToMarkdown: vi.fn(options.convertToMarkdown ?? (async () => {
      if (options.doclingError) throw options.doclingError;
      return { markdown: options.markdown ?? '# parsed' };
    })),
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
    docling: options.doclingClient ?? (docling as never),
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
      markdown: '# 光伏组件\n\n' + 'HJT 720W 规格参数说明与效率数据。'.repeat(25),
    });
    const result = await activities.processSellerDocument(INPUT);
    expect(result.outcome).toBe('ready');
    expect(docling.convertToMarkdown).toHaveBeenCalledWith(
      '光伏组件规格书.pdf',
      expect.any(Buffer),
      undefined,
      INPUT.workspaceId,
      expect.objectContaining({ allowEmptyMarkdown: true }),
    );
  });

  it('PDF 解析暂时未返回时以租约保存任务号，下次认领继续查询同一任务', async () => {
    const taskId = '9a240308-003e-479a-81b8-9efd1767399a';
    const row = { object_key: 'ws/k.pdf', mime: 'application/pdf', processing_attempt: 1 };
    const waiting = fixture({
      claimRows: [row],
      convertToMarkdown: async (_name, _data, _signal, _workspace, opts) => {
        await opts?.localAsync?.saveTaskId(taskId);
        throw new KbIngestError('KB_DOCLING_UNAVAILABLE', 'retryable', 'parse', 'poll interrupted');
      },
    });

    expect(await waiting.activities.processSellerDocument(INPUT)).toMatchObject({ outcome: 'queued' });
    const taskWrite = waiting.executeRaw.mock.calls
      .map(([sql]) => sql as { sql: string; values: unknown[] })
      .find((sql) => sql.values.some((value) => value === JSON.stringify({ _doclingTasks: { primary: taskId } })));
    expect(taskWrite?.sql).toContain('"lease_token" =');
    expect(taskWrite?.values).toContain(INPUT.documentId);

    const resumed = fixture({
      claimRows: [{ ...row, processing_attempt: 2, docling_tasks: { primary: taskId } }],
      convertToMarkdown: async (_name, _data, _signal, _workspace, opts: DoclingConvertOptions | undefined) => {
        expect(opts?.localAsync?.taskId).toBe(taskId);
        return { markdown: '# PDF catalogue\n\n' + 'Technical product details. '.repeat(30) };
      },
    });
    expect(await resumed.activities.processSellerDocument(INPUT)).toMatchObject({ outcome: 'ready' });
  });

  it('扫描 PDF 的旧 OCR 任务 404 后清除任务号，下一次重新提交 OCR 并发布文字', async () => {
    const primary = '9a240308-003e-479a-81b8-9efd1767399a';
    const expiredOcr = 'dd290261-ce12-4634-91c8-4342e9b63963';
    const replacementOcr = '6df37644-0605-4308-9607-98260ff92905';
    const pending = (task_id: string) => Response.json({ task_id, task_status: 'pending' });
    const succeeded = (task_id: string) => Response.json({ task_id, task_status: 'success' });
    const result = (md_content: string) => Response.json({ status: 'success', document: { md_content } });
    const recoveredText = 'OCR restored the scanned technical specifications.';
    const baseUrl = 'http://docling.fixture:5001';
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(succeeded(primary))
      .mockResolvedValueOnce(result(''))
      .mockResolvedValueOnce(Response.json({ detail: 'Task not found.' }, { status: 404 }))
      .mockResolvedValueOnce(succeeded(primary))
      .mockResolvedValueOnce(result(''))
      .mockResolvedValueOnce(pending(replacementOcr))
      .mockResolvedValueOnce(succeeded(replacementOcr))
      .mockResolvedValueOnce(result(recoveredText));
    vi.stubEnv('DOCLING_BACKEND', 'local');
    vi.stubEnv('DOCLING_URL', baseUrl);
    vi.stubGlobal('fetch', fetchMock);
    try {
      const row = {
        object_key: 'ws/scan.pdf', mime: 'application/pdf', processing_attempt: 2,
        docling_tasks: { primary, ocr: expiredOcr } as { primary: string; ocr?: string },
      };
      const { activities, executeRaw, embeddings } = fixture({
        claimRows: [row], doclingClient: new DoclingClient(),
        content: Buffer.from('%PDF-1.7\n1 0 obj << /Type /Pages /Count 1 >> endobj\n', 'latin1'),
      });
      executeRaw.mockImplementation(async (statement) => {
        const { values } = statement as { values: unknown[] };
        const checkpoint = values.find((value): value is string =>
          typeof value === 'string' && value.startsWith('{"_doclingTasks":'),
        );
        if (checkpoint) row.docling_tasks = JSON.parse(checkpoint)._doclingTasks;
        return 1;
      });

      const first = await activities.processSellerDocument(INPUT);
      expect(first).toMatchObject({ outcome: 'queued', retryAfterSeconds: 120 });
      expect(row.docling_tasks).toEqual({ primary });
      expect(embeddings.embed).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        `${baseUrl}/v1/status/poll/${primary}`,
        `${baseUrl}/v1/result/${primary}`,
        `${baseUrl}/v1/status/poll/${expiredOcr}`,
      ]);

      row.processing_attempt = 3;
      expect(await activities.processSellerDocument(INPUT)).toMatchObject({ outcome: 'ready' });
      const submissions = fetchMock.mock.calls.filter(([, request]) => request?.method === 'POST');
      expect(submissions).toHaveLength(1);
      expect(submissions[0]?.[0]).toBe(`${baseUrl}/v1/convert/source/async`);
      expect(JSON.parse(String(submissions[0]?.[1]?.body))).toMatchObject({ options: { force_ocr: true } });
      expect(embeddings.embed.mock.calls[0]?.[0]).toEqual([recoveredText]);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { mode: 'local', primaryText: '额定功率 10 千瓦。', expected: 'ready' },
    { mode: 'managed_api', primaryText: '', expected: 'failed_terminal' },
  ])('OCR 不可用时保留 $mode 已有的 $expected 行为', async ({ mode, primaryText, expected }) => {
    const primary = '9a240308-003e-479a-81b8-9efd1767399a';
    const ocr = 'dd290261-ce12-4634-91c8-4342e9b63963';
    const fetchMock = vi.fn<typeof fetch>();
    const result = () => Response.json({ status: 'success', document: { md_content: primaryText } });
    if (mode === 'local') {
      fetchMock.mockResolvedValueOnce(Response.json({ task_id: primary, task_status: 'success' }))
        .mockResolvedValueOnce(result())
        .mockResolvedValueOnce(Response.json({ detail: 'Task not found.' }, { status: 404 }));
    } else {
      fetchMock.mockResolvedValueOnce(result()).mockResolvedValueOnce(Response.json({}, { status: 503 }));
    }
    vi.stubEnv('DOCLING_BACKEND', mode);
    vi.stubEnv('DOCLING_URL', 'http://docling.fixture:5001');
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { activities } = fixture({
        claimRows: [{ object_key: 'ws/scan.pdf', mime: 'application/pdf', processing_attempt: 2, docling_tasks: { primary, ocr } }],
        doclingClient: new DoclingClient(),
      });
      expect(await activities.processSellerDocument(INPUT)).toMatchObject({ outcome: expected });
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it('正在等待有效解析租约过期时交回剩余等待时间', async () => {
    vi.useFakeTimers();
    try {
      const { activities, storage } = fixture({
        claimRows: [],
        currentStatus: { status: 'processing', deletedAt: null, leaseUntil: new Date(Date.now() + 125_000) },
      });
      expect(await activities.processSellerDocument(INPUT)).toEqual({
        documentId: INPUT.documentId,
        outcome: 'queued',
        retryAfterSeconds: 125,
      });
      expect(storage.getBufferBounded).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('DTO 保留公共解析摘要，隐藏内部解析任务号', () => {
    const doc = SellerDocumentDto.from({
      id: INPUT.documentId,
      companyId: INPUT.companyId,
      filename: 'catalog.pdf',
      mime: 'application/pdf',
      sizeBytes: 4096n,
      kind: 'pdf',
      status: 'queued',
      processingErrorCode: 'DOCUMENT_PARSE_UNAVAILABLE',
      chunkCount: 0,
      parsedMeta: { mode: 'priority_pages', _doclingTasks: { primary: '9a240308-003e-479a-81b8-9efd1767399a' } },
      factsExtractedAt: null,
      createdAt: new Date(0),
    });
    expect(doc.parsedMeta).toEqual({ mode: 'priority_pages' });
  });

  it('大页数 PDF（>15 页）：首阶段只解析前 15 页立即置 ready，并标记 tailPagesPending 供后台补全', async () => {
    const largePdf = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Pages /Count 42 >> endobj\n', 'latin1');
    const { activities, docling } = fixture({
      claimRows: [{ filename: 'catalog-42p.pdf', object_key: 'ws/42p.pdf', mime: 'application/pdf', processing_attempt: 1 }],
      content: largePdf,
      markdown: '# 光伏组件产品手册\n\n' + 'G12-0BB 750W 转换效率 24.5%，通过 IEC 61215 认证。'.repeat(60),
    });

    const result = await activities.processSellerDocument(INPUT);

    expect(result).toEqual({
      documentId: INPUT.documentId,
      outcome: 'ready',
      tailPagesPending: true,
      nextStartPage: 16,
      totalPages: 42,
    });
    expect(docling.convertToMarkdown).toHaveBeenCalledWith(
      'catalog-42p.pdf',
      largePdf,
      undefined,
      INPUT.workspaceId,
      expect.objectContaining({ pageRange: [1, 15], returnPageCount: true }),
    );
  });

  it('稀疏扫描 PDF：首轮文字不足自动走 force_ocr + L3 视觉模型兜底转写并提取产品', async () => {
    const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const scanPdf = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Pages /Count 4 >> endobj\n', 'latin1');
    const docling = {
      convertToMarkdown: vi
        .fn()
        .mockResolvedValueOnce({ markdown: '封面' })
        .mockResolvedValueOnce({
          markdown: '封面',
          pageCount: 4,
          pageImages: [{ pageNo: 1, pngBytes: validPng }],
        }),
    };
    const gateway = {
      reviewVision: vi.fn(async () => ({
        data: {
          transcribedMarkdown: '### 户用 10kWh 储能系统\n采用磷酸铁锂电芯，通过 IEC 62619 与 CE 认证，交期 15 天。',
          products: [{ name: '户用 10kWh 储能系统', description: '壁挂式光储一体机', confidence: 0.9 }],
          claims: [],
        },
        provider: 'gateway',
        model: 'gemini-3.8-flash',
      })),
      generateStructured: vi.fn(async () => ({
        data: { products: [], claims: [] },
        provider: 'gateway',
        model: 'gpt-6-luna',
      })),
    };
    const tx = {
      $queryRaw: vi.fn(async (arg: unknown) => {
        const sql = typeof (arg as { sql?: unknown })?.sql === 'string' ? (arg as { sql: string }).sql : '';
        if (sql.includes('RETURNING "parse_revision"')) return [{ parse_revision: 1 }];
        return [{ filename: 'scan.pdf', object_key: 'ws/scan.pdf', mime: 'application/pdf', processing_attempt: 1, uploaded_by: null }];
      }),
      $executeRaw: vi.fn(async () => 1),
      sellerDocument: { findFirst: vi.fn(async () => ({ status: 'queued', deletedAt: null })) },
      sellerDocumentChunk: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      offering: {
        findMany: vi.fn(async () => []),
        upsert: vi.fn(async (arg: unknown) => arg),
      },
      companyProfile: {
        findUnique: vi.fn(async () => ({ industry: null, summary: null })),
        update: vi.fn(async (arg: unknown) => arg),
      },
    };
    const activities = createSellerDocumentActivities({
      prisma: { withWorkspace: vi.fn(async (_ws: string, fn: (t: typeof tx) => unknown) => fn(tx)) } as unknown as PrismaService,
      storage: { getBufferBounded: vi.fn(async () => scanPdf) } as unknown as SellerDocumentsStorage,
      docling: docling as never,
      embeddings: { model: 'bge-m3', version: 'test', embed: vi.fn(async (t: string[]) => t.map(() => [0.1, 0.2])) } as never,
      gateway: gateway as never,
      resizeVisionPng: async (buf) => buf,
    });

    const result = await activities.processSellerDocument(INPUT);
    expect(result.outcome).toBe('ready');
    expect(docling.convertToMarkdown).toHaveBeenCalledTimes(2);
    expect(gateway.reviewVision).toHaveBeenCalledTimes(1);
    expect(tx.offering.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ name: '户用 10kWh 储能系统', source: 'seller_document' }),
      }),
    );
  });

  it('阶段二 processSellerDocumentTailPages 按 15 页批次补全尾页并追加分块', async () => {
    const docling = {
      convertToMarkdown: vi
        .fn()
        .mockResolvedValueOnce({ markdown: '## 第16-30页\n\n工业储能柜 215kWh 参数说明。', pageCount: 15 })
        .mockResolvedValueOnce({ markdown: '## 第31-35页\n\n质保 10 年与安装指南。', pageCount: 5 }),
    };
    const executeRaw = vi.fn(async () => 1);
    const tx = {
      $queryRaw: vi.fn(async () => [{ parse_revision: 2 }]),
      $executeRaw: executeRaw,
      sellerDocument: {
        findFirst: vi.fn(async () => ({
          filename: 'catalog-35p.pdf',
          objectKey: 'ws/35p.pdf',
          mime: 'application/pdf',
          uploadedBy: '20000000-0000-4000-8000-000000000002',
          chunkCount: 10,
          parsedMeta: { chunks: 10, mode: 'priority_pages', parsedPages: 15, totalPages: 35, fullParsePending: true },
        })),
      },
      sellerDocumentChunk: {
        aggregate: vi.fn(async () => ({ _max: { seq: 9 }, _count: { _all: 10 } })),
      },
    };
    const activities = createSellerDocumentActivities({
      prisma: { withWorkspace: vi.fn(async (_ws: string, fn: (t: typeof tx) => unknown) => fn(tx)) } as unknown as PrismaService,
      storage: { getBufferBounded: vi.fn(async () => Buffer.from('%PDF-1.7')) } as unknown as SellerDocumentsStorage,
      docling: docling as never,
      embeddings: { model: 'bge-m3', version: 'test', embed: vi.fn(async (t: string[]) => t.map(() => [0.2, 0.3])) } as never,
    });

    const out = await activities.processSellerDocumentTailPages({
      ...INPUT,
      startPage: 16,
      totalPages: 35,
    });

    expect(out.partial).toBe(false);
    expect(out.appendedChunks).toBeGreaterThan(0);
    expect(out.parsedPages).toBe(35);
    expect(docling.convertToMarkdown).toHaveBeenNthCalledWith(
      1,
      'catalog-35p.pdf',
      expect.any(Buffer),
      undefined,
      INPUT.workspaceId,
      expect.objectContaining({ pageRange: [16, 30] }),
    );
    expect(docling.convertToMarkdown).toHaveBeenNthCalledWith(
      2,
      'catalog-35p.pdf',
      expect.any(Buffer),
      undefined,
      INPUT.workspaceId,
      expect.objectContaining({ pageRange: [31, 35] }),
    );
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
