import {
  BadGatewayException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Asset } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';
import {
  AssetKind,
  buildObjectKey,
  buildStagingKey,
  extForMime,
  isAssetKind,
  kindAcceptsMime,
  maxBytesForKind,
  mimeMatchesSniffed,
  sniffMime,
} from './object-key';
import { StorageService } from './storage.service';

/** 声明大小的容差：直传字节数与 presign 声明差异超过此比例+固定余量即拒。 */
const SIZE_TOLERANCE_RATIO = 1.05;
const SIZE_TOLERANCE_BYTES = 1024;
const MAGIC_HEAD_BYTES = 16;
const COMMIT_LEASE_MS = 15 * 60 * 1000;
const COMMIT_RETRY_DELAY_MS = 30 * 1000;
/** presignPut 的开发/生产统一有效期；cleanup 必须等旧 URL 失效，防晚到 PUT 复活孤儿。 */
const PRESIGN_PUT_TTL_MS = 15 * 60 * 1000;

/** commit 后进 KB 摄入队列的素材类别（图片管线随 M1）。 */
const KB_QUEUED_KINDS: ReadonlySet<string> = new Set(['doc']);

type AssetPublicErrorCode =
  | 'ASSET_VALIDATION_FAILED'
  | 'ASSET_UPLOAD_INCOMPLETE'
  | 'ASSET_DUPLICATE'
  | 'ASSET_STATE_CONFLICT'
  | 'ASSET_BUSY'
  | 'ASSET_STORAGE_UNAVAILABLE'
  | 'ASSET_COMMIT_UNAVAILABLE';

function assetErrorBody(
  code: AssetPublicErrorCode,
  message: string,
  details?: Record<string, unknown>,
): { error: { code: AssetPublicErrorCode; message: string; details?: Record<string, unknown> } } {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

function assetValidationError(reason: string, message: string): UnprocessableEntityException {
  return new UnprocessableEntityException(
    assetErrorBody('ASSET_VALIDATION_FAILED', message, { reason }),
  );
}

function assetConflict(
  code: Extract<
    AssetPublicErrorCode,
    'ASSET_UPLOAD_INCOMPLETE' | 'ASSET_DUPLICATE' | 'ASSET_STATE_CONFLICT' | 'ASSET_BUSY'
  >,
  message: string,
): ConflictException {
  return new ConflictException(assetErrorBody(code, message));
}

function assetStorageUnavailable(): BadGatewayException {
  return new BadGatewayException(
    assetErrorBody(
      'ASSET_STORAGE_UNAVAILABLE',
      'asset storage is temporarily unavailable; retry later',
    ),
  );
}

function assetCommitUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException(
    assetErrorBody(
      'ASSET_COMMIT_UNAVAILABLE',
      'asset commit is temporarily unavailable; retry later',
    ),
  );
}

export interface PresignInput {
  kind: string;
  filename: string;
  size: number;
  mime: string;
}

export interface PresignResult {
  assetId: string;
  uploadUrl: string;
  expiresAt: Date;
}

/**
 * 素材上传三步（07 §3）：presign（校验+建行）→ 前端 PUT 直传 staging →
 * commit（魔数/大小/去重闸 → sha256 → 搬 canonical）。安全闸见 06 §2。
 */
@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async presign(ctx: RequestContext, siteId: string, input: PresignInput): Promise<PresignResult> {
    if (!isAssetKind(input.kind)) {
      throw assetValidationError('unsupported_kind', 'unsupported asset kind');
    }
    const ext = extForMime(input.mime);
    if (!ext) throw assetValidationError('unsupported_mime', 'unsupported asset mime type');
    if (!kindAcceptsMime(input.kind, input.mime)) {
      throw assetValidationError('kind_mime_mismatch', 'asset mime type is not valid for kind');
    }
    if (!Number.isFinite(input.size) || input.size <= 0) {
      throw assetValidationError('invalid_size', 'asset size must be positive');
    }
    const max = maxBytesForKind(input.kind);
    if (input.size > max) {
      throw assetValidationError('size_limit_exceeded', 'asset exceeds the size limit');
    }

    // UUIDs are not capabilities. Resolve the parent through workspace RLS before touching
    // object storage so a hidden/missing site cannot create a signed staging namespace.
    const visible = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.site.findUnique({ where: { id: siteId }, select: { id: true } }),
    );
    if (!visible) throw new NotFoundException('site not found');

    // 预签名不需要网络 I/O，但仍属于对象存储边界：先在事务外生成，避免把
    // 外部依赖/SDK 延迟带进数据库事务。URL 只有 DB 行成功创建后才会返回给客户端。
    const assetId = randomUUID();
    const stagingKey = buildStagingKey(ctx.workspaceId, siteId, assetId);
    let signed: Awaited<ReturnType<StorageService['presignPut']>>;
    try {
      signed = await this.storage.presignPut(stagingKey, input.mime);
    } catch {
      throw assetStorageUnavailable();
    }
    await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const site = await tx.site.findUnique({ where: { id: siteId }, select: { id: true } });
      if (!site) throw new NotFoundException('site not found');
      await tx.asset.create({
        data: {
          id: assetId,
          workspaceId: ctx.workspaceId,
          siteId,
          kind: input.kind,
          filename: input.filename,
          mime: input.mime,
          sizeBytes: input.size,
          objectKey: stagingKey,
          processingStatus: 'pending_upload',
        },
      });
    });
    return { assetId, uploadUrl: signed.url, expiresAt: signed.expiresAt };
  }

  /**
   * R2-A1 commit：短事务 CAS 认领 → 事务外校验/copy → fenced 短事务落 canonical 真值
   * → 事务外清 staging。每次认领都有 attempt + UUID token；旧持有者即使在 lease
   * 过期后继续运行，也无法回写或删除新持有者仍依赖的 staging 对象。
   */
  async commit(ctx: RequestContext, assetId: string): Promise<Asset> {
    const asset = await this.claimCommit(ctx, assetId);
    const fence = { token: asset.leaseToken!, attempt: asset.processingAttempt };
    const stagingKey = asset.objectKey;
    let head: Awaited<ReturnType<StorageService['head']>>;
    try {
      head = await this.storage.head(stagingKey);
    } catch (err) {
      await this.markRetryable(ctx, asset, fence, err, 'ASSET_STORAGE_UNAVAILABLE');
      throw assetStorageUnavailable();
    }
    if (!head) {
      await this.releasePendingUpload(ctx, asset, fence);
      throw assetConflict('ASSET_UPLOAD_INCOMPLETE', 'asset upload is not complete');
    }

    const kind = asset.kind as AssetKind;
    const max = maxBytesForKind(kind);
    const declaredCap = asset.sizeBytes * SIZE_TOLERANCE_RATIO + SIZE_TOLERANCE_BYTES;
    if (head.size > max || head.size > declaredCap) {
      await this.markTerminalWithCleanup(
        ctx,
        asset,
        fence,
        'rejected',
        `uploaded size ${head.size} exceeds limit`,
      );
      throw assetValidationError('size_mismatch', 'uploaded asset exceeds its declared size');
    }

    // 流式哈希 + 魔数头（大文件不整段进内存）
    let hashed: Awaited<ReturnType<StorageService['hashObject']>>;
    try {
      hashed = await this.storage.hashObject(stagingKey);
    } catch (err) {
      await this.markRetryable(ctx, asset, fence, err, 'ASSET_STORAGE_UNAVAILABLE');
      throw assetStorageUnavailable();
    }
    const { sha256, head: magicHead } = hashed;
    const sniffed = sniffMime(magicHead.subarray(0, MAGIC_HEAD_BYTES));
    if (!mimeMatchesSniffed(asset.mime, sniffed) || !kindAcceptsMime(kind, asset.mime)) {
      await this.markTerminalWithCleanup(
        ctx,
        asset,
        fence,
        'rejected',
        `content does not match declared ${asset.mime}`,
      );
      throw assetValidationError('content_type_mismatch', 'asset content does not match its type');
    }

    const ext = extForMime(asset.mime) ?? 'bin';
    const canonicalKey = buildObjectKey(ctx.workspaceId, asset.siteId, kind, sha256, ext);
    const duplicate = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.asset.findFirst({
        where: { objectKey: canonicalKey, deletedAt: null, NOT: { id: assetId } },
        select: { id: true },
      }),
    );
    if (duplicate) {
      await this.markTerminalWithCleanup(
        ctx,
        asset,
        fence,
        'duplicate',
        `duplicate content of asset ${duplicate.id}`,
        sha256,
      );
      throw assetConflict('ASSET_DUPLICATE', 'asset content has already been uploaded');
    }

    try {
      // canonical key 来自内容哈希；同源重试/并发 copy 到同一 key 是幂等的。
      await this.storage.copy(stagingKey, canonicalKey);
    } catch (err) {
      await this.markRetryable(ctx, asset, fence, err, 'ASSET_STORAGE_UNAVAILABLE');
      throw assetStorageUnavailable();
    }

    const nextStatus = KB_QUEUED_KINDS.has(kind) ? 'queued' : 'ready';
    let committed: Asset | null;
    try {
      committed = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
        const moved = await tx.asset.updateMany({
          where: {
            id: assetId,
            processingStatus: 'committing',
            processingAttempt: fence.attempt,
            leaseToken: fence.token,
            deletedAt: null,
          },
          data: {
            objectKey: canonicalKey,
            contentHash: sha256,
            processingStatus: nextStatus,
            leaseToken: null,
            leaseUntil: null,
            retryAt: null,
            error: null,
          },
        });
        if (moved.count !== 1) return null;
        await this.createCleanupIntent(tx, ctx, asset, stagingKey, 'staging', 'commit_succeeded');
        return tx.asset.findUnique({ where: { id: assetId } });
      });
    } catch (err) {
      if (this.isUniqueConstraintError(err)) {
        const winner = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
          tx.asset.findFirst({
            where: { objectKey: canonicalKey, deletedAt: null, NOT: { id: assetId } },
            select: { id: true },
          }),
        );
        if (winner) {
          await this.markTerminalWithCleanup(
            ctx,
            asset,
            fence,
            'duplicate',
            `duplicate content of asset ${winner.id}`,
            sha256,
          );
          throw assetConflict('ASSET_DUPLICATE', 'asset content has already been uploaded');
        }
      }
      await this.markRetryable(ctx, asset, fence, err, 'ASSET_COMMIT_UNAVAILABLE');
      throw assetCommitUnavailable();
    }

    if (!committed) {
      throw assetConflict('ASSET_STATE_CONFLICT', 'asset state changed; refresh and retry');
    }
    return committed;
  }

  async list(ctx: RequestContext, siteId: string, kind?: string): Promise<Asset[]> {
    if (kind && !isAssetKind(kind)) {
      throw assetValidationError('unsupported_kind', 'unsupported asset kind');
    }
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const site = await tx.site.findUnique({ where: { id: siteId }, select: { id: true } });
      if (!site) throw new NotFoundException('site not found');
      return tx.asset.findMany({
        where: { siteId, deletedAt: null, ...(kind ? { kind } : {}) },
        orderBy: { createdAt: 'asc' },
      });
    });
  }

  /**
   * R2-A1 删除只做 DB tombstone + durable cleanup intent。MF-0 引用扫描器落地前，
   * canonical intent 明确 parked，绝不执行对象删除；staging 可在事务提交后 best-effort 删。
   */
  async remove(ctx: RequestContext, assetId: string): Promise<void> {
    const target = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const asset = await tx.asset.findUnique({ where: { id: assetId } });
      if (!asset || asset.deletedAt) throw new NotFoundException('asset not found');
      const objectClass = this.isStagingKey(asset.objectKey) ? 'staging' : 'canonical';
      const moved = await tx.asset.updateMany({
        // 与 commit/KB claim 做同一行 CAS：进行中的 worker 必须先完成或释放，
        // 否则 delete 可能在 copy 已完成、canonical 尚未回写的窗口制造不可追踪孤儿。
        where: {
          id: assetId,
          deletedAt: null,
          processingStatus: { notIn: ['committing', 'processing'] },
        },
        data: {
          processingStatus: 'deleted',
          deletedAt: new Date(),
          leaseToken: null,
          leaseUntil: null,
          retryAt: null,
          processingErrorCode: null,
        },
      });
      if (moved.count !== 1) {
        throw assetConflict('ASSET_BUSY', 'asset is currently being processed');
      }
      // chunk 由 KbDocument FK 级联；同事务移除检索面，避免已删资料继续被命中。
      await tx.kbDocument.deleteMany({ where: { assetId } });
      await this.createCleanupIntent(tx, ctx, asset, asset.objectKey, objectClass, 'asset_deleted');
      return { objectKey: asset.objectKey, objectClass };
    });
    void target;
  }

  private async claimCommit(ctx: RequestContext, assetId: string): Promise<Asset> {
    const token = randomUUID();
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + COMMIT_LEASE_MS);
    const claimed = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const moved = await tx.asset.updateMany({
        where: {
          id: assetId,
          deletedAt: null,
          OR: [
            { processingStatus: 'pending_upload' },
            {
              processingStatus: 'failed_retryable',
              // failed_retryable is an A1 commit-stage state: canonical KB failures use
              // queued+retryAt. Never feed an already-canonical object back through commit.
              contentHash: null,
              OR: [{ retryAt: null }, { retryAt: { lte: now } }],
            },
            { processingStatus: 'committing', leaseUntil: { lte: now } },
          ],
        },
        data: {
          processingStatus: 'committing',
          processingAttempt: { increment: 1 },
          leaseToken: token,
          leaseUntil,
          retryAt: null,
          processingErrorCode: null,
          error: null,
        },
      });
      if (moved.count !== 1) return null;
      return tx.asset.findUnique({ where: { id: assetId } });
    });
    if (claimed) return claimed;

    const current = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.asset.findUnique({ where: { id: assetId } }),
    );
    if (!current || current.deletedAt) throw new NotFoundException('asset not found');
    throw assetConflict('ASSET_STATE_CONFLICT', 'asset state does not allow commit');
  }

  private async releasePendingUpload(
    ctx: RequestContext,
    asset: Asset,
    fence: { token: string; attempt: number },
  ): Promise<void> {
    const moved = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.asset.updateMany({
        where: {
          id: asset.id,
          processingStatus: 'committing',
          processingAttempt: fence.attempt,
          leaseToken: fence.token,
        },
        data: {
          processingStatus: 'pending_upload',
          leaseToken: null,
          leaseUntil: null,
          retryAt: null,
        },
      }),
    );
    if (moved.count !== 1) {
      throw assetConflict('ASSET_STATE_CONFLICT', 'asset state changed; refresh and retry');
    }
  }

  private async markRetryable(
    ctx: RequestContext,
    asset: Asset,
    fence: { token: string; attempt: number },
    err: unknown,
    processingErrorCode:
      | 'ASSET_STORAGE_UNAVAILABLE'
      | 'ASSET_STATE_CONFLICT'
      | 'ASSET_COMMIT_UNAVAILABLE',
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const moved = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.asset.updateMany({
        where: {
          id: asset.id,
          processingStatus: 'committing',
          processingAttempt: fence.attempt,
          leaseToken: fence.token,
        },
        data: {
          processingStatus: 'failed_retryable',
          leaseToken: null,
          leaseUntil: null,
          retryAt: new Date(Date.now() + COMMIT_RETRY_DELAY_MS),
          processingErrorCode,
          error: message.slice(0, 2000),
        },
      }),
    );
    if (moved.count !== 1) {
      throw assetConflict('ASSET_STATE_CONFLICT', 'asset state changed; refresh and retry');
    }
  }

  private async markTerminalWithCleanup(
    ctx: RequestContext,
    asset: Asset,
    fence: { token: string; attempt: number },
    status: 'rejected' | 'duplicate',
    error: string,
    contentHash?: string,
  ): Promise<void> {
    const moved = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const result = await tx.asset.updateMany({
        where: {
          id: asset.id,
          processingStatus: 'committing',
          processingAttempt: fence.attempt,
          leaseToken: fence.token,
        },
        data: {
          processingStatus: status,
          contentHash,
          processingErrorCode:
            status === 'duplicate' ? 'ASSET_DUPLICATE' : 'ASSET_VALIDATION_FAILED',
          leaseToken: null,
          leaseUntil: null,
          retryAt: null,
          error,
        },
      });
      if (result.count !== 1) return result;
      await this.createCleanupIntent(tx, ctx, asset, asset.objectKey, 'staging', status);
      return result;
    });
    if (moved.count !== 1) {
      throw assetConflict('ASSET_STATE_CONFLICT', 'asset state changed; refresh and retry');
    }
  }

  /**
   * R2-A4 routes staging cleanup to Temporal, but only after the original presigned PUT URL
   * has expired. Canonical payloads remain parked behind the MF-0 reference-scanner gate.
   */
  private async createCleanupIntent(
    tx: {
      outboxEvent: {
        create(args: { data: Record<string, unknown> }): Promise<unknown>;
      };
    },
    ctx: RequestContext,
    asset: Pick<Asset, 'id' | 'siteId' | 'createdAt'>,
    objectKey: string,
    objectClass: 'staging' | 'canonical',
    reason: string,
  ): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        workspaceId: ctx.workspaceId,
        eventType: 'AssetObjectCleanupRequested',
        schemaVersion: 1,
        aggregateType: 'Asset',
        aggregateId: asset.id,
        privacyClassification: 'INTERNAL',
        parkedAt: objectClass === 'canonical' ? new Date() : null,
        payload: {
          assetId: asset.id,
          siteId: asset.siteId,
          objectKey,
          objectClass,
          reason,
          ...(objectClass === 'staging'
            ? { notBefore: new Date(asset.createdAt.getTime() + PRESIGN_PUT_TTL_MS).toISOString() }
            : {}),
          ...(objectClass === 'canonical'
            ? { blockedUntil: 'site_spec_asset_reference_scanner' }
            : {}),
        },
      },
    });
  }

  private isStagingKey(objectKey: string): boolean {
    return objectKey.includes('/uploads/');
  }

  private isUniqueConstraintError(err: unknown): boolean {
    return Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'P2002');
  }
}
