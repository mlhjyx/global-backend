import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import {
  SellerDocumentsService,
  formatContentDisposition,
  sellerDocumentCanonicalKey,
  sellerDocumentStagingKey,
} from './seller-documents.service';
import type { SellerDocumentsStorage } from './seller-documents.storage';

const CTX: RequestContext = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  roles: ['MEMBER'],
  scopes: ['acquisition:read', 'acquisition:write'],
};
const COMPANY_ID = '30000000-0000-4000-8000-000000000003';
const DOC_ID = '40000000-0000-4000-8000-000000000004';
const SHA = 'a'.repeat(64);

function fixture(overrides: {
  count?: number;
  companyCount?: number;
  sumBytes?: bigint;
  claimRows?: Array<{ object_key: string; mime: string; size_bytes: bigint }>;
  searchRows?: Array<{ document_id: string; filename: string; seq: number; text: string; score: number }>;
  hashHead?: Buffer;
  updateError?: unknown;
} = {}) {
  const created: unknown[] = [];
  const updates: unknown[] = [];
  let updateCalls = 0;
  const tx = {
    companyProfile: { findUnique: vi.fn(async () => ({ id: COMPANY_ID })) },
    claimDocumentEvidence: { findMany: vi.fn(async () => []) },
    sellerDocumentChunk: { findMany: vi.fn(async () => []) },
    claim: { findMany: vi.fn(async () => []) },
    deletionRequest: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: '90000000-0000-4000-8000-000000000009' })),
    },
    outboxEvent: { create: vi.fn(async () => ({ eventId: '91000000-0000-4000-8000-000000000009' })) },
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async (argument: unknown) => {
      const sql = typeof (argument as { sql?: unknown })?.sql === 'string'
        ? (argument as { sql: string }).sql
        : Array.isArray(argument) ? (argument as unknown[]).join('?') : '';
      if (sql.includes('FROM "seller_document"') && !sql.includes('JOIN'))
        return [{ id: DOC_ID }];
      return overrides.searchRows ??
        overrides.claimRows ?? [
          { object_key: sellerDocumentStagingKey(CTX.workspaceId, DOC_ID), mime: 'application/pdf', size_bytes: 1024n },
        ];
    }),
    sellerDocument: {
      count: vi.fn(async () => overrides.count ?? 0),
      aggregate: vi.fn(async () => ({ _sum: { sizeBytes: overrides.sumBytes ?? 0n } })),
      create: vi.fn(async ({ data }: { data: unknown }) => { created.push(data); return data; }),
      findFirst: vi.fn(async () => ({ id: DOC_ID, companyId: COMPANY_ID, status: 'ready', objectKey: 'k', deletedAt: null })),
      update: vi.fn(async ({ data }: { data: unknown }) => {
        updateCalls += 1;
        if (overrides.updateError && updateCalls === 1) throw overrides.updateError;
        updates.push(data);
        return { id: DOC_ID, companyId: COMPANY_ID, status: 'queued', sizeBytes: 1n, createdAt: new Date() };
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const prisma = {
    withWorkspace: vi.fn(async (_ws: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const storage = {
    presignPut: vi.fn(async () => ({ url: 'https://minio/put?sig=1', expiresAt: new Date() })),
    presignGet: vi.fn(async () => 'https://minio/get?sig=1'),
    head: vi.fn(async () => ({ size: 1024, contentType: 'application/pdf' })),
    hashObject: vi.fn(async () => ({
      sha256: SHA,
      head: overrides.hashHead ?? Buffer.from('%PDF-1.7\n...'),
      size: 1024,
    })),
    copy: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  const embeddings = {
    model: 'site-builder-bge-m3-local',
    version: 'bge-m3:2026-07',
    embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
  };
  const launcher = { launchIngest: vi.fn(async () => undefined) };
  const service = new SellerDocumentsService(
    prisma as unknown as PrismaService,
    storage as unknown as SellerDocumentsStorage,
    embeddings as never,
    launcher,
  );
  return { service, prisma, tx, storage, embeddings, launcher, created, updates };
}

describe('SellerDocumentsService', () => {
  it('presign 拒绝不支持的类型，且不创建行', async () => {
    const { service, tx } = fixture();
    await expect(
      service.presign(CTX, COMPANY_ID, { filename: 'x.html', mime: 'text/html', size: 10 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.sellerDocument.create).not.toHaveBeenCalled();
  });

  it('presign 达到空间配额时 409，且不签发 URL', async () => {
    const { service, storage } = fixture({ count: 500 });
    await expect(
      service.presign(CTX, COMPANY_ID, { filename: 'a.pdf', mime: 'application/pdf', size: 10 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(storage.presignPut).not.toHaveBeenCalled();
  });

  it('presign 创建 pending_upload 行并返回 staging 前缀的 presigned PUT', async () => {
    const { service, created, storage } = fixture();
    const result = await service.presign(CTX, COMPANY_ID, {
      filename: '目录.pdf',
      mime: 'application/pdf',
      size: 1024,
    });
    expect(result.uploadUrl).toContain('https://minio/put');
    const row = created[0] as { status: string; kind: string; workspaceId: string };
    expect(row.status).toBe('pending_upload');
    expect(row.kind).toBe('pdf');
    expect(row.workspaceId).toBe(CTX.workspaceId);
    expect(storage.presignPut).toHaveBeenCalledWith(
      sellerDocumentStagingKey(CTX.workspaceId, result.documentId),
      'application/pdf',
    );
  });

  it('commit 成功后转存 canonical、置 queued 并启动 ingest', async () => {
    const { service, storage, launcher, updates } = fixture();
    const row = await service.commit(CTX, COMPANY_ID, DOC_ID);
    expect(row.status).toBe('queued');
    expect(storage.copy).toHaveBeenCalledWith(
      sellerDocumentStagingKey(CTX.workspaceId, DOC_ID),
      sellerDocumentCanonicalKey(CTX.workspaceId, COMPANY_ID, DOC_ID, SHA, 'pdf'),
    );
    expect(storage.delete).toHaveBeenCalled();
    expect(launcher.launchIngest).toHaveBeenCalledWith({
      workspaceId: CTX.workspaceId,
      companyId: COMPANY_ID,
      documentId: DOC_ID,
    });
    expect(updates[0]).toMatchObject({ status: 'queued', contentHash: SHA });
  });

  it('commit 魔数不符时标记 rejected 并中止转存', async () => {
    const { service, storage } = fixture({ hashHead: Buffer.from('PK\x03\x04zip') });
    await expect(service.commit(CTX, COMPANY_ID, DOC_ID)).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.copy).not.toHaveBeenCalled();
    expect(storage.presignGet).not.toHaveBeenCalled();
  });

  it('commit 撞活跃内容唯一索引时 409 并清理 canonical 副本', async () => {
    const dup = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const { service, storage, launcher } = fixture({ updateError: dup });
    await expect(service.commit(CTX, COMPANY_ID, DOC_ID)).rejects.toBeInstanceOf(ConflictException);
    expect(storage.copy).toHaveBeenCalledTimes(1);
    expect(launcher.launchIngest).not.toHaveBeenCalled();
  });

  it('commit 非 P2002 数据库异常时回滚至 pending_upload 并清理孤立 canonical，不滞留 committing', async () => {
    const { service, storage, updates, tx } = fixture({ updateError: new Error('db connection reset') });
    await expect(service.commit(CTX, COMPANY_ID, DOC_ID)).rejects.toThrow('db connection reset');
    const claimSql = (tx.$queryRaw.mock.calls[0]?.[0] as { sql?: string } | undefined)?.sql ?? '';
    expect(claimSql).toContain(`"status" = 'committing'`);
    expect(updates).toContainEqual(expect.objectContaining({ status: 'pending_upload', leaseToken: null, leaseUntil: null }));
    expect(storage.delete).toHaveBeenCalledWith(
      sellerDocumentCanonicalKey(CTX.workspaceId, COMPANY_ID, DOC_ID, SHA, 'pdf'),
    );
  });

  it('未上传完成（HEAD 404）时回到 pending_upload 并 409', async () => {
    const { service, storage } = fixture();
    storage.head.mockResolvedValueOnce(null);
    await expect(service.commit(CTX, COMPANY_ID, DOC_ID)).rejects.toBeInstanceOf(ConflictException);
    expect(storage.hashObject).not.toHaveBeenCalled();
  });

  it('混合检索：查询词过短拒绝且不调用嵌入', async () => {
    const { service, embeddings } = fixture();
    await expect(service.search(CTX, COMPANY_ID, 'a', 10)).rejects.toBeInstanceOf(BadRequestException);
    expect(embeddings.embed).not.toHaveBeenCalled();
  });

  it('混合检索：启用 hnsw.iterative_scan、过滤 NULL/嵌入版本并映射命中分块', async () => {
    const { service, embeddings, tx } = fixture({
      searchRows: [
        { document_id: DOC_ID, filename: '目录.pdf', seq: 0, text: '精密轴承规格', score: 0.83 },
      ],
    });
    const rows = await service.search(CTX, COMPANY_ID, '轴承', 10);
    expect(embeddings.embed).toHaveBeenCalledWith(['轴承']);
    const setLocalSql = (tx.$executeRaw.mock.calls[0]?.[0] as { sql?: string } | undefined)?.sql ?? '';
    expect(setLocalSql).toContain('SET LOCAL hnsw.iterative_scan = relaxed_order');
    const searchSql = (tx.$queryRaw.mock.calls[0]?.[0] as { sql?: string } | undefined)?.sql ?? '';
    expect(searchSql).toContain('c."embedding" IS NOT NULL');
    expect(searchSql).toContain('c."embed_model"');
    expect(searchSql).toContain('c."embed_version"');
    expect(searchSql).toContain('vector_candidates');
    expect(searchSql).toContain('NULLS LAST');
    expect(rows).toEqual([
      { documentId: DOC_ID, filename: '目录.pdf', seq: 0, text: '精密轴承规格', score: 0.83 },
    ]);
  });

  it('retry：租约已过期的 processing 文档允许接管重试，活跃租约仍 409', async () => {
    const { service, tx, launcher, updates } = fixture();
    tx.sellerDocument.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      companyId: COMPANY_ID,
      status: 'processing',
      objectKey: 'k',
      deletedAt: null,
      leaseUntil: new Date(Date.now() - 60_000),
    } as never);
    await service.retry(CTX, DOC_ID);
    expect(updates[0]).toMatchObject({ status: 'queued', leaseToken: null, leaseUntil: null });
    expect(launcher.launchIngest).toHaveBeenCalled();

    tx.sellerDocument.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      companyId: COMPANY_ID,
      status: 'processing',
      objectKey: 'k',
      deletedAt: null,
      leaseUntil: new Date(Date.now() + 60_000),
    } as never);
    await expect(service.retry(CTX, DOC_ID)).rejects.toBeInstanceOf(ConflictException);
  });

  it('软删置 deleted 并从列表与下载中消失', async () => {
    const { service, updates } = fixture();
    await service.softDelete(CTX, DOC_ID);
    expect(updates[0]).toMatchObject({ status: 'deleted' });
  });
});

describe('SellerDocumentsService.uploadContent（浏览器直传：引擎代传暂存区）', () => {
  function uploadFixture(row: Record<string, unknown> | null, putError?: Error) {
    const putObject = vi.fn(async () => {
      if (putError) throw putError;
    });
    const prisma = {
      withWorkspace: vi.fn(async (_ws: string, fn: (tx: unknown) => unknown) =>
        fn({
          sellerDocument: { findFirst: vi.fn(async () => row) },
        }),
      ),
    };
    const storage = { putObject };
    const service = new SellerDocumentsService(
      prisma as unknown as PrismaService,
      storage as unknown as SellerDocumentsStorage,
      {} as never,
      {} as never,
    );
    return { service, putObject };
  }

  const PENDING = {
    id: DOC_ID,
    companyId: COMPANY_ID,
    status: 'pending_upload',
    objectKey: sellerDocumentStagingKey(CTX.workspaceId, DOC_ID),
    mime: 'text/markdown',
    sizeBytes: 4n,
    deletedAt: null,
  };

  it('校验通过后把字节写进暂存对象并返回资料行', async () => {
    const { service, putObject } = uploadFixture(PENDING);
    const body = Buffer.from('# hi');
    const row = await service.uploadContent(CTX, COMPANY_ID, DOC_ID, body, 'text/markdown');
    expect(putObject).toHaveBeenCalledWith(PENDING.objectKey, body, PENDING.mime);
    expect(row).toBe(PENDING);
  });

  it('状态不是 pending_upload 时 409', async () => {
    const { service } = uploadFixture({ ...PENDING, status: 'queued' });
    await expect(
      service.uploadContent(CTX, COMPANY_ID, DOC_ID, Buffer.from('# hi'), 'text/markdown'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('声明的 MIME 与实际 Content-Type 不一致时 400', async () => {
    const { service } = uploadFixture(PENDING);
    await expect(
      service.uploadContent(CTX, COMPANY_ID, DOC_ID, Buffer.from('# hi'), 'image/png'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('字节数不等于 presign 申报大小时 400，避免静默截断', async () => {
    const { service } = uploadFixture(PENDING);
    await expect(
      service.uploadContent(CTX, COMPANY_ID, DOC_ID, Buffer.from('too long!'), 'application/markdown'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('不存在或已删除时 404', async () => {
    const { service } = uploadFixture(null);
    await expect(
      service.uploadContent(CTX, COMPANY_ID, DOC_ID, Buffer.from('# hi'), 'text/markdown'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('存储失败时 503', async () => {
    const { service } = uploadFixture(PENDING, new Error('minio down'));
    await expect(
      service.uploadContent(CTX, COMPANY_ID, DOC_ID, Buffer.from('# hi'), 'text/markdown'),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe('formatContentDisposition & SellerDocumentsService.openContentStream', () => {
  it('sanitizes ASCII, Unicode, quotes, semicolons, CR/LF, path traversal, and empty filenames', () => {
    expect(formatContentDisposition('catalog.pdf')).toBe(
      `attachment; filename="catalog.pdf"; filename*=UTF-8''catalog.pdf`,
    );
    const zh = formatContentDisposition('产品目录-2026.pdf');
    expect(zh).toContain('attachment; filename="');
    expect(zh).toContain(`filename*=UTF-8''${encodeURIComponent('产品目录-2026.pdf')}`);

    const injected = formatContentDisposition('../../a"b;c\r\nX-Evil: 1.pdf');
    expect(injected).not.toMatch(/[\r\n]/);
    expect(injected).not.toContain('/');
    expect(injected).not.toContain('\\');
    expect(injected).toMatch(/^attachment; filename="[^"]+"; filename\*=UTF-8''/);

    expect(formatContentDisposition('\x00\r\n')).toBe(
      `attachment; filename="document"; filename*=UTF-8''document`,
    );
  });

  function streamFixture(
    row: Record<string, unknown> | null,
    getObjectStream = vi.fn(async () => ({
      stream: Readable.from([Buffer.from('pdf-bytes')]),
      contentLength: 9,
      contentType: 'application/pdf',
    })),
  ) {
    const prisma = {
      withWorkspace: vi.fn(async (_ws: string, fn: (tx: unknown) => unknown) =>
        fn({
          sellerDocument: { findFirst: vi.fn(async () => row) },
        }),
      ),
    };
    const storage = { getObjectStream };
    const service = new SellerDocumentsService(
      prisma as unknown as PrismaService,
      storage as unknown as SellerDocumentsStorage,
      {} as never,
      {} as never,
    );
    return { service, getObjectStream, prisma };
  }

  const READY_DOC = {
    id: DOC_ID,
    companyId: COMPANY_ID,
    filename: '产品目录.pdf',
    mime: 'application/pdf',
    sizeBytes: 9n,
    status: 'ready',
    objectKey: 'ws/w1/companies/c1/seller-documents/d1/abc.pdf',
    deletedAt: null,
  };

  it.each(['ready', 'queued', 'processing'] as const)('opens content stream when status is %s', async (status) => {
    const { service, getObjectStream } = streamFixture({ ...READY_DOC, status });
    const opened = await service.openContentStream(CTX, DOC_ID);
    expect(getObjectStream).toHaveBeenCalledWith(READY_DOC.objectKey);
    expect(opened.mime).toBe('application/pdf');
    expect(opened.filename).toBe('产品目录.pdf');
    expect(opened.contentLength).toBe(9);
  });

  it.each(['pending_upload', 'committing', 'failed_terminal', 'rejected'] as const)(
    'throws 409 SELLER_DOCUMENT_NOT_READY when status is %s',
    async (status) => {
      const { service, getObjectStream } = streamFixture({ ...READY_DOC, status });
      await expect(service.openContentStream(CTX, DOC_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(getObjectStream).not.toHaveBeenCalled();
    },
  );

  it('throws 404 when document is missing or soft-deleted', async () => {
    const { service, getObjectStream } = streamFixture(null);
    await expect(service.openContentStream(CTX, DOC_ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(getObjectStream).not.toHaveBeenCalled();
  });

  it('maps S3 404/NoSuchKey to 404 NotFoundException and other errors to 503 SELLER_DOCUMENTS_STORAGE_UNAVAILABLE', async () => {
    const s3NotFound = streamFixture(READY_DOC, vi.fn(async () => {
      throw { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } };
    }));
    await expect(s3NotFound.service.openContentStream(CTX, DOC_ID)).rejects.toBeInstanceOf(NotFoundException);

    const s3Down = streamFixture(READY_DOC, vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    await expect(s3Down.service.openContentStream(CTX, DOC_ID)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
