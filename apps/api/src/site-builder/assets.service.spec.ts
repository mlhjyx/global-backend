import { describe, expect, it } from 'vitest';
import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AssetsService } from './assets.service';

const CTX = { userId: 'u1', workspaceId: '11111111-1111-4111-8111-111111111111', roles: [] };
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

function makeService(opts: { siteExists?: boolean } = {}) {
  const db: { assets: Record<string, unknown>[] } = { assets: [] };
  const objects = new Map<string, Buffer>();
  const ops: string[] = [];
  const kbDeletes: string[] = [];
  const outbox: Row[] = [];
  const tx = {
    site: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        opts.siteExists === false ? null : { id: where.id },
    },
    asset: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        db.assets.push({
          processingAttempt: 0,
          leaseToken: null,
          leaseUntil: null,
          retryAt: null,
          deletedAt: null,
          ...data,
        });
        return db.assets[db.assets.length - 1];
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        db.assets.find((a) => a.id === where.id) ?? null,
      findFirst: async ({ where }: { where: Row }) => db.assets.find((a) => matches(a, where)) ?? null,
      findMany: async ({ where = {} }: { where?: Row } = {}) =>
        db.assets.filter((a) => matches(a, where)),
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
      return { url: `https://minio.local/put/${key}`, expiresAt: new Date(Date.now() + 900_000) };
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
  return { service, db, objects, ops, kbDeletes, outbox };
}

async function presignAndUpload(
  s: ReturnType<typeof makeService>,
  body: Buffer = JPEG,
  input = { kind: 'product_image', filename: 'a.jpg', size: body.length, mime: 'image/jpeg' },
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
    expect(String(row.objectKey)).toBe(
      `ws/${CTX.workspaceId}/${SITE_ID}/uploads/${res.assetId}`,
    );
  });

  it('presign：非法 kind / 白名单外 mime / 超限大小 → 422', async () => {
    const s = makeService();
    const base = { filename: 'a', size: 100, mime: 'image/jpeg' };
    await expect(
      s.service.presign(CTX, SITE_ID, { ...base, kind: 'weird' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(
      s.service.presign(CTX, SITE_ID, { ...base, kind: 'doc', mime: 'text/html' }),
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
  });

  it('presign：站点不存在 → 404', async () => {
    const s = makeService({ siteExists: false });
    await expect(
      s.service.presign(CTX, SITE_ID, {
        kind: 'doc',
        filename: 'a.pdf',
        size: 100,
        mime: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
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
    expect(s.ops.filter((o) => o.startsWith('delete:'))).toHaveLength(1); // staging 清理
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
    await expect(s.service.commit(CTX, res.assetId)).rejects.toBeInstanceOf(ConflictException);
    s.objects.set(`ws/${CTX.workspaceId}/${SITE_ID}/uploads/${res.assetId}`, JPEG);
    await s.service.commit(CTX, res.assetId);
    await expect(s.service.commit(CTX, res.assetId)).rejects.toBeInstanceOf(ConflictException);
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
    await expect(s.service.commit(CTX, assetId)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    const row = s.db.assets.find((a) => a.id === assetId) as Record<string, unknown>;
    expect(row.processingStatus).toBe('rejected');
    expect(s.objects.size).toBe(0);
  });

  it('commit：内容重复（同 canonical key 已存在）→ 本行 duplicate + 409 带既有 assetId', async () => {
    const s = makeService();
    const a = await presignAndUpload(s);
    await s.service.commit(CTX, a.assetId);
    const b = await presignAndUpload(s);
    await expect(s.service.commit(CTX, b.assetId)).rejects.toBeInstanceOf(ConflictException);
    const rowB = s.db.assets.find((x) => x.id === b.assetId) as Record<string, unknown>;
    expect(rowB.processingStatus).toBe('duplicate');
    expect(String(rowB.error)).toContain(a.assetId);
  });

  it('delete：tombstone + 级联清 KB；scanner 前不删 canonical 对象', async () => {
    const s = makeService();
    const { assetId } = await presignAndUpload(s);
    await s.service.commit(CTX, assetId);
    const before = s.ops.filter((o) => o.startsWith('delete:')).length;
    await s.service.remove(CTX, assetId);
    const row = s.db.assets.find((a) => a.id === assetId);
    expect(row).toMatchObject({ processingStatus: 'deleted', deletedAt: expect.any(Date) });
    expect(s.ops.filter((o) => o.startsWith('delete:'))).toHaveLength(before);
    expect(s.kbDeletes).toEqual([assetId]);
    expect(s.outbox.at(-1)).toMatchObject({ eventType: 'AssetObjectCleanupRequested' });
  });
});
