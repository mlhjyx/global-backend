import { describe, expect, it, vi } from 'vitest';
import { KbService } from './kb.service';

const CTX = { userId: 'u1', workspaceId: '11111111-1111-4111-8111-111111111111', roles: [] };
const SITE_ID = '22222222-2222-4222-8222-222222222222';

function makeService(opts: { embedDim?: number; doclingMd?: string } = {}) {
  const dim = opts.embedDim ?? 1024;
  const db: {
    docs: Record<string, unknown>[];
    assets: Record<string, unknown>[];
    profiles: Record<string, unknown>[];
    chunks: Record<string, unknown>[];
  } = {
    docs: [],
    assets: [],
    profiles: [],
    chunks: [],
  };
  const rawInserts: unknown[][] = [];
  const embedCalls: string[][] = [];
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, expected]) => {
      if (key === 'OR') {
        return (expected as Record<string, unknown>[]).some((part) => matches(row, part));
      }
      const actual = row[key];
      if (expected !== null && typeof expected === 'object' && !(expected instanceof Date)) {
        const op = expected as Record<string, unknown>;
        if ('not' in op) return actual !== op.not;
        if ('in' in op) return (op.in as unknown[]).includes(actual);
        if ('notIn' in op) return !(op.notIn as unknown[]).includes(actual);
        if ('lte' in op) {
          return actual instanceof Date && actual.getTime() <= (op.lte as Date).getTime();
        }
      }
      if (expected === null) return actual == null;
      return actual === expected;
    });
  const applyData = (row: Record<string, unknown>, data: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(data)) {
      if (value !== null && typeof value === 'object' && 'increment' in value) {
        row[key] = Number(row[key] ?? 0) + Number((value as { increment: number }).increment);
      } else {
        row[key] = value;
      }
    }
  };
  const tx = {
    kbDocument: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `doc-${db.docs.length + 1}`, ...data };
        db.docs.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = db.docs.find((d) => d.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
      findUnique: async ({ where }: { where: { id?: string; assetId?: string } }) =>
        db.docs.find(
          (d) => (where.id ? d.id === where.id : d.assetId === where.assetId),
        ) ?? null,
      findMany: async ({
        where,
        orderBy,
        take,
      }: {
        where: { siteId: string; status?: string };
        orderBy?: { createdAt?: 'desc' | 'asc' };
        take?: number;
      }) => {
        let rows = db.docs.filter(
          (d) => d.siteId === where.siteId && (!where.status || d.status === where.status),
        );
        if (orderBy?.createdAt === 'desc') {
          rows = [...rows].sort(
            (a, b) => new Date(b.createdAt as Date).getTime() - new Date(a.createdAt as Date).getTime(),
          );
        }
        return take != null ? rows.slice(0, take) : rows;
      },
      count: async ({ where }: { where: { siteId: string } }) =>
        db.docs.filter((d) => d.siteId === where.siteId).length,
    },
    asset: {
      findMany: async ({
        where,
        take,
        select,
      }: {
        where: Record<string, unknown>;
        take?: number;
        select?: Record<string, boolean>;
      }) => {
        const rows = db.assets.filter((a) => matches(a, where)).slice(0, take);
        if (!select) return rows;
        return rows.map((row) =>
          Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])),
        );
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        db.assets.find((a) => a.id === where.id) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const rows = db.assets.filter((a) => matches(a, where));
        rows.forEach((r) => applyData(r, data));
        return { count: rows.length };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = db.assets.find((a) => a.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
    },
    brandProfile: {
      findFirst: async ({ where }: { where: { siteId: string } }) => {
        const rows = db.profiles
          .filter((p) => p.siteId === where.siteId)
          .sort((a, b) => (b.version as number) - (a.version as number));
        return rows[0] ?? null;
      },
    },
    kbChunk: {
      deleteMany: async ({ where }: { where: { documentId: string } }) => {
        const before = db.chunks.length;
        db.chunks = db.chunks.filter((c) => c.documentId !== where.documentId);
        return { count: before - db.chunks.length };
      },
      findMany: async ({
        where,
        take,
      }: {
        where: { documentId: string };
        take?: number;
      }) =>
        db.chunks
          .filter((c) => c.documentId === where.documentId)
          .sort((a, b) => (a.seq as number) - (b.seq as number))
          .slice(0, take ?? undefined),
    },
    $executeRaw: vi.fn(async (...args: unknown[]) => {
      rawInserts.push(args);
      return 1;
    }),
    $queryRaw: vi.fn(async () => []),
  };
  const prisma = {
    withWorkspace: async <T>(_ws: string, fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
  };
  const embeddings = {
    model: 'bge-m3',
    version: 'v1',
    embed: async (texts: string[]) => {
      embedCalls.push(texts);
      return texts.map(() => Array.from({ length: dim }, () => 0.1));
    },
  };
  const docling = {
    convertToMarkdown: async () => ({
      markdown: opts.doclingMd ?? '# Parsed\n\nParsed doc content here.',
    }),
  };
  const storage = {
    getBuffer: async () => Buffer.from('Plain text company intro, long enough to be a chunk.'),
  };
  const service = new KbService(
    prisma as never,
    embeddings as never,
    docling as never,
    storage as never,
  );
  return { service, db, rawInserts, embedCalls, tx };
}

describe('KbService（知识库地基：切块→向量化→pgvector 落库，02 §12）', () => {
  it('ingestText：建 doc（ready）+ 每 chunk 一次向量 INSERT + chunkCount 回填', async () => {
    const { service, db, rawInserts, embedCalls } = makeService();
    const text = ['# Intro', 'A'.repeat(300), '## Products', 'B'.repeat(300)].join('\n\n');
    const doc = await service.ingestText(CTX, {
      siteId: SITE_ID,
      source: 'wizard',
      title: '公司简介',
      text,
    });
    expect(doc.status).toBe('ready');
    expect(doc.chunkCount).toBeGreaterThanOrEqual(2);
    expect(rawInserts).toHaveLength(doc.chunkCount as number);
    expect(embedCalls.flat()).toHaveLength(doc.chunkCount as number);
    expect(db.docs).toHaveLength(1);
  });

  it('ingestText：空文本 → doc ready、chunkCount=0、不调 embedding', async () => {
    const { service, rawInserts, embedCalls } = makeService();
    const doc = await service.ingestText(CTX, {
      siteId: SITE_ID,
      source: 'intake',
      title: 'empty',
      text: '   ',
    });
    expect(doc.status).toBe('ready');
    expect(doc.chunkCount).toBe(0);
    expect(rawInserts).toHaveLength(0);
    expect(embedCalls).toHaveLength(0);
  });

  it('embedding 按批（≤32）分次调用', async () => {
    const { service, embedCalls } = makeService();
    const paragraphs = Array.from({ length: 70 }, (_, i) => `Paragraph ${i}: ${'x'.repeat(280)}.`);
    const text = `# Big\n\n${paragraphs.join('\n\n')}`;
    await service.ingestText(CTX, { siteId: SITE_ID, source: 'wizard', title: 'big', text });
    expect(embedCalls.length).toBeGreaterThanOrEqual(3);
    for (const batch of embedCalls) expect(batch.length).toBeLessThanOrEqual(32);
  });

  it('processQueued：txt 素材直读文本、docling 不参与；成功后 asset→ready', async () => {
    const { service, db } = makeService();
    db.assets.push({
      id: 'ast-1',
      siteId: SITE_ID,
      kind: 'doc',
      filename: 'intro.txt',
      mime: 'text/plain',
      objectKey: 'ws/x/y/doc/abc.txt',
      contentHash: 'a'.repeat(64),
      processingStatus: 'queued',
    });
    const summary = await service.processQueued(CTX, SITE_ID);
    expect(summary).toEqual({ processed: 1, failed: 0 });
    expect(db.assets[0].processingStatus).toBe('ready');
    expect(db.docs).toHaveLength(1);
    expect(db.docs[0].source).toBe('upload');
    expect(db.docs[0].assetId).toBe('ast-1');
  });

  it('R2-A2：进入外部 IO 前已分配 attempt + UUID fence + lease，完成后清 lease', async () => {
    const { service, db } = makeService();
    db.assets.push({
      id: 'ast-fenced',
      siteId: SITE_ID,
      kind: 'doc',
      filename: 'intro.txt',
      mime: 'text/plain',
      objectKey: 'ws/x/y/doc/fenced.txt',
      contentHash: 'b'.repeat(64),
      processingStatus: 'queued',
      processingAttempt: 0,
      leaseToken: null,
      leaseUntil: null,
    });
    const seen: Record<string, unknown>[] = [];
    const svc = service as unknown as { storage: { getBuffer: () => Promise<Buffer> } };
    svc.storage.getBuffer = async () => {
      seen.push({ ...db.assets[0] });
      return Buffer.from('Fenced document content, long enough to become a chunk.');
    };

    await service.processQueued(CTX, SITE_ID);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ processingStatus: 'processing', processingAttempt: 1 });
    expect(seen[0].leaseToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(seen[0].leaseUntil).toBeInstanceOf(Date);
    expect(db.assets[0]).toMatchObject({
      processingStatus: 'ready',
      processingAttempt: 1,
      leaseToken: null,
      leaseUntil: null,
      retryAt: null,
      processingErrorCode: null,
    });
  });

  it('R2-A2：typed 瞬时故障回 queued + retryAt，不误用 failed/failed_retryable', async () => {
    const { service, db } = makeService();
    db.assets.push({
      id: 'ast-transient',
      siteId: SITE_ID,
      kind: 'doc',
      filename: 'catalog.pdf',
      mime: 'application/pdf',
      objectKey: 'ws/x/y/doc/transient.pdf',
      contentHash: 'c'.repeat(64),
      processingStatus: 'queued',
      processingAttempt: 0,
    });
    const svc = service as unknown as { storage: { getBuffer: () => Promise<Buffer> } };
    svc.storage.getBuffer = async () => {
      throw Object.assign(new Error('arbitrary wording must not be parsed'), {
        code: 'KB_STORAGE_UNAVAILABLE',
        disposition: 'retryable',
        stage: 'storage',
      });
    };

    const out = await service.processQueued(CTX, SITE_ID);

    expect(out).toEqual({ processed: 0, failed: 1 });
    expect(db.assets[0]).toMatchObject({
      processingStatus: 'queued',
      processingErrorCode: 'KB_STORAGE_UNAVAILABLE',
      leaseToken: null,
      leaseUntil: null,
    });
    expect(db.assets[0].retryAt).toBeInstanceOf(Date);
  });

  it('R2-A2：同一 asset 结果丢失后重跑仍只有一个 KbDocument', async () => {
    const { service, db } = makeService();
    db.assets.push({
      id: 'ast-idempotent',
      siteId: SITE_ID,
      kind: 'doc',
      filename: 'catalog.txt',
      mime: 'text/plain',
      objectKey: 'ws/x/y/doc/idempotent.txt',
      contentHash: 'd'.repeat(64),
      processingStatus: 'queued',
      processingAttempt: 0,
    });

    await service.processQueued(CTX, SITE_ID);
    Object.assign(db.assets[0], { processingStatus: 'queued' }); // 模拟 ready 回写 ACK 丢失后的恢复扫描
    await service.processQueued(CTX, SITE_ID);

    expect(db.docs.filter((d) => d.assetId === 'ast-idempotent')).toHaveLength(1);
    expect(db.assets[0].processingStatus).toBe('ready');
  });

  it('R2-A2：persist 中途收到 Activity 取消会停止 chunk 写入并回 due queue', async () => {
    const { service, db, rawInserts } = makeService();
    db.assets.push({
      id: 'ast-cancel-persist',
      siteId: SITE_ID,
      kind: 'doc',
      filename: 'cancel.txt',
      mime: 'text/plain',
      objectKey: 'ws/x/y/doc/cancel.txt',
      contentHash: 'c'.repeat(64),
      processingStatus: 'queued',
      processingAttempt: 0,
    });
    const controller = new AbortController();

    const out = await service.processAsset(CTX, SITE_ID, 'ast-cancel-persist', {
      signal: controller.signal,
      heartbeat: (stage) => {
        if (stage === 'persist:chunk:0') controller.abort(new Error('activity cancelled'));
      },
    });

    expect(out).toMatchObject({ outcome: 'retry_scheduled', errorCode: 'KB_PERSIST_FAILED' });
    expect(rawInserts).toHaveLength(0);
    expect(db.assets[0]).toMatchObject({
      processingStatus: 'queued',
      leaseToken: null,
      leaseUntil: null,
    });
  });

  it('R2-A2：lease 过期接管后，旧 worker 恢复也不能 zombie write', async () => {
    const { service, db } = makeService();
    db.assets.push({
      id: 'ast-zombie',
      siteId: SITE_ID,
      kind: 'doc',
      filename: 'zombie.txt',
      mime: 'text/plain',
      objectKey: 'ws/x/y/doc/zombie.txt',
      contentHash: '1'.repeat(64),
      processingStatus: 'queued',
      processingAttempt: 0,
      leaseToken: null,
      leaseUntil: null,
    });
    let releaseOld!: (buffer: Buffer) => void;
    const oldBuffer = new Promise<Buffer>((resolve) => {
      releaseOld = resolve;
    });
    let storageCalls = 0;
    const svc = service as unknown as { storage: { getBuffer: () => Promise<Buffer> } };
    svc.storage.getBuffer = async () => {
      storageCalls += 1;
      if (storageCalls === 1) return oldBuffer;
      return Buffer.from('new worker wins with fenced content');
    };

    const oldWorker = service.processAsset(CTX, SITE_ID, 'ast-zombie');
    await vi.waitFor(() => expect(storageCalls).toBe(1));
    const oldToken = db.assets[0].leaseToken;
    db.assets[0].leaseUntil = new Date(Date.now() - 1);

    const winner = await service.processAsset(CTX, SITE_ID, 'ast-zombie');
    releaseOld(Buffer.from('old worker resumes too late'));
    const loser = await oldWorker;

    expect(winner.outcome).toBe('ready');
    expect(loser.outcome).toBe('superseded');
    expect(db.assets[0]).toMatchObject({ processingStatus: 'ready', processingAttempt: 2 });
    expect(db.assets[0].leaseToken).toBeNull();
    expect(oldToken).not.toBeNull();
    expect(db.docs.filter((d) => d.assetId === 'ast-zombie')).toHaveLength(1);
  });

  it('R2-A2：只有 typed 文档损坏进入 failed_terminal，且不安排 retry', async () => {
    const { service, db } = makeService();
    db.assets.push({
      id: 'ast-corrupt',
      siteId: SITE_ID,
      kind: 'doc',
      filename: 'corrupt.pdf',
      mime: 'application/pdf',
      objectKey: 'ws/x/y/doc/corrupt.pdf',
      contentHash: '2'.repeat(64),
      processingStatus: 'queued',
      processingAttempt: 0,
    });
    const svc = service as unknown as {
      docling: { convertToMarkdown: () => Promise<{ markdown: string }> };
    };
    svc.docling.convertToMarkdown = async () => {
      throw Object.assign(new Error('wording does not determine disposition'), {
        code: 'KB_DOCUMENT_INVALID',
        disposition: 'terminal',
        stage: 'parse',
      });
    };

    const out = await service.processAsset(CTX, SITE_ID, 'ast-corrupt');

    expect(out).toMatchObject({
      outcome: 'failed_terminal',
      errorCode: 'KB_DOCUMENT_INVALID',
    });
    expect(db.assets[0]).toMatchObject({
      processingStatus: 'failed_terminal',
      processingErrorCode: 'KB_DOCUMENT_INVALID',
      retryAt: null,
      leaseToken: null,
      leaseUntil: null,
    });
    expect(db.docs).toHaveLength(0);
  });

  it('R2-A2：retryAt 未到期时不认领，也不触达 MinIO', async () => {
    const { service, db } = makeService();
    db.assets.push({
      id: 'ast-not-due',
      siteId: SITE_ID,
      kind: 'doc',
      filename: 'later.txt',
      mime: 'text/plain',
      objectKey: 'ws/x/y/doc/later.txt',
      contentHash: '3'.repeat(64),
      processingStatus: 'queued',
      processingAttempt: 3,
      retryAt: new Date(Date.now() + 60_000),
      leaseToken: null,
      leaseUntil: null,
    });
    const svc = service as unknown as { storage: { getBuffer: ReturnType<typeof vi.fn> } };
    svc.storage.getBuffer = vi.fn(async () => Buffer.from('must not run'));

    await expect(service.processAsset(CTX, SITE_ID, 'ast-not-due')).resolves.toEqual({
      assetId: 'ast-not-due',
      outcome: 'not_due',
    });
    expect(svc.storage.getBuffer).not.toHaveBeenCalled();
    expect(db.assets[0].processingAttempt).toBe(3);
  });

  it('processQueued：单个瞬时失败不阻断其余，失败素材回 due queue', async () => {
    const { service, db } = makeService();
    db.assets.push(
      {
        id: 'ast-bad',
        siteId: SITE_ID,
        kind: 'doc',
        filename: 'bad.pdf',
        mime: 'application/pdf',
        objectKey: 'missing-object',
        contentHash: 'e'.repeat(64),
        processingStatus: 'queued',
      },
      {
        id: 'ast-ok',
        siteId: SITE_ID,
        kind: 'doc',
        filename: 'ok.txt',
        mime: 'text/plain',
        objectKey: 'ws/x/y/doc/ok.txt',
        contentHash: 'f'.repeat(64),
        processingStatus: 'queued',
      },
    );
    const svc = service as unknown as { storage: { getBuffer: (k: string) => Promise<Buffer> } };
    const realGet = svc.storage.getBuffer.bind(svc.storage);
    svc.storage.getBuffer = async (key: string) => {
      if (key === 'missing-object') throw new Error('NoSuchKey');
      return realGet(key);
    };
    const summary = await service.processQueued(CTX, SITE_ID);
    expect(summary).toEqual({ processed: 1, failed: 1 });
    const bad = db.assets.find((a) => a.id === 'ast-bad');
    expect(bad?.processingStatus).toBe('queued');
    expect(bad?.processingErrorCode).toBe('KB_STORAGE_UNAVAILABLE');
    expect(bad?.retryAt).toBeInstanceOf(Date);
    expect(String(bad?.error)).toContain('NoSuchKey');
    const ok = db.assets.find((a) => a.id === 'ast-ok');
    expect(ok?.processingStatus).toBe('ready');
  });

  it('status：文档数 + chunk 总数（未构建过 brand_profile 时 gaps=[]）', async () => {
    const { service, db } = makeService();
    db.docs.push(
      { id: 'd1', siteId: SITE_ID, chunkCount: 3 },
      { id: 'd2', siteId: SITE_ID, chunkCount: 2 },
    );
    expect(await service.status(CTX, SITE_ID)).toEqual({ documents: 2, chunks: 5, gaps: [] });
  });

  it('status：gaps 从最新 brand_profile 版本回填（M1-b，kb.service:116 挂账收口）', async () => {
    const { service, db } = makeService();
    const gap = { field: 'certifications', reason: 'needs_input', hint: '请上传证书文件' };
    db.profiles.push(
      { siteId: SITE_ID, version: 1, gaps: [{ field: 'old', reason: 'needs_input', hint: '旧版' }] },
      { siteId: SITE_ID, version: 2, gaps: [gap] },
    );
    const status = await service.status(CTX, SITE_ID);
    expect(status.gaps).toEqual([gap]); // 恒取最新版本，不混老版本
  });

  it('digestSources：只取 ready 文档、每文档按 seq 取前 N 块拼正文', async () => {
    const { service, db } = makeService();
    db.docs.push(
      { id: 'd1', siteId: SITE_ID, source: 'upload', title: 'catalog.pdf', status: 'ready', createdAt: new Date('2026-07-02') },
      { id: 'd2', siteId: SITE_ID, source: 'intake', title: '注册资料', status: 'queued', createdAt: new Date('2026-07-03') },
    );
    db.chunks.push(
      { documentId: 'd1', seq: 1, text: 'second' },
      { documentId: 'd1', seq: 0, text: 'first' },
      { documentId: 'd1', seq: 2, text: 'third' },
    );
    const sources = await service.digestSources(CTX, SITE_ID, { chunksPerDoc: 2 });
    expect(sources).toEqual([
      { source: 'upload', title: 'catalog.pdf', text: 'first\nsecond' }, // queued 的 d2 不参与
    ]);
  });
});
