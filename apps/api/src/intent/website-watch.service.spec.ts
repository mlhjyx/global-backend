import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebsiteWatchService } from './website-watch.service';
import { PageFetcher, FetchedPage } from './page-fetcher';
import { PrismaService } from '../prisma/prisma.service';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';

const watchAckMock = vi.hoisted(() => vi.fn(async (input: {
  transaction: unknown;
  acknowledgements: Array<{ producerId: string }>;
  apply: (transaction: unknown) => Promise<unknown>;
}) => ({
  status: 'APPLIED',
  acknowledgements: input.acknowledgements.map(({ producerId }) => ({
    producerId, status: 'APPLIED',
  })),
  value: await input.apply(input.transaction),
})));

vi.mock('../durable-results/domain-ack-consumer-bindings', () => ({
  applyDomainAckConsumerTransactions: watchAckMock,
}));

const WATCH_RECEIPT: DurableExecutionReceipt = Object.freeze({
  schemaVersion: 'durable-execution-receipt/v1',
  scopeKey: 'platform',
  authorityId: '20000000-0000-4000-8000-000000000001',
  accountId: '30000000-0000-4000-8000-000000000001',
  operationId: '40000000-0000-4000-8000-000000000001',
  operationKey: 'website-watch-render',
  resultStrategy: 'artifact_reference',
  resultSchema: 'crawl4ai-render/v1',
  resultDigest: 'a'.repeat(64),
  artifactId: '50000000-0000-4000-8000-000000000001',
  usage: { currency: 'USD', unit: 'microusd', callCount: 1, upperBoundMicrousd: '10000' },
  costBasis: 'estimated_upper_bound',
});

/** 最小内存 Prisma 假体：只实现 WebsiteWatchService 触及的表面，验证 diff 编排（无 DB/网络，CI 安全）。 */
class FakePrisma {
  sources = new Map<string, Record<string, unknown>>();
  entities: Record<string, unknown>[] = [];
  changes: Record<string, unknown>[] = [];
  fetches = new Map<string, Record<string, unknown>>();
  replayResult: Record<string, unknown> | null = null;
  private seq = 0;
  private id() {
    return `id${++this.seq}`;
  }
  monitoredSource = {
    findUnique: async ({ where }: { where: { id: string } }) => this.sources.get(where.id) ?? null,
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
    findFirst: async () => this.replayResult
      ? { executionResult: this.replayResult }
      : null,
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
  };
  // DAT-011 kill-switch 查询：默认无 SUSPENDED 记录（测试不模拟封禁）。
  sourcePolicy = {
    findFirst: async () => null,
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

  it.each([
    { code: 'EXECUTION_BUDGET_AUTHORITY_REVOKED' },
    { name: 'ActivityFailure', cause: { type: 'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE' } },
  ])('rethrows execution-control failure before page diff persistence', async (failure) => {
    let calls = 0;
    const controlled = new WebsiteWatchService({
      prisma: prisma as unknown as PrismaService,
      fetcher: { fetch: async () => { calls += 1; throw failure; } },
    });
    await expect(controlled.watch('src1')).rejects.toBe(failure);
    expect(calls).toBe(1);
    expect(prisma.entities).toEqual([]);
    expect(prisma.changes).toEqual([]);
  });

  it('ACKs a render receipt on the exact transaction that stores the website baseline', async () => {
    watchAckMock.mockClear();
    fetcher.next = { url: URL1, html: productHtml('Laser X1') };
    const platformWriter = {
      $transaction: vi.fn(async (callback: (transaction: FakePrisma) => Promise<unknown>) =>
        callback(prisma)),
    };
    const receipted = new WebsiteWatchService({
      prisma: prisma as unknown as PrismaService,
      fetcher,
      platformWriter: platformWriter as never,
      durableReceipts: [{ producerId: 'crawl4ai.render', receipt: WATCH_RECEIPT }],
    });

    await expect(receipted.watch('src1')).resolves.toMatchObject({
      status: 'DONE', pagesFetched: 1, added: 1,
    });
    expect(watchAckMock).toHaveBeenCalledWith(expect.objectContaining({
      transaction: prisma,
      acknowledgements: [expect.objectContaining({
        producerId: 'crawl4ai.render', receipt: WATCH_RECEIPT,
      })],
    }));
    expect(prisma.entities).toHaveLength(1);
    expect([...prisma.fetches.values()].at(-1)).toEqual(expect.objectContaining({
      executionOperationIds: [WATCH_RECEIPT.operationId],
    }));

    const withoutWriter = new WebsiteWatchService({
      prisma: prisma as unknown as PrismaService,
      fetcher,
      durableReceipts: [{ producerId: 'crawl4ai.render', receipt: WATCH_RECEIPT }],
    });
    await expect(withoutWriter.watch('src1'))
      .rejects.toThrow('DOMAIN_ACK_PLATFORM_TRANSACTION_UNAVAILABLE');
  });

  it('returns exact website-watch readback on all-replay and skips queued mutations', async () => {
    const authoritative = {
      sourceId: 'src1', status: 'DONE', pagesFetched: 2, pagesMissed: 0,
      added: 1, changed: 1, intentEvents: 1,
    };
    prisma.replayResult = authoritative;
    fetcher.next = { url: URL1, html: productHtml('Laser X1') };
    watchAckMock.mockImplementationOnce(async (input: {
      transaction: unknown;
      acknowledgements: Array<{ producerId: string }>;
      readback: (transaction: unknown) => Promise<unknown>;
    }) => ({
      status: 'REPLAYED',
      acknowledgements: input.acknowledgements.map(({ producerId }) => ({
        producerId, status: 'REPLAYED',
      })),
      value: await input.readback(input.transaction),
    }));
    const receipted = new WebsiteWatchService({
      prisma: prisma as unknown as PrismaService,
      fetcher,
      platformWriter: {
        $transaction: vi.fn(async (callback: (transaction: FakePrisma) => Promise<unknown>) =>
          callback(prisma)),
      } as never,
      durableReceipts: [{ producerId: 'crawl4ai.render', receipt: WATCH_RECEIPT }],
    });

    await expect(receipted.watch('src1')).resolves.toEqual(authoritative);
    expect(prisma.entities).toEqual([]);
    expect(prisma.changes).toEqual([]);
    expect([...prisma.fetches.values()].at(-1)).toEqual(expect.objectContaining({
      status: 'REPLAYED', executionResult: authoritative,
    }));
  });
});
