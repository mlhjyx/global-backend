import { describe, expect, it, vi } from 'vitest';
import { KbService } from './kb.service';

const CTX = { userId: 'u1', workspaceId: '11111111-1111-4111-8111-111111111111', roles: [] };
const SITE_ID = '22222222-2222-4222-8222-222222222222';

function makeService(opts: { embedDim?: number; doclingMd?: string } = {}) {
  const dim = opts.embedDim ?? 1024;
  const db: { docs: Record<string, unknown>[]; assets: Record<string, unknown>[] } = {
    docs: [],
    assets: [],
  };
  const rawInserts: unknown[][] = [];
  const embedCalls: string[][] = [];
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
      findMany: async ({ where }: { where: { siteId: string } }) =>
        db.docs.filter((d) => d.siteId === where.siteId),
      count: async ({ where }: { where: { siteId: string } }) =>
        db.docs.filter((d) => d.siteId === where.siteId).length,
    },
    asset: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        db.assets.filter(
          (a) => a.siteId === (where.siteId as string) && a.processingStatus === 'queued',
        ),
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; processingStatus?: string };
        data: Record<string, unknown>;
      }) => {
        const rows = db.assets.filter(
          (a) =>
            a.id === where.id &&
            (!where.processingStatus || a.processingStatus === where.processingStatus),
        );
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = db.assets.find((a) => a.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
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
    await service.ingestText(CTX, { siteId: SITE_ID, source: 'upload', title: 'big', text });
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
      processingStatus: 'queued',
    });
    const summary = await service.processQueued(CTX, SITE_ID);
    expect(summary).toEqual({ processed: 1, failed: 0 });
    expect(db.assets[0].processingStatus).toBe('ready');
    expect(db.docs).toHaveLength(1);
    expect(db.docs[0].source).toBe('upload');
    expect(db.docs[0].assetId).toBe('ast-1');
  });

  it('processQueued：单个素材失败不阻断其余（fail-safe），失败原因落 asset.error', async () => {
    const { service, db } = makeService();
    db.assets.push(
      {
        id: 'ast-bad',
        siteId: SITE_ID,
        kind: 'doc',
        filename: 'bad.pdf',
        mime: 'application/pdf',
        objectKey: 'missing-object',
        processingStatus: 'queued',
      },
      {
        id: 'ast-ok',
        siteId: SITE_ID,
        kind: 'doc',
        filename: 'ok.txt',
        mime: 'text/plain',
        objectKey: 'ws/x/y/doc/ok.txt',
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
    expect(bad?.processingStatus).toBe('failed');
    expect(String(bad?.error)).toContain('NoSuchKey');
    const ok = db.assets.find((a) => a.id === 'ast-ok');
    expect(ok?.processingStatus).toBe('ready');
  });

  it('status：文档数 + chunk 总数（gaps 空数组占位，M1 brandProfile 补）', async () => {
    const { service, db } = makeService();
    db.docs.push(
      { id: 'd1', siteId: SITE_ID, chunkCount: 3 },
      { id: 'd2', siteId: SITE_ID, chunkCount: 2 },
    );
    expect(await service.status(CTX, SITE_ID)).toEqual({ documents: 2, chunks: 5, gaps: [] });
  });
});
