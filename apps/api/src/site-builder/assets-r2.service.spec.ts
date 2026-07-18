import {
  BadGatewayException,
  ConflictException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AssetsService } from './assets.service';
import { AssetReferenceScanError } from './asset-reference';

const CTX = {
  userId: 'u1',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  roles: [],
};
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('r2-asset')]);

type Row = Record<string, unknown>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') return (expected as Row[]).some((candidate) => matches(row, candidate));
    if (key === 'AND') return (expected as Row[]).every((candidate) => matches(row, candidate));
    if (key === 'NOT') return !matches(row, expected as Row);
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      const condition = expected as Row;
      if ('in' in condition) return (condition.in as unknown[]).includes(row[key]);
      if ('notIn' in condition) return !(condition.notIn as unknown[]).includes(row[key]);
      if ('lte' in condition) return row[key] instanceof Date && row[key] <= condition.lte!;
      if ('equals' in condition) return row[key] === condition.equals;
    }
    return row[key] === expected;
  });
}

function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in value) {
      row[key] = Number(row[key] ?? 0) + Number((value as { increment: number }).increment);
    } else {
      row[key] = value;
    }
  }
}

function makeService(
  options: {
    assertPresignOutsideTransaction?: boolean;
    failCopy?: boolean;
    copyThenThrow?: boolean;
    failDelete?: boolean;
    failFinalizeAfterCopy?: boolean;
    uniqueCollisionOnFinalize?: boolean;
    usages?: Array<{
      source: 'site_spec' | 'profile';
      page: string;
      component: string;
      fieldPath: string;
    }>;
    scanError?: Error;
  } = {},
) {
  const assets: Row[] = [];
  const outbox: Row[] = [];
  const objects = new Map<string, Buffer>();
  const operations: string[] = [];
  let inTransaction = false;
  let uniqueCollisionPending = options.uniqueCollisionOnFinalize ?? false;

  const tx = {
    $executeRaw: async () => {
      operations.push('db:key-lock');
      return 1;
    },
    $queryRaw: async () => assets.filter((row) => !row.deletedAt).map((row) => ({ id: row.id })),
    site: { findUnique: async () => ({ id: SITE_ID }) },
    asset: {
      create: async ({ data }: { data: Row }) => {
        const row = {
          createdAt: new Date('2026-07-17T00:00:00.000Z'),
          processingAttempt: 0,
          leaseToken: null,
          leaseUntil: null,
          retryAt: null,
          deletedAt: null,
          cleanupEventId: null,
          cleanupCompletedAt: null,
          error: null,
          ...data,
        };
        assets.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => assets.find((row) => row.id === where.id) ?? null,
      findFirst: async ({ where }: { where: Row }) => assets.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where = {} }: { where?: Row } = {}) => assets.filter((row) => matches(row, where)),
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = assets.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error('asset missing');
        applyData(row, data);
        if (data.objectKey) operations.push('db:finalize');
        return row;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const selected = assets.filter((row) => matches(row, where));
        if (options.failFinalizeAfterCopy && selected.length > 0 && typeof data.objectKey === 'string') {
          throw new Error('forced database finalize failure');
        }
        if (
          uniqueCollisionPending &&
          selected.length > 0 &&
          typeof data.objectKey === 'string' &&
          ['ready', 'queued'].includes(String(data.processingStatus))
        ) {
          uniqueCollisionPending = false;
          const winner = {
            ...selected[0],
            id: '33333333-3333-4333-8333-333333333333',
            objectKey: data.objectKey,
            processingStatus: 'ready',
          };
          assets.push(winner);
          throw Object.assign(new Error('unique constraint'), {
            code: 'P2002',
          });
        }
        for (const row of selected) applyData(row, data);
        if (selected.length > 0 && data.objectKey) operations.push('db:finalize');
        return { count: selected.length };
      },
      count: async ({ where }: { where: Row }) => assets.filter((row) => matches(row, where)).length,
      delete: async ({ where }: { where: { id: string } }) => {
        const index = assets.findIndex((row) => row.id === where.id);
        if (index >= 0) assets.splice(index, 1);
      },
    },
    kbDocument: { deleteMany: async () => ({ count: 0 }) },
    assetVariant: { findMany: async () => [] },
    outboxEvent: {
      create: async ({ data }: { data: Row }) => {
        outbox.push(data);
        return data;
      },
    },
  };
  const prisma = {
    withWorkspace: async <T>(_workspaceId: string, fn: (client: typeof tx) => Promise<T>) => {
      inTransaction = true;
      try {
        return await fn(tx);
      } finally {
        inTransaction = false;
      }
    },
  };
  const storage = {
    presignPut: async (key: string) => {
      if (options.assertPresignOutsideTransaction && inTransaction) {
        throw new Error('presign called inside database transaction');
      }
      return {
        url: `https://minio.local/${key}`,
        expiresAt: new Date(Date.now() + 900_000),
      };
    },
    head: async (key: string) => (objects.has(key) ? { size: objects.get(key)!.length } : null),
    hashObject: async (key: string) => {
      const body = objects.get(key);
      if (!body) throw new Error('missing object');
      return {
        sha256: createHash('sha256').update(body).digest('hex'),
        head: body.subarray(0, 16),
        size: body.length,
      };
    },
    copy: async (from: string, to: string) => {
      operations.push(`storage:copy:${inTransaction ? 'in-tx' : 'outside-tx'}`);
      if (options.failCopy) throw new Error('temporary MinIO failure');
      objects.set(to, objects.get(from)!);
      if (options.copyThenThrow) throw new Error('copy response lost after server-side success');
    },
    delete: async (key: string) => {
      operations.push(`storage:delete:${key}`);
      if (options.failDelete) throw new Error('temporary delete failure');
      objects.delete(key);
    },
  };

  const service = new AssetsService(
    prisma as never,
    storage as never,
    {
      scan: async () => {
        if (options.scanError) throw options.scanError;
        return options.usages ?? [];
      },
    } as never,
  );
  return { service, assets, outbox, objects, operations, storage };
}

async function uploaded(s: ReturnType<typeof makeService>) {
  const signed = await s.service.presign(CTX, SITE_ID, {
    kind: 'product_image',
    filename: 'pump.jpg',
    size: JPEG.length,
    mime: 'image/jpeg',
  });
  const row = s.assets.find((candidate) => candidate.id === signed.assetId)!;
  s.objects.set(String(row.objectKey), JPEG);
  return { signed, row };
}

describe('AssetsService R2-A1 correctness gate', () => {
  it('signs the upload URL before opening the short database transaction', async () => {
    const s = makeService({ assertPresignOutsideTransaction: true });

    const result = await s.service.presign(CTX, SITE_ID, {
      kind: 'product_image',
      filename: 'pump.jpg',
      size: JPEG.length,
      mime: 'image/jpeg',
    });

    expect(result.uploadUrl).toContain('minio.local');
    expect(s.assets).toHaveLength(1);
  });

  it('CAS-claims a commit with an attempt and fencing token before touching object storage', async () => {
    const s = makeService();
    const { signed, row } = await uploaded(s);
    const headReached = deferred<void>();
    const releaseHead = deferred<{ size: number } | null>();
    s.storage.head = async () => {
      headReached.resolve();
      return releaseHead.promise;
    };

    const pending = s.service.commit(CTX, signed.assetId);
    await headReached.promise;

    expect(row.processingStatus).toBe('committing');
    expect(row.processingAttempt).toBe(1);
    expect(row.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.leaseUntil).toBeInstanceOf(Date);
    releaseHead.resolve({ size: JPEG.length });
    await pending;
  });

  it('rejects a concurrent commit before the loser reaches storage', async () => {
    const s = makeService();
    const { signed } = await uploaded(s);
    const firstAtHead = deferred<void>();
    const releaseFirst = deferred<{ size: number } | null>();
    let headCalls = 0;
    s.storage.head = async () => {
      headCalls += 1;
      if (headCalls === 1) {
        firstAtHead.resolve();
        return releaseFirst.promise;
      }
      throw new Error('concurrent loser reached object storage');
    };

    const first = s.service.commit(CTX, signed.assetId);
    await firstAtHead.promise;
    await expect(s.service.commit(CTX, signed.assetId)).rejects.toBeInstanceOf(ConflictException);
    expect(headCalls).toBe(1);
    releaseFirst.resolve({ size: JPEG.length });
    await first;
  });

  it('allows an expired lease takeover and fences the resumed old holder from zombie writes', async () => {
    const s = makeService();
    const { signed, row } = await uploaded(s);
    const firstAtCopy = deferred<void>();
    const releaseFirst = deferred<void>();
    let copyCalls = 0;
    s.storage.copy = async (_from: string, to: string) => {
      copyCalls += 1;
      if (copyCalls === 1) {
        firstAtCopy.resolve();
        await releaseFirst.promise;
      }
      s.objects.set(to, JPEG);
    };

    const expiredHolder = s.service.commit(CTX, signed.assetId);
    await firstAtCopy.promise;
    row.leaseUntil = new Date(0);

    const winner = await s.service.commit(CTX, signed.assetId);
    expect(winner.processingStatus).toBe('ready');
    expect(row.processingAttempt).toBe(2);

    releaseFirst.resolve();
    await expect(expiredHolder).rejects.toBeInstanceOf(ConflictException);
    expect(row.processingStatus).toBe('ready');
    expect(s.operations.filter((op) => op.startsWith('storage:delete'))).toHaveLength(0);
    expect(s.outbox).toHaveLength(1);
  });

  it('rejects delete while commit owns the lease so a copied canonical object cannot become orphaned', async () => {
    const s = makeService();
    const { signed, row } = await uploaded(s);
    const canonicalCopied = deferred<void>();
    const releaseCopy = deferred<void>();
    s.storage.copy = async (_from: string, to: string) => {
      s.objects.set(to, JPEG);
      canonicalCopied.resolve();
      await releaseCopy.promise;
    };

    const committing = s.service.commit(CTX, signed.assetId);
    await canonicalCopied.promise;
    const removal = await s.service.remove(CTX, signed.assetId).then(
      () => null,
      (err: unknown) => err,
    );
    releaseCopy.resolve();
    const commitResult = await Promise.allSettled([committing]);

    expect(removal).toBeInstanceOf(ConflictException);
    expect(commitResult[0]).toMatchObject({ status: 'fulfilled' });
    expect(row.processingStatus).toBe('ready');
  });

  it('marks a transient copy failure retryable and retains staging for a later lease', async () => {
    const s = makeService({ failCopy: true });
    const { signed, row } = await uploaded(s);
    const stagingKey = String(row.objectKey);

    const error = await s.service.commit(CTX, signed.assetId).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BadGatewayException);
    expect((error as HttpException).getResponse()).toMatchObject({
      error: { code: 'ASSET_STORAGE_UNAVAILABLE' },
    });
    expect(JSON.stringify((error as HttpException).getResponse())).not.toContain('temporary MinIO');

    expect(row.processingStatus).toBe('failed_retryable');
    expect(row.retryAt).toBeInstanceOf(Date);
    expect(row.leaseToken).toBeNull();
    expect(s.objects.has(stagingKey)).toBe(true);
  });

  it('R2-A2：commit 不得重新认领已有 canonical contentHash 的 retryable 行', async () => {
    const s = makeService();
    const { signed, row } = await uploaded(s);
    Object.assign(row, {
      processingStatus: 'failed_retryable',
      contentHash: 'a'.repeat(64),
      retryAt: new Date(Date.now() - 1),
      objectKey: `ws/${CTX.workspaceId}/${SITE_ID}/doc/${'a'.repeat(64)}.pdf`,
    });
    let storageTouched = false;
    s.storage.head = async () => {
      storageTouched = true;
      return { size: JPEG.length };
    };

    await expect(s.service.commit(CTX, signed.assetId)).rejects.toBeInstanceOf(ConflictException);
    expect(storageTouched).toBe(false);
    expect(row.processingStatus).toBe('failed_retryable');
  });

  it('holds the same-key database fence through copy and canonical finalize', async () => {
    const s = makeService();
    const { signed } = await uploaded(s);

    await s.service.commit(CTX, signed.assetId);

    expect(s.operations).toEqual(['db:key-lock', 'storage:copy:in-tx', 'db:finalize']);
  });

  it('compensates an unowned canonical copy when database finalize fails', async () => {
    const s = makeService({ failFinalizeAfterCopy: true });
    const { signed, row } = await uploaded(s);
    const stagingKey = String(row.objectKey);

    await expect(s.service.commit(CTX, signed.assetId)).rejects.toBeInstanceOf(ServiceUnavailableException);

    const canonicalCopies = [...s.objects.keys()].filter((key) => key !== stagingKey);
    expect(canonicalCopies).toEqual([]);
    expect(s.objects.has(stagingKey)).toBe(true);
    expect(row.processingStatus).toBe('failed_retryable');
  });

  it('treats a thrown copy response as ambiguous and compensates a server-side success', async () => {
    const s = makeService({ copyThenThrow: true });
    const { signed, row } = await uploaded(s);
    const stagingKey = String(row.objectKey);

    await expect(s.service.commit(CTX, signed.assetId)).rejects.toBeInstanceOf(BadGatewayException);

    expect([...s.objects.keys()].filter((key) => key !== stagingKey)).toEqual([]);
    expect(s.objects.has(stagingKey)).toBe(true);
    expect(row.processingStatus).toBe('failed_retryable');
  });

  it('blocks DELETE when post-copy compensation failed until commit is retried', async () => {
    const s = makeService({ copyThenThrow: true, failDelete: true });
    const { signed, row } = await uploaded(s);

    await expect(s.service.commit(CTX, signed.assetId)).rejects.toBeInstanceOf(BadGatewayException);
    expect(String(row.error)).toContain('canonical_copy_compensation_pending');

    const error = await s.service.remove(CTX, signed.assetId).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as HttpException).getResponse()).toMatchObject({ error: { code: 'ASSET_BUSY' } });
    expect(row.deletedAt).toBeNull();
  });

  it('reconciles a final unique race into an explicit duplicate state', async () => {
    const s = makeService({ uniqueCollisionOnFinalize: true });
    const { signed, row } = await uploaded(s);

    await expect(s.service.commit(CTX, signed.assetId)).rejects.toBeInstanceOf(ConflictException);

    expect(row.processingStatus).toBe('duplicate');
    expect(String(row.error)).toContain('33333333-3333-4333-8333-333333333333');
  });

  it('routes staging cleanup durably only after the upload URL expires', async () => {
    const s = makeService({ failDelete: true });
    const { signed, row } = await uploaded(s);
    const stagingKey = String(row.objectKey);

    await s.service.commit(CTX, signed.assetId);

    expect(s.outbox).toHaveLength(1);
    expect(s.outbox[0]).toMatchObject({
      eventType: 'AssetObjectCleanupRequested',
      aggregateType: 'Asset',
      aggregateId: signed.assetId,
      parkedAt: null,
      payload: {
        objectKey: stagingKey,
        objectClass: 'staging',
        notBefore: '2026-07-17T00:15:00.000Z',
      },
    });
    expect(s.operations.some((op) => op.startsWith('storage:delete'))).toBe(false);
  });

  it('tombstones a canonical asset and emits a strict v2 cleanup plan without storage IO', async () => {
    const s = makeService();
    const { signed, row } = await uploaded(s);
    await s.service.commit(CTX, signed.assetId);
    const canonicalKey = String(row.objectKey);
    const deletesBeforeRemove = s.operations.filter((op) => op.startsWith('storage:delete')).length;

    await s.service.remove(CTX, signed.assetId);

    expect(row.processingStatus).toBe('deleted');
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(s.assets).toContain(row);
    expect(s.objects.has(canonicalKey)).toBe(true);
    expect(s.operations.filter((op) => op.startsWith('storage:delete'))).toHaveLength(deletesBeforeRemove);
    expect(s.outbox.at(-1)).toMatchObject({
      eventType: 'AssetObjectCleanupRequested',
      schemaVersion: 2,
      parkedAt: null,
      payload: {
        objectClass: 'canonical',
        canonical: { objectKey: canonicalKey, contentHash: row.contentHash },
        variants: [],
      },
    });
    expect(Object.keys((s.outbox.at(-1)?.payload ?? {}) as Row).sort()).toEqual([
      'assetId',
      'canonical',
      'objectClass',
      'reason',
      'siteId',
      'variants',
    ]);
  });

  it('returns stable ASSET_IN_USE usages and leaves DB/object/outbox untouched', async () => {
    const usage = {
      source: 'profile' as const,
      page: '$profile',
      component: 'brand',
      fieldPath: '/brand/logoAssetId',
    };
    const s = makeService({ usages: [usage] });
    const { signed, row } = await uploaded(s);
    await s.service.commit(CTX, signed.assetId);
    const outboxBefore = s.outbox.length;
    const objectKey = String(row.objectKey);

    const error = await s.service.remove(CTX, signed.assetId).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as HttpException).getResponse()).toEqual({
      error: {
        code: 'ASSET_IN_USE',
        message: 'asset is referenced by the active site, profile, or Claim evidence',
        details: { usages: [usage] },
      },
    });
    expect(row.deletedAt).toBeNull();
    expect(row.processingStatus).toBe('ready');
    expect(s.objects.has(objectKey)).toBe(true);
    expect(s.outbox).toHaveLength(outboxBefore);
  });

  it('maps an unverifiable active reference surface to a stable fail-closed conflict', async () => {
    const s = makeService({ scanError: new AssetReferenceScanError('stored SiteSpec is malformed') });
    const { signed, row } = await uploaded(s);
    await s.service.commit(CTX, signed.assetId);
    const outboxBefore = s.outbox.length;
    const objectKey = String(row.objectKey);

    const error = await s.service.remove(CTX, signed.assetId).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as HttpException).getResponse()).toEqual({
      error: {
        code: 'ASSET_STATE_CONFLICT',
        message: 'active site references cannot be verified; repair the site state before deleting this asset',
      },
    });
    expect(row.deletedAt).toBeNull();
    expect(s.objects.has(objectKey)).toBe(true);
    expect(s.outbox).toHaveLength(outboxBefore);
  });

  it('blocks same-hash reuse until the old canonical cleanup is durably settled', async () => {
    const s = makeService();
    const first = await uploaded(s);
    await s.service.commit(CTX, first.signed.assetId);
    await s.service.remove(CTX, first.signed.assetId);

    const second = await uploaded(s);
    const error = await s.service.commit(CTX, second.signed.assetId).catch((caught) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as HttpException).getResponse()).toMatchObject({
      error: { code: 'ASSET_BUSY' },
    });
    expect(second.row.processingStatus).toBe('failed_retryable');
    expect(s.objects.has(String(second.row.objectKey))).toBe(true);
  });

  it('checks every same-key tombstone instead of trusting an older settled owner', async () => {
    const s = makeService();
    const first = await uploaded(s);
    await s.service.commit(CTX, first.signed.assetId);
    await s.service.remove(CTX, first.signed.assetId);
    first.row.cleanupCompletedAt = new Date();

    const second = await uploaded(s);
    await s.service.commit(CTX, second.signed.assetId);
    await s.service.remove(CTX, second.signed.assetId);

    const third = await uploaded(s);
    const error = await s.service.commit(CTX, third.signed.assetId).catch((caught) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as HttpException).getResponse()).toMatchObject({
      error: { code: 'ASSET_BUSY' },
    });
    expect(second.row.cleanupCompletedAt).toBeNull();
    expect(third.row.processingStatus).toBe('failed_retryable');
  });
});
