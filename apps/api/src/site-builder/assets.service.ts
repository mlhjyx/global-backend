import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Asset, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';
import {
  AssetKind,
  buildObjectKey,
  buildStagingKey,
  extForMime,
  isAssetKind,
  maxBytesForKind,
  mimeMatchesSniffed,
  sniffMime,
} from './object-key';
import { StorageService } from './storage.service';

/** 声明大小的容差：直传字节数与 presign 声明差异超过此比例+固定余量即拒。 */
const SIZE_TOLERANCE_RATIO = 1.05;
const SIZE_TOLERANCE_BYTES = 1024;
const MAGIC_HEAD_BYTES = 16;

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
    if (!Number.isFinite(input.size) || input.size <= 0) {
      throw new UnprocessableEntityException('invalid size');
    }
    const max = maxBytesForKind(input.kind);
    if (input.size > max) {
      throw new UnprocessableEntityException(
        `file too large for kind ${input.kind}: max ${max} bytes`,
      );
    }

    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const site = await tx.site.findUnique({ where: { id: siteId }, select: { id: true } });
      if (!site) throw new NotFoundException('site not found');
      const assetId = randomUUID();
      const stagingKey = buildStagingKey(ctx.workspaceId, siteId, assetId);
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
      const { url, expiresAt } = await this.storage.presignPut(stagingKey, input.mime);
      return { assetId, uploadUrl: url, expiresAt };
    });
  }

  async commit(ctx: RequestContext, assetId: string): Promise<Asset> {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const asset = await tx.asset.findUnique({ where: { id: assetId } });
      if (!asset) throw new NotFoundException('asset not found');
      if (asset.processingStatus !== 'pending_upload') {
        throw new ConflictException(`asset already ${asset.processingStatus}`);
      }
      const stagingKey = asset.objectKey;
      const head = await this.storage.head(stagingKey);
      if (!head) throw new ConflictException('object not uploaded yet');

      const kind = asset.kind as AssetKind;
      const max = maxBytesForKind(kind);
      const declaredCap = asset.sizeBytes * SIZE_TOLERANCE_RATIO + SIZE_TOLERANCE_BYTES;
      if (head.size > max || head.size > declaredCap) {
        await this.reject(tx, assetId, stagingKey, `uploaded size ${head.size} exceeds limit`);
        throw new UnprocessableEntityException('uploaded object exceeds declared/kind size limit');
      }

      const buffer = await this.storage.getBuffer(stagingKey);
      const sniffed = sniffMime(buffer.subarray(0, MAGIC_HEAD_BYTES));
      if (!mimeMatchesSniffed(asset.mime, sniffed)) {
        await this.reject(tx, assetId, stagingKey, `content does not match declared ${asset.mime}`);
        throw new UnprocessableEntityException('file content does not match declared type');
      }

      const contentHash = createHash('sha256').update(buffer).digest('hex');
      const ext = extForMime(asset.mime) ?? 'bin';
      const canonicalKey = buildObjectKey(ctx.workspaceId, asset.siteId, kind, contentHash, ext);

      const duplicate = await tx.asset.findFirst({
        where: { objectKey: canonicalKey },
        select: { id: true },
      });
      if (duplicate) {
        await this.reject(tx, assetId, stagingKey, `duplicate content of asset ${duplicate.id}`);
        throw new ConflictException(
          `duplicate content: already uploaded as asset ${duplicate.id}`,
        );
      }

      await this.storage.copy(stagingKey, canonicalKey);
      await this.storage.delete(stagingKey);
      const nextStatus = KB_QUEUED_KINDS.has(kind) ? 'queued' : 'ready';
      return tx.asset.update({
        where: { id: assetId },
        data: { objectKey: canonicalKey, contentHash, processingStatus: nextStatus, error: null },
      });
    });
  }

  async list(ctx: RequestContext, siteId: string, kind?: string): Promise<Asset[]> {
    return this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.asset.findMany({
        where: { siteId, ...(kind ? { kind } : {}) },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  /** 删除素材行；最后一个引用才删对象（内容去重防误删）。spec 引用检查随 M1 物化。 */
  async remove(ctx: RequestContext, assetId: string): Promise<void> {
    await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const asset = await tx.asset.findUnique({ where: { id: assetId } });
      if (!asset) throw new NotFoundException('asset not found');
      const others = await tx.asset.count({
        where: { objectKey: asset.objectKey, NOT: { id: assetId } },
      });
      await tx.asset.delete({ where: { id: assetId } });
      if (others === 0) {
        try {
          await this.storage.delete(asset.objectKey);
        } catch (err) {
          // 行已删、对象残留可容忍（后续清扫），但必须留痕
          this.log.warn(
            `orphan object cleanup failed for ${asset.objectKey}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    });
  }

  private async reject(
    tx: Prisma.TransactionClient,
    assetId: string,
    stagingKey: string,
    error: string,
  ): Promise<void> {
    await tx.asset.update({
      where: { id: assetId },
      data: { processingStatus: 'rejected', error },
    });
    try {
      await this.storage.delete(stagingKey);
    } catch (err) {
      this.log.warn(
        `staging cleanup failed for ${stagingKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
