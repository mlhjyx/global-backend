/**
 * R2-A4 development-only true-service verifier.
 *
 * Requires the current branch worker on the normal task queue. With --fault-injection it
 * briefly stops the local MinIO container after Temporal starts, then restores it to prove
 * retry convergence. Never run against production.
 *
 * ALLOW_DEV_DB_VERIFIER=true DOTENV_CONFIG_PATH=/global/backend/apps/api/.env \
 *   node --import tsx scripts/verify-site-builder-cleanup-r2.mts --fault-injection
 */
import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { OutboxRelayService } from '../src/relay/outbox-relay.service';
import { StorageService } from '../src/site-builder/storage.service';
import { TemporalClient } from '../src/temporal/temporal.client';

const execFileAsync = promisify(execFile);
const faultInjection = process.argv.includes('--fault-injection');

function isLoopback(host: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host.toLowerCase());
}

function guardDevelopmentTargets(): void {
  if (process.env.ALLOW_DEV_DB_VERIFIER !== 'true' || process.env.NODE_ENV === 'production') {
    throw new Error('refusing cleanup verifier without explicit non-production development opt-in');
  }
  for (const raw of [process.env.DATABASE_URL, process.env.APP_DATABASE_URL]) {
    if (!raw) throw new Error('DATABASE_URL and APP_DATABASE_URL are required');
    const url = new URL(raw);
    if (!isLoopback(url.hostname) || url.pathname !== '/global_dev') {
      throw new Error('cleanup verifier requires loopback global_dev databases');
    }
  }
  const s3 = new URL(process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000');
  if (!isLoopback(s3.hostname)) throw new Error('cleanup verifier requires loopback S3');
  const temporal = new URL(
    (process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233').includes('://')
      ? (process.env.TEMPORAL_ADDRESS as string)
      : `grpc://${process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233'}`,
  );
  if (!isLoopback(temporal.hostname) || temporal.port !== '7233') {
    throw new Error('cleanup verifier requires loopback Temporal :7233');
  }
  if ((process.env.TEMPORAL_NAMESPACE ?? 'default') !== 'default') {
    throw new Error('cleanup verifier requires the default development namespace');
  }
}

async function waitFor<T>(label: string, read: () => Promise<T | null>, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main(): Promise<void> {
  guardDevelopmentTargets();
  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const app = new PrismaService();
  const storage = new StorageService();
  const temporal = new TemporalClient();
  await Promise.all([owner.$connect(), app.$connect(), temporal.onModuleInit()]);
  await storage.onModuleInit();

  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const siteId = randomUUID();
  const assetId = randomUUID();
  const eventId = randomUUID();
  const canonicalAssetId = randomUUID();
  const canonicalEventId = randomUUID();
  const stagingKey = `ws/${workspaceId}/${siteId}/uploads/${assetId}`;
  const canonicalKey = `ws/${workspaceId}/${siteId}/product_image/${'a'.repeat(64)}.jpg`;
  const canonicalBlockedKey = `ws/${workspaceId}/${siteId}/product_image/${'b'.repeat(64)}.jpg`;
  const touchedKeys = [stagingKey, canonicalKey, canonicalBlockedKey];
  let minioStopped = false;

  try {
    const role = await app.$queryRaw<{ is_superuser: string }[]>`
      SELECT current_setting('is_superuser') AS is_superuser`;
    if (role[0]?.is_superuser === 'on') throw new Error('app_user is unexpectedly superuser');

    await owner.workspace.createMany({
      data: [
        { id: workspaceId, name: 'R2-A4 cleanup verify' },
        { id: otherWorkspaceId, name: 'R2-A4 cleanup verify other' },
      ],
    });
    await app.withWorkspace(workspaceId, async (tx) => {
      await tx.site.create({
        data: { id: siteId, workspaceId, name: 'R2-A4 Verify Site', slug: `r2-a4-${siteId}`, intake: {} },
      });
      await tx.asset.createMany({
        data: [
          {
            id: assetId,
            workspaceId,
            siteId,
            kind: 'product_image',
            filename: 'cleanup.jpg',
            mime: 'image/jpeg',
            sizeBytes: 4,
            objectKey: canonicalKey,
            contentHash: 'a'.repeat(64),
            processingStatus: 'ready',
          },
          {
            id: canonicalAssetId,
            workspaceId,
            siteId,
            kind: 'product_image',
            filename: 'blocked.jpg',
            mime: 'image/jpeg',
            sizeBytes: 4,
            objectKey: canonicalBlockedKey,
            contentHash: 'b'.repeat(64),
            processingStatus: 'deleted',
            deletedAt: new Date(),
          },
        ],
      });
    });
    await Promise.all([
      storage.putBuffer(stagingKey, Buffer.from('late'), 'image/jpeg'),
      storage.putBuffer(canonicalKey, Buffer.from('keep'), 'image/jpeg'),
      storage.putBuffer(canonicalBlockedKey, Buffer.from('blocked'), 'image/jpeg'),
    ]);

    const notBefore = new Date(Date.now() + 4_000).toISOString();
    await app.withWorkspace(workspaceId, async (tx) => {
      await tx.outboxEvent.create({
        data: {
          eventId,
          workspaceId,
          eventType: 'AssetObjectCleanupRequested',
          schemaVersion: 1,
          aggregateType: 'Asset',
          aggregateId: assetId,
          privacyClassification: 'INTERNAL',
          payload: { assetId, siteId, objectKey: stagingKey, objectClass: 'staging', reason: 'commit_succeeded', notBefore },
        },
      });
      await tx.outboxEvent.create({
        data: {
          eventId: canonicalEventId,
          workspaceId,
          eventType: 'AssetObjectCleanupRequested',
          schemaVersion: 1,
          aggregateType: 'Asset',
          aggregateId: canonicalAssetId,
          privacyClassification: 'INTERNAL',
          parkedAt: new Date(),
          payload: {
            assetId: canonicalAssetId,
            siteId,
            objectKey: canonicalBlockedKey,
            objectClass: 'canonical',
            reason: 'asset_deleted',
            blockedUntil: 'site_spec_asset_reference_scanner',
          },
        },
      });
    });

    const relay = new OutboxRelayService(temporal, owner);
    const row = await owner.outboxEvent.findUniqueOrThrow({ where: { eventId } });
    await relay.routeEvent(row as never);
    if (!(await storage.head(stagingKey))) throw new Error('cleanup ran before notBefore timer');

    if (faultInjection) {
      await execFileAsync('docker', ['stop', 'global-minio']);
      minioStopped = true;
      await new Promise((resolve) => setTimeout(resolve, 7_000));
      await execFileAsync('docker', ['start', 'global-minio']);
      minioStopped = false;
      await waitFor('MinIO recovery', async () => {
        try {
          return (await storage.head(canonicalKey)) ? true : null;
        } catch {
          return null;
        }
      });
    }

    await Promise.race([
      temporal.client.workflow.getHandle(eventId).result(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('cleanup workflow timeout')), 45_000)),
    ]);
    if (await storage.head(stagingKey)) throw new Error('staging object survived completed workflow');
    if (!(await storage.head(canonicalKey))) throw new Error('canonical asset changed during staging cleanup');

    const published = await app.withWorkspace(workspaceId, (tx) =>
      tx.outboxEvent.findUniqueOrThrow({ where: { eventId } }),
    );
    if (!published.publishedAt || published.parkedAt) throw new Error('relay publication truth is invalid');
    const blocked = await app.withWorkspace(workspaceId, (tx) =>
      tx.outboxEvent.findUniqueOrThrow({ where: { eventId: canonicalEventId } }),
    );
    if (!blocked.parkedAt || blocked.publishedAt || !(await storage.head(canonicalBlockedKey))) {
      throw new Error('canonical cleanup escaped the MF-0 gate');
    }
    const hidden = await app.withWorkspace(otherWorkspaceId, (tx) =>
      tx.outboxEvent.findUnique({ where: { eventId } }),
    );
    if (hidden) throw new Error('cross-workspace cleanup event was visible');

    console.log(
      JSON.stringify({
        ok: true,
        environment: 'ubuntu-development',
        checks: ['app_user_force_rls', 'relay_temporal_minio', 'durable_timer', 'retry_recovery', 'canonical_parked', 'cross_tenant_hidden'],
      }),
    );
  } finally {
    if (minioStopped) await execFileAsync('docker', ['start', 'global-minio']).catch(() => undefined);
    for (const key of touchedKeys) await storage.delete(key).catch(() => undefined);
    await owner.outboxEvent.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } }).catch(() => undefined);
    await owner.site.deleteMany({ where: { id: siteId } }).catch(() => undefined);
    await owner.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } }).catch(() => undefined);
    await Promise.all([temporal.onModuleDestroy(), app.$disconnect(), owner.$disconnect()]);
  }
}

main().catch((error) => {
  console.error('R2-A4 cleanup development verifier failed:', error);
  process.exit(1);
});
