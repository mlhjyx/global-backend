/** R2-A4 development-only true-service verifier. Never run against production. */
import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ApplicationFailure } from '@temporalio/activity';
import { NativeConnection, Worker } from '@temporalio/worker';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { OutboxRelayService } from '../src/relay/outbox-relay.service';
import { StorageService } from '../src/site-builder/storage.service';
import { TemporalClient } from '../src/temporal/temporal.client';
import { createAssetCleanupActivities } from '../src/temporal/asset-cleanup.activities';
import {
  CleanupExecutionStatus,
  queueAssetCleanupRedrive,
} from '../src/temporal/asset-cleanup.redrive';

const execFileAsync = promisify(execFile);
const faultInjection = process.argv.includes('--fault-injection');
const temporalAddress = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
const temporalNamespace = process.env.TEMPORAL_NAMESPACE ?? 'default';

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
    if (!isLoopback(url.hostname) || (url.port || '5432') !== '5432' || url.pathname !== '/global_dev') {
      throw new Error('cleanup verifier requires loopback :5432/global_dev databases');
    }
  }
  const s3 = new URL(process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000');
  if (!isLoopback(s3.hostname) || (s3.port || '80') !== '9000') {
    throw new Error('cleanup verifier requires loopback MinIO :9000');
  }
  const temporalUrl = new URL(
    temporalAddress.includes('://') ? temporalAddress : `grpc://${temporalAddress}`,
  );
  if (!isLoopback(temporalUrl.hostname) || temporalUrl.port !== '7233' || temporalNamespace !== 'default') {
    throw new Error('cleanup verifier requires loopback Temporal :7233 default namespace');
  }
}

async function waitFor(label: string, check: () => Promise<boolean>, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function assertMinioContainer(): Promise<void> {
  const { stdout } = await execFileAsync('docker', [
    'inspect',
    '--format',
    '{{ index .Config.Labels "com.docker.compose.project" }}:{{ index .Config.Labels "com.docker.compose.service" }}',
    'global-minio',
  ]);
  if (stdout.trim() !== 'global:minio') throw new Error('global-minio is not the expected global:minio compose service');
}

async function main(): Promise<void> {
  guardDevelopmentTargets();
  if (faultInjection) await assertMinioContainer();

  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const app = new PrismaService();
  const storage = new StorageService();
  const temporal = new TemporalClient();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const siteId = randomUUID();
  const cleanupAssetId = randomUUID();
  const cleanupEventId = randomUUID();
  const redriveAssetId = randomUUID();
  const redriveEventId = randomUUID();
  const canonicalAssetId = randomUUID();
  const canonicalEventId = randomUUID();
  const cleanupStagingKey = `ws/${workspaceId}/${siteId}/uploads/${cleanupAssetId}`;
  const redriveStagingKey = `ws/${workspaceId}/${siteId}/uploads/${redriveAssetId}`;
  const cleanupCanonicalKey = `ws/${workspaceId}/${siteId}/product_image/${'a'.repeat(64)}.jpg`;
  const redriveCanonicalKey = `ws/${workspaceId}/${siteId}/product_image/${'b'.repeat(64)}.jpg`;
  const blockedCanonicalKey = `ws/${workspaceId}/${siteId}/product_image/${'c'.repeat(64)}.jpg`;
  const touchedKeys = [cleanupStagingKey, redriveStagingKey, cleanupCanonicalKey, redriveCanonicalKey, blockedCanonicalKey];
  const taskQueue = `r2-a4-cleanup-verify-${randomUUID()}`;
  const attempts = new Map<string, number>();
  const transportFailures = new Map<string, number>();
  const successfulDeletes = new Map<string, number>();
  const forcedNonRetryable = new Set<string>();
  const workflowHandles = new Map<string, ReturnType<typeof temporal.client.workflow.getHandle>>();
  let minioStopped = false;
  let worker: Worker | undefined;
  let workerRun: Promise<void> | undefined;
  let nativeConnection: NativeConnection | undefined;
  let verificationError: unknown;
  let resurrectionPromise: Promise<void> | undefined;
  let resurrectionObserved = false;

  const verifierStorage = {
    head: (key: string) => storage.head(key),
    delete: async (key: string) => {
      attempts.set(key, (attempts.get(key) ?? 0) + 1);
      if (forcedNonRetryable.has(key)) {
        throw ApplicationFailure.nonRetryable('verifier forced terminal failure', 'VERIFY_CLEANUP_FAILED');
      }
      try {
        await storage.delete(key);
        const successful = (successfulDeletes.get(key) ?? 0) + 1;
        successfulDeletes.set(key, successful);
        if (key === cleanupStagingKey && successful === 1) {
          // Reproduce a PUT authorised before expiry completing after the first delete. The
          // script-only workflow's durable settle must then reach a second delete/recheck.
          resurrectionPromise = new Promise<void>((resolve, reject) => {
            setTimeout(() => {
              storage.putBuffer(key, Buffer.from('completed-after-first-delete'), 'image/jpeg')
                .then(async () => {
                  resurrectionObserved = Boolean(await storage.head(key));
                  resolve();
                }, reject);
            }, 500);
          });
        }
      } catch (error) {
        transportFailures.set(key, (transportFailures.get(key) ?? 0) + 1);
        throw error;
      }
    },
  };

  try {
    await Promise.all([owner.$connect(), app.$connect(), temporal.onModuleInit()]);
    await storage.onModuleInit();
    const mutex = await owner.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtextextended('r2-a4-cleanup-development-verifier', 0)) AS locked`;
    if (!mutex[0]?.locked) throw new Error('another R2-A4 cleanup verifier is already running');
    const roles = await app.$queryRaw<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    if (!roles[0] || roles[0].rolsuper || roles[0].rolbypassrls || roles[0].current_user !== 'app_user') {
      throw new Error('APP_DATABASE_URL must be the non-superuser, non-BYPASSRLS app_user role');
    }

    nativeConnection = await NativeConnection.connect({ address: temporalAddress });
    worker = await Worker.create({
      connection: nativeConnection,
      namespace: temporalNamespace,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL('./workflows/asset-cleanup-verifier.workflow.ts', import.meta.url),
      ),
      activities: createAssetCleanupActivities({ prisma: app, storage: verifierStorage }),
    });
    workerRun = worker.run();

    await owner.workspace.createMany({
      data: [
        { id: workspaceId, name: 'R2-A4 cleanup verify' },
        { id: otherWorkspaceId, name: 'R2-A4 cleanup verify other' },
      ],
    });
    await app.withWorkspace(workspaceId, async (tx) => {
      await tx.site.create({ data: { id: siteId, workspaceId, name: 'R2-A4 Verify', slug: `r2-a4-${siteId}`, intake: {} } });
      await tx.asset.createMany({
        data: [
          { id: cleanupAssetId, workspaceId, siteId, kind: 'product_image', filename: 'cleanup.jpg', mime: 'image/jpeg', sizeBytes: 4, objectKey: cleanupCanonicalKey, contentHash: 'a'.repeat(64), processingStatus: 'ready' },
          { id: redriveAssetId, workspaceId, siteId, kind: 'product_image', filename: 'redrive.jpg', mime: 'image/jpeg', sizeBytes: 4, objectKey: redriveCanonicalKey, contentHash: 'b'.repeat(64), processingStatus: 'ready' },
          { id: canonicalAssetId, workspaceId, siteId, kind: 'product_image', filename: 'blocked.jpg', mime: 'image/jpeg', sizeBytes: 4, objectKey: blockedCanonicalKey, contentHash: 'c'.repeat(64), processingStatus: 'deleted', deletedAt: new Date() },
        ],
      });
    });
    await Promise.all([
      storage.putBuffer(cleanupStagingKey, Buffer.from('late'), 'image/jpeg'),
      storage.putBuffer(redriveStagingKey, Buffer.from('redrive'), 'image/jpeg'),
      storage.putBuffer(cleanupCanonicalKey, Buffer.from('keep-a'), 'image/jpeg'),
      storage.putBuffer(redriveCanonicalKey, Buffer.from('keep-b'), 'image/jpeg'),
      storage.putBuffer(blockedCanonicalKey, Buffer.from('blocked'), 'image/jpeg'),
    ]);

    const cleanupNotBefore = new Date(Date.now() + 5_000).toISOString();
    const redriveNotBefore = new Date(Date.now() - 1_000).toISOString();
    await app.withWorkspace(workspaceId, async (tx) => {
      for (const data of [
        { eventId: cleanupEventId, aggregateId: cleanupAssetId, objectKey: cleanupStagingKey, notBefore: cleanupNotBefore },
        { eventId: redriveEventId, aggregateId: redriveAssetId, objectKey: redriveStagingKey, notBefore: redriveNotBefore },
      ]) {
        await tx.outboxEvent.create({ data: { eventId: data.eventId, workspaceId, eventType: 'AssetObjectCleanupRequested', schemaVersion: 1, aggregateType: 'Asset', aggregateId: data.aggregateId, privacyClassification: 'INTERNAL', payload: { assetId: data.aggregateId, siteId, objectKey: data.objectKey, objectClass: 'staging', reason: 'commit_succeeded', notBefore: data.notBefore } } });
      }
      await tx.outboxEvent.create({ data: { eventId: canonicalEventId, workspaceId, eventType: 'AssetObjectCleanupRequested', schemaVersion: 1, aggregateType: 'Asset', aggregateId: canonicalAssetId, privacyClassification: 'INTERNAL', parkedAt: new Date(), payload: { assetId: canonicalAssetId, siteId, objectKey: blockedCanonicalKey, objectClass: 'canonical', reason: 'asset_deleted', blockedUntil: 'site_spec_asset_reference_scanner' } } });
    });

    const relayTemporal = {
      client: { workflow: { start: async (type: string, options: Record<string, unknown>) => {
        const handle = await temporal.client.workflow.start(type, { ...options, taskQueue } as never);
        workflowHandles.set(String(options.workflowId), handle as never);
        return handle;
      } } },
    };
    const relay = new OutboxRelayService(relayTemporal as never, owner);
    const route = async (eventId: string) => relay.routeEvent(await owner.outboxEvent.findUniqueOrThrow({ where: { eventId } }) as never);

    await route(cleanupEventId);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if ((attempts.get(cleanupStagingKey) ?? 0) !== 0 || !(await storage.head(cleanupStagingKey))) {
      throw new Error('durable timer did not preserve staging before notBefore');
    }
    if (faultInjection) {
      await execFileAsync('docker', ['stop', 'global-minio']);
      minioStopped = true;
      await waitFor('a real MinIO transport failure', async () => (transportFailures.get(cleanupStagingKey) ?? 0) >= 1);
      await execFileAsync('docker', ['start', 'global-minio']);
      minioStopped = false;
      await waitFor('MinIO recovery', async () => {
        try { return Boolean(await storage.head(cleanupCanonicalKey)); } catch { return false; }
      });
    }
    await workflowHandles.get(cleanupEventId)!.result();
    await resurrectionPromise;
    if (!resurrectionObserved || (successfulDeletes.get(cleanupStagingKey) ?? 0) < 2) {
      throw new Error('settle/recheck did not prove deletion of an object revived after first delete');
    }
    if (faultInjection && ((attempts.get(cleanupStagingKey) ?? 0) < 2 || (transportFailures.get(cleanupStagingKey) ?? 0) < 1)) {
      throw new Error('Temporal did not retry after the proven MinIO transport failure');
    }

    forcedNonRetryable.add(redriveStagingKey);
    await route(redriveEventId);
    const firstRedriveHandle = workflowHandles.get(redriveEventId)!;
    await firstRedriveHandle.result().then(
      () => { throw new Error('forced cleanup execution unexpectedly completed'); },
      () => undefined,
    );
    if ((await firstRedriveHandle.describe()).status.name !== 'FAILED') throw new Error('forced cleanup execution did not fail');
    forcedNonRetryable.delete(redriveStagingKey);
    const redrive = await queueAssetCleanupRedrive({
      prisma: app,
      workspaceId,
      eventId: redriveEventId,
      executionStatus: async () => (await temporal.client.workflow.getHandle(redriveEventId).describe()).status.name as CleanupExecutionStatus,
    });
    if (redrive.previousStatus !== 'FAILED') throw new Error('guarded redrive did not observe FAILED');
    await route(redriveEventId);
    const secondRedriveHandle = workflowHandles.get(redriveEventId)!;
    if (secondRedriveHandle.firstExecutionRunId === firstRedriveHandle.firstExecutionRunId) throw new Error('redrive did not create a new run');
    await secondRedriveHandle.result();

    if (await storage.head(cleanupStagingKey) || await storage.head(redriveStagingKey)) throw new Error('staging object survived completed cleanup');
    if (!(await storage.head(cleanupCanonicalKey)) || !(await storage.head(redriveCanonicalKey))) throw new Error('canonical object changed');
    const blocked = await app.withWorkspace(workspaceId, (tx) => tx.outboxEvent.findUniqueOrThrow({ where: { eventId: canonicalEventId } }));
    if (!blocked.parkedAt || blocked.publishedAt || !(await storage.head(blockedCanonicalKey))) throw new Error('canonical cleanup escaped MF-0 gate');
    const hidden = await app.withWorkspace(otherWorkspaceId, (tx) => tx.outboxEvent.findUnique({ where: { eventId: cleanupEventId } }));
    if (hidden) throw new Error('cross-workspace cleanup event was visible');

    console.log(JSON.stringify({ ok: true, environment: 'ubuntu-development', taskQueue, checks: ['app_user_force_rls', 'dedicated_verifier_only_worker', 'relay_temporal_minio', 'durable_expiry_grace_timer', 'real_minio_post_delete_revival_settle_redelete', ...(faultInjection ? ['real_minio_retry_recovery'] : []), 'failed_guarded_redrive_new_run', 'canonical_parked', 'cross_tenant_hidden'] }));
  } catch (error) {
    verificationError = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (minioStopped) {
      await execFileAsync('docker', ['start', 'global-minio']).catch((error) => cleanupErrors.push(error));
      minioStopped = false;
    }
    for (const handle of workflowHandles.values()) {
      try {
        const status = (await handle.describe()).status.name;
        if (status === 'RUNNING') await handle.terminate('R2-A4 verifier cleanup');
      } catch { /* closed/not-found */ }
    }
    if (worker) {
      worker.shutdown();
      await workerRun?.catch((error) => cleanupErrors.push(error));
    }
    await nativeConnection?.close().catch((error) => cleanupErrors.push(error));

    // Objects first, DB provenance last. If an object cannot be deleted/HEAD-verified, retain
    // the workspace/Site/Asset/Outbox rows so the residue remains attributable and recoverable.
    let objectsClean = true;
    for (const key of touchedKeys) {
      try {
        await storage.delete(key);
        if (await storage.head(key)) throw new Error(`object residue: ${key}`);
      } catch (error) {
        objectsClean = false;
        cleanupErrors.push(error);
      }
    }
    if (objectsClean) {
      try {
        await owner.$transaction(async (tx) => {
          await tx.outboxEvent.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } });
          await tx.asset.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } });
          await tx.site.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } });
          await tx.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
        });
        const [workspaces, sites, assets, events] = await Promise.all([
          owner.workspace.count({ where: { id: { in: [workspaceId, otherWorkspaceId] } } }),
          owner.site.count({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } }),
          owner.asset.count({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } }),
          owner.outboxEvent.count({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } }),
        ]);
        if (workspaces || sites || assets || events) throw new Error(`database residue: ${JSON.stringify({ workspaces, sites, assets, events })}`);
      } catch (error) { cleanupErrors.push(error); }
    }
    await temporal.onModuleDestroy().catch((error) => cleanupErrors.push(error));
    await app.$disconnect().catch((error) => cleanupErrors.push(error));
    await owner.$disconnect().catch((error) => cleanupErrors.push(error));
    const failures = [verificationError, ...cleanupErrors].filter((value) => value !== undefined);
    if (failures.length) throw new AggregateError(failures, 'R2-A4 verifier and/or cleanup failed');
  }
}

main().catch((error) => {
  console.error('R2-A4 cleanup development verifier failed:', error);
  process.exit(1);
});
