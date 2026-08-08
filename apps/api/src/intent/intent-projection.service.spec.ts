import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import {
  canonicalize,
  sameIntent,
  mergeIntent,
  IntentAttr,
  IntentEvent,
  IntentProjectionService,
  discoverWatchPages,
  toIntentEvent,
} from './intent-projection.service';

// 这三个纯函数是 TED P3 / openFDA P3 / web_watch 共享的**幂等基石**——每 sweep 复现同一信号时靠它们判「实质未变」
// 而不重写 canonical / 不堆 field_evidence。TED P3 实测抓到过 jsonb 键序 bug（DB 取回对象键序被 Postgres 规范化，
// 与内存插入序不同 → 朴素 JSON.stringify 误判「变了」）——canonicalize 就是修复。此处把该纪律锁进单测。

describe('canonicalize —— 键序无关的稳定规范形（jsonb 往返比较）', () => {
  it('对象递归按键名排序，键序不同 → 规范形相同', () => {
    const a = { b: 1, a: { d: 2, c: 3 } };
    const b = { a: { c: 3, d: 2 }, b: 1 };
    expect(JSON.stringify(canonicalize(a))).toBe(JSON.stringify(canonicalize(b)));
  });
  it('数组保序（顺序是语义，不排序）', () => {
    expect(JSON.stringify(canonicalize([3, 1, 2]))).toBe(JSON.stringify([3, 1, 2]));
  });
  it('标量原样', () => {
    expect(canonicalize('x')).toBe('x');
    expect(canonicalize(5)).toBe(5);
    expect(canonicalize(null)).toBe(null);
  });
});

const ev = (over: Partial<IntentEvent> = {}): IntentEvent => ({ type: 'FDA_CLEARANCE', at: '2025-09-08', strength: 0.85, ...over });

describe('sameIntent —— 实质相等判定（忽略 _ts，键序无关）', () => {
  it('同内容 → 相等（幂等门核心：仅时间戳变不算变）', () => {
    const a = mergeIntent(undefined, [ev()]);
    const b = mergeIntent(undefined, [ev()]);
    expect(sameIntent(a, b)).toBe(true);
  });
  it('模拟 jsonb 键序被规范化（DB 取回）→ 仍判相等', () => {
    const inMemory = mergeIntent(undefined, [ev()]);
    // 模拟 Postgres jsonb 往返：深拷贝并打乱顶层键序
    const fromDb = JSON.parse(JSON.stringify({ _ts: inMemory._ts, events: inMemory.events, counts: inMemory.counts, intent_score: inMemory.intent_score, last_change_at: inMemory.last_change_at })) as IntentAttr;
    expect(sameIntent(inMemory, fromDb)).toBe(true);
  });
  it('内容不同（新事件）→ 不相等', () => {
    const a = mergeIntent(undefined, [ev({ at: '2025-09-08' })]);
    const b = mergeIntent(a, [ev({ at: '2026-04-22', evidence: { k: 'K111' } })]);
    expect(sameIntent(a, b)).toBe(false);
  });
});

describe('mergeIntent —— 合并/去重/滚动/幂等', () => {
  it('按 type|at|url 去重（同一清关每 sweep 复现 → 不重复堆事件）', () => {
    const first = mergeIntent(undefined, [ev()]);
    const again = mergeIntent(first, [ev()]); // 同一事件再来
    expect(again.events.length).toBe(1);
    expect(sameIntent(first, again)).toBe(true); // 幂等：再合并实质未变
  });
  it('新近降序 + counts 累计 + intent_score=最强', () => {
    const merged = mergeIntent(undefined, [ev({ at: '2025-01-01', strength: 0.5 }), ev({ at: '2026-04-22', strength: 0.85 })]);
    expect(merged.events[0].at).toBe('2026-04-22'); // 最新在前
    expect(merged.counts.FDA_CLEARANCE).toBe(2);
    expect(merged.intent_score).toBe(0.85);
  });
  it('相等 at 的不同类型事件 → 稳定序，重复合并幂等（比较器一致性回归）', () => {
    // 同 at 不同 type（FDA 清关 + 网站变更同日）——比较器若不一致会重排 → 破幂等。
    const events: IntentEvent[] = [ev({ type: 'FDA_CLEARANCE', at: '2025-09-08' }), ev({ type: 'PAGE_CHANGED', at: '2025-09-08', strength: 0.3 })];
    const m1 = mergeIntent(undefined, events);
    const m2 = mergeIntent(m1, events); // 再合并同样两条
    expect(m2.events.length).toBe(2);
    expect(sameIntent(m1, m2)).toBe(true); // 稳定序 → 幂等成立
  });
  it('滚动保留上限（不无限增长）', () => {
    const many: IntentEvent[] = Array.from({ length: 30 }, (_, i) => ev({ at: `2025-${String((i % 12) + 1).padStart(2, '0')}-0${(i % 9) + 1}`, evidence: { i } }));
    const merged = mergeIntent(undefined, many);
    expect(merged.events.length).toBeLessThanOrEqual(20);
  });
});

// ─── 收口⑤ HIGH 回归锁：mergeIntent at 格式漂移免疫（epoch 归一去重键 + 一致比较器）───
import { mergeIntent as mergeIntentFn, sameIntent as sameIntentFn } from './intent-projection.service';

describe('mergeIntent — at 格式漂移免疫（存量旧格式与新 UTC ISO 同刻去重，一次重写即收敛）', () => {
  it('date-only / UTC ISO / 带时区 ISO 同刻 → 去重为一条（incoming 新格式存活）', () => {
    const prev = mergeIntentFn(undefined, [{ type: 'FDA_CLEARANCE', at: '2026-05-05', strength: 0.85 }]);
    const next = mergeIntentFn(prev, [{ type: 'FDA_CLEARANCE', at: '2026-05-05T00:00:00.000Z', strength: 0.85 }]);
    expect(next.events).toHaveLength(1);
    expect(next.events[0].at).toBe('2026-05-05T00:00:00.000Z');
    // 一次重写后收敛（再合并同事件 → 实质不变，增量 sweep 幂等恢复）
    const again = mergeIntentFn(next, [{ type: 'FDA_CLEARANCE', at: '2026-05-05T00:00:00.000Z', strength: 0.85 }]);
    expect(sameIntentFn(next, again)).toBe(true);

    const tzPrev = mergeIntentFn(undefined, [{ type: 'TENDER_PUBLISHED', at: '2026-07-08T00:00:00+02:00', strength: 0.9 }]);
    const tzNext = mergeIntentFn(tzPrev, [{ type: 'TENDER_PUBLISHED', at: '2026-07-07T22:00:00.000Z', strength: 0.9 }]);
    expect(tzNext.events).toHaveLength(1); // +02:00 与 UTC 等刻 → 同键
  });

  it('跨格式排序按真实时刻；不可解析 at 视为最旧（评分侧本就 0 分）', () => {
    const merged = mergeIntentFn(undefined, [
      { type: 'A', at: 'not-a-date', strength: 0.5 },
      { type: 'B', at: '2026-07-01', strength: 0.5 },
      { type: 'C', at: '2026-07-02T00:00:00+02:00', strength: 0.5 }, // = 2026-07-01T22:00Z，晚于 B
    ]);
    expect(merged.events.map((e) => e.type)).toEqual(['C', 'B', 'A']);
  });

  it('同刻不同 type / 不同 page_url 绝不误并（去重键其余维度保留）', () => {
    const merged = mergeIntentFn(undefined, [
      { type: 'PAGE_CHANGED', at: '2026-07-01T00:00:00.000Z', strength: 0.3, page_url: 'https://a.example/x' },
      { type: 'PAGE_CHANGED', at: '2026-07-01T00:00:00.000Z', strength: 0.3, page_url: 'https://a.example/y' },
      { type: 'HIRING_UP', at: '2026-07-01T00:00:00.000Z', strength: 0.6 },
    ]);
    expect(merged.events).toHaveLength(3);
  });
});

function projectionHarness(priorIntent?: IntentAttr) {
  const occurredAt = new Date('2026-08-07T12:00:00.000Z');
  const company = {
    id: 'co-1',
    status: 'ACTIVE',
    version: 1,
    attributes: priorIntent ? { retained: 'yes', intent: priorIntent } : { retained: 'yes' },
  };
  const evidence: Record<string, unknown>[] = [];
  const update = vi.fn(async ({ data }: { data: { attributes: Record<string, unknown> } }) => {
    company.attributes = data.attributes as typeof company.attributes;
    company.version += 1;
    return { id: company.id };
  });
  const evidenceCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    evidence.push(data);
    return { id: `fe-${evidence.length}` };
  });
  const tx = {
    canonicalCompany: {
      findUnique: vi.fn(async () => company),
      update,
    },
    fieldEvidence: { create: evidenceCreate },
  };
  const changes = [
    {
      changeType: 'NEW_PRODUCTS',
      createdAt: occurredAt,
      detail: {
        strength: 0.7,
        page_kind: 'products',
        url: 'https://acme.example/products/pump',
        evidence: { added: ['pump'] },
      },
      source: {
        config: {
          company: { name: 'Acme GmbH', domain: 'acme.example' },
        },
      },
    },
  ];
  const prisma = {
    sourceEntityChange: { findMany: vi.fn(async () => changes) },
    withWorkspace: vi.fn(
      async (_workspaceId: string, fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    ),
  } as unknown as PrismaService;
  return {
    service: new IntentProjectionService({ prisma }),
    company,
    evidence,
    update,
    evidenceCreate,
  };
}

describe('IntentProjectionService.projectIntent', () => {
  it('is idempotent for a replayed canonical change and does not duplicate evidence', async () => {
    const h = projectionHarness();

    expect(await h.service.projectIntent('ws-1')).toEqual({
      companiesTouched: 1,
      eventsProjected: 1,
    });
    const versionAfterFirst = h.company.version;
    const evidenceAfterFirst = h.evidence.length;

    expect(await h.service.projectIntent('ws-1')).toEqual({
      companiesTouched: 0,
      eventsProjected: 0,
    });
    expect(h.company.version).toBe(versionAfterFirst);
    expect(h.evidence).toHaveLength(evidenceAfterFirst);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.evidenceCreate).toHaveBeenCalledTimes(1);
  });

  it('keeps cross-source intent in canonical attributes but only writes web-watch events as web-watch evidence', async () => {
    const priorIntent = mergeIntent(undefined, [
      {
        type: 'TENDER_PUBLISHED',
        at: '2026-08-06T12:00:00.000Z',
        strength: 0.9,
        evidence: { notice: 'ted-1', source: 'ted' },
      },
    ]);
    const h = projectionHarness(priorIntent);

    await h.service.projectIntent('ws-1');

    expect(h.company.attributes.retained).toBe('yes');
    expect(
      (h.company.attributes.intent as IntentAttr).events.map((event) => event.type),
    ).toEqual(['NEW_PRODUCTS', 'TENDER_PUBLISHED']);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0]).toMatchObject({
      field: 'intent.website_change',
      providerKey: 'web_watch',
      value: {
        events: [expect.objectContaining({ type: 'NEW_PRODUCTS' })],
      },
    });
    expect(JSON.stringify(h.evidence[0])).not.toContain('TENDER_PUBLISHED');
  });
});

describe('IntentProjectionService.registerWatch', () => {
  function registerHarness(args?: {
    company?: { name: string; domain: string | null; region: string | null } | null;
    prior?: { id: string; config: unknown } | null;
  }) {
    const company = args && 'company' in args
      ? args.company
      : { name: 'Acme Pumps', domain: 'www.acme.example', region: 'DE' };
    const prior = args && 'prior' in args ? args.prior : null;
    const update = vi.fn(async () => ({ id: prior?.id }));
    const create = vi.fn(async () => ({ id: 'source-new' }));
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({ canonicalCompany: { findUnique: vi.fn(async () => company) } }),
      ),
      monitoredSource: {
        findUnique: vi.fn(async () => prior),
        update,
        create,
      },
    } as unknown as PrismaService;
    return { service: new IntentProjectionService({ prisma }), update, create };
  }

  it('rejects a missing company or a company without a usable domain', async () => {
    await expect(registerHarness({ company: null }).service.registerWatch('ws-1', 'missing')).rejects.toThrow(
      'not found in workspace',
    );
    await expect(
      registerHarness({ company: { name: 'No Web', domain: null, region: null } }).service.registerWatch('ws-1', 'co-1'),
    ).rejects.toThrow('has no domain');
  });

  it('creates a bounded explicit watch with the requested cadence and normalized domain', async () => {
    const h = registerHarness();
    const pages = Array.from({ length: 15 }, (_, index) => ({
      url: `https://acme.example/page-${index}`,
      kind: 'generic' as const,
    }));

    await expect(h.service.registerWatch('ws-1', 'co-1', { pages, cadenceMs: 1234 })).resolves.toEqual({
      sourceId: 'source-new',
      sourceKey: 'web_watch:acme.example',
      created: true,
      pages: 12,
    });
    expect(h.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sourceKey: 'web_watch:acme.example',
        cadence: { kind: 'fixed', everyMs: 1234 },
        region: 'DE',
        status: 'ACTIVE',
      }),
    });
  });

  it('merges existing pages by URL and keeps the existing source identity', async () => {
    const h = registerHarness({
      prior: {
        id: 'source-old',
        config: { pages: [{ url: 'https://acme.example/products', kind: 'products' }, null, { nope: true }] },
      },
    });
    await expect(
      h.service.registerWatch('ws-1', 'co-1', {
        pages: [
          { url: 'https://acme.example/products', kind: 'generic' },
          { url: 'https://acme.example/news', kind: 'news' },
        ],
      }),
    ).resolves.toEqual({
      sourceId: 'source-old',
      sourceKey: 'web_watch:acme.example',
      created: false,
      pages: 2,
    });
    expect(h.update).toHaveBeenCalledWith({
      where: { id: 'source-old' },
      data: {
        config: {
          company: { name: 'Acme Pumps', domain: 'acme.example' },
          pages: [
            { url: 'https://acme.example/products', kind: 'generic' },
            { url: 'https://acme.example/news', kind: 'news' },
          ],
        },
      },
    });
  });

  it('uses the broker boundary for automatic sitemap discovery', async () => {
    const invoke = vi.fn(async (_tool: string, input: { url: string }) => ({
      data: {
        status: 200,
        ok: true,
        text: input.url.endsWith('/sitemap.xml')
          ? '<urlset><url><loc>https://acme.example/products/pumps</loc></url></urlset>'
          : '',
      },
    }));
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({ canonicalCompany: { findUnique: vi.fn(async () => ({ name: 'Acme', domain: 'acme.example', region: null })) } }),
      ),
      monitoredSource: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => ({ id: 'source-auto' })),
      },
    } as unknown as PrismaService;
    const brokerService = new IntentProjectionService({ prisma, broker: { invoke } as never });

    await expect(brokerService.registerWatch('ws-1', 'co-1')).resolves.toMatchObject({
      created: true,
      pages: 2,
    });
    expect(invoke).toHaveBeenCalledWith(
      'http.get',
      expect.objectContaining({ url: expect.stringContaining('acme.example') }),
      { workspaceId: 'platform', correlationId: 'register-watch' },
    );
  });
});

describe('intent projection edge cases and page discovery', () => {
  it('maps explicit and default detail fields without trusting malformed values', () => {
    expect(
      toIntentEvent({
        changeType: 'HIRING_UP',
        createdAt: new Date('2026-08-08T00:00:00.000Z'),
        detail: { strength: 'high', page_kind: 5, url: false, evidence: { delta: 2 } },
      }),
    ).toEqual({
      type: 'HIRING_UP',
      at: '2026-08-08T00:00:00.000Z',
      strength: 0.6,
      page_kind: undefined,
      page_url: undefined,
      evidence: { delta: 2 },
    });
    expect(
      toIntentEvent({ changeType: 'UNKNOWN', createdAt: new Date('2026-08-08T00:00:00.000Z'), detail: null }),
    ).toMatchObject({ strength: 0.3 });
  });

  it('discovers one shortest page per intent class, deduplicates, and survives fetch failure', async () => {
    const urls = [
      'https://acme.example/company/suppliers/register',
      'https://acme.example/supplier',
      'https://acme.example/company/careers/jobs',
      'https://acme.example/jobs',
      'https://acme.example/products/pumps',
      'https://acme.example/news/releases/one',
    ];
    const httpGet = vi.fn(async ({ url }: { url: string }) => ({
      status: 200,
      ok: true,
      text: url.endsWith('/sitemap.xml')
        ? `<urlset>${urls.map((value) => `<url><loc>${value}</loc></url>`).join('')}</urlset>`
        : '',
    }));

    await expect(discoverWatchPages('acme.example', httpGet)).resolves.toEqual([
      { url: 'https://acme.example/', kind: 'generic' },
      { url: 'https://acme.example/supplier', kind: 'sourcing' },
      { url: 'https://acme.example/jobs', kind: 'careers' },
      { url: 'https://acme.example/products/pumps', kind: 'products' },
      { url: 'https://acme.example/news/releases/one', kind: 'news' },
    ]);
    await expect(discoverWatchPages('acme.example', async () => Promise.reject(new Error('offline')))).resolves.toEqual([
      { url: 'https://acme.example/', kind: 'generic' },
    ]);
    await expect(discoverWatchPages('acme.example')).resolves.toHaveLength(1);
  });

  it('skips empty, malformed, missing, and suppressed projections without writes', async () => {
    const update = vi.fn();
    const evidenceCreate = vi.fn();
    const run = async (changes: unknown[], company: unknown) => {
      const tx = {
        canonicalCompany: { findUnique: vi.fn(async () => company), update },
        fieldEvidence: { create: evidenceCreate },
      };
      const prisma = {
        sourceEntityChange: { findMany: vi.fn(async () => changes) },
        withWorkspace: vi.fn(async (_workspaceId: string, fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
      } as unknown as PrismaService;
      return new IntentProjectionService({ prisma }).projectIntent('ws-1', { sinceMs: 1, limit: 3 });
    };

    await expect(run([], null)).resolves.toEqual({ companiesTouched: 0, eventsProjected: 0 });
    await expect(
      run([{ source: { config: { company: { name: 'No Domain' } } } }], null),
    ).resolves.toEqual({ companiesTouched: 0, eventsProjected: 0 });
    const change = {
      changeType: 'PAGE_CHANGED',
      createdAt: new Date('2026-08-08T00:00:00.000Z'),
      detail: {},
      source: { config: { company: { name: 'Acme', domain: 'acme.example' } } },
    };
    await expect(run([change], null)).resolves.toEqual({ companiesTouched: 0, eventsProjected: 0 });
    await expect(
      run([change], { id: 'co-1', status: 'SUPPRESSED', attributes: null }),
    ).resolves.toEqual({ companiesTouched: 0, eventsProjected: 0 });
    expect(update).not.toHaveBeenCalled();
    expect(evidenceCreate).not.toHaveBeenCalled();
  });
});
