/**
 * M1-c true verifier — Ubuntu development PostgreSQL + MinIO only.
 *
 * Run from apps/api:
 *   ALLOW_DEV_DB_VERIFIER=true node --import tsx scripts/verify-site-builder-m1c.mts
 */
import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';

import { PrismaClient, type Prisma } from '@prisma/client';
import sharp from 'sharp';

import { PrismaService } from '../src/prisma/prisma.service';
import {
  IMAGE_PIPELINE_VERSION,
  inspectImageInput,
  planImageVariants,
} from '../src/site-builder/image-pipeline';
import {
  IsolatedImagePipelineRunner,
  type ImagePipelineRunner,
} from '../src/site-builder/image-pipeline-runner';
import { ImagePipelineService } from '../src/site-builder/image-pipeline.service';
import { projectDerivedImageManifest } from '../src/site-builder/media-foundation';
import { buildObjectKey, buildVariantObjectKey } from '../src/site-builder/object-key';
import { StorageService } from '../src/site-builder/storage.service';

const PREFIX = '__codex_m1c_verifier__:';
const checks: string[] = [];

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`assertion failed: ${message}`);
  checks.push(message);
  console.log(`  ✅ ${message}`);
}

function isLoopback(host: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host.toLowerCase());
}

function requireDevelopmentTargets(): void {
  if (process.env.ALLOW_DEV_DB_VERIFIER !== 'true' || process.env.NODE_ENV === 'production') {
    throw new Error('require ALLOW_DEV_DB_VERIFIER=true and non-production NODE_ENV');
  }
  for (const [name, raw] of [
    ['DATABASE_URL', process.env.DATABASE_URL],
    ['APP_DATABASE_URL', process.env.APP_DATABASE_URL],
  ] as const) {
    if (!raw) throw new Error(`${name} is required`);
    const url = new URL(raw);
    if (!isLoopback(url.hostname) || (url.port || '5432') !== '5432' || url.pathname !== '/global_dev') {
      throw new Error(`refusing ${name} target ${url.host}${url.pathname}`);
    }
  }
  const s3 = new URL(process.env.S3_ENDPOINT ?? 'http://localhost:9000');
  if (!isLoopback(s3.hostname) || (s3.port || '80') !== '9000') {
    throw new Error(`refusing non-development S3 endpoint ${s3.host}`);
  }
}

function hash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

async function fixture(): Promise<Buffer> {
  return sharp({
    create: {
      width: 3200,
      height: 2400,
      channels: 3,
      background: { r: 40, g: 100, b: 180 },
    },
  })
    .withExif({
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '31/1 14/1 0/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '121/1 28/1 0/1',
      },
    })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function main(): Promise<void> {
  requireDevelopmentTargets();
  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const appA = new PrismaService();
  const appB = new PrismaService();
  const storage = new StorageService();
  const isolatedRunner = new IsolatedImagePipelineRunner(120_000);
  let renderCalls = 0;
  const runner: ImagePipelineRunner = {
    render: (...args) => {
      renderCalls += 1;
      return isolatedRunner.render(...args);
    },
  };
  const serviceA = new ImagePipelineService(appA, storage, runner);
  const serviceB = new ImagePipelineService(appB, storage, runner);
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const siteId = randomUUID();
  const otherSiteId = randomUUID();
  const assetId = randomUUID();
  const lossAssetId = randomUUID();
  const badAssetId = randomUUID();
  const rollbackAssetId = randomUUID();
  const capacityAssetId = randomUUID();
  const objectKeys = new Set<string>();
  let failure: unknown;

  try {
    await Promise.all([owner.$connect(), appA.$connect(), appB.$connect()]);
    await storage.onModuleInit();
    const abandoned = await owner.workspace.findMany({
      where: { name: { startsWith: PREFIX } },
      select: { id: true },
    });
    if (abandoned.length) {
      const ids = abandoned.map((row) => row.id);
      const [variantObjects, assetObjects] = await Promise.all([
        owner.assetVariant.findMany({ where: { workspaceId: { in: ids } }, select: { objectKey: true } }),
        owner.asset.findMany({ where: { workspaceId: { in: ids } }, select: { objectKey: true } }),
      ]);
      await owner.assetVariant.deleteMany({ where: { workspaceId: { in: ids } } });
      await owner.site.deleteMany({ where: { workspaceId: { in: ids } } });
      await owner.workspace.deleteMany({ where: { id: { in: ids } } });
      for (const row of [...variantObjects, ...assetObjects]) await storage.delete(row.objectKey);
    }
    await owner.workspace.createMany({
      data: [
        { id: workspaceId, name: `${PREFIX}${randomUUID()}:A` },
        { id: otherWorkspaceId, name: `${PREFIX}${randomUUID()}:B` },
      ],
    });
    await owner.site.createMany({
      data: [
        { id: siteId, workspaceId, name: 'M1-c verifier A', slug: `m1c-${randomUUID()}`, intake: {} },
        { id: otherSiteId, workspaceId: otherWorkspaceId, name: 'M1-c verifier B', slug: `m1c-${randomUUID()}`, intake: {} },
      ],
    });

    const original = await fixture();
    const originalHash = hash(original);
    const originalKey = buildObjectKey(workspaceId, siteId, 'product_image', originalHash, 'jpg');
    const lossKey = buildObjectKey(workspaceId, siteId, 'factory_image', originalHash, 'jpg');
    const badKey = buildObjectKey(workspaceId, siteId, 'product_image', 'f'.repeat(64), 'jpg');
    const rollbackKey = buildObjectKey(workspaceId, siteId, 'logo', originalHash, 'jpg');
    const capacityKey = buildObjectKey(workspaceId, siteId, 'cert', originalHash, 'jpg');
    objectKeys.add(originalKey);
    objectKeys.add(lossKey);
    objectKeys.add(badKey);
    objectKeys.add(rollbackKey);
    objectKeys.add(capacityKey);
    await storage.putBuffer(originalKey, original, 'image/jpeg');
    await storage.putBuffer(lossKey, original, 'image/jpeg');
    await storage.putBuffer(badKey, Buffer.from('not-an-image'), 'image/jpeg');
    await storage.putBuffer(rollbackKey, original, 'image/jpeg');
    await storage.putBuffer(capacityKey, original, 'image/jpeg');
    await owner.asset.createMany({
      data: [
        {
          id: assetId,
          workspaceId,
          siteId,
          kind: 'product_image',
          filename: 'product.jpg',
          mime: 'image/jpeg',
          sizeBytes: original.length,
          objectKey: originalKey,
          contentHash: originalHash,
          processingStatus: 'ready',
          meta: { focalPoint: { x: 0.7, y: 0.5 } },
        },
        {
          id: lossAssetId,
          workspaceId,
          siteId,
          kind: 'factory_image',
          filename: 'factory.jpg',
          mime: 'image/jpeg',
          sizeBytes: original.length,
          objectKey: lossKey,
          contentHash: originalHash,
          processingStatus: 'ready',
          meta: { focalPoint: { x: 0.5, y: 0.5 }, hasPerson: true },
        },
        {
          id: badAssetId,
          workspaceId,
          siteId,
          kind: 'product_image',
          filename: 'bad.jpg',
          mime: 'image/jpeg',
          sizeBytes: 12,
          objectKey: badKey,
          contentHash: 'f'.repeat(64),
          processingStatus: 'ready',
        },
        {
          id: rollbackAssetId,
          workspaceId,
          siteId,
          kind: 'logo',
          filename: 'rollback.jpg',
          mime: 'image/jpeg',
          sizeBytes: original.length,
          objectKey: rollbackKey,
          contentHash: originalHash,
          processingStatus: 'ready',
        },
        {
          id: capacityAssetId,
          workspaceId,
          siteId,
          kind: 'cert',
          filename: 'capacity.jpg',
          mime: 'image/jpeg',
          sizeBytes: original.length,
          objectKey: capacityKey,
          contentHash: originalHash,
          processingStatus: 'ready',
        },
      ],
    });
    await owner.assetVariant.createMany({
      data: Array.from({ length: 120 }, (_, index) => {
        const recipeHash = hash(Buffer.from(`capacity-${index}`));
        return {
          workspaceId,
          siteId,
          assetId: capacityAssetId,
          variantType: 'logo',
          mime: 'image/png',
          width: 1,
          height: 1,
          sizeBytes: 1,
          objectKey: buildVariantObjectKey(
            workspaceId,
            siteId,
            capacityAssetId,
            recipeHash,
            'png',
          ),
          contentHash: 'a'.repeat(64),
          pipelineVersion: 'capacity-fixture-v1',
          recipeHash,
          status: 'failed',
          error: 'capacity fixture',
        };
      }),
    });

    const concurrent = await Promise.all([
      serviceA.processAsset({ workspaceId, siteId, assetId }),
      serviceB.processAsset({ workspaceId, siteId, assetId }),
    ]);
    check(concurrent.every((result) => result.status === 'done'), 'same-asset concurrent producers both settle');
    const rows = await appA.withWorkspace(workspaceId, (tx) =>
      tx.assetVariant.findMany({ where: { assetId }, orderBy: { recipeHash: 'asc' } }),
    );
    check(rows.length === 30, 'product image materializes 2 roles × 5 widths × 3 codecs exactly once');
    check(new Set(rows.map((row) => row.objectKey)).size === rows.length, 'every recipe owns one canonical object key');
    let checksumsValid = true;
    let metadataStripped = true;
    let coloursValid = true;
    for (const row of rows) {
      objectKeys.add(row.objectKey);
      const bytes = await storage.getBuffer(row.objectKey);
      const metadata = await sharp(bytes).metadata();
      checksumsValid &&= hash(bytes) === row.contentHash && bytes.length === row.sizeBytes;
      metadataStripped &&= metadata.exif === undefined && metadata.xmp === undefined;
      coloursValid &&= metadata.space === 'srgb';
    }
    check(checksumsValid, 'all 30 objects match DB checksum and byte count');
    check(metadataStripped, 'all 30 objects strip EXIF/GPS/XMP metadata');
    check(coloursValid, 'all 30 objects decode as sRGB');
    const assetAfter = await appA.withWorkspace(workspaceId, (tx) => tx.asset.findUnique({ where: { id: assetId } }));
    const projected = projectDerivedImageManifest({
      pipelineVersion: IMAGE_PIPELINE_VERSION,
      sourceHash: originalHash,
      variants: rows,
    });
    check(
      JSON.stringify(canonical(assetAfter?.derivedKeys)) === JSON.stringify(canonical(projected)),
      'derivedKeys is the exact authoritative Variant projection',
    );
    check((await storage.hashObject(originalKey)).sha256 === originalHash, 'original object remains byte-identical');

    const identityBefore = rows.map((row) => `${row.id}:${row.contentHash}`).join('|');
    const renderCallsBeforeReplay = renderCalls;
    const replay = await serviceA.processAsset({ workspaceId, siteId, assetId });
    const replayRows = await appA.withWorkspace(workspaceId, (tx) =>
      tx.assetVariant.findMany({ where: { assetId }, orderBy: { recipeHash: 'asc' } }),
    );
    check(replay.reused === 30 && replayRows.length === 30, 'replay reuses every ready Variant');
    check(renderCalls === renderCallsBeforeReplay, 'ready-set replay does not start a Sharp child process');
    check(identityBefore === replayRows.map((row) => `${row.id}:${row.contentHash}`).join('|'), 'replay preserves immutable row identity/checksum');

    let injected = false;
    const responseLossStorage = Object.create(storage) as StorageService;
    responseLossStorage.putBuffer = async (key, data, contentType) => {
      await storage.putBuffer(key, data, contentType);
      if (!injected) {
        injected = true;
        throw new Error('simulated PUT response loss');
      }
    };
    const lossService = new ImagePipelineService(appA, responseLossStorage, runner);
    const loss = await lossService.processAsset({ workspaceId, siteId, assetId: lossAssetId });
    check(injected && loss.status === 'done', 'PUT response loss is recovered by authoritative hash verification');
    const lossRows = await appA.withWorkspace(workspaceId, (tx) =>
      tx.assetVariant.findMany({ where: { assetId: lossAssetId } }),
    );
    for (const row of lossRows) objectKeys.add(row.objectKey);
    check(lossRows.length === 30, 'response-loss asset publishes a complete 30-Variant set');
    check(
      lossRows.every((row) => (row.metadata as Record<string, unknown> | null)?.hasPerson === true),
      'existing hasPerson=true is preserved without pretending to detect people',
    );

    let withWorkspaceCalls = 0;
    const normalWithWorkspace = appA.withWorkspace.bind(appA);
    const rollbackPrisma = {
      withWorkspace: async <T>(
        workspace: string,
        fn: (tx: Prisma.TransactionClient) => Promise<T>,
        options?: { maxWait?: number; timeout?: number },
      ): Promise<T> => {
        withWorkspaceCalls += 1;
        // processAsset uses call 1 for Asset read, call 2 for ready-set probe, call 3 for persist.
        if (withWorkspaceCalls !== 3) return normalWithWorkspace(workspace, fn, options);
        return appA.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspace}, true)`;
            await fn(tx);
            throw new Error('simulated commit-path rollback');
          },
          options,
        );
      },
    } as PrismaService;
    const rollbackService = new ImagePipelineService(rollbackPrisma, storage, runner);
    let rolledBack = false;
    try {
      await rollbackService.processAsset({ workspaceId, siteId, assetId: rollbackAssetId });
    } catch (error) {
      rolledBack = /simulated commit-path rollback/.test(String(error));
    }
    check(rolledBack, 'DB rollback after object PUT is surfaced to the caller');
    check(
      (await appA.withWorkspace(workspaceId, (tx) =>
        tx.assetVariant.count({ where: { assetId: rollbackAssetId } }),
      )) === 0,
      'rolled-back transaction publishes no Variant rows',
    );
    const rollbackInspection = await inspectImageInput(original, 'image/jpeg');
    const rollbackPlans = planImageVariants({
      assetKind: 'logo',
      assetContentHash: originalHash,
      inspection: rollbackInspection,
    });
    const rollbackVariantKeys = rollbackPlans.map((plan) =>
      buildVariantObjectKey(
        workspaceId,
        siteId,
        rollbackAssetId,
        plan.recipeHash,
        plan.recipe.output.format,
      ),
    );
    check(
      (await Promise.all(rollbackVariantKeys.map((key) => storage.head(key)))).every(
        (head) => head === null,
      ),
      'ownership-aware compensation removes every unowned object after rollback',
    );

    let parkingCalls = 0;
    const parkingPrisma = {
      withWorkspace: async <T>(
        workspace: string,
        fn: (tx: Prisma.TransactionClient) => Promise<T>,
        options?: { maxWait?: number; timeout?: number },
      ): Promise<T> => {
        parkingCalls += 1;
        if (parkingCalls !== 3) return normalWithWorkspace(workspace, fn, options);
        return appA.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspace}, true)`;
            await fn(tx);
            throw new Error('simulated rollback with unavailable object delete');
          },
          options,
        );
      },
    } as PrismaService;
    const deleteFailureStorage = Object.create(storage) as StorageService;
    deleteFailureStorage.delete = async () => {
      throw new Error('simulated MinIO delete outage');
    };
    let parkedFailureSurfaced = false;
    try {
      await new ImagePipelineService(parkingPrisma, deleteFailureStorage, runner).processAsset({
        workspaceId,
        siteId,
        assetId: rollbackAssetId,
      });
    } catch (error) {
      parkedFailureSurfaced = /simulated rollback with unavailable object delete/.test(String(error));
    }
    check(parkedFailureSurfaced, 'rollback remains a visible failure when object deletion is unavailable');
    const parked = await appA.withWorkspace(workspaceId, (tx) =>
      tx.assetVariant.findMany({ where: { assetId: rollbackAssetId } }),
    );
    for (const row of parked) objectKeys.add(row.objectKey);
    check(
      parked.length === 15 &&
        parked.every(
          (row) => row.status === 'failed' && row.error === 'IMAGE_VARIANT_ORPHAN_CLEANUP_REQUIRED',
        ),
      'delete outage parks every object as a durable failed Variant owner',
    );
    await serviceA.processAsset({ workspaceId, siteId, assetId: rollbackAssetId });
    check(
      (await appA.withWorkspace(workspaceId, (tx) =>
        tx.assetVariant.count({ where: { assetId: rollbackAssetId, status: 'ready' } }),
      )) === 15,
      'normal retry verifies and promotes all parked Variant objects',
    );

    let capacityRejected = false;
    try {
      await serviceA.processAsset({ workspaceId, siteId, assetId: capacityAssetId });
    } catch (error) {
      capacityRejected = /variant budget exceeded/.test(String(error));
    }
    check(capacityRejected, 'writer refuses to exceed the 120-row per-Asset cleanup budget');
    check(
      (await appA.withWorkspace(workspaceId, (tx) =>
        tx.assetVariant.count({ where: { assetId: capacityAssetId } }),
      )) === 120,
      'capacity rejection creates no extra Variant or object ownership rows',
    );

    const siteSummary = await serviceA.processSiteImages({ workspaceId, siteId });
    check(
      siteSummary.status === 'degraded' && siteSummary.failed === 2,
      'corrupt/capacity failures are isolated and reported as degraded',
    );
    check(siteSummary.processed === 3, 'healthy images still complete when a sibling image fails');
    check(
      (await appA.withWorkspace(otherWorkspaceId, (tx) => tx.assetVariant.count({ where: { assetId } }))) === 0,
      'FORCE RLS hides workspace A variants from workspace B',
    );
    check(
      (await appA.$queryRaw<Array<{ count: bigint }>>`SELECT count(*)::bigint AS count FROM asset_variant`)[0]?.count === 0n,
      'FORCE RLS hides all variants when workspace context is unset',
    );
  } catch (error) {
    failure = error;
  } finally {
    try {
      const rows = await owner.assetVariant.findMany({
        where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
        select: { objectKey: true },
      });
      for (const row of rows) objectKeys.add(row.objectKey);
      await owner.assetVariant.deleteMany({
        where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
      });
      await owner.site.deleteMany({
        where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
      });
      await owner.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
      for (const key of objectKeys) await storage.delete(key);
      check(
        (await owner.workspace.count({ where: { id: { in: [workspaceId, otherWorkspaceId] } } })) === 0,
        'verifier database fixtures cleaned',
      );
      check(
        (await Promise.all([...objectKeys].map((key) => storage.head(key)))).every((head) => head === null),
        'verifier object fixtures cleaned',
      );
    } catch (cleanupError) {
      failure ??= cleanupError;
    }
    await Promise.allSettled([appA.$disconnect(), appB.$disconnect(), owner.$disconnect()]);
  }
  if (failure) throw failure;
  console.log(`\nM1-c verifier passed (${checks.length} assertions). Development only; no production deployment performed.`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
