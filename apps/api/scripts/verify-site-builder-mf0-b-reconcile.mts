/** MF0-B true PostgreSQL verifier for historical parked canonical reconciliation (development only). */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { SiteSpecAssetReferenceScanner } from '../src/site-builder/site-spec-asset-reference-scanner';
import { reconcileParkedCanonicalCleanups } from '../src/temporal/asset-cleanup.reconcile';

function guard() {
  if (process.env.ALLOW_DEV_DB_VERIFIER !== 'true' || process.env.NODE_ENV === 'production') {
    throw new Error('require ALLOW_DEV_DB_VERIFIER=true and non-production NODE_ENV');
  }
  for (const name of ['DATABASE_URL', 'APP_DATABASE_URL'] as const) {
    const raw = process.env[name];
    if (!raw) throw new Error(`${name} is required`);
    const url = new URL(raw);
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname) || url.pathname !== '/global_dev') {
      throw new Error(`${name} must target loopback/global_dev`);
    }
  }
}

const classifications = ['eligible', 'referenced', 'busy', 'inconsistent', 'already'] as const;

async function main() {
  guard();
  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const app = new PrismaService();
  const workspaceId = randomUUID();
  const siteId = randomUUID();
  const rows = new Map<
    (typeof classifications)[number],
    { assetId: string; eventId: string; hash: string; objectKey: string }
  >();
  for (const classification of classifications) {
    const assetId = randomUUID();
    const eventId = randomUUID();
    const hash = Buffer.from(`${classification}:${assetId}`).toString('hex').slice(0, 64).padEnd(64, '0');
    rows.set(classification, {
      assetId,
      eventId,
      hash,
      objectKey: `ws/${workspaceId}/${siteId}/product_image/${hash}.jpg`,
    });
  }
  const missingEventId = randomUUID();
  const missingAssetId = randomUUID();
  try {
    await Promise.all([owner.$connect(), app.$connect()]);
    await owner.workspace.create({
      data: { id: workspaceId, name: `__codex_mf0b_reconcile__:${workspaceId}` },
    });
    await owner.site.create({
      data: { id: siteId, workspaceId, name: 'MF0-B reconcile', slug: `mf0b-rec-${siteId}`, intake: {} },
    });
    for (const [classification, row] of rows) {
      await owner.asset.create({
        data: {
          id: row.assetId,
          workspaceId,
          siteId,
          kind: 'product_image',
          filename: `${classification}.jpg`,
          mime: 'image/jpeg',
          sizeBytes: 1,
          objectKey: row.objectKey,
          contentHash: row.hash,
          processingStatus: 'ready',
        },
      });
    }

    const referenced = rows.get('referenced')!;
    const versionId = randomUUID();
    await owner.siteVersion.create({
      data: {
        id: versionId,
        workspaceId,
        siteId,
        version: 1,
        source: 'manual',
        specVersion: '1.0.0',
        buildStatus: 'succeeded',
        spec: {
          specVersion: '1.0.0',
          assets: { [referenced.assetId]: { kind: 'product_image', hash: referenced.hash } },
          pages: [
            {
              id: 'home',
              puck: {
                root: {},
                content: [{ type: 'Hero', props: { imageAssetId: referenced.assetId } }],
              },
            },
          ],
        },
      },
    });
    await owner.site.update({ where: { id: siteId }, data: { activeVersionId: versionId } });

    const busy = rows.get('busy')!;
    await owner.assetVariant.create({
      data: {
        workspaceId,
        siteId,
        assetId: busy.assetId,
        variantType: 'hero',
        mime: 'image/webp',
        objectKey: `ws/${workspaceId}/${siteId}/variants/${busy.assetId}/${'b'.repeat(64)}.webp`,
        pipelineVersion: 'verify',
        recipeHash: 'b'.repeat(64),
        status: 'processing',
      },
    });

    for (const [classification, row] of rows) {
      await owner.asset.update({
        where: { id: row.assetId },
        data: {
          processingStatus: 'deleted',
          deletedAt: new Date(),
          cleanupEventId: row.eventId,
          ...(classification === 'already' ? { cleanupCompletedAt: new Date() } : {}),
        },
      });
      if (classification !== 'already') {
        // Reproduce the exact post-051 quarantine state. The marker guard intentionally forbids
        // application writes from creating this state, so the owner verifier disables triggers
        // only for this transaction, just as the migration backfill precedes trigger creation.
        await owner.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL session_replication_role = 'replica'`;
          await tx.asset.update({
            where: { id: row.assetId },
            data: { cleanupEventId: null, cleanupLegacyUnbound: true },
          });
        });
      }
      await owner.outboxEvent.create({
        data: {
          eventId: row.eventId,
          workspaceId,
          eventType: 'AssetObjectCleanupRequested',
          schemaVersion: 1,
          aggregateType: 'Asset',
          aggregateId: row.assetId,
          privacyClassification: 'INTERNAL',
          parkedAt: new Date(),
          payload: {
            assetId: row.assetId,
            siteId,
            objectKey: classification === 'inconsistent' ? `${row.objectKey}.wrong` : row.objectKey,
            objectClass: 'canonical',
            reason: 'asset_deleted',
            blockedUntil: 'site_spec_asset_reference_scanner',
          } as Prisma.InputJsonValue,
        },
      });
    }
    await owner.outboxEvent.create({
      data: {
        eventId: missingEventId,
        workspaceId,
        eventType: 'AssetObjectCleanupRequested',
        schemaVersion: 1,
        aggregateType: 'Asset',
        aggregateId: missingAssetId,
        privacyClassification: 'INTERNAL',
        parkedAt: new Date(),
        payload: {
          assetId: missingAssetId,
          siteId,
          objectKey: `ws/${workspaceId}/${siteId}/product_image/${'f'.repeat(64)}.jpg`,
          objectClass: 'canonical',
          reason: 'asset_deleted',
          blockedUntil: 'site_spec_asset_reference_scanner',
        },
      },
    });

    const deps = { ownerDb: owner, prisma: app, scanner: new SiteSpecAssetReferenceScanner() };
    const dry = await reconcileParkedCanonicalCleanups(deps, { limit: 20 });
    if (
      dry.counts.eligible !== 1 ||
      dry.counts.referenced !== 1 ||
      dry.counts.busy !== 1 ||
      dry.counts.inconsistent !== 1 ||
      dry.counts.missing !== 1 ||
      dry.counts.already_reconciled !== 1
    ) {
      throw new Error(`unexpected dry-run classifications: ${JSON.stringify(dry.counts)}`);
    }
    if (dry.legacyUnboundRemaining !== 4) {
      throw new Error(`dry-run changed or miscounted quarantine state: ${dry.legacyUnboundRemaining}`);
    }
    const applied = await reconcileParkedCanonicalCleanups(deps, { apply: true, limit: 20 });
    if (applied.counts.eligible !== 1) throw new Error('eligible legacy event was not applied');
    if (applied.legacyUnboundRemaining !== 3) {
      throw new Error(`apply did not reduce quarantine count: ${applied.legacyUnboundRemaining}`);
    }
    const eligible = rows.get('eligible')!;
    const successor = await owner.outboxEvent.findFirst({
      where: { causationId: eligible.eventId, schemaVersion: 2 },
    });
    const rebound = await owner.asset.findUnique({ where: { id: eligible.assetId } });
    if (!successor || rebound?.cleanupEventId !== successor.eventId || rebound.cleanupLegacyUnbound) {
      throw new Error('strict successor provenance was not bound atomically');
    }
    const rerun = await reconcileParkedCanonicalCleanups(deps, { apply: true, limit: 20 });
    if (rerun.counts.already_reconciled < 2) {
      throw new Error('reconciliation rerun was not idempotent');
    }
    console.log(
      JSON.stringify({
        verified: true,
        postgres: true,
        dryRun: dry.counts,
        apply: applied.counts,
        rerun: rerun.counts,
        successorCausation: true,
      }),
    );
  } finally {
    await owner.outboxEvent.deleteMany({ where: { workspaceId } }).catch(() => undefined);
    await owner.site.deleteMany({ where: { workspaceId } }).catch(() => undefined);
    await owner.workspace.deleteMany({ where: { id: workspaceId } }).catch(() => undefined);
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  }
}

await main();
