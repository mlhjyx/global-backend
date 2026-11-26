import 'reflect-metadata';
import {
  type ExecutionContext,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobalHttpExceptionFilter } from '../common/http-exception.filter';
import { createWorkspacePurgeActivities } from '../temporal/workspace-purge.activities';
import { WorkspacePurgeInternalController } from './workspace-purge-internal.controller';
import {
  purgeWorkspaceRedisKeysWithClient,
  workspaceHttpThrottleKeys,
  type WorkspacePurgeRedisClient,
} from './workspace-purge-redis';
import { WorkspacePurgeServiceTokenGuard } from './workspace-purge-service-token.guard';
import { WorkspacePurgeService } from './workspace-purge.service';
import type { WorkspacePurgeReceiptRecord } from './workspace-purge.types';

const WS_ID = '10000000-0000-4000-8000-000000000001';
const USER_ID = '20000000-0000-4000-8000-000000000002';
const RECEIPT_ID = '30000000-0000-4000-8000-000000000003';

function makeReceipt(overrides: Partial<WorkspacePurgeReceiptRecord> = {}): WorkspacePurgeReceiptRecord {
  const now = new Date('2026-11-26T00:00:00.000Z');
  return {
    id: RECEIPT_ID,
    workspaceId: WS_ID,
    idempotencyKey: 'purge-key-1',
    status: 'PENDING',
    requestedBy: USER_ID,
    cleanupManifest: {},
    dbRowsDeleted: null,
    minioObjectsDeleted: null,
    redisKeysDeleted: 0,
    temporalWorkflowsCancelled: 0,
    errorCode: null,
    ruleVersion: 'workspace-purge/v1',
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

Reflect.defineMetadata('design:paramtypes', [WorkspacePurgeService], WorkspacePurgeInternalController);

describe('WorkspacePurgeServiceTokenGuard', () => {
  const originalToken = process.env.WORKSPACE_PURGE_INTERNAL_SERVICE_TOKEN;
  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.WORKSPACE_PURGE_INTERNAL_SERVICE_TOKEN;
    } else {
      process.env.WORKSPACE_PURGE_INTERNAL_SERVICE_TOKEN = originalToken;
    }
  });

  function ctxWith(headers: Record<string, unknown>, remoteAddress = '172.18.0.5'): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers, socket: { remoteAddress } }),
      }),
    } as unknown as ExecutionContext;
  }

  it('fails closed with 503 when WORKSPACE_PURGE_INTERNAL_SERVICE_TOKEN is unset', () => {
    delete process.env.WORKSPACE_PURGE_INTERNAL_SERVICE_TOKEN;
    const guard = new WorkspacePurgeServiceTokenGuard();
    expect(() => guard.canActivate(ctxWith({ 'x-service-token': 'abc' }))).toThrow(
      ServiceUnavailableException,
    );
  });

  it('rejects missing or mismatched x-service-token with 401 and admits valid token from non-loopback', () => {
    process.env.WORKSPACE_PURGE_INTERNAL_SERVICE_TOKEN = 'super-secret-purge-token';
    const guard = new WorkspacePurgeServiceTokenGuard();
    expect(() => guard.canActivate(ctxWith({}))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(ctxWith({ 'x-service-token': 'wrong' }))).toThrow(
      UnauthorizedException,
    );
    expect(guard.canActivate(ctxWith({ 'x-service-token': 'super-secret-purge-token' }))).toBe(true);
  });
});

describe('WorkspacePurgeInternalController (HTTP)', () => {
  const originalToken = process.env.WORKSPACE_PURGE_INTERNAL_SERVICE_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.WORKSPACE_PURGE_INTERNAL_SERVICE_TOKEN;
    } else {
      process.env.WORKSPACE_PURGE_INTERNAL_SERVICE_TOKEN = originalToken;
    }
  });

  async function boot(service: Partial<WorkspacePurgeService>) {
    @Module({
      controllers: [WorkspacePurgeInternalController],
      providers: [
        { provide: WorkspacePurgeService, useValue: service },
        WorkspacePurgeServiceTokenGuard,
      ],
    })
    class TestModule {}

    const app = await NestFactory.create<NestExpressApplication>(TestModule, {
      logger: false,
      abortOnError: false,
    });
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    app.useGlobalFilters(new GlobalHttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    return app;
  }

  it('accepts POST /api/v1/internal/workspaces/:id/purge (202) and GET receipt (200 / 404)', async () => {
    process.env.WORKSPACE_PURGE_INTERNAL_SERVICE_TOKEN = 'test-purge-token';
    const requestPurge = vi.fn(async () => makeReceipt());
    const getReceipt = vi
      .fn()
      .mockResolvedValueOnce(makeReceipt({ status: 'COMPLETED', redisKeysDeleted: 3 }))
      .mockRejectedValueOnce(
        new NotFoundException({ error: { code: 'WORKSPACE_PURGE_NOT_FOUND', message: 'not found' } }),
      );

    const app = await boot({ requestPurge, getReceipt });
    try {
      const base = await app.getUrl();
      const postRes = await fetch(`${base}/api/v1/internal/workspaces/${WS_ID}/purge`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-service-token': 'test-purge-token',
        },
        body: JSON.stringify({
          idempotencyKey: 'purge-key-1',
          requestedBy: USER_ID,
          campaignPlanJobIds: ['40000000-0000-4000-8000-000000000004'],
        }),
      });
      expect(postRes.status).toBe(202);
      const postJson = await postRes.json();
      expect(postJson.data).toMatchObject({
        id: RECEIPT_ID,
        workspaceId: WS_ID,
        status: 'PENDING',
      });

      const badPost = await fetch(`${base}/api/v1/internal/workspaces/not-a-uuid/purge`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-service-token': 'test-purge-token',
        },
        body: JSON.stringify({ idempotencyKey: 'k' }),
      });
      expect(badPost.status).toBe(400);

      const getRes = await fetch(`${base}/api/v1/internal/workspaces/${WS_ID}/purge`, {
        headers: { 'x-service-token': 'test-purge-token' },
      });
      expect(getRes.status).toBe(200);
      expect((await getRes.json()).data).toMatchObject({ status: 'COMPLETED', redisKeysDeleted: 3 });

      const missRes = await fetch(`${base}/api/v1/internal/workspaces/${WS_ID}/purge`, {
        headers: { 'x-service-token': 'test-purge-token' },
      });
      expect(missRes.status).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('workspace-purge Redis & activities helpers', () => {
  it('derives RedisHttpThrottlerStorage keys and unlinks scanned workspace keys', async () => {
    const [hitsKey, stateKey] = workspaceHttpThrottleKeys(WS_ID);
    const expectedDigest = createHash('sha256')
      .update(JSON.stringify(['default', `ws:${WS_ID}`]))
      .digest('hex');
    expect(hitsKey).toBe(`http-throttle:v1:{${expectedDigest}}:hits`);
    expect(stateKey).toBe(`http-throttle:v1:{${expectedDigest}}:state`);

    const unlinked: string[] = [];
    const client: WorkspacePurgeRedisClient = {
      connect: async () => undefined,
      unlink: async (...keys: string[]) => {
        unlinked.push(...keys);
        return keys.length;
      },
      del: async () => 0,
      scan: vi
        .fn()
        .mockResolvedValueOnce(['12', [`ws:${WS_ID}:cache:1`]])
        .mockResolvedValueOnce(['0', [`ws:${WS_ID}:lock:2`]]),
      quit: async () => undefined,
      disconnect: () => undefined,
      on: () => undefined,
    };

    const count = await purgeWorkspaceRedisKeysWithClient(client, WS_ID);
    expect(count).toBe(4);
    expect(unlinked).toEqual([
      hitsKey,
      stateKey,
      `ws:${WS_ID}:cache:1`,
      `ws:${WS_ID}:lock:2`,
    ]);
  });

  it('cancels discovered workflows (ignoring self/already-completed) and purges all 3 buckets', async () => {
    const cancelledIds: string[] = [];
    const cancelMock = {
      client: {
        workflow: {
          getHandle: (id: string) => ({
            cancel: async () => {
              if (id === 'discovery-gone') {
                throw new Error('Workflow execution already completed');
              }
              cancelledIds.push(id);
            },
          }),
        },
      },
      reconnect: async () => true,
    };
    const sellerDelPrefix = vi.fn(async () => 4);
    const siteDelPrefix = vi.fn(async () => 2);
    const eraseFinalObject = vi.fn(async () => 'DELETED' as const);

    const acts = createWorkspacePurgeActivities({
      prisma: {} as never,
      siteBuilderStorage: { deletePrefix: siteDelPrefix },
      sellerDocumentsStorage: { deletePrefix: sellerDelPrefix },
      personalArtifactCleanupPort: { eraseFinalObject },
      temporal: cancelMock as never,
      redisPurger: async () => 5,
    });

    const cancelledCount = await acts.cancelWorkspaceWorkflows({
      workspaceId: WS_ID,
      workflowIds: [`workspace-purge-${WS_ID}`, 'discovery-1', 'discovery-gone', 'data-export-1'],
    });
    expect(cancelledCount).toBe(2);
    expect(cancelledIds).toEqual(['discovery-1', 'data-export-1']);

    const storageCounts = await acts.purgeWorkspaceStorage({
      workspaceId: WS_ID,
      siteIds: ['site-1'],
      legacyReleasePrefixes: ['sites/site-1/releases/rel-1'],
      personalObjects: [
        { objectKey: 'k1', sha256: 'a'.repeat(64), versionId: 'v1', objectScope: 'workspace' },
        { objectKey: 'k1', sha256: 'a'.repeat(64), versionId: 'v2', objectScope: 'workspace' },
      ],
    });
    expect(sellerDelPrefix).toHaveBeenCalledWith(`ws/${WS_ID}/`);
    expect(siteDelPrefix).toHaveBeenCalledWith(`ws/${WS_ID}/`);
    expect(siteDelPrefix).toHaveBeenCalledWith('sites/site-1/');
    expect(siteDelPrefix).toHaveBeenCalledWith('sites/site-1/releases/rel-1/');
    expect(eraseFinalObject).toHaveBeenCalledTimes(1);
    expect(storageCounts).toEqual({
      sellerDocuments: 4,
      siteBuilder: 6,
      operationArtifacts: 1,
    });
  });

  it('cleans exportObjectKeys via DataExportStorage when DATA_EXPORT_S3_BUCKET differs from seller documents bucket', async () => {
    const sellerDelPrefix = vi.fn(async () => 2);
    const exportDelete = vi.fn(async () => undefined);
    const exportDelPrefix = vi.fn(async () => 3);

    const actsOverride = createWorkspacePurgeActivities({
      prisma: {} as never,
      siteBuilderStorage: { deletePrefix: vi.fn(async () => 0) },
      sellerDocumentsStorage: { bucket: 'global-seller-documents', deletePrefix: sellerDelPrefix },
      dataExportStorage: {
        bucket: 'custom-data-exports',
        delete: exportDelete,
        deletePrefix: exportDelPrefix,
      },
      personalArtifactCleanupPort: { eraseFinalObject: vi.fn(async () => 'DELETED' as const) },
      redisPurger: async () => 0,
    });

    const resWithPrefix = await actsOverride.purgeWorkspaceStorage({
      workspaceId: WS_ID,
      siteIds: [],
      legacyReleasePrefixes: [],
      exportObjectKeys: [
        `ws/${WS_ID}/exports/e1.csv`,
        `legacy-exports/${WS_ID}/e2.zip`,
        `legacy-exports/${WS_ID}/e2.zip`,
      ],
      personalObjects: [],
    });
    expect(exportDelPrefix).toHaveBeenCalledWith(`ws/${WS_ID}/`);
    expect(exportDelete).toHaveBeenCalledTimes(1);
    expect(exportDelete).toHaveBeenCalledWith(`legacy-exports/${WS_ID}/e2.zip`);
    expect(resWithPrefix).toEqual({
      sellerDocuments: 6,
      siteBuilder: 0,
      operationArtifacts: 0,
    });

    // Without deletePrefix on custom bucket mock, falls back to deleting each unique exportObjectKey
    const exportDeleteOnly = vi.fn(async () => undefined);
    const actsFallback = createWorkspacePurgeActivities({
      prisma: {} as never,
      siteBuilderStorage: { deletePrefix: vi.fn(async () => 0) },
      sellerDocumentsStorage: { bucket: 'global-seller-documents', deletePrefix: sellerDelPrefix },
      dataExportStorage: { bucket: 'custom-data-exports', delete: exportDeleteOnly },
      personalArtifactCleanupPort: { eraseFinalObject: vi.fn(async () => 'DELETED' as const) },
      redisPurger: async () => 0,
    });
    const resFallback = await actsFallback.purgeWorkspaceStorage({
      workspaceId: WS_ID,
      siteIds: [],
      legacyReleasePrefixes: [],
      exportObjectKeys: [`ws/${WS_ID}/exports/e1.csv`, `ws/${WS_ID}/exports/e1.csv`],
      personalObjects: [],
    });
    expect(exportDeleteOnly).toHaveBeenCalledTimes(1);
    expect(exportDeleteOnly).toHaveBeenCalledWith(`ws/${WS_ID}/exports/e1.csv`);
    expect(resFallback.sellerDocuments).toBe(3);

    // Same bucket skips redundant DataExportStorage deletion
    const exportSameBucketDel = vi.fn(async () => undefined);
    const actsSameBucket = createWorkspacePurgeActivities({
      prisma: {} as never,
      siteBuilderStorage: { deletePrefix: vi.fn(async () => 0) },
      sellerDocumentsStorage: { bucket: 'global-seller-documents', deletePrefix: sellerDelPrefix },
      dataExportStorage: { bucket: 'global-seller-documents', delete: exportSameBucketDel },
      personalArtifactCleanupPort: { eraseFinalObject: vi.fn(async () => 'DELETED' as const) },
      redisPurger: async () => 0,
    });
    const resSame = await actsSameBucket.purgeWorkspaceStorage({
      workspaceId: WS_ID,
      siteIds: [],
      legacyReleasePrefixes: [],
      exportObjectKeys: [`ws/${WS_ID}/exports/e1.csv`],
      personalObjects: [],
    });
    expect(exportSameBucketDel).not.toHaveBeenCalled();
    expect(resSame.sellerDocuments).toBe(2);
  });
});
