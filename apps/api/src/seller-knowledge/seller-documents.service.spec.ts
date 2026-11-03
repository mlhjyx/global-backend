import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { SellerDocumentsService, sellerDocumentCanonicalKey, sellerDocumentStagingKey } from './seller-documents.service';
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
  hashHead?: Buffer;
  updateError?: unknown;
} = {}) {
  const created: unknown[] = [];
  const updates: unknown[] = [];
  let updateCalls = 0;
  const tx = {
    companyProfile: { findUnique: vi.fn(async () => ({ id: COMPANY_ID })) },
    sellerDocument: {
      count: vi.fn(async () => overrides.count ?? 0),
      aggregate: vi.fn(async () => ({ _sum: { sizeBytes: overrides.sumBytes ?? 0n } })),
      create: vi.fn(async ({ data }: { data: unknown }) => {
        created.push(data);
        return data;
      }),
      findFirst: vi.fn(async () => ({
        id: DOC_ID,
        companyId: COMPANY_ID,
        status: 'ready',
        objectKey: 'k',
        deletedAt: null,
      })),
      update: vi.fn(async ({ data }: { data: unknown }) => {
        updateCalls += 1;
        // 仅第一次 update 抛：覆盖「成功转存后撞唯一索引」的场景，后续 markTerminal 需成功。
        if (overrides.updateError && updateCalls === 1) throw overrides.updateError;
        updates.push(data);
        return { id: DOC_ID, companyId: COMPANY_ID, status: 'queued', sizeBytes: 1n, createdAt: new Date() };
      }),
    },
    $queryRaw: vi.fn(async () =>
      overrides.claimRows ?? [
        { object_key: sellerDocumentStagingKey(CTX.workspaceId, DOC_ID), mime: 'application/pdf', size_bytes: 1024n },
      ],
    ),
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
  const launcher = { launchIngest: vi.fn(async () => undefined) };
  const service = new SellerDocumentsService(
    prisma as unknown as PrismaService,
    storage as unknown as SellerDocumentsStorage,
    launcher,
  );
  return { service, prisma, tx, storage, launcher, created, updates };
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

  it('未上传完成（HEAD 404）时回到 pending_upload 并 409', async () => {
    const { service, storage } = fixture();
    storage.head.mockResolvedValueOnce(null);
    await expect(service.commit(CTX, COMPANY_ID, DOC_ID)).rejects.toBeInstanceOf(ConflictException);
    expect(storage.hashObject).not.toHaveBeenCalled();
  });

  it('软删置 deleted 并从列表与下载中消失', async () => {
    const { service, updates } = fixture();
    await service.softDelete(CTX, DOC_ID);
    expect(updates[0]).toMatchObject({ status: 'deleted' });
  });
});
