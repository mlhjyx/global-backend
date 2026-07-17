import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  IMAGE_PIPELINE_VERSION,
  planImageVariants,
  type ImageInspection,
  type PlannedImageVariant,
  type RenderedImageVariant,
} from './image-pipeline';
import {
  type ImagePipelineRunner,
} from './image-pipeline-runner';
import {
  buildAssetVariantRecipeHash,
  projectDerivedImageManifest,
} from './media-foundation';
import {
  buildVariantAttemptObjectKey,
  buildVariantObjectKey,
  type AssetKind,
} from './object-key';
import { StorageService } from './storage.service';

export const IMAGE_PIPELINE_RUNNER = Symbol('IMAGE_PIPELINE_RUNNER');
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VARIANTS_PER_ASSET = 120;
const VARIANT_LEASE_MS = 10 * 60_000;
const VARIANT_WAIT_MS = 100;
const VARIANT_WAIT_TIMEOUT_MS = 5 * 60_000;
const OBJECT_OPERATION_TIMEOUT_MS = 60_000;
const PROMOTION_OPERATION_TIMEOUT_MS = 15_000;
const MAX_SITE_IMAGE_BATCH = 2;
const MAX_SITE_IMAGE_WORKSET = 512;
const MAX_ATTEMPT_KEYS_PER_VARIANT = 8;
const MAX_ATTEMPT_RECONCILE_OBJECTS = 128;
const MAX_CLEANUP_TOTAL_OBJECTS = 128;
const ATTEMPT_RECONCILE_CONCURRENCY = 8;
const IMAGE_KINDS = new Set<AssetKind>(['logo', 'product_image', 'factory_image', 'cert']);
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface ImageAssetProcessResult {
  assetId: string;
  status: 'done';
  variants: number;
  reused: number;
  qualityWarnings: string[];
}

export interface SiteImagePipelineSummary {
  status: 'done' | 'degraded';
  processed: number;
  failed: number;
  variants: number;
  /** Legacy cursor fields are retained only for pre-workset Temporal histories. */
  nextCursor?: string | null;
  upperBound?: string | null;
  items: Array<
    | ImageAssetProcessResult
    | { assetId: string; status: 'failed'; error: string }
  >;
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function jsonRecord(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : {};
}

function attemptKeysFromMetadata(metadata: Record<string, Prisma.JsonValue>): string[] {
  const keys = Array.isArray(metadata.attemptKeys)
    ? metadata.attemptKeys.filter((value): value is string => typeof value === 'string')
    : [];
  const reservation = jsonRecord(metadata.reservation ?? null);
  if (typeof reservation.attemptKey === 'string') keys.push(reservation.attemptKey);
  return [...new Set(keys)];
}

function safeMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('image pipeline aborted');
  }
}

function boundedOperationSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(OBJECT_OPERATION_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onDone = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(onDone, ms);
    timer.unref();
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('image pipeline aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

@Injectable()
export class ImagePipelineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @Inject(IMAGE_PIPELINE_RUNNER) private readonly runner: ImagePipelineRunner,
  ) {}

  async listSiteImageIds(input: {
    workspaceId: string;
    siteId: string;
  }): Promise<{ assetIds: string[]; truncated: boolean }> {
    const rows = await this.prisma.withWorkspace(input.workspaceId, (tx) =>
      tx.asset.findMany({
        where: {
          siteId: input.siteId,
          deletedAt: null,
          processingStatus: 'ready',
          kind: { in: [...IMAGE_KINDS] },
          mime: { in: [...IMAGE_MIMES] },
          contentHash: { not: null },
        },
        orderBy: { id: 'asc' },
        take: MAX_SITE_IMAGE_WORKSET + 1,
        select: { id: true },
      }),
    );
    return {
      assetIds: rows.slice(0, MAX_SITE_IMAGE_WORKSET).map((row) => row.id),
      truncated: rows.length > MAX_SITE_IMAGE_WORKSET,
    };
  }

  async processSiteImages(
    input: {
      workspaceId: string;
      siteId: string;
      afterAssetId?: string | null;
      upperBound?: string | null;
      assetIds?: string[];
      limit?: number;
    },
    signal?: AbortSignal,
  ): Promise<SiteImagePipelineSummary> {
    const baseWhere: Prisma.AssetWhereInput = {
          siteId: input.siteId,
          deletedAt: null,
          processingStatus: 'ready',
          kind: { in: [...IMAGE_KINDS] },
          mime: { in: [...IMAGE_MIMES] },
          contentHash: { not: null },
    };
    const limit = input.limit === undefined
      ? null
      : Math.max(1, Math.min(MAX_SITE_IMAGE_BATCH, input.limit));
    if (input.assetIds && (input.assetIds.length < 1 || input.assetIds.length > MAX_SITE_IMAGE_BATCH)) {
      throw new Error(`explicit image batch must contain 1-${MAX_SITE_IMAGE_BATCH} asset ids`);
    }
    const upperBound = input.assetIds
      ? null
      : input.upperBound ?? await this.prisma.withWorkspace(input.workspaceId, async (tx) => {
          const last = await tx.asset.findFirst({
            where: baseWhere,
            orderBy: { id: 'desc' },
            select: { id: true },
          });
          return last?.id ?? null;
        });
    if (upperBound === null) {
      if (!input.assetIds) {
        return {
          status: 'done', processed: 0, failed: 0, variants: 0, items: [],
          nextCursor: null, upperBound: null,
        };
      }
    }
    const assets = input.assetIds
      ? input.assetIds.map((id) => ({ id }))
      : await this.prisma.withWorkspace(input.workspaceId, (tx) =>
          tx.asset.findMany({
            where: {
              ...baseWhere,
              id: {
                ...(input.afterAssetId ? { gt: input.afterAssetId } : {}),
                lte: upperBound!,
              },
            },
            orderBy: { id: 'asc' },
            take: limit ?? undefined,
            select: { id: true },
          }),
        );
    const items: SiteImagePipelineSummary['items'] = [];
    for (const asset of assets) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('image pipeline aborted');
      }
      try {
        items.push(await this.processAsset({ ...input, assetId: asset.id }, signal));
      } catch (error) {
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error('image pipeline aborted');
        }
        items.push({ assetId: asset.id, status: 'failed', error: safeMessage(error) });
      }
    }
    const completed = items.filter((item): item is ImageAssetProcessResult => item.status === 'done');
    const failed = items.length - completed.length;
    return {
      status: failed > 0 ? 'degraded' : 'done',
      processed: completed.length,
      failed,
      variants: completed.reduce((sum, item) => sum + item.variants, 0),
      items,
      nextCursor:
        !input.assetIds && limit !== null && assets.length === limit && assets.at(-1)?.id !== upperBound
          ? (assets.at(-1)?.id ?? null)
          : null,
      upperBound,
    };
  }

  async processAsset(
    input: {
      workspaceId: string;
      siteId: string;
      assetId: string;
    },
    signal?: AbortSignal,
  ): Promise<ImageAssetProcessResult> {
    const asset = await this.prisma.withWorkspace(input.workspaceId, (tx) =>
      tx.asset.findFirst({
        where: {
          id: input.assetId,
          siteId: input.siteId,
          deletedAt: null,
          processingStatus: 'ready',
        },
      }),
    );
    if (!asset || !asset.contentHash) throw new Error(`ready image asset ${input.assetId} not found`);
    const kind = asset.kind as AssetKind;
    if (!IMAGE_KINDS.has(kind) || !IMAGE_MIMES.has(asset.mime)) {
      throw new Error(`asset ${input.assetId} is not a processable image`);
    }
    if (asset.sizeBytes <= 0 || asset.sizeBytes > MAX_IMAGE_BYTES) {
      throw new Error(`asset ${input.assetId} exceeds the image byte policy`);
    }
    const source = await this.storage.getBufferBounded(asset.objectKey, MAX_IMAGE_BYTES, signal);
    if (source.length !== asset.sizeBytes || sha256(source) !== asset.contentHash) {
      throw new Error(`asset ${input.assetId} object no longer matches its committed identity`);
    }
    const inspection = await this.runner.inspect(source, asset.mime, signal);
    const meta = jsonRecord(asset.meta);
    const focal = jsonRecord(meta.focalPoint ?? null);
    const focalPoint =
      typeof focal.x === 'number' &&
      typeof focal.y === 'number' &&
      focal.x >= 0 &&
      focal.x <= 1 &&
      focal.y >= 0 &&
      focal.y <= 1
        ? { x: focal.x, y: focal.y }
        : null;
    const plans = planImageVariants({
      assetKind: kind,
      assetContentHash: asset.contentHash,
      inspection,
      focalPoint,
    });
    if (
      await this.tryReuseReadySet(
        {
          workspaceId: input.workspaceId,
          siteId: input.siteId,
          assetId: input.assetId,
          sourceHash: asset.contentHash,
          sourceObjectKey: asset.objectKey,
        },
        plans,
        signal,
      )
    ) {
      return {
        assetId: input.assetId,
        status: 'done',
        variants: plans.length,
        reused: plans.length,
        qualityWarnings: inspection.quality.warnings,
      };
    }
    const job = {
      workspaceId: input.workspaceId,
      siteId: input.siteId,
      assetId: input.assetId,
      sourceHash: asset.contentHash,
      sourceObjectKey: asset.objectKey,
      sourceMeta: meta,
    };
    await this.reconcileAttemptKeys(job, signal);
    const producerToken = randomUUID();
    const waitDeadline = Date.now() + VARIANT_WAIT_TIMEOUT_MS;
    while (!(await this.reserveVariantSet(job, inspection, plans, producerToken))) {
      throwIfAborted(signal);
      if (Date.now() >= waitDeadline) throw new Error('image variant reservation wait timed out');
      await sleep(VARIANT_WAIT_MS, signal);
      if (await this.tryReuseReadySet(job, plans, signal)) {
        return {
          assetId: input.assetId,
          status: 'done',
          variants: plans.length,
          reused: plans.length,
          qualityWarnings: inspection.quality.warnings,
        };
      }
    }
    try {
      const rendered = await this.runner.render(source, plans, signal);
      throwIfAborted(signal);
      this.validateRendered(plans, rendered);
      const persisted = await this.materializeAndFinalize(
        job,
        inspection,
        plans,
        rendered,
        producerToken,
        signal,
      );
      return {
        assetId: input.assetId,
        status: 'done',
        variants: plans.length,
        reused: persisted.reused,
        qualityWarnings: inspection.quality.warnings,
      };
    } catch (error) {
      await this.failReservation(job, plans, producerToken, safeMessage(error));
      throw error;
    }
  }

  private async tryReuseReadySet(
    input: {
      workspaceId: string;
      siteId: string;
      assetId: string;
      sourceHash: string;
      sourceObjectKey: string;
    },
    plans: readonly PlannedImageVariant[],
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (plans.length === 0) return true;
    const snapshot = await this.prisma.withWorkspace(input.workspaceId, async (tx) => {
      const asset = await tx.asset.findFirst({
        where: {
          id: input.assetId,
          workspaceId: input.workspaceId,
          siteId: input.siteId,
          deletedAt: null,
          processingStatus: 'ready',
          contentHash: input.sourceHash,
          objectKey: input.sourceObjectKey,
        },
        select: { id: true },
      });
      if (!asset) return null;
      const rows = await tx.assetVariant.findMany({
        where: {
          assetId: input.assetId,
          recipeHash: { in: plans.map((plan) => plan.recipeHash) },
          pipelineVersion: IMAGE_PIPELINE_VERSION,
          status: 'ready',
        },
        orderBy: { recipeHash: 'asc' },
      });
      return rows.length === plans.length ? rows : null;
    });
    if (!snapshot) return false;
    const byRecipe = new Map(snapshot.map((row) => [row.recipeHash, row]));
    for (const plan of plans) {
      const operationSignal = boundedOperationSignal(signal);
      throwIfAborted(operationSignal);
      const row = byRecipe.get(plan.recipeHash);
      const expectedKey = buildVariantObjectKey(
        input.workspaceId,
        input.siteId,
        input.assetId,
        plan.recipeHash,
        plan.recipe.output.format,
      );
      if (
        !row ||
        row.objectKey !== expectedKey ||
        row.variantType !== plan.recipe.output.role ||
        row.width !== plan.recipe.output.width ||
        row.height !== plan.recipe.output.height ||
        row.contentHash === null ||
        row.sizeBytes === null
      ) return false;
      const head = await this.storage.head(row.objectKey, operationSignal);
      if (!head || head.size !== row.sizeBytes || head.contentType !== row.mime) return false;
      const hashed = await this.storage.hashObject(row.objectKey, operationSignal);
      throwIfAborted(operationSignal);
      if (hashed.sha256 !== row.contentHash || hashed.size !== row.sizeBytes) return false;
    }
    return this.prisma.withWorkspace(
      input.workspaceId,
      async (tx) => {
        throwIfAborted(signal);
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT id
          FROM asset
          WHERE id = ${input.assetId}::uuid
            AND workspace_id = ${input.workspaceId}::uuid
            AND site_id = ${input.siteId}::uuid
            AND deleted_at IS NULL
            AND processing_status = 'ready'
            AND content_hash = ${input.sourceHash}
            AND object_key = ${input.sourceObjectKey}
            AND content_hash = ${input.sourceHash}
            AND object_key = ${input.sourceObjectKey}
          FOR UPDATE
        `);
        if (locked.length !== 1) return false;
        const current = await tx.assetVariant.findMany({
          where: {
            assetId: input.assetId,
            recipeHash: { in: plans.map((plan) => plan.recipeHash) },
            pipelineVersion: IMAGE_PIPELINE_VERSION,
            status: 'ready',
          },
        });
        if (current.length !== plans.length) return false;
        const currentByRecipe = new Map(current.map((row) => [row.recipeHash, row]));
        if (snapshot.some((row) => {
          const fresh = currentByRecipe.get(row.recipeHash);
          return !fresh || fresh.id !== row.id || fresh.contentHash !== row.contentHash ||
            fresh.sizeBytes !== row.sizeBytes || fresh.objectKey !== row.objectKey;
        })) return false;
        const manifest = projectDerivedImageManifest({
          pipelineVersion: IMAGE_PIPELINE_VERSION,
          sourceHash: input.sourceHash,
          variants: current,
        });
        await tx.asset.update({
          where: { id: input.assetId },
          data: { derivedKeys: manifest as unknown as Prisma.InputJsonObject },
        });
        return true;
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
  }

  private validateRendered(
    plans: readonly PlannedImageVariant[],
    rendered: ReadonlyMap<string, RenderedImageVariant>,
  ): void {
    if (rendered.size !== plans.length) throw new Error('renderer returned an incomplete variant set');
    for (const plan of plans) {
      if (buildAssetVariantRecipeHash(plan.recipe) !== plan.recipeHash) {
        throw new Error(`recipe identity drifted for ${plan.recipeHash}`);
      }
      const output = rendered.get(plan.recipeHash);
      if (
        !output ||
        sha256(output.data) !== output.info.contentHash ||
        output.data.length !== output.info.sizeBytes ||
        output.info.width !== plan.recipe.output.width ||
        output.info.height !== plan.recipe.output.height
      ) {
        throw new Error(`renderer output is invalid for ${plan.recipeHash}`);
      }
    }
  }

  private async ensureObject(
    key: string,
    rendered: RenderedImageVariant,
    signal?: AbortSignal,
    lifecycle?: 'variant-attempt',
  ): Promise<boolean> {
    throwIfAborted(signal);
    const existing = await this.storage.head(key, signal);
    if (existing) {
      const hashed = await this.storage.hashObject(key, signal);
      throwIfAborted(signal);
      if (
        existing.size !== rendered.info.sizeBytes ||
        existing.contentType !== rendered.info.mime ||
        hashed.sha256 !== rendered.info.contentHash ||
        hashed.size !== rendered.info.sizeBytes
      ) {
        throw new Error(`canonical variant object conflicts with ${key}`);
      }
      return true;
    }
    try {
      throwIfAborted(signal);
      await this.storage.putBuffer(
        key,
        rendered.data,
        rendered.info.mime,
        signal,
        lifecycle ? { lifecycle } : undefined,
      );
    } catch (error) {
      // PUT may have committed but its response was lost. Verify the authoritative bytes before
      // deciding whether this is a failure; compensation later is ownership-aware.
      const after = await this.storage.head(key, signal);
      if (!after) throw error;
    }
    throwIfAborted(signal);
    const after = await this.storage.head(key, signal);
    const hashed = await this.storage.hashObject(key, signal);
    throwIfAborted(signal);
    if (
      !after ||
      after.size !== rendered.info.sizeBytes ||
      after.contentType !== rendered.info.mime ||
      hashed.sha256 !== rendered.info.contentHash ||
      hashed.size !== rendered.info.sizeBytes
    ) {
      throw new Error(`variant object verification failed for ${key}`);
    }
    return false;
  }

  /**
   * Ready/failed and expired-processing attempt objects are disposable. Storage IO happens
   * outside the Asset row lock; only keys proven absent are then removed under that lock. Every
   * attempt PUT is independently TTL-tagged to converge if a fenced producer resumes afterward.
   */
  private async reconcileAttemptKeys(
    input: {
      workspaceId: string;
      siteId: string;
      assetId: string;
      sourceHash: string;
      sourceObjectKey: string;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    const rows = await this.prisma.withWorkspace(input.workspaceId, async (tx) => {
      const asset = await tx.asset.findFirst({
        where: {
          id: input.assetId,
          workspaceId: input.workspaceId,
          siteId: input.siteId,
          deletedAt: null,
          processingStatus: 'ready',
          contentHash: input.sourceHash,
          objectKey: input.sourceObjectKey,
        },
        select: { id: true },
      });
      if (!asset) throw new Error('asset changed before image attempt reconciliation');
      return tx.assetVariant.findMany({
        where: { assetId: input.assetId },
        select: { id: true, recipeHash: true, objectKey: true, status: true, metadata: true },
      });
    });
    const now = Date.now();
    const candidates = rows.filter((row) => {
      if (row.status === 'ready' || row.status === 'failed') return true;
      if (row.status !== 'processing') return false;
      const reservation = jsonRecord(jsonRecord(row.metadata).reservation ?? null);
      const lease = typeof reservation.leaseUntil === 'string'
        ? Date.parse(reservation.leaseUntil)
        : Number.NaN;
      return Number.isFinite(lease) && lease <= now;
    });
    const keysByRow = new Map<string, string[]>();
    for (const row of candidates) {
      const canonicalPrefix =
        `ws/${input.workspaceId}/${input.siteId}/variants/${input.assetId}/${row.recipeHash}.`;
      const ext = row.objectKey.startsWith(canonicalPrefix)
        ? row.objectKey.slice(canonicalPrefix.length)
        : '';
      if (!['avif', 'webp', 'jpg', 'png'].includes(ext)) {
        throw new Error(`image variant canonical provenance conflicts for ${row.recipeHash}`);
      }
      const prefix = `ws/${input.workspaceId}/${input.siteId}/variant-attempts/${input.assetId}/`;
      const suffix = `/${row.recipeHash}.${ext}`;
      const keys = attemptKeysFromMetadata(jsonRecord(row.metadata));
      for (const key of keys) {
        const token = key.startsWith(prefix) && key.endsWith(suffix)
          ? key.slice(prefix.length, -suffix.length)
          : '';
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
          throw new Error(`image variant attempt provenance conflicts for ${row.recipeHash}`);
        }
      }
      keysByRow.set(row.id, keys);
    }
    const allKeys = [...new Set([...keysByRow.values()].flat())];
    if (allKeys.length === 0) return;
    if (allKeys.length > MAX_ATTEMPT_RECONCILE_OBJECTS) {
      throw new Error(`image variant attempt reconciliation exceeds ${MAX_ATTEMPT_RECONCILE_OBJECTS} objects`);
    }
    const operationSignal = AbortSignal.any([
      boundedOperationSignal(signal),
      AbortSignal.timeout(PROMOTION_OPERATION_TIMEOUT_MS),
    ]);
    const absent = new Set<string>();
    for (let offset = 0; offset < allKeys.length; offset += ATTEMPT_RECONCILE_CONCURRENCY) {
      throwIfAborted(operationSignal);
      const batch = allKeys.slice(offset, offset + ATTEMPT_RECONCILE_CONCURRENCY);
      await Promise.all(batch.map((key) => this.storage.delete(key, operationSignal)));
      const heads = await Promise.all(batch.map((key) => this.storage.head(key, operationSignal)));
      for (const [index, key] of batch.entries()) {
        if (heads[index]) {
          throw new Error(`image variant attempt reconciliation could not delete ${key}`);
        }
        absent.add(key);
      }
    }
    await this.prisma.withWorkspace(input.workspaceId, async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM asset
        WHERE id = ${input.assetId}::uuid
          AND workspace_id = ${input.workspaceId}::uuid
          AND site_id = ${input.siteId}::uuid
          AND deleted_at IS NULL
          AND processing_status = 'ready'
          AND content_hash = ${input.sourceHash}
          AND object_key = ${input.sourceObjectKey}
        FOR UPDATE
      `);
      if (locked.length !== 1) return;
      const rows = await tx.assetVariant.findMany({
        where: { id: { in: candidates.map((row) => row.id) }, assetId: input.assetId },
        select: { id: true, status: true, metadata: true },
      });
      for (const row of rows) {
        const metadata = jsonRecord(row.metadata);
        const reservation = jsonRecord(metadata.reservation ?? null);
        if (row.status === 'processing') {
          const lease = typeof reservation.leaseUntil === 'string'
            ? Date.parse(reservation.leaseUntil)
            : Number.NaN;
          if (!Number.isFinite(lease) || lease > Date.now()) continue;
        } else if (row.status !== 'ready' && row.status !== 'failed') {
          continue;
        }
        const remaining = attemptKeysFromMetadata(metadata).filter((key) => !absent.has(key));
        const { attemptKeys: _attemptKeys, reservation: _reservation, ...rest } = metadata;
        const keepReservation =
          typeof reservation.attemptKey === 'string' && !absent.has(reservation.attemptKey);
        await tx.assetVariant.updateMany({
          where: { id: row.id, assetId: input.assetId, status: row.status },
          data: {
            ...(row.status === 'processing'
              ? { status: 'failed' as const, error: 'IMAGE_VARIANT_ATTEMPT_EXPIRED: reconciled before retry' }
              : {}),
            metadata: {
              ...rest,
              ...(keepReservation ? { reservation } : {}),
              ...(remaining.length > 0 ? { attemptKeys: remaining } : {}),
            } as Prisma.InputJsonObject,
          },
        });
      }
    });
  }

  private async reserveVariantSet(
    input: {
      workspaceId: string;
      siteId: string;
      assetId: string;
      sourceHash: string;
      sourceObjectKey: string;
      sourceMeta: Record<string, Prisma.JsonValue>;
    },
    inspection: ImageInspection,
    plans: readonly PlannedImageVariant[],
    producerToken: string,
  ): Promise<boolean> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + VARIANT_LEASE_MS);
    return this.prisma.withWorkspace(
      input.workspaceId,
      async (tx) => {
          const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT id
            FROM asset
            WHERE id = ${input.assetId}::uuid
              AND workspace_id = ${input.workspaceId}::uuid
              AND site_id = ${input.siteId}::uuid
              AND deleted_at IS NULL
              AND processing_status = 'ready'
              AND content_hash = ${input.sourceHash}
              AND object_key = ${input.sourceObjectKey}
            FOR UPDATE
          `);
          if (locked.length !== 1) throw new Error('asset changed before image variant reservation');
          const existing = await tx.assetVariant.findMany({
            where: { assetId: input.assetId },
            orderBy: { recipeHash: 'asc' },
          });
          const byRecipe = new Map(existing.map((row) => [row.recipeHash, row]));
          const newCount = plans.filter((plan) => !byRecipe.has(plan.recipeHash)).length;
          if (existing.length + newCount > MAX_VARIANTS_PER_ASSET) {
            throw new Error(
              `asset variant budget exceeded (${existing.length}+${newCount}>${MAX_VARIANTS_PER_ASSET})`,
            );
          }
          const ordered = [...plans].sort((left, right) =>
            left.recipeHash.localeCompare(right.recipeHash),
          );
          // Detect an active producer before making any mutation. Returning false after partially
          // reserving rows would commit a split set and strand the waiter behind its own lease.
          for (const plan of ordered) {
            const current = byRecipe.get(plan.recipeHash);
            if (!current || current.status === 'ready') continue;
            const metadata = jsonRecord(current.metadata);
            const reservation = jsonRecord(metadata.reservation ?? null);
            const parsedLease =
              typeof reservation.leaseUntil === 'string'
                ? Date.parse(reservation.leaseUntil)
                : Number.NaN;
            if (current.status === 'processing' && reservation.token !== producerToken) {
              if (typeof reservation.token !== 'string' || !Number.isFinite(parsedLease)) {
                throw new Error(`image variant ${plan.recipeHash} has an invalid processing lease`);
              }
              if (parsedLease > now.getTime()) return false;
            }
          }
          const futureAttemptKeys = new Set(
            existing.flatMap((row) => attemptKeysFromMetadata(jsonRecord(row.metadata))),
          );
          for (const plan of ordered) {
            const current = byRecipe.get(plan.recipeHash);
            if (current?.status === 'ready') continue;
            futureAttemptKeys.add(buildVariantAttemptObjectKey(
              input.workspaceId,
              input.siteId,
              input.assetId,
              producerToken,
              plan.recipeHash,
              plan.recipe.output.format,
            ));
          }
          const futureObjectCount = 1 + existing.length + newCount + futureAttemptKeys.size;
          if (futureObjectCount > MAX_CLEANUP_TOTAL_OBJECTS) {
            throw new Error(
              `asset cleanup object budget exceeded (${futureObjectCount}>${MAX_CLEANUP_TOTAL_OBJECTS})`,
            );
          }
          for (const plan of ordered) {
            const key = buildVariantObjectKey(
              input.workspaceId,
              input.siteId,
              input.assetId,
              plan.recipeHash,
              plan.recipe.output.format,
            );
            const attemptKey = buildVariantAttemptObjectKey(
              input.workspaceId,
              input.siteId,
              input.assetId,
              producerToken,
              plan.recipeHash,
              plan.recipe.output.format,
            );
            await tx.$executeRaw(Prisma.sql`
              SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))
            `);
            const current = byRecipe.get(plan.recipeHash);
            if (current) {
              if (
                current.objectKey !== key ||
                current.pipelineVersion !== IMAGE_PIPELINE_VERSION ||
                current.variantType !== plan.recipe.output.role ||
                current.mime !== this.outputMime(plan) ||
                current.width !== plan.recipe.output.width ||
                current.height !== plan.recipe.output.height
              ) {
                throw new Error(`existing variant provenance conflicts for ${plan.recipeHash}`);
              }
              if (current.status === 'ready') continue;
              const metadata = jsonRecord(current.metadata);
              const reservation = jsonRecord(metadata.reservation ?? null);
              const attemptKeys = [...new Set([...attemptKeysFromMetadata(metadata), attemptKey])];
              if (attemptKeys.length > MAX_ATTEMPT_KEYS_PER_VARIANT) {
                throw new Error(`image variant attempt-key budget exceeded for ${plan.recipeHash}`);
              }
              const attempt =
                typeof reservation.attempt === 'number' && Number.isInteger(reservation.attempt)
                  ? reservation.attempt + 1
                  : 1;
                await tx.assetVariant.update({
                  where: { id: current.id },
                  data: {
                    status: 'processing',
                    error: null,
                    metadata: this.variantMetadata(input, inspection, plan, {
                      token: producerToken,
                      leaseUntil: leaseUntil.toISOString(),
                      attempt,
                      attemptKey,
                    }, attemptKeys),
                  },
                });
            } else {
              await tx.assetVariant.create({
                data: this.reservationData(
                  input,
                  inspection,
                  plan,
                  key,
                  producerToken,
                  leaseUntil,
                ),
              });
            }
          }
          return true;
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
  }

  private async materializeAndFinalize(
    input: {
      workspaceId: string;
      siteId: string;
      assetId: string;
      sourceHash: string;
      sourceObjectKey: string;
      sourceMeta: Record<string, Prisma.JsonValue>;
    },
    inspection: ImageInspection,
    plans: readonly PlannedImageVariant[],
    rendered: ReadonlyMap<string, RenderedImageVariant>,
    producerToken: string,
    signal?: AbortSignal,
  ): Promise<{ reused: number }> {
    let reused = 0;
    const ordered = [...plans].sort((left, right) =>
      left.recipeHash.localeCompare(right.recipeHash),
    );
    for (const plan of ordered) {
      const operationSignal = boundedOperationSignal(signal);
      throwIfAborted(operationSignal);
      const needsPromotion = await this.renewReservation(
        input,
        plans,
        plan.recipeHash,
        producerToken,
        operationSignal,
      );
      const output = rendered.get(plan.recipeHash)!;
      const key = buildVariantObjectKey(
        input.workspaceId,
        input.siteId,
        input.assetId,
        plan.recipeHash,
        plan.recipe.output.format,
      );
      if (!needsPromotion) {
        await this.verifyReadyObject(key, output, operationSignal);
        reused += 1;
        continue;
      }
      const attemptKey = buildVariantAttemptObjectKey(
        input.workspaceId,
        input.siteId,
        input.assetId,
        producerToken,
        plan.recipeHash,
        plan.recipe.output.format,
      );
      await this.ensureObject(attemptKey, output, operationSignal, 'variant-attempt');
      const promotionSignal = AbortSignal.any([
        operationSignal,
        AbortSignal.timeout(PROMOTION_OPERATION_TIMEOUT_MS),
      ]);
      await this.promoteAttempt(
        input,
        inspection,
        plan,
        output,
        producerToken,
        attemptKey,
        key,
        promotionSignal,
      );
      try {
        await this.storage.delete(attemptKey, operationSignal);
        if (!(await this.storage.head(attemptKey, operationSignal))) {
          await this.clearAttemptKey(input, plan.recipeHash, attemptKey);
        }
      } catch {
        // attemptKey remains in durable Variant metadata and canonical cleanup's frozen plan.
      }
      throwIfAborted(operationSignal);
    }
    throwIfAborted(signal);
    await this.prisma.withWorkspace(
      input.workspaceId,
      async (tx) => {
        throwIfAborted(signal);
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT id
          FROM asset
          WHERE id = ${input.assetId}::uuid
            AND workspace_id = ${input.workspaceId}::uuid
            AND site_id = ${input.siteId}::uuid
            AND deleted_at IS NULL
            AND processing_status = 'ready'
            AND content_hash = ${input.sourceHash}
            AND object_key = ${input.sourceObjectKey}
          FOR UPDATE
        `);
        if (locked.length !== 1) throw new Error('asset changed while image variants were materialized');
        const rows = await tx.assetVariant.findMany({
          where: { assetId: input.assetId, recipeHash: { in: plans.map((plan) => plan.recipeHash) } },
          orderBy: { recipeHash: 'asc' },
        });
        if (rows.length !== plans.length) throw new Error('reserved image variant set is incomplete');
        const byRecipe = new Map(rows.map((row) => [row.recipeHash, row]));
        for (const plan of ordered) {
          throwIfAborted(signal);
          const row = byRecipe.get(plan.recipeHash);
          const output = rendered.get(plan.recipeHash)!;
          const key = buildVariantObjectKey(
            input.workspaceId,
            input.siteId,
            input.assetId,
            plan.recipeHash,
            plan.recipe.output.format,
          );
          if (!row || row.objectKey !== key || row.pipelineVersion !== IMAGE_PIPELINE_VERSION) {
            throw new Error(`reserved variant provenance conflicts for ${plan.recipeHash}`);
          }
          if (row.status === 'ready') {
            if (row.contentHash !== output.info.contentHash || row.sizeBytes !== output.info.sizeBytes) {
              throw new Error(`ready variant identity conflicts for ${plan.recipeHash}`);
            }
            continue;
          }
          throw new Error(`image variant was not promoted for ${plan.recipeHash}`);
        }
        throwIfAborted(signal);
        const ready = await tx.assetVariant.findMany({
          where: {
            assetId: input.assetId,
            recipeHash: { in: plans.map((plan) => plan.recipeHash) },
            pipelineVersion: IMAGE_PIPELINE_VERSION,
            status: 'ready',
          },
          orderBy: { recipeHash: 'asc' },
        });
        if (ready.length !== plans.length) throw new Error('current image variant set did not finalize');
        const manifest = projectDerivedImageManifest({
          pipelineVersion: IMAGE_PIPELINE_VERSION,
          sourceHash: input.sourceHash,
          variants: ready,
        });
        await tx.asset.update({
          where: { id: input.assetId },
          data: { derivedKeys: manifest as unknown as Prisma.InputJsonObject },
        });
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    return { reused };
  }

  private async promoteAttempt(
    input: {
      workspaceId: string;
      siteId: string;
      assetId: string;
      sourceHash: string;
      sourceObjectKey: string;
      sourceMeta: Record<string, Prisma.JsonValue>;
    },
    inspection: ImageInspection,
    plan: PlannedImageVariant,
    output: RenderedImageVariant,
    producerToken: string,
    attemptKey: string,
    canonicalKey: string,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    await this.prisma.withWorkspace(
      input.workspaceId,
      async (tx) => {
        throwIfAborted(signal);
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT id FROM asset
          WHERE id = ${input.assetId}::uuid
            AND workspace_id = ${input.workspaceId}::uuid
            AND site_id = ${input.siteId}::uuid
            AND deleted_at IS NULL
            AND processing_status = 'ready'
            AND content_hash = ${input.sourceHash}
            AND object_key = ${input.sourceObjectKey}
          FOR UPDATE
        `);
        if (locked.length !== 1) throw new Error('asset changed before image variant promotion');
        await tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${canonicalKey}, 0))
        `);
        const row = await tx.assetVariant.findFirst({
          where: { assetId: input.assetId, recipeHash: plan.recipeHash },
        });
        if (!row) throw new Error(`image variant reservation is missing for ${plan.recipeHash}`);
        if (row.status === 'ready') {
          if (row.contentHash !== output.info.contentHash || row.sizeBytes !== output.info.sizeBytes) {
            throw new Error(`ready variant identity conflicts for ${plan.recipeHash}`);
          }
          return;
        }
        const metadata = jsonRecord(row.metadata);
        const reservation = jsonRecord(metadata.reservation ?? null);
        if (
          row.status !== 'processing' ||
          reservation.token !== producerToken ||
          reservation.attemptKey !== attemptKey
        ) {
          throw new Error(`image variant promotion was fenced for ${plan.recipeHash}`);
        }

        const existing = await this.storage.head(canonicalKey, signal);
        if (!existing) {
          try {
            await this.storage.copy(attemptKey, canonicalKey, signal);
          } catch (error) {
            if (!(await this.storage.head(canonicalKey, signal))) throw error;
          }
        }
        const after = await this.storage.head(canonicalKey, signal);
        const hashed = await this.storage.hashObject(canonicalKey, signal);
        if (
          !after ||
          after.size !== output.info.sizeBytes ||
          after.contentType !== output.info.mime ||
          hashed.sha256 !== output.info.contentHash ||
          hashed.size !== output.info.sizeBytes
        ) {
          throw new Error(`variant promotion verification failed for ${canonicalKey}`);
        }
        const promoted = await tx.assetVariant.updateMany({
          where: {
            id: row.id,
            status: 'processing',
            metadata: { path: ['reservation', 'token'], equals: producerToken },
          },
          data: {
            status: 'ready',
            contentHash: output.info.contentHash,
            sizeBytes: output.info.sizeBytes,
            error: null,
            metadata: this.variantMetadata(
              input,
              inspection,
              plan,
              undefined,
              attemptKeysFromMetadata(metadata),
            ),
          },
        });
        if (promoted.count !== 1) throw new Error(`image variant promotion CAS lost ${plan.recipeHash}`);
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
    throwIfAborted(signal);
  }

  private async verifyReadyObject(
    key: string,
    rendered: RenderedImageVariant,
    signal?: AbortSignal,
  ): Promise<void> {
    const existing = await this.storage.head(key, signal);
    if (!existing) {
      throw new Error(`ready variant storage integrity error: missing ${key}`);
    }
    const hashed = await this.storage.hashObject(key, signal);
    if (
      existing.size !== rendered.info.sizeBytes ||
      existing.contentType !== rendered.info.mime ||
      hashed.sha256 !== rendered.info.contentHash ||
      hashed.size !== rendered.info.sizeBytes
    ) {
      throw new Error(`ready variant storage integrity error: identity mismatch ${key}`);
    }
  }

  private async clearAttemptKey(
    input: { workspaceId: string; siteId: string; assetId: string },
    recipeHash: string,
    attemptKey: string,
  ): Promise<void> {
    await this.prisma.withWorkspace(input.workspaceId, async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM asset
        WHERE id = ${input.assetId}::uuid
          AND workspace_id = ${input.workspaceId}::uuid
          AND site_id = ${input.siteId}::uuid
          AND deleted_at IS NULL
        FOR UPDATE
      `);
      if (locked.length !== 1) return;
      const row = await tx.assetVariant.findFirst({
        where: { assetId: input.assetId, recipeHash, status: 'ready' },
        select: { id: true, metadata: true },
      });
      if (!row) return;
      const metadata = jsonRecord(row.metadata);
      const current = attemptKeysFromMetadata(metadata);
      if (!current.includes(attemptKey)) return;
      const remaining = current.filter((key) => key !== attemptKey);
      const { attemptKeys: _removed, ...withoutAttempt } = metadata;
      const nextMetadata = {
        ...withoutAttempt,
        ...(remaining.length > 0 ? { attemptKeys: remaining } : {}),
      };
      await tx.assetVariant.updateMany({
        where: {
          id: row.id,
          status: 'ready',
        },
        data: { metadata: nextMetadata as Prisma.InputJsonObject },
      });
    });
  }

  private async renewReservation(
    input: { workspaceId: string; siteId: string; assetId: string },
    plans: readonly PlannedImageVariant[],
    currentRecipeHash: string,
    producerToken: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    throwIfAborted(signal);
    const leaseUntil = new Date(Date.now() + VARIANT_LEASE_MS).toISOString();
    const needsPromotion = await this.prisma.withWorkspace(
      input.workspaceId,
      async (tx) => {
        throwIfAborted(signal);
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT id FROM asset
          WHERE id = ${input.assetId}::uuid
            AND workspace_id = ${input.workspaceId}::uuid
            AND site_id = ${input.siteId}::uuid
            AND deleted_at IS NULL
            AND processing_status = 'ready'
          FOR UPDATE
        `);
        if (locked.length !== 1) throw new Error('asset is no longer writable during image materialization');
        const rows = await tx.assetVariant.findMany({
          where: {
            assetId: input.assetId,
            recipeHash: { in: plans.map((plan) => plan.recipeHash) },
          },
        });
        if (rows.length !== plans.length) throw new Error('image variant reservation set is incomplete');
        let currentNeedsPromotion = false;
        for (const row of rows) {
          if (row.status === 'ready') continue;
          const metadata = jsonRecord(row.metadata);
          const reservation = jsonRecord(metadata.reservation ?? null);
          if (reservation.token !== producerToken) {
            throw new Error(`image variant reservation was fenced for ${row.recipeHash}`);
          }
          const renewed = await tx.assetVariant.updateMany({
            where: {
              id: row.id,
              status: 'processing',
              metadata: { path: ['reservation', 'token'], equals: producerToken },
            },
            data: {
              metadata: {
                ...metadata,
                reservation: { ...reservation, leaseUntil },
              } as Prisma.InputJsonObject,
            },
          });
          if (renewed.count !== 1) throw new Error(`image variant lease renewal lost ${row.recipeHash}`);
          if (row.recipeHash === currentRecipeHash) currentNeedsPromotion = true;
        }
        return currentNeedsPromotion;
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    throwIfAborted(signal);
    return needsPromotion;
  }

  private async failReservation(
    input: { workspaceId: string; siteId: string; assetId: string },
    plans: readonly PlannedImageVariant[],
    producerToken: string,
    error: string,
  ): Promise<void> {
    await this.prisma.withWorkspace(input.workspaceId, async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT id FROM asset
        WHERE id = ${input.assetId}::uuid
          AND workspace_id = ${input.workspaceId}::uuid
          AND site_id = ${input.siteId}::uuid
        FOR UPDATE
      `);
      const rows = await tx.assetVariant.findMany({
        where: {
          assetId: input.assetId,
          recipeHash: { in: plans.map((plan) => plan.recipeHash) },
          status: 'processing',
        },
      });
      for (const row of rows) {
        const metadata = jsonRecord(row.metadata);
        const reservation = jsonRecord(metadata.reservation ?? null);
        if (reservation.token !== producerToken) continue;
        await tx.assetVariant.updateMany({
          where: {
            id: row.id,
            status: 'processing',
            metadata: { path: ['reservation', 'token'], equals: producerToken },
          },
          data: { status: 'failed', error: `IMAGE_VARIANT_ATTEMPT_FAILED: ${error}` },
        });
      }
    });
  }

  private outputMime(plan: PlannedImageVariant): RenderedImageVariant['info']['mime'] {
    return plan.recipe.output.format === 'avif'
      ? 'image/avif'
      : plan.recipe.output.format === 'webp'
        ? 'image/webp'
        : plan.recipe.output.format === 'jpeg'
          ? 'image/jpeg'
          : 'image/png';
  }

  private variantMetadata(
    input: {
      workspaceId: string;
      siteId: string;
      assetId: string;
      sourceMeta: Record<string, Prisma.JsonValue>;
    },
    inspection: ImageInspection,
    plan: PlannedImageVariant,
    reservation?: { token: string; leaseUntil: string; attempt: number; attemptKey: string },
    attemptKeys?: string[],
  ): Prisma.InputJsonObject {
    return {
        schemaVersion: '1.0',
        recipe: plan.recipe as unknown as Prisma.InputJsonObject,
        quality: inspection.quality as unknown as Prisma.InputJsonObject,
        aiEdited: false,
        ...(reservation ? { reservation } : {}),
        ...(attemptKeys && attemptKeys.length > 0 ? { attemptKeys } : {}),
        ...(typeof input.sourceMeta.hasPerson === 'boolean'
          ? { hasPerson: input.sourceMeta.hasPerson }
          : {}),
    };
  }

  private reservationData(
    input: {
      workspaceId: string;
      siteId: string;
      assetId: string;
      sourceMeta: Record<string, Prisma.JsonValue>;
    },
    inspection: ImageInspection,
    plan: PlannedImageVariant,
    key: string,
    producerToken: string,
    leaseUntil: Date,
  ): Prisma.AssetVariantUncheckedCreateInput {
    const attemptKey = buildVariantAttemptObjectKey(
      input.workspaceId,
      input.siteId,
      input.assetId,
      producerToken,
      plan.recipeHash,
      plan.recipe.output.format,
    );
    return {
      workspaceId: input.workspaceId,
      siteId: input.siteId,
      assetId: input.assetId,
      variantType: plan.recipe.output.role,
      mime: this.outputMime(plan),
      width: plan.recipe.output.width,
      height: plan.recipe.output.height,
      durationMs: null,
      bitrateKbps: null,
      sizeBytes: null,
      objectKey: key,
      contentHash: null,
      pipelineVersion: IMAGE_PIPELINE_VERSION,
      recipeHash: plan.recipeHash,
      sourceVariantId: null,
      status: 'processing',
      error: null,
      metadata: this.variantMetadata(
        input,
        inspection,
        plan,
        {
          token: producerToken,
          leaseUntil: leaseUntil.toISOString(),
          attempt: 1,
          attemptKey,
        },
        [attemptKey],
      ),
    };
  }
}
