import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestContext } from '../auth/request-context';
import { mimeMatchesSniffed, sniffMime } from '../site-builder/object-key';
import { SellerDocumentsStorage } from './seller-documents.storage';

/** 允许的资料类型 → kind 与单文件上限（字节）。HTML/SVG/可执行类永不入列。 */
const MIME_KIND: Record<string, { kind: string; maxBytes: number }> = {
  'application/pdf': { kind: 'pdf', maxBytes: 50 * 1024 * 1024 },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    kind: 'docx',
    maxBytes: 50 * 1024 * 1024,
  },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
    kind: 'pptx',
    maxBytes: 50 * 1024 * 1024,
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    kind: 'other',
    maxBytes: 50 * 1024 * 1024,
  },
  'text/plain': { kind: 'txt', maxBytes: 10 * 1024 * 1024 },
  'text/markdown': { kind: 'md', maxBytes: 10 * 1024 * 1024 },
};

const EXT_FOR_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'txt',
  'text/markdown': 'md',
};

/** 配额（env 可调）：每空间 500 份 / 2 GiB、每公司 200 份（PRD §7 默认值）。 */
const QUOTA = Object.freeze({
  perWorkspace: envInt('SELLER_DOCUMENTS_MAX_PER_WORKSPACE', 500),
  perCompany: envInt('SELLER_DOCUMENTS_MAX_PER_COMPANY', 200),
  bytesPerWorkspace: envInt('SELLER_DOCUMENTS_MAX_BYTES_PER_WORKSPACE', 2 * 1024 * 1024 * 1024),
});

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const SIZE_TOLERANCE = 1.05;
const SIZE_SLACK_BYTES = 1024;

export function sellerDocumentStagingKey(workspaceId: string, documentId: string): string {
  return `ws/${workspaceId}/seller-documents/staging/${documentId}`;
}

export function sellerDocumentCanonicalKey(
  workspaceId: string,
  companyId: string,
  documentId: string,
  sha256: string,
  ext: string,
): string {
  return `ws/${workspaceId}/companies/${companyId}/seller-documents/${documentId}/${sha256}.${ext}`;
}

/** ingest 工作流启动器（2b 接 Temporal；本 PR 用占位实现，文档停在 queued）。 */
export const SELLER_DOCUMENTS_INGEST_LAUNCHER = Symbol('SELLER_DOCUMENTS_INGEST_LAUNCHER');
export interface SellerDocumentsIngestLauncher {
  launchIngest(input: { workspaceId: string; companyId: string; documentId: string }): Promise<void>;
}

type SellerDocumentRow = Prisma.SellerDocumentGetPayload<Record<string, never>>;

function storageUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    error: { code: 'SELLER_DOCUMENTS_STORAGE_UNAVAILABLE', message: '资料存储暂时不可用，请稍后重试' },
  });
}

@Injectable()
export class SellerDocumentsService {
  private readonly log = new Logger(SellerDocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SellerDocumentsStorage,
    @Inject(SELLER_DOCUMENTS_INGEST_LAUNCHER)
    private readonly launcher: SellerDocumentsIngestLauncher,
  ) {}

  async presign(
    ctx: RequestContext,
    companyId: string,
    input: { filename: string; mime: string; size: number },
  ): Promise<{ documentId: string; uploadUrl: string; expiresAt: Date }> {
    const spec = MIME_KIND[input.mime];
    if (!spec) {
      throw new BadRequestException({
        error: { code: 'UNSUPPORTED_DOCUMENT_TYPE', message: '仅支持 PDF/Word/PPT/Excel/纯文本/Markdown' },
      });
    }
    if (input.size > spec.maxBytes) {
      throw new BadRequestException({
        error: { code: 'DOCUMENT_TOO_LARGE', message: `该类型单文件上限 ${Math.floor(spec.maxBytes / 1024 / 1024)}MB` },
      });
    }
    const documentId = randomUUID();
    const stagingKey = sellerDocumentStagingKey(ctx.workspaceId, documentId);

    await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.companyProfile.findUnique({
        where: { id: companyId },
        select: { id: true },
      });
      if (!company) throw new NotFoundException('company not found');
      const [workspaceCount, workspaceBytes, companyCount] = await Promise.all([
        tx.sellerDocument.count({ where: { deletedAt: null } }),
        tx.sellerDocument.aggregate({ where: { deletedAt: null }, _sum: { sizeBytes: true } }),
        tx.sellerDocument.count({ where: { companyId, deletedAt: null } }),
      ]);
      if (workspaceCount >= QUOTA.perWorkspace || companyCount >= QUOTA.perCompany) {
        throw new ConflictException({
          error: { code: 'SELLER_DOCUMENT_QUOTA_EXCEEDED', message: '资料数量已达上限，请删除旧资料后重试' },
        });
      }
      const usedBytes = Number(workspaceBytes._sum.sizeBytes ?? 0n);
      if (usedBytes + input.size > QUOTA.bytesPerWorkspace) {
        throw new ConflictException({
          error: { code: 'SELLER_DOCUMENT_QUOTA_EXCEEDED', message: '资料存储空间已达上限，请删除旧资料后重试' },
        });
      }
      await tx.sellerDocument.create({
        data: {
          id: documentId,
          workspaceId: ctx.workspaceId,
          companyId,
          uploadedBy: ctx.userId,
          filename: input.filename,
          mime: input.mime,
          sizeBytes: BigInt(input.size),
          kind: spec.kind,
          objectKey: stagingKey,
          status: 'pending_upload',
        },
      });
    });

    let signed: { url: string; expiresAt: Date };
    try {
      signed = await this.storage.presignPut(stagingKey, input.mime);
    } catch {
      throw storageUnavailable();
    }
    return { documentId, uploadUrl: signed.url, expiresAt: signed.expiresAt };
  }

  async commit(ctx: RequestContext, companyId: string, documentId: string): Promise<SellerDocumentRow> {
    const claimed = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.$queryRaw<Array<{ object_key: string; mime: string; size_bytes: bigint }>>(Prisma.sql`
        UPDATE "seller_document"
        SET "status" = 'committing',
            "processing_attempt" = "processing_attempt" + 1,
            "lease_token" = ${randomUUID()}::uuid,
            "lease_until" = now() + interval '10 minutes',
            "updated_at" = now()
        WHERE "id" = ${documentId}::uuid
          AND "workspace_id" = ${ctx.workspaceId}::uuid
          AND "company_id" = ${companyId}::uuid
          AND "status" = 'pending_upload'
          AND "deleted_at" IS NULL
        RETURNING "object_key", "mime", "size_bytes"
      `),
    );
    if (claimed.length === 0) {
      const existing = await this.findActive(ctx, documentId);
      if (!existing || existing.companyId !== companyId) throw new NotFoundException('document not found');
      if (existing.status === 'queued' || existing.status === 'processing' || existing.status === 'ready') {
        return existing;
      }
      throw new ConflictException({
        error: { code: 'SELLER_DOCUMENT_NOT_UPLOADABLE', message: '该资料不处于待上传状态' },
      });
    }
    const { object_key: stagingKey, mime, size_bytes: declaredSize } = claimed[0];

    let head: { size: number } | null;
    let hashed: { sha256: string; head: Buffer; size: number };
    try {
      head = await this.storage.head(stagingKey);
      if (!head) {
        await this.resetToPendingUpload(ctx, documentId);
        throw new ConflictException({
          error: { code: 'SELLER_DOCUMENT_UPLOAD_INCOMPLETE', message: '尚未检测到上传完成，请重试' },
        });
      }
      hashed = await this.storage.hashObject(stagingKey);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      await this.resetToPendingUpload(ctx, documentId);
      throw storageUnavailable();
    }

    const spec = MIME_KIND[mime];
    const declaredCap = Number(declaredSize) * SIZE_TOLERANCE + SIZE_SLACK_BYTES;
    if (!spec || hashed.size > spec.maxBytes || hashed.size > declaredCap) {
      await this.markTerminal(ctx, documentId, 'rejected', 'SIZE_OR_TYPE_MISMATCH');
      throw new BadRequestException({
        error: { code: 'SELLER_DOCUMENT_REJECTED', message: '文件大小或内容与声明不符' },
      });
    }
    const sniffed = sniffMime(hashed.head);
    if (!mimeMatchesSniffed(mime, sniffed)) {
      await this.markTerminal(ctx, documentId, 'rejected', 'CONTENT_TYPE_MISMATCH');
      throw new BadRequestException({
        error: { code: 'SELLER_DOCUMENT_REJECTED', message: '文件内容与声明的类型不符' },
      });
    }

    const ext = EXT_FOR_MIME[mime] ?? 'bin';
    const canonicalKey = sellerDocumentCanonicalKey(ctx.workspaceId, companyId, documentId, hashed.sha256, ext);
    try {
      await this.storage.copy(stagingKey, canonicalKey);
    } catch {
      await this.resetToPendingUpload(ctx, documentId);
      throw storageUnavailable();
    }

    let committed: SellerDocumentRow;
    try {
      committed = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
        tx.sellerDocument.update({
          where: { id: documentId },
          data: {
            objectKey: canonicalKey,
            contentHash: hashed.sha256,
            status: 'queued',
            leaseToken: null,
            leaseUntil: null,
            retryAt: null,
            processingErrorCode: null,
            processingStage: null,
          },
        }),
      );
    } catch (error) {
      // 部分唯一索引（活跃内容）冲突：同一公司下已存在同一份文件（按稳定错误码判定，
      // 不依赖 Prisma 错误类在运行时入口间的 instanceof 一致性）。
      if ((error as { code?: string }).code === 'P2002') {
        await this.markTerminal(ctx, documentId, 'rejected', 'DUPLICATE_CONTENT');
        await this.storage.delete(canonicalKey).catch(() => undefined);
        throw new ConflictException({
          error: { code: 'SELLER_DOCUMENT_DUPLICATE', message: '公司已存在相同内容的资料' },
        });
      }
      throw error;
    }
    await this.storage.delete(stagingKey).catch(() => undefined);
    await this.launchIngest(ctx, companyId, documentId);
    return committed;
  }

  async list(ctx: RequestContext, companyId: string, limit: number, cursor?: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const rows = await tx.sellerDocument.findMany({
        where: { companyId, deletedAt: null },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      return { data, nextCursor: hasMore ? data[data.length - 1].id : null, hasMore };
    });
  }

  async get(ctx: RequestContext, documentId: string): Promise<SellerDocumentRow> {
    const row = await this.findActive(ctx, documentId);
    if (!row) throw new NotFoundException('document not found');
    return row;
  }

  async downloadUrl(ctx: RequestContext, documentId: string): Promise<string> {
    const row = await this.get(ctx, documentId);
    if (row.status !== 'ready' && row.status !== 'queued' && row.status !== 'processing') {
      throw new ConflictException({
        error: { code: 'SELLER_DOCUMENT_NOT_READY', message: '资料尚未上传完成' },
      });
    }
    try {
      return await this.storage.presignGet(row.objectKey);
    } catch {
      throw storageUnavailable();
    }
  }

  async retry(ctx: RequestContext, documentId: string): Promise<SellerDocumentRow> {
    const row = await this.get(ctx, documentId);
    if (row.status !== 'failed_terminal' && row.status !== 'queued') {
      throw new ConflictException({
        error: { code: 'SELLER_DOCUMENT_NOT_RETRYABLE', message: '只有失败或排队中的资料可以重试' },
      });
    }
    const updated = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.sellerDocument.update({
        where: { id: documentId },
        data: { status: 'queued', retryAt: null, processingErrorCode: null },
      }),
    );
    await this.launchIngest(ctx, row.companyId, documentId);
    return updated;
  }

  async softDelete(ctx: RequestContext, documentId: string): Promise<SellerDocumentRow> {
    const row = await this.get(ctx, documentId);
    if (row.status === 'deleted') return row;
    const updated = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.sellerDocument.update({
        where: { id: documentId },
        data: { status: 'deleted', deletedAt: new Date(), deletedBy: ctx.userId },
      }),
    );
    // 物理清理（chunk/对象）由 Phase 2b 的清理管线按 deleted_at 扫描；chunk 先随文档级联不可见。
    return updated;
  }

  private async findActive(ctx: RequestContext, documentId: string): Promise<SellerDocumentRow | null> {
    return this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.sellerDocument.findFirst({ where: { id: documentId, deletedAt: null } }),
    );
  }

  private async resetToPendingUpload(ctx: RequestContext, documentId: string): Promise<void> {
    await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.sellerDocument.update({
        where: { id: documentId },
        data: { status: 'pending_upload', leaseToken: null, leaseUntil: null },
      }),
    );
  }

  private async markTerminal(
    ctx: RequestContext,
    documentId: string,
    status: 'rejected',
    code: string,
  ): Promise<void> {
    await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.sellerDocument.update({
        where: { id: documentId },
        data: { status, processingErrorCode: code, leaseToken: null, leaseUntil: null },
      }),
    );
  }

  private async launchIngest(ctx: RequestContext, companyId: string, documentId: string): Promise<void> {
    try {
      await this.launcher.launchIngest({
        workspaceId: ctx.workspaceId,
        companyId,
        documentId,
      });
    } catch (error) {
      // 启动失败不回滚提交：文档停在 queued，2b 的对账/扫描会捡起；此处只记日志与错误码。
      this.log.warn(`seller document ingest launch failed (${documentId}): ${String(error)}`);
      await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
        tx.sellerDocument.update({
          where: { id: documentId },
          data: { processingErrorCode: 'INGEST_LAUNCH_UNAVAILABLE' },
        }),
      );
    }
  }
}
