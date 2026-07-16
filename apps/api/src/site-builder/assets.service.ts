import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
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

/** commit 后进 KB 摄入队列的素材类别（图片管线随 M1）。 */
const KB_QUEUED_KINDS: ReadonlySet<string> = new Set(['doc']);

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
  private readonly log = new Logger(AssetsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async presign(ctx: RequestContext, siteId: string, input: PresignInput): Promise<PresignResult> {
    if (!isAssetKind(input.kind)) {
      throw new UnprocessableEntityException(`unsupported asset kind: ${input.kind}`);
    }
    const ext = extForMime(input.mime);
    if (!ext) throw new UnprocessableEntityException(`unsupported mime type: ${input.mime}`);
    if (!kindAcceptsMime(input.kind, input.mime)) {
      throw new UnprocessableEntityException(
        `mime ${input.mime} not allowed for kind ${input.kind}`,
      );
    }
    if (!Number.isFinite(input.size) || input.size <= 0) {
      throw new UnprocessableEntityException('invalid size');
    }
    const max = maxBytesForKind(input.kind);
    if (input.size > max) {
      throw new UnprocessableEntityException(
        `file too large for kind ${input.kind}: max ${max} bytes`,
      );
    }

    // 预签名不需要网络 I/O，但仍属于对象存储边界：先在事务外生成，避免把
    // 外部依赖/SDK 延迟带进数据库事务。URL 只有 DB 行成功创建后才会返回给客户端。
    const assetId = randomUUID();
    const stagingKey = buildStagingKey(ctx.workspaceId, siteId, assetId);
    const { url, expiresAt } = await this.storage.presignPut(stagingKey, input.mime);
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
    return { assetId, uploadUrl: url, expiresAt };
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
      await this.markRetryable(ctx, asset, fence, err);
      throw err;
    }
    if (!head) {
      await this.releasePendingUpload(ctx, asset, fence);
      throw new ConflictException('object not uploaded yet');
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
      throw new UnprocessableEntityException('uploaded object exceeds declared/kind size limit');
    }

    // 流式哈希 + 魔数头（大文件不整段进内存）
    let hashed: Awaited<ReturnType<StorageService['hashObject']>>;
    try {
      hashed = await this.storage.hashObject(stagingKey);
    } catch (err) {
      await this.markRetryable(ctx, asset, fence, err);
      throw err;
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
      throw new UnprocessableEntityException('file content does not match declared type');
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
      throw new ConflictException(`duplicate content: already uploaded as asset ${duplicate.id}`);
    }

    try {
      // canonical key 来自内容哈希；同源重试/并发 copy 到同一 key 是幂等的。
      await this.storage.copy(stagingKey, canonicalKey);
    } catch (err) {
      await this.markRetryable(ctx, asset, fence, err);
      throw err;
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
          throw new ConflictException(`duplicate content: already uploaded as asset ${winner.id}`);
        }
      }
      await this.markRetryable(ctx, asset, fence, err);
      throw err;
    }

    if (!committed) throw new ConflictException('asset commit lease was superseded');
    await this.deleteStagingBestEffort(stagingKey);
    return committed;
  }

  async list(ctx: RequestContext, siteId: string, kind?: string): Promise<Asset[]> {
    return this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.asset.findMany({
        where: { siteId, deletedAt: null, ...(kind ? { kind } : {}) },
        orderBy: { createdAt: 'asc' },
      }),
    );
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
        throw new ConflictException('asset is currently being committed or processed');
      }
      // chunk 由 KbDocument FK 级联；同事务移除检索面，避免已删资料继续被命中。
      await tx.kbDocument.deleteMany({ where: { assetId } });
      await this.createCleanupIntent(tx, ctx, asset, asset.objectKey, objectClass, 'asset_deleted');
      return { objectKey: asset.objectKey, objectClass };
    });
    if (target.objectClass === 'staging') await this.deleteStagingBestEffort(target.objectKey);
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
    throw new ConflictException(`asset already ${current.processingStatus}`);
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
    if (moved.count !== 1) throw new ConflictException('asset commit lease was superseded');
  }

  private async markRetryable(
    ctx: RequestContext,
    asset: Asset,
    fence: { token: string; attempt: number },
    err: unknown,
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
          error: message.slice(0, 2000),
        },
      }),
    );
    if (moved.count !== 1) throw new ConflictException('asset commit lease was superseded');
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
    if (moved.count !== 1) throw new ConflictException('asset commit lease was superseded');
    await this.deleteStagingBestEffort(asset.objectKey);
  }

  /**
   * R2-A1 only records durable cleanup truth. parkedAt is intentional: R2-A4 will register
   * the internal command, redrive these rows and run the Temporal consumer. Canonical payloads
   * additionally carry the MF-0 scanner gate and must remain non-executable until then.
   */
  private async createCleanupIntent(
    tx: {
      outboxEvent: {
        create(args: { data: Record<string, unknown> }): Promise<unknown>;
      };
    },
    ctx: RequestContext,
    asset: Pick<Asset, 'id' | 'siteId'>,
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
        parkedAt: new Date(),
        payload: {
          assetId: asset.id,
          siteId: asset.siteId,
          objectKey,
          objectClass,
          reason,
          ...(objectClass === 'canonical'
            ? { blockedUntil: 'site_spec_asset_reference_scanner' }
            : {}),
        },
      },
    });
  }

  private async deleteStagingBestEffort(stagingKey: string): Promise<void> {
    try {
      await this.storage.delete(stagingKey);
    } catch (err) {
      this.log.warn(
        `staging cleanup failed for ${stagingKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private isStagingKey(objectKey: string): boolean {
    return objectKey.includes('/uploads/');
  }

  private isUniqueConstraintError(err: unknown): boolean {
    return Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'P2002');
  }
}
