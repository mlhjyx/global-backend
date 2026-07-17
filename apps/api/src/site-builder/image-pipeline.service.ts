import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  IMAGE_PIPELINE_VERSION,
  inspectImageInput,
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
import { buildVariantObjectKey, type AssetKind } from './object-key';
import { StorageService } from './storage.service';

export const IMAGE_PIPELINE_RUNNER = Symbol('IMAGE_PIPELINE_RUNNER');
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VARIANTS_PER_ASSET = 120;
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

function safeMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

@Injectable()
export class ImagePipelineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @Inject(IMAGE_PIPELINE_RUNNER) private readonly runner: ImagePipelineRunner,
  ) {}

  async processSiteImages(
    input: { workspaceId: string; siteId: string },
    signal?: AbortSignal,
  ): Promise<SiteImagePipelineSummary> {
    const assets = await this.prisma.withWorkspace(input.workspaceId, (tx) =>
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
    };
  }

  async processAsset(
    input: { workspaceId: string; siteId: string; assetId: string },
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
    const inspection = await inspectImageInput(source, asset.mime);
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
    const rendered = await this.runner.render(source, plans, signal);
    this.validateRendered(plans, rendered);
    const persisted = await this.persist(
      {
        workspaceId: input.workspaceId,
        siteId: input.siteId,
        assetId: input.assetId,
        sourceHash: asset.contentHash,
        sourceObjectKey: asset.objectKey,
        sourceMeta: meta,
      },
      inspection,
      plans,
      rendered,
    );
    return {
      assetId: input.assetId,
      status: 'done',
      variants: plans.length,
      reused: persisted.reused,
      qualityWarnings: inspection.quality.warnings,
    };
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
  ): Promise<boolean> {
    if (plans.length === 0) return true;
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
        if (locked.length !== 1) return false;
        const rows = await tx.assetVariant.findMany({
          where: {
            assetId: input.assetId,
            recipeHash: { in: plans.map((plan) => plan.recipeHash) },
            pipelineVersion: IMAGE_PIPELINE_VERSION,
            status: 'ready',
          },
        });
        if (rows.length !== plans.length) return false;
        const byRecipe = new Map(rows.map((row) => [row.recipeHash, row]));
        for (const plan of plans) {
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
          ) {
            return false;
          }
          const head = await this.storage.head(row.objectKey);
          if (
            !head ||
            head.size !== row.sizeBytes ||
            head.contentType !== row.mime
          ) {
            return false;
          }
          const hashed = await this.storage.hashObject(row.objectKey);
          if (hashed.sha256 !== row.contentHash || hashed.size !== row.sizeBytes) return false;
        }
        const manifest = projectDerivedImageManifest({
          pipelineVersion: IMAGE_PIPELINE_VERSION,
          sourceHash: input.sourceHash,
          variants: rows,
        });
        await tx.asset.update({
          where: { id: input.assetId },
          data: { derivedKeys: manifest as unknown as Prisma.InputJsonObject },
        });
        return true;
      },
      { maxWait: 10_000, timeout: 120_000 },
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
    attemptedWrites: Set<string>,
  ): Promise<boolean> {
    const existing = await this.storage.head(key);
    if (existing) {
      const hashed = await this.storage.hashObject(key);
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
    attemptedWrites.add(key);
    try {
      await this.storage.putBuffer(key, rendered.data, rendered.info.mime);
    } catch (error) {
      // PUT may have committed but its response was lost. Verify the authoritative bytes before
      // deciding whether this is a failure; compensation later is ownership-aware.
      const after = await this.storage.head(key);
      if (!after) throw error;
    }
    const after = await this.storage.head(key);
    const hashed = await this.storage.hashObject(key);
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

  private async persist(
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
  ): Promise<{ reused: number }> {
    const attemptedWrites = new Set<string>();
    let reused = 0;
    try {
      await this.prisma.withWorkspace(
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
          if (locked.length !== 1) throw new Error('asset changed while image variants were rendered');
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
          for (const plan of ordered) {
            const output = rendered.get(plan.recipeHash)!;
            const key = buildVariantObjectKey(
              input.workspaceId,
              input.siteId,
              input.assetId,
              plan.recipeHash,
              plan.recipe.output.format,
            );
            await tx.$executeRaw(Prisma.sql`
              SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))
            `);
            const objectReused = await this.ensureObject(key, output, attemptedWrites);
            const current = byRecipe.get(plan.recipeHash);
            const data = this.variantData(input, inspection, plan, output, key, 'ready');
            if (current) {
              if (
                current.objectKey !== key ||
                current.pipelineVersion !== IMAGE_PIPELINE_VERSION ||
                current.variantType !== plan.recipe.output.role ||
                current.mime !== output.info.mime ||
                current.width !== output.info.width ||
                current.height !== output.info.height
              ) {
                throw new Error(`existing variant provenance conflicts for ${plan.recipeHash}`);
              }
              if (
                current.status === 'ready' &&
                (current.contentHash !== output.info.contentHash ||
                  current.sizeBytes !== output.info.sizeBytes)
              ) {
                throw new Error(`ready variant identity conflicts for ${plan.recipeHash}`);
              }
              if (current.status !== 'ready') {
                await tx.assetVariant.update({
                  where: { id: current.id },
                  data: {
                    status: 'ready',
                    contentHash: output.info.contentHash,
                    sizeBytes: output.info.sizeBytes,
                    error: null,
                    metadata: data.metadata,
                  },
                });
              } else if (!objectReused) {
                // Missing ready object repaired with exactly the immutable content identity.
                reused += 1;
              } else {
                reused += 1;
              }
            } else {
              await tx.assetVariant.create({ data });
            }
          }
          const ready = await tx.assetVariant.findMany({
            where: {
              assetId: input.assetId,
              pipelineVersion: IMAGE_PIPELINE_VERSION,
              status: 'ready',
            },
          });
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
        { maxWait: 10_000, timeout: 180_000 },
      );
      return { reused };
    } catch (error) {
      try {
        await this.compensateUnowned(input, inspection, plans, rendered, attemptedWrites);
      } catch (compensationError) {
        throw new AggregateError(
          [error, compensationError],
          'image variant persistence failed and orphan parking could not be completed',
        );
      }
      throw error;
    }
  }

  private variantData(
    input: {
      workspaceId: string;
      siteId: string;
      assetId: string;
      sourceMeta: Record<string, Prisma.JsonValue>;
    },
    inspection: ImageInspection,
    plan: PlannedImageVariant,
    output: RenderedImageVariant,
    key: string,
    status: 'ready' | 'failed',
  ): Prisma.AssetVariantUncheckedCreateInput {
    return {
      workspaceId: input.workspaceId,
      siteId: input.siteId,
      assetId: input.assetId,
      variantType: plan.recipe.output.role,
      mime: output.info.mime,
      width: output.info.width,
      height: output.info.height,
      durationMs: null,
      bitrateKbps: null,
      sizeBytes: output.info.sizeBytes,
      objectKey: key,
      contentHash: output.info.contentHash,
      pipelineVersion: IMAGE_PIPELINE_VERSION,
      recipeHash: plan.recipeHash,
      sourceVariantId: null,
      status,
      error: status === 'failed' ? 'IMAGE_VARIANT_ORPHAN_CLEANUP_REQUIRED' : null,
      metadata: {
        schemaVersion: '1.0',
        recipe: plan.recipe as unknown as Prisma.InputJsonObject,
        quality: inspection.quality as unknown as Prisma.InputJsonObject,
        aiEdited: false,
        ...(typeof input.sourceMeta.hasPerson === 'boolean'
          ? { hasPerson: input.sourceMeta.hasPerson }
          : {}),
      },
    };
  }

  private async compensateUnowned(
    input: {
      workspaceId: string;
      siteId: string;
      assetId: string;
      sourceMeta: Record<string, Prisma.JsonValue>;
    },
    inspection: ImageInspection,
    plans: readonly PlannedImageVariant[],
    rendered: ReadonlyMap<string, RenderedImageVariant>,
    keys: ReadonlySet<string>,
  ): Promise<void> {
    const failures: unknown[] = [];
    for (const key of [...keys].sort()) {
      try {
        await this.prisma.withWorkspace(
          input.workspaceId,
          async (tx) => {
            await tx.$executeRaw(Prisma.sql`
              SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))
            `);
            const owner = await tx.assetVariant.findUnique({
              where: { objectKey: key },
              select: { id: true },
            });
            if (owner) return;
            let settled = false;
            try {
              await this.storage.delete(key);
              settled = (await this.storage.head(key)) === null;
            } catch {
              try {
                settled = (await this.storage.head(key)) === null;
              } catch {
                settled = false;
              }
            }
            if (settled) return;
            const plan = plans.find((candidate) =>
              key.endsWith(`/${candidate.recipeHash}.${candidate.recipe.output.format === 'jpeg' ? 'jpg' : candidate.recipe.output.format}`),
            );
            const output = plan ? rendered.get(plan.recipeHash) : undefined;
            if (!plan || !output) throw new Error(`cannot park unowned variant ${key}`);
            // Durable failed row makes the object visible to MF0-B cleanup and lets a later retry
            // verify/adopt the exact bytes. Never leave an untracked object after delete failure.
            await tx.assetVariant.create({
              data: this.variantData(input, inspection, plan, output, key, 'failed'),
            });
          },
          { timeout: 60_000 },
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'one or more variant objects could not be deleted or parked');
    }
  }
}
