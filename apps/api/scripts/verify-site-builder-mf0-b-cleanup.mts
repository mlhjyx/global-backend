/** MF0-B true PostgreSQL + MinIO + Temporal canonical cleanup verifier (development only). */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { PrismaClient, type Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { StorageService } from '../src/site-builder/storage.service';
import { buildVariantObjectKey } from '../src/site-builder/object-key';
import { createAssetCleanupActivities } from '../src/temporal/asset-cleanup.activities';
import { assetCleanupPayload, parseAssetCleanupCommand } from '../src/temporal/asset-cleanup.contract';

function isLoopback(host: string) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host.toLowerCase());
}

function guard() {
  if (process.env.ALLOW_DEV_DB_VERIFIER !== 'true' || process.env.NODE_ENV === 'production') {
    throw new Error('require ALLOW_DEV_DB_VERIFIER=true and non-production NODE_ENV');
  }
  for (const name of ['DATABASE_URL', 'APP_DATABASE_URL'] as const) {
    const raw = process.env[name];
    if (!raw) throw new Error(`${name} is required`);
    const url = new URL(raw);
    if (!isLoopback(url.hostname) || url.pathname !== '/global_dev')
      throw new Error(`${name} must target loopback/global_dev`);
  }
  const s3 = new URL(process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000');
  if (!isLoopback(s3.hostname) || (s3.port || '80') !== '9000') throw new Error('MinIO must be loopback:9000');
}

async function main() {
  guard();
  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const app = new PrismaService();
  const storage = new StorageService();
  const temporalAddress = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
  const workspaceId = randomUUID();
  const siteId = randomUUID();
  const assetId = randomUUID();
  const eventId = randomUUID();
  const parentId = randomUUID();
  const childId = randomUUID();
  const sourceHash = 'a'.repeat(64);
  const parentRecipe = 'b'.repeat(64);
  const childRecipe = 'c'.repeat(64);
  const canonicalKey = `ws/${workspaceId}/${siteId}/product_image/${sourceHash}.jpg`;
  const parentKey = buildVariantObjectKey(workspaceId, siteId, assetId, parentRecipe, 'webp');
  const childKey = buildVariantObjectKey(workspaceId, siteId, assetId, childRecipe, 'avif');
  const taskQueue = `mf0b-cleanup-verify-${randomUUID()}`;
  let nativeConnection: NativeConnection | undefined;
  let worker: Worker | undefined;
  let workerRun: Promise<void> | undefined;
  let clientConnection: Connection | undefined;
  try {
    await Promise.all([owner.$connect(), app.$connect()]);
    await storage.onModuleInit();
    await owner.workspace.create({ data: { id: workspaceId, name: `__codex_mf0b_cleanup__:${workspaceId}` } });
    await owner.site.create({
      data: { id: siteId, workspaceId, name: 'MF0-B cleanup', slug: `mf0b-clean-${siteId}`, intake: {} },
    });
    await owner.asset.create({
      data: {
        id: assetId,
        workspaceId,
        siteId,
        kind: 'product_image',
        filename: 'source.jpg',
        mime: 'image/jpeg',
        sizeBytes: 6,
        objectKey: canonicalKey,
        contentHash: sourceHash,
        processingStatus: 'ready',
      },
    });
    await owner.assetVariant.create({
      data: {
        id: parentId,
        workspaceId,
        siteId,
        assetId,
        variantType: 'hero',
        mime: 'image/webp',
        width: 640,
        height: 360,
        sizeBytes: 6,
        objectKey: parentKey,
        contentHash: 'd'.repeat(64),
        pipelineVersion: 'verify',
        recipeHash: parentRecipe,
        status: 'ready',
      },
    });
    await owner.assetVariant.create({
      data: {
        id: childId,
        workspaceId,
        siteId,
        assetId,
        sourceVariantId: parentId,
        variantType: 'hero',
        mime: 'image/avif',
        width: 320,
        height: 180,
        sizeBytes: 6,
        objectKey: childKey,
        contentHash: 'e'.repeat(64),
        pipelineVersion: 'verify',
        recipeHash: childRecipe,
        status: 'ready',
      },
    });
    const command = parseAssetCleanupCommand({
      eventId,
      workspaceId,
      siteId,
      assetId,
      objectClass: 'canonical',
      reason: 'asset_deleted',
      canonical: { objectKey: canonicalKey, contentHash: sourceHash },
      variants: [
        {
          id: parentId,
          objectKey: parentKey,
          contentHash: 'd'.repeat(64),
          recipeHash: parentRecipe,
          sourceVariantId: null,
          status: 'ready',
        },
        {
          id: childId,
          objectKey: childKey,
          contentHash: 'e'.repeat(64),
          recipeHash: childRecipe,
          sourceVariantId: parentId,
          status: 'ready',
        },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    });
    await app.withWorkspace(workspaceId, async (tx) => {
      await tx.asset.update({
        where: { id: assetId },
        data: { processingStatus: 'deleted', deletedAt: new Date(), cleanupEventId: eventId },
      });
      await tx.outboxEvent.create({
        data: {
          eventId,
          workspaceId,
          eventType: 'AssetObjectCleanupRequested',
          schemaVersion: 2,
          aggregateType: 'Asset',
          aggregateId: assetId,
          privacyClassification: 'INTERNAL',
          payload: assetCleanupPayload(command) as Prisma.InputJsonValue,
        },
      });
    });
    await Promise.all([
      storage.putBuffer(canonicalKey, Buffer.from('source'), 'image/jpeg'),
      storage.putBuffer(parentKey, Buffer.from('parent'), 'image/webp'),
      storage.putBuffer(childKey, Buffer.from('child!'), 'image/avif'),
    ]);

    nativeConnection = await NativeConnection.connect({ address: temporalAddress });
    worker = await Worker.create({
      connection: nativeConnection,
      namespace,
      taskQueue,
      workflowsPath: fileURLToPath(new URL('./workflows/asset-cleanup-verifier.workflow.ts', import.meta.url)),
      activities: createAssetCleanupActivities({ prisma: app, storage }),
    });
    workerRun = worker.run();
    clientConnection = await Connection.connect({ address: temporalAddress });
    const client = new Client({ connection: clientConnection, namespace });
    const handle = await client.workflow.start('assetObjectCleanupWorkflow', {
      taskQueue,
      workflowId: eventId,
      args: [command],
    });
    await handle.result();

    for (const key of [childKey, parentKey, canonicalKey]) {
      if (await storage.head(key)) throw new Error(`object survived canonical cleanup: ${key}`);
    }
    const settled = await app.withWorkspace(workspaceId, async (tx) => ({
      asset: await tx.asset.findUnique({ where: { id: assetId } }),
      variants: await tx.assetVariant.count({ where: { assetId } }),
    }));
    if (!settled.asset?.cleanupCompletedAt || settled.variants !== 0) {
      throw new Error('canonical cleanup did not settle DB provenance');
    }

    const replacementId = randomUUID();
    await owner.asset.create({
      data: {
        id: replacementId,
        workspaceId,
        siteId,
        kind: 'product_image',
        filename: 'replacement.jpg',
        mime: 'image/jpeg',
        sizeBytes: 11,
        objectKey: canonicalKey,
        contentHash: sourceHash,
        processingStatus: 'ready',
      },
    });
    await storage.putBuffer(canonicalKey, Buffer.from('replacement'), 'image/jpeg');
    const replay = createAssetCleanupActivities({ prisma: app, storage });
    const replayResult = await replay.cleanupCanonicalAssetObjects(command);
    const replaySettle = await replay.settleCanonicalAssetCleanup(command);
    if (!replayResult.alreadySettled || replaySettle.variantsDeleted !== 0 || !(await storage.head(canonicalKey))) {
      throw new Error('settled old event touched a later same-hash replacement');
    }
    console.log(JSON.stringify({ verified: true, temporal: true, minio: true, postgres: true }));
  } finally {
    await storage.delete(canonicalKey).catch(() => undefined);
    await storage.delete(parentKey).catch(() => undefined);
    await storage.delete(childKey).catch(() => undefined);
    await owner.outboxEvent.deleteMany({ where: { workspaceId } }).catch(() => undefined);
    await owner.site.deleteMany({ where: { workspaceId } }).catch(() => undefined);
    await owner.workspace.deleteMany({ where: { id: workspaceId } }).catch(() => undefined);
    if (worker) worker.shutdown();
    await workerRun?.catch(() => undefined);
    await clientConnection?.close();
    await nativeConnection?.close();
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  }
}

await main();
