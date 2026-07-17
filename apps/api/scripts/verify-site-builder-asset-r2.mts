/**
 * R2-A1 Asset 开发环境真服务验证（无 sandbox）。
 *
 * 依赖：PostgreSQL + MinIO；使用真实 app_user/RLS、真实 presigned PUT、真实 copy/delete。
 * 可控 gate 只负责冻结第一次 head 的时序，以确定性制造并发窗口；存储操作仍落真实 MinIO。
 * R2-A4 后本脚本验证 cleanup intent 真值与「不提前删除」；Temporal 真链由
 * verify-site-builder-cleanup-r2.mts 独立验证。
 *
 * 跑法（Ubuntu 开发环境）：
 *   cd apps/api
 *   node --import tsx scripts/verify-site-builder-asset-r2.mts
 */
import 'dotenv/config';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { AssetsService } from '../src/site-builder/assets.service';
import { StorageService } from '../src/site-builder/storage.service';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('r2-a1-real-minio-verification')]);
const RETRY_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.from('r2-a1-distinct-retry-payload')]);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ok(section: string, message: string): void {
  console.log(`  ✅ ${section} ${message}`);
}

async function expectConflict(promise: Promise<unknown>, label: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ConflictException) return;
    throw new Error(`${label}: expected ConflictException, got ${String(err)}`);
  }
  throw new Error(`${label}: expected conflict, request succeeded`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const appDb = new PrismaService();
  const owner = new PrismaClient({ datasourceUrl: databaseUrl });
  const storage = new StorageService();
  await Promise.all([appDb.$connect(), owner.$connect()]);
  await storage.onModuleInit();

  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const siteId = randomUUID();
  const ctx = { userId: 'verify-r2-a1', workspaceId, roles: [] };
  const otherCtx = {
    userId: 'verify-r2-a1-other',
    workspaceId: otherWorkspaceId,
    roles: [],
  };
  const touchedKeys = new Set<string>();

  try {
    const role = await appDb.$queryRaw<{ is_superuser: string; current_user: string }[]>`
      SELECT current_setting('is_superuser') AS is_superuser, current_user`;
    if (role[0]?.is_superuser === 'on') {
      throw new Error('APP_DATABASE_URL resolves to a superuser; RLS proof would be invalid');
    }
    ok('RLS guard', `connected as ${role[0]?.current_user}, is_superuser=off`);

    await owner.workspace.createMany({
      data: [
        { id: workspaceId, name: 'site-builder-r2-a1-verify' },
        { id: otherWorkspaceId, name: 'site-builder-r2-a1-verify-other' },
      ],
    });
    await appDb.withWorkspace(workspaceId, (tx) =>
      tx.site.create({
        data: {
          id: siteId,
          workspaceId,
          name: 'R2-A1 Verify Site',
          slug: `r2-a1-${randomUUID()}`,
          intake: {},
        },
      }),
    );

    const baseAssets = new AssetsService(appDb, storage);
    const signed = await baseAssets.presign(ctx, siteId, {
      kind: 'product_image',
      filename: 'pump.jpg',
      size: JPEG.length,
      mime: 'image/jpeg',
    });
    const staging = await appDb.withWorkspace(workspaceId, (tx) =>
      tx.asset.findUniqueOrThrow({ where: { id: signed.assetId } }),
    );
    touchedKeys.add(staging.objectKey);
    const put = await fetch(signed.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: JPEG,
    });
    if (!put.ok) throw new Error(`presigned PUT failed: HTTP ${put.status}`);
    ok('presign/PUT', `real MinIO object ${staging.objectKey} uploaded`);

    // 第一次 commit 在真实 MinIO HEAD 前冻结；第二次必须被 DB CAS 拒绝，不能触达 HEAD。
    const firstAtHead = deferred<void>();
    const releaseFirst = deferred<void>();
    let headCalls = 0;
    const gatedStorage = Object.create(storage) as StorageService;
    gatedStorage.head = async (key: string) => {
      headCalls += 1;
      if (headCalls === 1) {
        firstAtHead.resolve();
        await releaseFirst.promise;
      }
      return storage.head(key);
    };
    const gatedAssets = new AssetsService(appDb, gatedStorage);
    const firstCommit = gatedAssets.commit(ctx, signed.assetId);
    await firstAtHead.promise;

    const claimed = await appDb.withWorkspace(workspaceId, (tx) =>
      tx.asset.findUniqueOrThrow({ where: { id: signed.assetId } }),
    );
    if (
      claimed.processingStatus !== 'committing' ||
      claimed.processingAttempt !== 1 ||
      !claimed.leaseToken ||
      !claimed.leaseUntil
    ) {
      throw new Error(`invalid claimed row: ${JSON.stringify(claimed)}`);
    }
    await expectConflict(gatedAssets.commit(ctx, signed.assetId), 'concurrent commit');
    await expectConflict(baseAssets.remove(ctx, signed.assetId), 'delete during commit');
    if (headCalls !== 1) throw new Error(`CAS loser reached MinIO HEAD (${headCalls} calls)`);
    releaseFirst.resolve();
    const ready = await firstCommit;
    touchedKeys.add(ready.objectKey);
    if (ready.processingStatus !== 'ready') throw new Error(`commit ended ${ready.processingStatus}`);
    if (!(await storage.head(staging.objectKey)))
      throw new Error('staging object was deleted before the presigned PUT expiry gate');
    if (!(await storage.head(ready.objectKey))) throw new Error('canonical object missing after commit');
    ok('CAS/fencing', 'commit/delete losers blocked; canonical committed before staging cleanup');

    const stagingIntent = await appDb.withWorkspace(workspaceId, (tx) =>
      tx.outboxEvent.findFirst({
        where: {
          aggregateId: signed.assetId,
          eventType: 'AssetObjectCleanupRequested',
        },
        orderBy: { id: 'desc' },
      }),
    );
    const stagingPayload = stagingIntent?.payload as Record<string, unknown> | undefined;
    if (
      stagingIntent?.parkedAt ||
      stagingPayload?.objectClass !== 'staging' ||
      typeof stagingPayload?.notBefore !== 'string'
    ) {
      throw new Error('durable routable staging cleanup intent missing');
    }
    ok('Outbox', `staging cleanup intent routed after notBefore as event ${stagingIntent.eventId}`);

    // 同内容第二个 staging：真实 partial unique 最终收敛为 duplicate，绝不悬空 committing。
    const duplicateSigned = await baseAssets.presign(ctx, siteId, {
      kind: 'product_image',
      filename: 'pump-copy.jpg',
      size: JPEG.length,
      mime: 'image/jpeg',
    });
    const duplicateStaging = await appDb.withWorkspace(workspaceId, (tx) =>
      tx.asset.findUniqueOrThrow({ where: { id: duplicateSigned.assetId } }),
    );
    touchedKeys.add(duplicateStaging.objectKey);
    const duplicatePut = await fetch(duplicateSigned.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: JPEG,
    });
    if (!duplicatePut.ok) throw new Error(`duplicate presigned PUT failed: ${duplicatePut.status}`);
    await expectConflict(baseAssets.commit(ctx, duplicateSigned.assetId), 'duplicate commit');
    const duplicate = await appDb.withWorkspace(workspaceId, (tx) =>
      tx.asset.findUniqueOrThrow({ where: { id: duplicateSigned.assetId } }),
    );
    if (duplicate.processingStatus !== 'duplicate' || duplicate.leaseToken) {
      throw new Error(`duplicate did not reconcile: ${JSON.stringify(duplicate)}`);
    }
    if (!(await storage.head(duplicateStaging.objectKey)))
      throw new Error('duplicate staging was deleted before its upload URL expired');
    ok('duplicate', `second asset reconciled; staging retained until durable cleanup gate`);

    // 真 MinIO copy 的可恢复失败：第一次人工注入瞬时错误，只改变适配器返回；staging 仍是真对象。
    const retrySigned = await baseAssets.presign(ctx, siteId, {
      kind: 'product_image',
      filename: 'retry.jpg',
      size: RETRY_JPEG.length,
      mime: 'image/jpeg',
    });
    const retryStaging = await appDb.withWorkspace(workspaceId, (tx) =>
      tx.asset.findUniqueOrThrow({ where: { id: retrySigned.assetId } }),
    );
    touchedKeys.add(retryStaging.objectKey);
    const retryPut = await fetch(retrySigned.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: RETRY_JPEG,
    });
    if (!retryPut.ok) throw new Error(`retry presigned PUT failed: ${retryPut.status}`);
    const failingStorage = Object.create(storage) as StorageService;
    failingStorage.copy = async () => {
      throw new Error('verify injected transient copy failure');
    };
    const failingAssets = new AssetsService(appDb, failingStorage);
    try {
      await failingAssets.commit(ctx, retrySigned.assetId);
      throw new Error('copy failure injection unexpectedly succeeded');
    } catch (err) {
      if (err instanceof Error && err.message === 'copy failure injection unexpectedly succeeded') throw err;
    }
    const retryable = await appDb.withWorkspace(workspaceId, (tx) =>
      tx.asset.findUniqueOrThrow({ where: { id: retrySigned.assetId } }),
    );
    if (retryable.processingStatus !== 'failed_retryable' || !retryable.retryAt) {
      throw new Error(`transient failure not retryable: ${JSON.stringify(retryable)}`);
    }
    if (!(await storage.head(retryStaging.objectKey))) throw new Error('retry staging was deleted');
    await appDb.withWorkspace(workspaceId, (tx) =>
      tx.asset.update({
        where: { id: retrySigned.assetId },
        data: { retryAt: new Date(0) },
      }),
    );
    const retried = await baseAssets.commit(ctx, retrySigned.assetId);
    touchedKeys.add(retried.objectKey);
    if (retried.processingStatus !== 'ready' || retried.processingAttempt !== 2) {
      throw new Error(`retry did not re-claim/finalize: ${JSON.stringify(retried)}`);
    }
    if (!(await storage.head(retryStaging.objectKey)))
      throw new Error('retry staging was deleted before its upload URL expired');
    ok('retry', 'transient failure retained staging; second fenced attempt finalized safely');

    // 删除 ready 资产：DB/Kb 面先 tombstone，canonical 留给 MF0-B Temporal 异步回收。
    await baseAssets.remove(ctx, signed.assetId);
    const tombstone = await appDb.withWorkspace(workspaceId, (tx) =>
      tx.asset.findUniqueOrThrow({ where: { id: signed.assetId } }),
    );
    if (tombstone.processingStatus !== 'deleted' || !tombstone.deletedAt) {
      throw new Error(`asset not tombstoned: ${JSON.stringify(tombstone)}`);
    }
    if (!(await storage.head(ready.objectKey))) throw new Error('canonical object was deleted before scanner');
    const canonicalIntent = await appDb.withWorkspace(workspaceId, (tx) =>
      tx.outboxEvent.findFirst({
        where: {
          aggregateId: signed.assetId,
          eventType: 'AssetObjectCleanupRequested',
        },
        orderBy: { id: 'desc' },
      }),
    );
    const canonicalPayload = canonicalIntent?.payload as Record<string, unknown> | undefined;
    if (
      canonicalIntent?.schemaVersion !== 2 ||
      canonicalIntent?.parkedAt ||
      canonicalPayload?.objectClass !== 'canonical' ||
      !canonicalPayload?.canonical ||
      !Array.isArray(canonicalPayload?.variants)
    ) {
      throw new Error(`canonical cleanup gate missing: ${JSON.stringify(canonicalPayload)}`);
    }
    const listedAfterDelete = await baseAssets.list(ctx, siteId);
    if (listedAfterDelete.some((asset) => asset.id === signed.assetId)) {
      throw new Error('tombstoned asset leaked through list');
    }
    ok('tombstone', 'canonical retained in DELETE transaction; strict MF0-B cleanup queued');

    try {
      await baseAssets.list(otherCtx, siteId);
      throw new Error('tenant B unexpectedly resolved tenant A site');
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
    }
    ok('tenant isolation', 'other workspace receives the same hidden-site 404');

    console.log('\n🎉 R2-A1 开发环境真服务验证全绿（PostgreSQL/RLS + MinIO；A4 cleanup 另验）。');
  } finally {
    // verifier-only cleanup：生产路径仍遵守 tombstone/outbox，不调用这里的 owner/直接对象清理。
    for (const key of touchedKeys) await storage.delete(key).catch(() => undefined);
    await owner.site.deleteMany({ where: { id: siteId } }).catch(() => undefined);
    await owner.outboxEvent
      .deleteMany({
        where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
      })
      .catch(() => undefined);
    await owner.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } }).catch(() => undefined);
    await Promise.all([appDb.$disconnect(), owner.$disconnect()]);
  }
}

main().catch((err) => {
  console.error('💥 R2-A1 verify failed:', err);
  process.exit(1);
});
