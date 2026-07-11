import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { companyIdentity } from '../discovery/identity';
import { mergeIntent, type IntentAttr, type IntentEvent } from '../intent/intent-projection.service';
import { IntentRecomputeService, type ProjectionSurface } from './intent-recompute.service';

const WS = 'ws-1';
const DAY_MS = 86_400_000;
const now = Date.now();

/** 与增量投影同一过滤面（对抗复审 HIGH 回归锁的前提）。 */
const SURFACES: ProjectionSurface[] = [{ provider: 'ted', cpvCodes: ['42120000'], buyerCountries: ['DEU'] }];

interface Company {
  id: string;
  domain: string | null;
  dedupeKey: string;
  attributes: Record<string, unknown>;
  status: string;
  version: number;
}

interface Fixture {
  companies: Map<string, Company>;
  signals: Record<string, unknown>[];
  watchSources: Map<string, { id: string }>;
  watchChanges: { sourceId: string; changeType: string; createdAt: Date; detail: unknown }[];
}

function fakePrisma(f: Fixture): PrismaService {
  const tx = {
    canonicalCompany: {
      findUnique: async ({ where }: { where: { id: string } }) => f.companies.get(where.id) ?? null,
      findMany: async ({ where, take }: { where: { id?: { gt: string } }; take: number }) =>
        [...f.companies.values()]
          .filter((c) => (where.id?.gt ? c.id > where.id.gt : true))
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, take)
          .map((c) => ({ id: c.id })),
      update: async ({ where, data }: { where: { id: string }; data: { attributes: Record<string, unknown> } }) => {
        const c = f.companies.get(where.id)!;
        f.companies.set(where.id, { ...c, attributes: data.attributes, version: c.version + 1 });
        return { id: where.id };
      },
    },
  };
  return {
    withWorkspace: async (_ws: string, fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    sourceSignal: {
      findMany: async ({ where }: { where: { subjectKey: string; status: string } }) =>
        f.signals
          .filter((s) => s.subjectKey === where.subjectKey && s.status === where.status)
          .sort((a, b) => (b.occurredAt as Date).getTime() - (a.occurredAt as Date).getTime()),
    },
    monitoredSource: {
      findUnique: async ({ where }: { where: { sourceKey: string } }) => f.watchSources.get(where.sourceKey) ?? null,
    },
    sourceEntityChange: {
      findMany: async ({ where, take }: {
        where: { sourceId: string; changeType: { in: string[] }; createdAt: { gte: Date } };
        take: number;
      }) =>
        f.watchChanges
          .filter(
            (c) =>
              c.sourceId === where.sourceId &&
              where.changeType.in.includes(c.changeType) &&
              c.createdAt.getTime() >= where.createdAt.gte.getTime(),
          )
          .slice(0, take),
    },
  } as unknown as PrismaService;
}

const buyerKey = companyIdentity({ name: 'Stadt Musterstadt', country: 'DE' }).dedupeKey;

function tedSignalRow(over?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: 'sig-1',
    providerKey: 'ted',
    signalType: 'TENDER_PUBLISHED',
    externalId: 'N-100',
    subjectName: 'Stadt Musterstadt',
    subjectCountry: 'DE',
    subjectKey: buyerKey,
    taxonomyKeys: ['cpv:42122130'],
    strength: 0.9,
    occurredAt: new Date(now - 3 * DAY_MS),
    status: 'ACTIVE',
    payload: { cpv: ['42122130'], notice: 'N-100', source: 'ted' },
    ...over,
  };
}

/** 增量投影会写出的事件（同形——不动点测试依赖证据同构）。 */
function incrementalEvent(sig: Record<string, unknown>): IntentEvent {
  const payload = sig.payload as Record<string, unknown>;
  return {
    type: 'TENDER_PUBLISHED',
    at: (sig.occurredAt as Date).toISOString(),
    strength: 0.9,
    evidence: { cpv: payload.cpv, notice: payload.notice, source: 'ted' },
  };
}

function fixture(over?: Partial<Fixture>): Fixture {
  return {
    companies: new Map([
      ['co-1', { id: 'co-1', domain: null, dedupeKey: buyerKey, attributes: { ted_buyer: true }, status: 'NEW', version: 1 }],
    ]),
    signals: [tedSignalRow()],
    watchSources: new Map(),
    watchChanges: [],
    ...over,
  };
}

describe('IntentRecomputeService —— 收口⑤「信号可复算」（surfaces=与增量投影同过滤面）', () => {
  it('投影被清空后可从 ACTIVE 一等信号确定性重建（可复算核心断言）', async () => {
    const f = fixture();
    const svc = new IntentRecomputeService({ prisma: fakePrisma(f) });
    const r = await svc.recomputeCompany(WS, 'co-1', { surfaces: SURFACES });
    expect(r).toBe('rebuilt');
    const intent = f.companies.get('co-1')!.attributes.intent as IntentAttr;
    expect(intent.events).toHaveLength(1);
    expect(intent.events[0]).toMatchObject({
      type: 'TENDER_PUBLISHED',
      at: new Date(now - 3 * DAY_MS).toISOString(),
      strength: 0.9,
    });
  });

  it('信号全过期 → 陈旧 intent 被清除（过期收敛）；再复算幂等 unchanged', async () => {
    const f = fixture({ signals: [tedSignalRow({ status: 'EXPIRED' })] });
    f.companies.set('co-1', {
      ...f.companies.get('co-1')!,
      attributes: { ted_buyer: true, intent: { last_change_at: 'x', intent_score: 0.9, counts: {}, events: [], _ts: 'x' } },
    });
    const svc = new IntentRecomputeService({ prisma: fakePrisma(f) });
    expect(await svc.recomputeCompany(WS, 'co-1', { surfaces: SURFACES })).toBe('cleared');
    expect(f.companies.get('co-1')!.attributes.intent).toBeUndefined();
    expect(f.companies.get('co-1')!.attributes.ted_buyer).toBe(true); // 其余命名空间不动
    expect(await svc.recomputeCompany(WS, 'co-1', { surfaces: SURFACES })).toBe('unchanged');
  });

  it('重建结果与既有实质相同 → unchanged（不 bump version）', async () => {
    const f = fixture();
    const svc = new IntentRecomputeService({ prisma: fakePrisma(f) });
    await svc.recomputeCompany(WS, 'co-1', { surfaces: SURFACES });
    const version = f.companies.get('co-1')!.version;
    expect(await svc.recomputeCompany(WS, 'co-1', { surfaces: SURFACES })).toBe('unchanged');
    expect(f.companies.get('co-1')!.version).toBe(version);
  });

  it('同 provider 多**匹配**信号 → 全部成为事件（与增量逐 sweep 累积同构，弃 per-provider 取最新）', async () => {
    const f = fixture({
      signals: [
        tedSignalRow({ id: 's-old', externalId: 'N-old', occurredAt: new Date(now - 20 * DAY_MS), payload: { cpv: ['42122130'], notice: 'N-old', source: 'ted' } }),
        tedSignalRow({ id: 's-new', externalId: 'N-new', occurredAt: new Date(now - 2 * DAY_MS), payload: { cpv: ['42122130'], notice: 'N-new', source: 'ted' } }),
      ],
    });
    const svc = new IntentRecomputeService({ prisma: fakePrisma(f) });
    await svc.recomputeCompany(WS, 'co-1', { surfaces: SURFACES });
    const intent = f.companies.get('co-1')!.attributes.intent as IntentAttr;
    expect(intent.events).toHaveLength(2);
    expect(intent.events[0].at).toBe(new Date(now - 2 * DAY_MS).toISOString()); // 新近优先
  });

  it('🔒 HIGH 回归锁：跨 CPV/出面信号绝不注入；与增量投影有公共不动点（unchanged，不抖动）', async () => {
    const matching = tedSignalRow({ id: 's-match', externalId: 'N-match', occurredAt: new Date(now - 5 * DAY_MS), payload: { cpv: ['42122130'], notice: 'N-match', source: 'ted' } });
    const f = fixture({
      signals: [
        matching,
        // 更晚发生但**不在本 workspace 投影面内**的信号（他 ICP/他租户的建筑类招标；旧实现会取它注入 → 抖动）
        tedSignalRow({ id: 's-alien', externalId: 'N-alien', occurredAt: new Date(now - 1 * DAY_MS), taxonomyKeys: ['cpv:45000000'], payload: { cpv: ['45000000'], notice: 'N-alien', source: 'ted' } }),
        // 国别出面（FR 不在 buyerCountries=['DEU']）
        tedSignalRow({ id: 's-fr', externalId: 'N-fr', occurredAt: new Date(now - 1 * DAY_MS), subjectCountry: 'FR' }),
        // 出窗（40d > sinceDays 默认 30d）
        tedSignalRow({ id: 's-stale', externalId: 'N-stale', occurredAt: new Date(now - 40 * DAY_MS) }),
      ],
    });
    // prior = 增量投影的产物（只含匹配信号）
    f.companies.set('co-1', {
      ...f.companies.get('co-1')!,
      attributes: { ted_buyer: true, intent: mergeIntent(undefined, [incrementalEvent(matching)]) },
    });
    const svc = new IntentRecomputeService({ prisma: fakePrisma(f) });
    const version = f.companies.get('co-1')!.version;
    expect(await svc.recomputeCompany(WS, 'co-1', { surfaces: SURFACES })).toBe('unchanged'); // 不动点：不重写不抖
    expect(f.companies.get('co-1')!.version).toBe(version);
    const intent = f.companies.get('co-1')!.attributes.intent as IntentAttr;
    expect(intent.events.map((e) => (e.evidence as { notice: string }).notice)).toEqual(['N-match']); // 出面信号零注入
  });

  it('无 surfaces → TED/FDA 平台信号一律不注入（只重放 web_watch 租户轨）', async () => {
    const f = fixture();
    const svc = new IntentRecomputeService({ prisma: fakePrisma(f) });
    expect(await svc.recomputeCompany(WS, 'co-1')).toBe('unchanged'); // 无面无 web_watch → 无事件、原本也无 intent
    expect(f.companies.get('co-1')!.attributes.intent).toBeUndefined();
  });

  it('§6 防御纵深：openfda 信号主体为个体户自然人 → 复算不注入（同投影层）', async () => {
    const personKey = companyIdentity({ name: 'Smith, John', country: 'US' }).dedupeKey;
    const f = fixture({
      companies: new Map([
        ['co-1', { id: 'co-1', domain: null, dedupeKey: personKey, attributes: {}, status: 'NEW', version: 1 }],
      ]),
      signals: [
        tedSignalRow({
          id: 's-fda', providerKey: 'openfda', signalType: 'FDA_CLEARANCE', externalId: 'K1',
          subjectName: 'Smith, John', subjectCountry: 'US', subjectKey: personKey,
          taxonomyKeys: ['fda:QAS'], strength: 0.85, payload: { product_code: 'QAS', k_number: 'K1', source: 'openfda' },
        }),
      ],
    });
    const svc = new IntentRecomputeService({ prisma: fakePrisma(f) });
    expect(
      await svc.recomputeCompany(WS, 'co-1', { surfaces: [{ provider: 'openfda', productCodes: ['QAS'] }] }),
    ).toBe('unchanged');
    expect(f.companies.get('co-1')!.attributes.intent).toBeUndefined();
  });

  it('web_watch 租户轨事实按保留期重放（域名定位监控源）', async () => {
    const f = fixture({
      companies: new Map([
        ['co-1', { id: 'co-1', domain: 'example.de', dedupeKey: buyerKey, attributes: {}, status: 'NEW', version: 1 }],
      ]),
      signals: [],
      watchSources: new Map([['web_watch:example.de', { id: 'src-1' }]]),
      watchChanges: [
        { sourceId: 'src-1', changeType: 'SOURCING_OPENED', createdAt: new Date(now - 5 * DAY_MS), detail: { strength: 1, page_kind: 'sourcing', url: 'https://example.de/suppliers' } },
        { sourceId: 'src-1', changeType: 'HIRING_UP', createdAt: new Date(now - 120 * DAY_MS), detail: { strength: 0.6 } }, // 超重放窗 → 不进
      ],
    });
    const svc = new IntentRecomputeService({ prisma: fakePrisma(f) });
    expect(await svc.recomputeCompany(WS, 'co-1')).toBe('rebuilt');
    const intent = f.companies.get('co-1')!.attributes.intent as IntentAttr;
    expect(intent.events).toHaveLength(1);
    expect(intent.events[0].type).toBe('SOURCING_OPENED');
  });

  it('recomputeWorkspace：id 游标分页（limit 页满给 nextCursor，扫完为 null）', async () => {
    const mk = (id: string): [string, Company] => [id, { id, domain: null, dedupeKey: `k-${id}`, attributes: {}, status: 'NEW', version: 1 }];
    const f = fixture({ companies: new Map([mk('co-1'), mk('co-2'), mk('co-3')]), signals: [] });
    const svc = new IntentRecomputeService({ prisma: fakePrisma(f) });
    const p1 = await svc.recomputeWorkspace(WS, { limit: 2, surfaces: SURFACES });
    expect(p1.companiesScanned).toBe(2);
    expect(p1.nextCursor).toBe('co-2');
    const p2 = await svc.recomputeWorkspace(WS, { limit: 2, cursor: p1.nextCursor!, surfaces: SURFACES });
    expect(p2.companiesScanned).toBe(1);
    expect(p2.nextCursor).toBeNull();
  });
});
