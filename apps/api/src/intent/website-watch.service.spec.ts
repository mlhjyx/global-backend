import { describe, it, expect, beforeEach } from 'vitest';
import { WebsiteWatchService } from './website-watch.service';
import { PageFetcher, FetchedPage } from './page-fetcher';
import { PrismaService } from '../prisma/prisma.service';

/** 最小内存 Prisma 假体：只实现 WebsiteWatchService 触及的表面，验证 diff 编排（无 DB/网络，CI 安全）。 */
class FakePrisma {
  sources = new Map<string, Record<string, unknown>>();
  entities: Record<string, unknown>[] = [];
  changes: Record<string, unknown>[] = [];
  fetches = new Map<string, Record<string, unknown>>();
  private seq = 0;
  private id() {
    return `id${++this.seq}`;
  }
  monitoredSource = {
    findUnique: async ({ where }: { where: { id: string } }) => this.sources.get(where.id) ?? null,
    findMany: async () => [...this.sources.values()].filter((source) => source.providerKey === 'web_watch').map((source) => ({ id: source.id })),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      Object.assign(this.sources.get(where.id)!, data);
      return this.sources.get(where.id);
    },
  };
  sourceFetch = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: this.id(), ...data };
      this.fetches.set(row.id as string, row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      Object.assign(this.fetches.get(where.id)!, data);
      return this.fetches.get(where.id);
    },
  };
  sourceEntity = {
    findMany: async ({ where }: { where: { sourceId: string } }) => this.entities.filter((e) => e.sourceId === where.sourceId),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: this.id(), missCount: 0, withdrawnAt: null, ...data };
      this.entities.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const e = this.entities.find((x) => x.id === where.id)!;
      Object.assign(e, data);
      return e;
    },
  };
  sourceEntityChange = {
    createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
      this.changes.push(...data);
      return { count: data.length };
    },
    deleteMany: async () => ({ count: this.changes.splice(0).length }),
  };
  // DAT-011 kill-switch 查询：默认无 SUSPENDED 记录（测试不模拟封禁）。
  sourcePolicy = {
    suspended: false,
    findFirst: async () => (this.sourcePolicy.suspended ? { id: 'policy-1' } : null),
  };
}

/** 可切换返回的假抓取器。 */
class StubFetcher implements PageFetcher {
  next: FetchedPage | null = null;
  async fetch(url: string): Promise<FetchedPage | null> {
    return this.next ? { url, html: this.next.html } : null;
  }
}

const productHtml = (...names: string[]) =>
  '<html><body>' +
  names.map((n) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: n })}</script>`).join('') +
  `<p>${'we build industrial machinery for global export markets '.repeat(4)}</p></body></html>`;

const URL1 = 'https://acme.com/products';

describe('WebsiteWatchService', () => {
  let prisma: FakePrisma;
  let fetcher: StubFetcher;
  let svc: WebsiteWatchService;

  beforeEach(() => {
    prisma = new FakePrisma();
    fetcher = new StubFetcher();
    prisma.sources.set('src1', {
      id: 'src1',
      providerKey: 'web_watch',
      status: 'ACTIVE',
      label: 'Acme',
      region: null,
      cadence: { everyMs: 86400000 },
      config: { company: { name: 'Acme', domain: 'acme.com' }, pages: [{ url: URL1, kind: 'products' }] },
    });
    svc = new WebsiteWatchService({ prisma: prisma as unknown as PrismaService, fetcher });
  });

  it('round 1: first sight = ADDED baseline, no intent event', async () => {
    fetcher.next = { url: URL1, html: productHtml('Laser X1') };
    const r = await svc.watch('src1');
    expect(r.status).toBe('DONE');
    expect(r.added).toBe(1);
    expect(r.intentEvents).toBe(0);
    expect(prisma.changes.map((c) => c.changeType)).toEqual(['ADDED']);
    expect(prisma.entities).toHaveLength(1);
  });

  it('round 2: a new product yields a NEW_PRODUCTS intent event with only the new name', async () => {
    fetcher.next = { url: URL1, html: productHtml('Laser X1') };
    await svc.watch('src1');
    prisma.changes = [];
    fetcher.next = { url: URL1, html: productHtml('Laser X1', 'Tube Laser T3') };
    const r = await svc.watch('src1');
    expect(r.changed).toBe(1);
    expect(r.intentEvents).toBe(1);
    const ev = prisma.changes.find((c) => c.changeType === 'NEW_PRODUCTS')!;
    expect((ev.detail as { evidence: { new_products: string[] } }).evidence.new_products).toEqual(['Tube Laser T3']);
  });

  it('unchanged content emits no change and touches lastSeen', async () => {
    fetcher.next = { url: URL1, html: productHtml('Laser X1') };
    await svc.watch('src1');
    prisma.changes = [];
    const r = await svc.watch('src1'); // identical html
    expect(r.changed).toBe(0);
    expect(prisma.changes).toHaveLength(0);
  });

  it('anti-flap: a single fetch failure does NOT remove; two in a row does', async () => {
    fetcher.next = { url: URL1, html: productHtml('Laser X1') };
    await svc.watch('src1');
    prisma.changes = [];

    fetcher.next = null; // miss #1
    const r = await svc.watch('src1');
    expect(r.pagesMissed).toBe(1);
    expect(prisma.changes.some((c) => c.changeType === 'REMOVED')).toBe(false);
    expect(prisma.entities[0].missCount).toBe(1);
    expect(prisma.entities[0].withdrawnAt).toBeNull();

    await svc.watch('src1'); // miss #2 → threshold
    expect(prisma.changes.some((c) => c.changeType === 'REMOVED')).toBe(true);
    expect(prisma.entities[0].withdrawnAt).not.toBeNull();
  });

  it('dedupes duplicate URLs in config (no double-create → no unique violation)', async () => {
    (prisma.sources.get('src1') as Record<string, unknown>).config = {
      company: { name: 'Acme', domain: 'acme.com' },
      pages: [{ url: URL1, kind: 'products' }, { url: URL1, kind: 'products' }], // same url twice
    };
    fetcher.next = { url: URL1, html: productHtml('Laser X1') };
    const r = await svc.watch('src1');
    expect(r.status).toBe('DONE');
    expect(prisma.entities).toHaveLength(1); // not 2
    expect(r.added).toBe(1);
  });

  it('rejects a non-web_watch source', async () => {
    prisma.sources.set('bad', { id: 'bad', providerKey: 'trade_fair', status: 'ACTIVE', config: {} });
    await expect(svc.watch('bad')).rejects.toThrow(/not a web_watch/);
  });

  it('skips a paused source', async () => {
    (prisma.sources.get('src1') as Record<string, unknown>).status = 'PAUSED';
    const r = await svc.watch('src1');
    expect(r.status).toBe('SKIPPED');
  });

  it('rejects missing sources and skips malformed/empty page configs', async () => {
    await expect(svc.watch('missing')).rejects.toThrow('not found');
    (prisma.sources.get('src1') as Record<string, unknown>).config = null;
    await expect(svc.watch('src1')).resolves.toMatchObject({ status: 'SKIPPED', reason: 'no pages in config' });
    (prisma.sources.get('src1') as Record<string, unknown>).config = {
      company: null,
      pages: [null, 'bad', { nope: true }],
    };
    await expect(svc.watch('src1')).resolves.toMatchObject({ status: 'SKIPPED', reason: 'no pages in config' });
  });

  it('honors the DAT-011 suspended-domain gate before creating a fetch receipt', async () => {
    prisma.sourcePolicy.suspended = true;
    await expect(svc.watch('src1')).resolves.toMatchObject({
      status: 'SKIPPED',
      reason: 'domain SUSPENDED (DAT-011)',
    });
    expect(prisma.fetches.size).toBe(0);
  });

  it('treats a withdrawn page revival as a new baseline and retires removed config pages', async () => {
    fetcher.next = { url: URL1, html: productHtml('Laser X1') };
    await svc.watch('src1');
    prisma.changes = [];
    prisma.entities[0].withdrawnAt = new Date('2026-08-01T00:00:00.000Z');
    fetcher.next = { url: URL1, html: productHtml('Laser X2') };
    const revived = await svc.watch('src1');
    expect(revived.changed).toBe(0);
    expect(prisma.changes).toEqual([expect.objectContaining({ changeType: 'ADDED', detail: expect.objectContaining({ revived: true }) })]);

    (prisma.sources.get('src1') as Record<string, unknown>).config = {
      company: { name: '', domain: '' },
      pages: [{ url: 'https://acme.com/news' }, { url: 'mailto:bad' }, { url: '%' }],
    };
    fetcher.next = { url: 'https://acme.com/news', html: '<html><body>news</body></html>' };
    await svc.watch('src1');
    expect(prisma.entities.find((entity) => entity.externalId === URL1)?.withdrawnAt).not.toBeNull();
  });

  it('purges retained events only when web-watch sources exist', async () => {
    prisma.changes.push({ id: 'change-1' }, { id: 'change-2' });
    await expect(svc.purgeStaleEvents(1000)).resolves.toEqual({ deleted: 2 });
    prisma.sources.clear();
    await expect(svc.purgeStaleEvents(1000)).resolves.toEqual({ deleted: 0 });
  });
});
