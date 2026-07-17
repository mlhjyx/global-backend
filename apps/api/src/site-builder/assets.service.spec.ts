import { describe, expect, it } from 'vitest';
import {
  BadGatewayException,
  ConflictException,
  HttpException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AssetsService } from './assets.service';

const CTX = {
  userId: 'u1',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  roles: [],
};
const SITE_ID = '22222222-2222-4222-8222-222222222222';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fakejpegbody')]);

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') return (expected as Row[]).some((candidate) => matches(row, candidate));
    if (key === 'NOT') return !matches(row, expected as Row);
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      const condition = expected as Row;
      if ('notIn' in condition) return !(condition.notIn as unknown[]).includes(row[key]);
      if ('in' in condition) return (condition.in as unknown[]).includes(row[key]);
      if ('lte' in condition) return row[key] instanceof Date && row[key] <= condition.lte!;
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

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof HttpException)) return undefined;
  const response = error.getResponse() as { error?: { code?: string } };
  return response.error?.code;
}

function makeService(opts: { siteExists?: boolean } = {}) {
  const db: { assets: Record<string, unknown>[]; variants: Row[] } = { assets: [], variants: [] };
  const objects = new Map<string, Buffer>();
  const ops: string[] = [];
  const kbDeletes: string[] = [];
  const outbox: Row[] = [];
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async () => db.assets.filter((row) => !row.deletedAt).map((row) => ({ id: row.id })),
    site: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        ops.push(`site:find:${where.id}`);
        return opts.siteExists === false ? null : { id: where.id, profile: null, activeVersionId: null };
      },
    },
    asset: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        db.assets.push({
          createdAt: new Date(),
          processingAttempt: 0,
          leaseToken: null,
          leaseUntil: null,
          retryAt: null,
          deletedAt: null,
          cleanupEventId: null,
          cleanupCompletedAt: null,
          ...data,
        });
        return db.assets[db.assets.length - 1];
      },
      findUnique: async ({ where }: { where: { id: string } }) => db.assets.find((a) => a.id === where.id) ?? null,
      findFirst: async ({ where }: { where: Row }) => db.assets.find((a) => matches(a, where)) ?? null,
      findMany: async ({ where = {} }: { where?: Row } = {}) => db.assets.filter((a) => matches(a, where)),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = db.assets.find((a) => a.id === where.id);
        if (!row) throw new Error('missing');
        applyData(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const selected = db.assets.filter((a) => matches(a, where));
        for (const row of selected) applyData(row, data);
        return { count: selected.length };
      },
      count: async ({ where }: { where: { objectKey: string; NOT: { id: string } } }) =>
        db.assets.filter((a) => a.objectKey === where.objectKey && a.id !== where.NOT.id).length,
      delete: async ({ where }: { where: { id: string } }) => {
        const i = db.assets.findIndex((a) => a.id === where.id);
        if (i >= 0) db.assets.splice(i, 1);
      },
    },
    kbDocument: {
      deleteMany: async ({ where }: { where: { assetId: string } }) => {
        kbDeletes.push(where.assetId);
        return { count: 0 };
      },
    },
    assetVariant: {
      findMany: async ({ where = {} }: { where?: Row } = {}) =>
        db.variants.filter((row) => matches(row, where)),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const selected = db.variants.filter((row) => matches(row, where));
        for (const row of selected) applyData(row, data);
        return { count: selected.length };
      },
    },
    outboxEvent: {
      create: async ({ data }: { data: Row }) => {
        outbox.push(data);
        return data;
      },
    },
  };
  const prisma = {
    withWorkspace: async <T>(_ws: string, fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
  };
  const storage = {
    presignPut: async (key: string) => {
      ops.push(`presignPut:${key}`);
      return {
        url: `https://minio.local/put/${key}`,
        expiresAt: new Date(Date.now() + 900_000),
      };
    },
    presignGet: async (key: string) => `https://minio.local/get/${key}`,
    head: async (key: string) => (objects.has(key) ? { size: objects.get(key)!.length } : null),
    getBuffer: async (key: string) => {
      const buf = objects.get(key);
      if (!buf) throw new Error('no such object');
      return buf;
    },
    hashObject: async (key: string) => {
      const buf = objects.get(key);
      if (!buf) throw new Error('no such object');
      return {
        sha256: createHash('sha256').update(buf).digest('hex'),
        head: buf.subarray(0, 16),
        size: buf.length,
      };
    },
    copy: async (from: string, to: string) => {
      ops.push(`copy:${from}->${to}`);
      objects.set(to, objects.get(from)!);
    },
    delete: async (key: string) => {
      ops.push(`delete:${key}`);
      objects.delete(key);
    },
  };
  const service = new AssetsService(prisma as never, storage as never);
  return { service, db, objects, ops, kbDeletes, outbox, tx };
}

async function presignAndUpload(
  s: ReturnType<typeof makeService>,
  body: Buffer = JPEG,
  input = {
    kind: 'product_image',
    filename: 'a.jpg',
    size: body.length,
    mime: 'image/jpeg',
  },
) {
  const res = await s.service.presign(CTX, SITE_ID, input);
  const row = s.db.assets.find((a) => a.id === res.assetId) as Record<string, unknown>;
  s.objects.set(String(row.objectKey), body); // 模拟前端 PUT 直传
  return res;
}

describe('AssetsService（上传三步 presign→PUT→commit，07 §3 / 06 §2）', () => {
  it('presign：建 pending_upload 行（staging key）并返回预签名 URL', async () => {
    const s = makeService();
    const res = await s.service.presign(CTX, SITE_ID, {
      kind: 'product_image',
      filename: 'pump.jpg',
      size: 1000,
      mime: 'image/jpeg',
    });
    expect(res.uploadUrl).toContain('/put/');
    const row = s.db.assets[0] as Record<string, unknown>;
    expect(row.processingStatus).toBe('pending_upload');
    expect(String(row.objectKey)).toBe(`ws/${CTX.workspaceId}/${SITE_ID}/uploads/${res.assetId}`);
  });

  it('presign：非法 kind / 白名单外 mime / 超限大小 → 422', async () => {
    const s = makeService();
    const base = { filename: 'a', size: 100, mime: 'image/jpeg' };
    await expect(s.service.presign(CTX, SITE_ID, { ...base, kind: 'weird' })).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    await expect(
      s.service.presign(CTX, SITE_ID, {
        ...base,
        kind: 'doc',
        mime: 'text/html',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(
      s.service.presign(CTX, SITE_ID, {
        ...base,
        kind: 'logo',
        size: 21 * 1024 * 1024,
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    // kind × mime 相容闸（Codex P2）：pdf 不得混进 product_image
    await expect(
      s.service.presign(CTX, SITE_ID, {
        ...base,
        kind: 'product_image',
        mime: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    const error = await s.service.presign(CTX, SITE_ID, { ...base, kind: 'weird' }).catch((caught: unknown) => caught);
    expect(errorCode(error)).toBe('ASSET_VALIDATION_FAILED');
  });

  it('presign：先验证站点；站点不存在时不得触达对象存储', async () => {
    const s = makeService({ siteExists: false });
    await expect(
      s.service.presign(CTX, SITE_ID, {
        kind: 'doc',
        filename: 'a.pdf',
        size: 100,
        mime: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(s.ops).toEqual([`site:find:${SITE_ID}`]);
  });

  it('presign：对象存储故障 → 502 ASSET_STORAGE_UNAVAILABLE，不回显 SDK 文本', async () => {
    const s = makeService();
    const svc = s.service as unknown as {
      storage: { presignPut: () => Promise<never> };
    };
    svc.storage.presignPut = async () => {
      throw new Error('S3 endpoint http://storage.internal accessKey=secret');
    };

    const error = await s.service
      .presign(CTX, SITE_ID, {
        kind: 'doc',
        filename: 'a.pdf',
        size: 100,
        mime: 'application/pdf',
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BadGatewayException);
    expect(errorCode(error)).toBe('ASSET_STORAGE_UNAVAILABLE');
    expect(JSON.stringify((error as HttpException).getResponse())).not.toContain('storage.internal');
  });

  it('commit：魔数匹配 → 算 sha256、搬 canonical、图片直接 ready', async () => {
    const s = makeService();
    const { assetId } = await presignAndUpload(s);
    const row = await s.service.commit(CTX, assetId);
    const hash = createHash('sha256').update(JPEG).digest('hex');
    expect(row.processingStatus).toBe('ready');
    expect(row.contentHash).toBe(hash);
    expect(row.objectKey).toBe(`ws/${CTX.workspaceId}/${SITE_ID}/product_image/${hash}.jpg`);
    expect(s.ops.some((o) => o.startsWith('copy:'))).toBe(true);
    expect(s.ops.filter((o) => o.startsWith('delete:'))).toHaveLength(0); // 由 durable cleanup 延后清理
    expect(s.outbox.at(-1)).toMatchObject({
      eventType: 'AssetObjectCleanupRequested',
    });
  });

  it('commit：doc 类进 KB 队列（processingStatus=queued）', async () => {
    const s = makeService();
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('body')]);
    const { assetId } = await presignAndUpload(s, pdf, {
      kind: 'doc',
      filename: 'brochure.pdf',
      size: pdf.length,
      mime: 'application/pdf',
    });
    const row = await s.service.commit(CTX, assetId);
    expect(row.processingStatus).toBe('queued');
  });

  it('commit：对象未上传 → 409；重复 commit → 409', async () => {
    const s = makeService();
    const res = await s.service.presign(CTX, SITE_ID, {
      kind: 'product_image',
      filename: 'a.jpg',
      size: JPEG.length,
      mime: 'image/jpeg',
    });
    const missing = await s.service.commit(CTX, res.assetId).catch((caught: unknown) => caught);
    expect(missing).toBeInstanceOf(ConflictException);
    expect(errorCode(missing)).toBe('ASSET_UPLOAD_INCOMPLETE');
    s.objects.set(`ws/${CTX.workspaceId}/${SITE_ID}/uploads/${res.assetId}`, JPEG);
    await s.service.commit(CTX, res.assetId);
    const repeated = await s.service.commit(CTX, res.assetId).catch((caught: unknown) => caught);
    expect(repeated).toBeInstanceOf(ConflictException);
    expect(errorCode(repeated)).toBe('ASSET_STATE_CONFLICT');
  });

  it('commit：声明 mime 与魔数不符 → 行标 rejected、staging 删除、422', async () => {
    const s = makeService();
    const evil = Buffer.from('MZ\x90\x00 not a jpeg');
    const { assetId } = await presignAndUpload(s, evil, {
      kind: 'product_image',
      filename: 'evil.jpg',
      size: evil.length,
      mime: 'image/jpeg',
    });
    const error = await s.service.commit(CTX, assetId).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect(errorCode(error)).toBe('ASSET_VALIDATION_FAILED');
    const row = s.db.assets.find((a) => a.id === assetId) as Record<string, unknown>;
    expect(row.processingStatus).toBe('rejected');
    expect(s.objects.size).toBe(1); // 预签名失效后由 durable cleanup 清 staging
    expect(s.outbox.at(-1)).toMatchObject({
      eventType: 'AssetObjectCleanupRequested',
    });
  });

  it('commit：内容重复（同 canonical key 已存在）→ 本行 duplicate + 409 带既有 assetId', async () => {
    const s = makeService();
    const a = await presignAndUpload(s);
    await s.service.commit(CTX, a.assetId);
    const b = await presignAndUpload(s);
    const error = await s.service.commit(CTX, b.assetId).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect(errorCode(error)).toBe('ASSET_DUPLICATE');
    const rowB = s.db.assets.find((x) => x.id === b.assetId) as Record<string, unknown>;
    expect(rowB.processingStatus).toBe('duplicate');
    expect(String(rowB.error)).toContain(a.assetId);
  });

  it('commit：对象存储故障 → 502 稳定码，原始 SDK 文本不进入公共异常', async () => {
    const s = makeService();
    const { assetId } = await presignAndUpload(s);
    const svc = s.service as unknown as {
      storage: { head: () => Promise<never> };
    };
    svc.storage.head = async () => {
      throw new Error('MinIO http://internal-storage:9000 accessKey=secret');
    };

    const error = await s.service.commit(CTX, assetId).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BadGatewayException);
    expect(errorCode(error)).toBe('ASSET_STORAGE_UNAVAILABLE');
    expect(JSON.stringify((error as HttpException).getResponse())).not.toContain('internal-storage');
  });

  it('commit：canonical 真值落库暂不可用 → 503 ASSET_COMMIT_UNAVAILABLE，不回显 DB 文本', async () => {
    const s = makeService();
    const { assetId } = await presignAndUpload(s);
    const updateMany = s.tx.asset.updateMany;
    s.tx.asset.updateMany = async (args) => {
      if (typeof args.data.objectKey === 'string') {
        throw new Error('postgresql://global:secret@database.internal/global_dev');
      }
      return updateMany(args);
    };

    const error = await s.service.commit(CTX, assetId).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(503);
    expect(errorCode(error)).toBe('ASSET_COMMIT_UNAVAILABLE');
    expect(JSON.stringify((error as HttpException).getResponse())).not.toContain('database.internal');
  });

  it('list：先验证站点，不存在或跨租户不可见时统一 404', async () => {
    const s = makeService({ siteExists: false });
    await expect(s.service.list(CTX, SITE_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('list：未知 kind → 422 ASSET_VALIDATION_FAILED', async () => {
    const s = makeService();
    const error = await s.service.list(CTX, SITE_ID, 'not-a-kind').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect(errorCode(error)).toBe('ASSET_VALIDATION_FAILED');
  });

  it('delete：引用门通过后 tombstone + 级联清 KB；对象留给 Temporal', async () => {
    const s = makeService();
    const { assetId } = await presignAndUpload(s);
    await s.service.commit(CTX, assetId);
    const before = s.ops.filter((o) => o.startsWith('delete:')).length;
    await s.service.remove(CTX, assetId);
    const row = s.db.assets.find((a) => a.id === assetId);
    expect(row).toMatchObject({
      processingStatus: 'deleted',
      deletedAt: expect.any(Date),
    });
    expect(s.ops.filter((o) => o.startsWith('delete:'))).toHaveLength(before);
    expect(s.kbDeletes).toEqual([assetId]);
    expect(s.outbox.at(-1)).toMatchObject({
      eventType: 'AssetObjectCleanupRequested',
    });
  });

  it('delete：图片 processing 租约存活时阻塞，过期后先冻结 failed 再进入清理账本', async () => {
    const s = makeService();
    const { assetId } = await presignAndUpload(s);
    await s.service.commit(CTX, assetId);
    const recipeHash = 'a'.repeat(64);
    const variant = {
      id: '33333333-3333-4333-8333-333333333333',
      assetId,
      objectKey: `ws/${CTX.workspaceId}/${SITE_ID}/variants/${assetId}/${recipeHash}.webp`,
      contentHash: null,
      recipeHash,
      sourceVariantId: null,
      status: 'processing',
      metadata: { reservation: { token: 'producer', leaseUntil: new Date(Date.now() + 60_000).toISOString() } },
    };
    s.db.variants.push(variant);

    const busy = await s.service.remove(CTX, assetId).catch((error: unknown) => error);
    expect(errorCode(busy)).toBe('ASSET_BUSY');

    (variant.metadata as { reservation: { leaseUntil: string } }).reservation.leaseUntil = new Date(0).toISOString();
    await expect(s.service.remove(CTX, assetId)).resolves.toBeUndefined();
    expect(variant).toMatchObject({ status: 'failed', error: 'IMAGE_VARIANT_LEASE_EXPIRED' });
  });
});
