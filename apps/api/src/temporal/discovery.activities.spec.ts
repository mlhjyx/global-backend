import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDiscoveryActivities } from './discovery.activities';
import { resolveRunStatus } from './discovery.run-status';
import { budgetLedger } from '../tools/budget';
import type {
  CompanyDiscoveryAdapter,
  EnrichmentResult,
  ExecutionContext,
  ProviderCompanyRecord,
} from '../discovery/provider-contract';

/**
 * executeQuery 预算截断透传单测（Codex PR #51 P1，根治版）：fan-out 中某源打穿 run 预算时，**真实 provider
 * 的 fail-safe catch 会把 BudgetExceededError 吞成空结果**（对源失败是对的）——所以 executeQuery 不能靠
 * 「某源 reject」判断，必须靠 BudgetLedger.wasExhausted 检出，据此返回 budgetTruncated 让 workflow 判 PARTIAL
 * 而非 DONE。本测用一个「reserve 打穿 → 自己吞掉」的假 adapter 复刻生产形态（而非直接抛错的合成 mock）。
 */

const REC: ProviderCompanyRecord = {
  externalId: 'acme.de',
  name: 'Acme',
  domain: 'acme.de',
  attributes: {},
  provenance: { sourceUrl: 'https://acme.de/', fetchedAt: '2026-07-11T00:00:00.000Z', contentHash: 'h', parserVersion: 'v1' },
};

/** 模拟真实 provider：broker/gateway 的 reserve 打穿预算 → provider 自己 fail-safe 吞成空结果（不透传）。 */
function budgetSwallowingAdapter(key: string): CompanyDiscoveryAdapter {
  return {
    key,
    classes: ['public_intelligence'],
    discoverCompanies: async (_q: unknown, ctx: ExecutionContext) => {
      try {
        budgetLedger.reserve(ctx.runId ?? ctx.workspaceId, 10_000_000); // 远超 cap → 打穿
      } catch {
        /* 如真实 provider：fail-safe catch 吞掉 BudgetExceededError */
      }
      return { records: [], costCents: 0 };
    },
  } as unknown as CompanyDiscoveryAdapter;
}

function okAdapter(key: string, records: ProviderCompanyRecord[]): CompanyDiscoveryAdapter {
  return {
    key,
    classes: ['public_intelligence'],
    discoverCompanies: async () => ({ records, costCents: 0 }),
  } as unknown as CompanyDiscoveryAdapter;
}

function makeDeps(adapters: CompanyDiscoveryAdapter[]) {
  const tx = {
    rawSourceRecord: { createMany: async ({ data }: { data: unknown[] }) => ({ count: data.length }) },
    usageLedger: { create: async () => ({}) },
  };
  const prisma = {
    sourcePolicy: { findMany: async () => [] as { domain: string }[] },
    withWorkspace: async <T>(_ws: string, fn: (tx: unknown) => Promise<T>): Promise<T> => fn(tx),
  };
  const providers = { routeCompanyDiscovery: async () => adapters };
  return { prisma, providers, gateway: {} } as unknown as Parameters<typeof createDiscoveryActivities>[0];
}

const QUERY = { source_class: 'public_intelligence', filters: {}, keywords: [], priority: 1 };

// executeQuery/enrichRun 不 close run 预算账户（finalizeRun 才 close）→ 测试自行 force-close，清打标防单例泄漏。
afterEach(() => {
  for (const k of ['run-budget-x', 'run-ok-x', 'run-enrich-x', 'run-enrich-ok', 'run-signal-x', 'run-leak']) {
    budgetLedger.close(k, { force: true });
  }
});

/** 模拟真实富集源：enrichCompany 里 broker/gateway 的 reserve 打穿预算 → enrichRun 的 catch 吞掉。 */
const budgetSwallowingEnricher = {
  key: 'gleif',
  enrichCompany: async (_c: unknown, ctx: ExecutionContext) => {
    budgetLedger.reserve(ctx.runId ?? ctx.workspaceId, 10_000_000); // 抛 → enrichRun catch 吞掉（fail-safe）
    return { matched: false } as EnrichmentResult;
  },
};

function makeEnrichDeps(enrichers: unknown[]) {
  const tx = {
    $queryRaw: async () => [{ locked: true }],
    rawSourceRecord: { findMany: async () => [{ id: 'raw1' }] },
    identityLink: { findMany: async () => [{ canonicalId: 'c1' }] },
    canonicalCompany: {
      findMany: async () => [{ id: 'c1', name: 'C1', domain: 'c1.de', country: 'DE', region: null, attributes: {} }],
      updateMany: async () => ({ count: 1 }),
      update: async () => ({}),
      findUnique: async () => ({ id: 'c1', name: 'C1', domain: 'c1.de', status: 'NEW' }),
    },
    suppressionRecord: { findMany: async () => [] },
    fieldEvidence: { create: async () => ({}) },
  };
  const prisma = {
    sourcePolicy: { findMany: async () => [] as { domain: string }[] },
    withWorkspace: async <T>(_ws: string, fn: (tx: unknown) => Promise<T>): Promise<T> => fn(tx),
  };
  const providers = { routeEnrichment: async () => enrichers, routeSignalEnrichment: async () => enrichers };
  return { prisma, providers, gateway: {} } as unknown as Parameters<typeof createDiscoveryActivities>[0];
}

describe('executeQuery —— 预算截断显性上报（不假 DONE），靠 ledger 而非源抛错', () => {
  it('某源打穿 run 预算并被 fail-safe 吞掉 → wasExhausted 检出 budgetTruncated=true，其余源记录仍落库', async () => {
    const deps = makeDeps([budgetSwallowingAdapter('public_web'), okAdapter('wikidata', [REC])]);
    const acts = createDiscoveryActivities(deps);
    const r = await acts.executeQuery({ workspaceId: 'ws-1', runId: 'run-budget-x', query: QUERY });
    expect(r.budgetTruncated).toBe(true);
    expect(r.rawCount).toBe(1); // wikidata 的记录不因 public_web 打穿而丢失
  });

  it('全部源正常 → budgetTruncated=false，记录照常落库', async () => {
    const deps = makeDeps([okAdapter('wikidata', [REC])]);
    const acts = createDiscoveryActivities(deps);
    const r = await acts.executeQuery({ workspaceId: 'ws-1', runId: 'run-ok-x', query: QUERY });
    expect(r.budgetTruncated).toBe(false);
    expect(r.rawCount).toBe(1);
  });

  it('按 source_hint 收窄源，注入 taxonomy 规范码，去重 raw 并记录实际成本', async () => {
    const createMany = vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
    const createUsage = vi.fn(async () => ({}));
    const discover = vi.fn(async (query: { filters: Record<string, unknown> }, _ctx: unknown, policy: unknown) => ({
      records: [REC, REC, { ...REC, externalId: undefined, name: 'No id' }, { ...REC, externalId: undefined, name: 'No id' }],
      costCents: 25,
      query,
      policy,
    }));
    const ignored = vi.fn();
    const tx = {
      rawSourceRecord: { createMany },
      usageLedger: { create: createUsage },
    };
    const prisma = {
      sourcePolicy: { findMany: vi.fn(async () => [{ domain: 'blocked.example' }]) },
      withWorkspace: async <T>(_ws: string, fn: (client: typeof tx) => Promise<T>): Promise<T> => fn(tx),
    };
    const taxonomy = {
      resolveMany: vi.fn(async () => [
        { code: 'C28', wikidataQid: 'Q190117', osmTags: [{ k: 'industrial', v: 'machine_shop' }] },
      ]),
      resolve: vi.fn(async () => ({ code: 'DE', wikidataQid: 'Q183' })),
    };
    const providers = {
      routeCompanyDiscovery: vi.fn(async () => [
        { key: 'wikidata', discoverCompanies: discover },
        { key: 'public_web', discoverCompanies: ignored },
      ]),
    };
    const acts = createDiscoveryActivities({ prisma, providers, taxonomy, gateway: {} } as never);

    const result = await acts.executeQuery({
      workspaceId: 'ws-1',
      runId: 'run-ok-x',
      query: {
        source_class: 'public_intelligence',
        filters: { source_hint: 'wiki', industry: 'Maschinenbau', country: 'Deutschland' },
        keywords: ['pump'],
        priority: 1,
      },
    });

    expect(ignored).not.toHaveBeenCalled();
    expect(discover).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 25,
        filters: expect.objectContaining({
          _industryQids: ['Q190117'],
          _industryCodes: ['C28'],
          _countryQid: 'Q183',
          _countryCode: 'DE',
        }),
      }),
      expect.objectContaining({ workspaceId: 'ws-1', runId: 'run-ok-x' }),
      { blockedDomains: ['blocked.example'] },
    );
    expect(createMany.mock.calls[0]?.[0].data).toHaveLength(2);
    expect(createUsage).toHaveBeenCalledWith({
      data: expect.objectContaining({ quantity: 2, costUsd: 0.25, meta: expect.objectContaining({ providers: ['wikidata'] }) }),
    });
    expect(result).toEqual({
      rawCount: 2,
      costCents: 25,
      provider: 'wikidata',
      budgetTruncated: false,
    });
  });

  it('source_hint 过滤掉全部适配器时不打开预算也不写 raw', async () => {
    const deps = makeDeps([okAdapter('wikidata', [REC])]);
    const result = await createDiscoveryActivities(deps).executeQuery({
      workspaceId: 'ws-1',
      runId: 'run-ok-x',
      query: { ...QUERY, filters: { source_hint: 'not-registered' } },
    });
    expect(result).toEqual({ rawCount: 0, costCents: 0, provider: null, budgetTruncated: false });
  });
});

describe('loadPlanQueries / finalizeRun —— 计划状态与收口事件', () => {
  it('仅接受 READY/EXECUTED，并以缺省优先级 99 稳定排序', async () => {
    const queries = [
      { ...QUERY, priority: 3 },
      { ...QUERY, priority: 1 },
      { ...QUERY, priority: undefined },
    ];
    const plan = { status: 'READY', queries };
    const tx = { discoveryQueryPlan: { findUnique: vi.fn(async () => plan) } };
    const prisma = { withWorkspace: async <T>(_ws: string, fn: (client: typeof tx) => Promise<T>) => fn(tx) };
    const acts = createDiscoveryActivities({ prisma, providers: {}, gateway: {} } as never);

    await expect(acts.loadPlanQueries({ workspaceId: 'ws-1', planId: 'plan-1' })).resolves.toEqual({
      queries: [queries[1], queries[0], queries[2]],
    });
    plan.status = 'DRAFT';
    await expect(acts.loadPlanQueries({ workspaceId: 'ws-1', planId: 'plan-1' })).rejects.toThrow(
      'must be READY',
    );
    tx.discoveryQueryPlan.findUnique.mockResolvedValueOnce(null as never);
    await expect(acts.loadPlanQueries({ workspaceId: 'ws-1', planId: 'missing' })).rejects.toThrow('not found');
  });

  it('DONE 更新计划并发出完成与评分事件；FAILED 只发完成事件', async () => {
    const runUpdate = vi.fn(async () => ({}));
    const planUpdate = vi.fn(async () => ({}));
    const eventCreate = vi.fn(async () => ({}));
    const tx = {
      discoveryRun: { update: runUpdate },
      discoveryQueryPlan: { update: planUpdate },
      outboxEvent: { create: eventCreate },
    };
    const prisma = { withWorkspace: async <T>(_ws: string, fn: (client: typeof tx) => Promise<T>) => fn(tx) };
    const acts = createDiscoveryActivities({ prisma, providers: {}, gateway: {} } as never);

    await acts.finalizeRun({
      workspaceId: 'ws-1',
      runId: 'run-ok-x',
      planId: 'plan-1',
      icpId: 'icp-1',
      status: 'DONE',
      stats: { raw: 2 },
    });
    expect(planUpdate).toHaveBeenCalledOnce();
    expect(eventCreate).toHaveBeenCalledTimes(2);
    expect(eventCreate.mock.calls[1]?.[0]).toEqual({
      data: expect.objectContaining({ eventType: 'QualifyRequested', aggregateId: 'icp-1' }),
    });

    planUpdate.mockClear();
    eventCreate.mockClear();
    await acts.finalizeRun({
      workspaceId: 'ws-1',
      runId: 'run-ok-x',
      planId: 'plan-1',
      icpId: 'icp-1',
      status: 'FAILED',
      stats: { failures: 1 },
    });
    expect(planUpdate).not.toHaveBeenCalled();
    expect(eventCreate).toHaveBeenCalledTimes(1);
    expect(eventCreate.mock.calls[0]?.[0]).toEqual({
      data: expect.objectContaining({ eventType: 'DiscoveryRunCompleted' }),
    });
  });
});

describe('canonicalizeRun —— suppression authority 线性化', () => {
  it('在读 suppression 和任何 canonical write 前先取 workspace policy lock', async () => {
    const order: string[] = [];
    const tx = {
      $queryRaw: async () => {
        order.push('lock');
        return [{ pg_advisory_xact_lock: null }];
      },
      rawSourceRecord: {
        findMany: async () => [
          {
            id: 'raw-1',
            providerKey: 'wikidata',
            payload: { name: 'Acme GmbH', domain: 'acme.de', country: 'DE' },
          },
        ],
      },
      suppressionRecord: {
        findMany: async () => {
          order.push('suppression-read');
          return [];
        },
      },
      canonicalCompany: {
        findUnique: async () => null,
        updateMany: async () => ({ count: 0 }),
        upsert: async () => {
          order.push('canonical-write');
          return { id: 'company-1' };
        },
      },
      identityLink: {
        findFirst: async () => ({ id: 'existing-link' }),
        create: async () => ({}),
      },
      fieldEvidence: { create: async () => ({}) },
    };
    const prisma = {
      withWorkspace: async <T>(
        _workspaceId: string,
        callback: (client: typeof tx) => Promise<T>,
      ): Promise<T> => callback(tx),
    };
    const activities = createDiscoveryActivities({
      prisma,
      providers: {},
      gateway: {},
    } as never);

    await activities.canonicalizeRun({ workspaceId: 'ws-1', runId: 'run-1' });

    expect(order).toEqual(['lock', 'suppression-read', 'canonical-write']);
  });

  it('既有 canonical identity 命中 suppression 时只修复状态，不再链接或写 evidence', async () => {
    const upsert = vi.fn();
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const linkCreate = vi.fn();
    const evidenceCreate = vi.fn();
    const tx = {
      $queryRaw: async () => [{ pg_advisory_xact_lock: null }],
      rawSourceRecord: {
        findMany: async () => [
          {
            id: 'raw-1',
            providerKey: 'wikidata',
            payload: { name: 'Source Listing Name', country: 'DE' },
          },
        ],
      },
      suppressionRecord: {
        findMany: async () => [{ type: 'domain', value: 'blocked.example' }],
      },
      canonicalCompany: {
        findUnique: async () => ({
          id: 'company-1',
          name: 'Existing Legal Entity GmbH',
          domain: 'blocked.example',
          attributes: {},
          status: 'NEW',
        }),
        updateMany,
        upsert,
      },
      identityLink: { findFirst: vi.fn(), create: linkCreate },
      fieldEvidence: { create: evidenceCreate },
    };
    const prisma = {
      withWorkspace: async <T>(_workspaceId: string, callback: (client: typeof tx) => Promise<T>): Promise<T> =>
        callback(tx),
    };
    const activities = createDiscoveryActivities({ prisma, providers: {}, gateway: {} } as never);

    await expect(activities.canonicalizeRun({ workspaceId: 'ws-1', runId: 'run-1' })).resolves.toEqual({
      companies: 0,
      suppressed: 1,
    });
    expect(updateMany).toHaveBeenCalledOnce();
    expect(upsert).not.toHaveBeenCalled();
    expect(linkCreate).not.toHaveBeenCalled();
    expect(evidenceCreate).not.toHaveBeenCalled();
  });

  it('规范化完整 raw 记录、拦截 exact suppression，并一次写入字段 evidence', async () => {
    const evidence: unknown[] = [];
    const links: unknown[] = [];
    const upserts: unknown[] = [];
    const raws = [
      { id: 'raw-skip', providerKey: 'directory', fetchedAt: null, payload: {} },
      {
        id: 'raw-1',
        providerKey: 'ted',
        fetchedAt: new Date('2026-08-08T00:00:00.000Z'),
        payload: {
          name: 'Acme Pumps',
          legalName: 'Acme Pumpen GmbH',
          domain: 'acme.example',
          country: 'DE',
          region: 'EU',
          industry: 'pumps',
          employeeCount: 10,
          revenueUsd: 100,
          attributes: { products: ['pump'] },
          identifier: { scheme: 'vat', value: 'DE123' },
          sharedGroupAmbiguity: true,
          license: 'CC-BY-4.0',
        },
      },
      {
        id: 'raw-suppressed',
        providerKey: 'directory',
        fetchedAt: null,
        payload: { name: 'Suppressed Corp', country: 'DE' },
      },
    ];
    const tx = {
      $queryRaw: async () => [{ locked: true }],
      rawSourceRecord: { findMany: async () => raws },
      suppressionRecord: { findMany: async () => [{ type: 'company_name', value: 'Suppressed Corp' }] },
      canonicalCompany: {
        findUnique: async () => null,
        updateMany: async () => ({ count: 0 }),
        upsert: async (input: unknown) => {
          upserts.push(input);
          return { id: 'co-1' };
        },
      },
      identityLink: {
        findFirst: async () => null,
        create: async (input: unknown) => links.push(input),
      },
      fieldEvidence: { create: async (input: unknown) => evidence.push(input) },
    };
    const deps = {
      prisma: { withWorkspace: async <T>(_ws: string, fn: (client: typeof tx) => Promise<T>) => fn(tx) },
      providers: {},
      gateway: {},
    } as unknown as Parameters<typeof createDiscoveryActivities>[0];

    await expect(
      createDiscoveryActivities(deps).canonicalizeRun({ workspaceId: 'ws', runId: 'run' }),
    ).resolves.toEqual({ companies: 1, suppressed: 1 });
    expect(upserts).toHaveLength(1);
    expect(links).toHaveLength(1);
    expect(evidence.length).toBeGreaterThan(5);
    expect(JSON.stringify(upserts[0])).toContain('"status":"NEW"');
    expect(JSON.stringify(evidence)).toContain('"allowedActions":["display","match"]');
  });

  it('已有 raw identity link 时不重复写 link 或 evidence', async () => {
    const evidence: unknown[] = [];
    const linkCreate = vi.fn();
    const tx = {
      $queryRaw: async () => [{ locked: true }],
      rawSourceRecord: {
        findMany: async () => [
          { id: 'raw-1', providerKey: 'directory', fetchedAt: null, payload: { name: 'Acme', domain: 'acme.example' } },
        ],
      },
      suppressionRecord: { findMany: async () => [] },
      canonicalCompany: {
        findUnique: async () => null,
        updateMany: async () => ({ count: 0 }),
        upsert: async () => ({ id: 'co-1' }),
      },
      identityLink: { findFirst: async () => ({ id: 'link-1' }), create: linkCreate },
      fieldEvidence: { create: async (input: unknown) => evidence.push(input) },
    };
    const deps = {
      prisma: { withWorkspace: async <T>(_ws: string, fn: (client: typeof tx) => Promise<T>) => fn(tx) },
      providers: {},
      gateway: {},
    } as unknown as Parameters<typeof createDiscoveryActivities>[0];
    await expect(
      createDiscoveryActivities(deps).canonicalizeRun({ workspaceId: 'ws', runId: 'run' }),
    ).resolves.toMatchObject({ companies: 1 });
    expect(linkCreate).not.toHaveBeenCalled();
    expect(evidence).toEqual([]);
  });
});

describe('enrichRun / resetRunBudget —— 富集阶段截断也上报 + 崩溃重试清账', () => {
  it('富集源打穿 run 预算并被 fail-safe 吞掉 → enrichRun.budgetTruncated=true（不假 DONE）', async () => {
    const deps = makeEnrichDeps([budgetSwallowingEnricher]);
    const acts = createDiscoveryActivities(deps);
    const r = await acts.enrichRun({ workspaceId: 'ws-1', runId: 'run-enrich-x', icpId: 'icp-1' });
    expect(r.budgetTruncated).toBe(true);
  });

  it('富集正常 → enrichRun.budgetTruncated=false', async () => {
    const deps = makeEnrichDeps([{ key: 'gleif', enrichCompany: async () => ({ matched: false }) }]);
    const acts = createDiscoveryActivities(deps);
    const r = await acts.enrichRun({ workspaceId: 'ws-1', runId: 'run-enrich-ok', icpId: 'icp-1' });
    expect(r.budgetTruncated).toBe(false);
  });

  it('信号富集源打穿 run 预算并被 fail-safe 吞掉 → enrichSignalsRun.budgetTruncated=true（与 enrichRun 对称）', async () => {
    const deps = makeEnrichDeps([budgetSwallowingEnricher]);
    const acts = createDiscoveryActivities(deps);
    const r = await acts.enrichSignalsRun({ workspaceId: 'ws-1', runId: 'run-signal-x', icpId: 'icp-1' });
    expect(r.budgetTruncated).toBe(true);
  });

  it('resetRunBudget 清除同 runId 残留的打穿标记（崩溃重试防误报截断）', async () => {
    const acts = createDiscoveryActivities(makeEnrichDeps([]));
    budgetLedger.open('run-leak', 10);
    try {
      budgetLedger.reserve('run-leak', 999);
    } catch {
      /* expected：打穿即打标 */
    }
    expect(budgetLedger.wasExhausted('run-leak')).toBe(true);
    await acts.resetRunBudget({ runId: 'run-leak' });
    expect(budgetLedger.wasExhausted('run-leak')).toBe(false);
  });

  it('合并互补富集、跳过已有 namespace，并且不为 null 属性写 evidence', async () => {
    const updates: unknown[] = [];
    const evidence: unknown[] = [];
    const calls: string[] = [];
    const companies = [
      {
        id: 'co-1',
        name: 'Existing',
        domain: 'existing.example',
        country: 'DE',
        region: 'EU',
        attributes: { gleif: { lei: 'LEI' } },
        status: 'NEW',
      },
      {
        id: 'co-2',
        name: 'New',
        domain: null,
        country: null,
        region: null,
        attributes: null,
        status: 'NEW',
      },
    ];
    const tx = {
      $queryRaw: async () => [{ locked: true }],
      rawSourceRecord: { findMany: async () => [{ id: 'raw-1' }] },
      identityLink: { findMany: async () => companies.map((company) => ({ canonicalId: company.id })) },
      suppressionRecord: { findMany: async () => [] },
      canonicalCompany: {
        findMany: async () => companies,
        findUnique: async ({ where }: { where: { id: string } }) => companies.find((company) => company.id === where.id),
        updateMany: async (input: unknown) => {
          updates.push(input);
          return { count: 1 };
        },
      },
      fieldEvidence: { create: async (input: unknown) => evidence.push(input) },
    };
    const enrichers = [
      {
        key: 'gleif',
        enrichCompany: async (company: { name: string }) => {
          calls.push(`gleif:${company.name}`);
          return { matched: false };
        },
      },
      {
        key: 'wikidata',
        enrichCompany: async (company: { name: string }) => {
          calls.push(`wikidata:${company.name}`);
          return {
            matched: true,
            confidence: 0.9,
            attributes: { industry: 'pumps', absent: null },
            provenance: { fetchedAt: '2026-08-08T00:00:00.000Z' },
          };
        },
      },
      { key: 'broken', enrichCompany: async () => Promise.reject(new Error('provider down')) },
    ];
    const deps = {
      prisma: {
        sourcePolicy: { findMany: async () => [] },
        withWorkspace: async <T>(_ws: string, fn: (client: typeof tx) => Promise<T>) => fn(tx),
      },
      providers: { routeEnrichment: async () => enrichers },
      gateway: {},
    } as unknown as Parameters<typeof createDiscoveryActivities>[0];

    const result = await createDiscoveryActivities(deps).enrichRun({
      workspaceId: 'ws',
      runId: 'run-enrich-hit',
      icpId: 'icp',
    });
    expect(result).toMatchObject({ enriched: 2, matched: 2, provider: 'wikidata', budgetTruncated: false });
    expect(calls).not.toContain('gleif:Existing');
    expect(calls).toContain('gleif:New');
    expect(updates).toHaveLength(2);
    expect(evidence).toHaveLength(2);
    budgetLedger.close('run-enrich-hit', { force: true });
  });

  it('信号富集遵守 suspension 与 TTL，只提交过期且命中的 namespace', async () => {
    const updates: unknown[] = [];
    const evidence: unknown[] = [];
    const calls: string[] = [];
    const companies = [
      { id: 'blocked', name: 'Blocked', domain: 'blocked.example', country: 'DE', region: null, attributes: {}, status: 'NEW' },
      { id: 'fresh', name: 'Fresh', domain: 'fresh.example', country: 'DE', region: null, attributes: { signal: { _ts: new Date().toISOString() } }, status: 'NEW' },
      { id: 'stale', name: 'Stale', domain: 'stale.example', country: null, region: null, attributes: { signal: { _ts: '2020-01-01T00:00:00.000Z' } }, status: 'NEW' },
    ];
    const tx = {
      $queryRaw: async () => [{ locked: true }],
      rawSourceRecord: { findMany: async () => [{ id: 'raw-1' }] },
      identityLink: { findMany: async () => companies.map((company) => ({ canonicalId: company.id })) },
      suppressionRecord: { findMany: async () => [] },
      canonicalCompany: {
        findMany: async () => companies,
        findUnique: async ({ where }: { where: { id: string } }) => companies.find((company) => company.id === where.id),
        updateMany: async (input: unknown) => {
          updates.push(input);
          return { count: 1 };
        },
      },
      fieldEvidence: { create: async (input: unknown) => evidence.push(input) },
    };
    const deps = {
      prisma: {
        sourcePolicy: { findMany: async () => [{ domain: 'BLOCKED.EXAMPLE' }] },
        withWorkspace: async <T>(_ws: string, fn: (client: typeof tx) => Promise<T>) => fn(tx),
      },
      providers: {
        routeSignalEnrichment: async () => [
          {
            key: 'signal',
            enrichCompany: async (company: { name: string }) => {
              calls.push(company.name);
              return { matched: true, confidence: 1, attributes: { hiring: 2, empty: null } };
            },
          },
          { key: 'broken', enrichCompany: async () => Promise.reject(new Error('down')) },
        ],
      },
      gateway: {},
    } as unknown as Parameters<typeof createDiscoveryActivities>[0];

    const result = await createDiscoveryActivities(deps).enrichSignalsRun({
      workspaceId: 'ws',
      runId: 'run-signal-hit',
      icpId: 'icp',
    });
    expect(result).toMatchObject({ enriched: 2, matched: 1, provider: 'signal', budgetTruncated: false });
    expect(calls).toEqual(['Stale']);
    expect(updates).toHaveLength(1);
    expect(evidence).toHaveLength(1);
    budgetLedger.close('run-signal-hit', { force: true });
  });
});

describe('resolveRunStatus —— 预算截断绝不判 DONE', () => {
  it('无失败无截断 → DONE', () => {
    expect(resolveRunStatus({ failures: 0, totalQueries: 3, budgetTruncated: false })).toBe('DONE');
  });
  it('预算截断（即使零失败）→ PARTIAL', () => {
    expect(resolveRunStatus({ failures: 0, totalQueries: 3, budgetTruncated: true })).toBe('PARTIAL');
  });
  it('部分源失败 → PARTIAL', () => {
    expect(resolveRunStatus({ failures: 1, totalQueries: 3, budgetTruncated: false })).toBe('PARTIAL');
  });
  it('全部源失败 → FAILED', () => {
    expect(resolveRunStatus({ failures: 3, totalQueries: 3, budgetTruncated: false })).toBe('FAILED');
  });
});

/**
 * P1-1 kill-switch（Codex PR #93）：专利缓存冷启动 enqueue 必须受 data_provider.google_patents ENABLED 门控。
 * seed=DISABLED（未签 LIA/DPIA）时绝不 enqueue——不污染刷新队列（PII 物化的真正闸在 refreshPatentCache）。
 */
describe('enqueuePatentLookupsForRun · P1-1 kill-switch', () => {
  it('provider DISABLED → 不 enqueue（candidates:0, enqueued:0），且绝不查公司表', async () => {
    const prisma = {
      dataProvider: { findUnique: async () => ({ status: 'DISABLED' }) },
      withWorkspace: async () => {
        throw new Error('DISABLED 时绝不应查公司表');
      },
    };
    const deps = { prisma, providers: {}, gateway: {} } as unknown as Parameters<typeof createDiscoveryActivities>[0];
    const acts = createDiscoveryActivities(deps);
    const res = await acts.enqueuePatentLookupsForRun({ workspaceId: 'ws', runId: 'run', icpId: 'icp' });
    expect(res).toEqual({ candidates: 0, enqueued: 0 });
  });

  it('provider ENABLED → 正常 enqueue 本 run fit=match 公司', async () => {
    const upserts: unknown[] = [];
    const tx = {
      rawSourceRecord: { findMany: async () => [{ id: 'raw1' }] },
      identityLink: { findMany: async () => [{ canonicalId: 'c1' }] },
      canonicalCompany: { findMany: async () => [{ name: 'Acme GmbH', country: 'DE' }] },
    };
    const prisma = {
      dataProvider: { findUnique: async () => ({ status: 'ENABLED' }) },
      withWorkspace: async <T>(_ws: string, fn: (tx: unknown) => Promise<T>): Promise<T> => fn(tx),
      patentLookupRequest: { upsert: async ({ create }: { create: unknown }) => { upserts.push(create); return {}; } },
    };
    const deps = { prisma, providers: {}, gateway: {} } as unknown as Parameters<typeof createDiscoveryActivities>[0];
    const acts = createDiscoveryActivities(deps);
    const res = await acts.enqueuePatentLookupsForRun({ workspaceId: 'ws', runId: 'run', icpId: 'icp' });
    expect(res).toEqual({ candidates: 1, enqueued: 1 });
    expect(upserts).toHaveLength(1);
  });
});

describe('registerWatchesForRun —— domain eligibility 与 best-effort registration', () => {
  it('只注册带域名且未存在的 watch，单家公司失败不阻断本批', async () => {
    const created: unknown[] = [];
    const tx = {
      $queryRaw: async () => [{ locked: true }],
      rawSourceRecord: { findMany: async () => [{ id: 'raw-1' }] },
      identityLink: { findMany: async () => [{ canonicalId: 'co-1' }, { canonicalId: 'co-2' }] },
      canonicalCompany: {
        findMany: async () => [{ id: 'co-1' }, { id: 'co-2' }],
        findUnique: async ({ where }: { where: { id: string } }) =>
          where.id === 'co-1'
            ? { id: 'co-1', name: 'Acme', domain: 'acme.example', region: 'DE', status: 'NEW' }
            : { id: 'co-2', name: 'No Domain', domain: null, region: null, status: 'NEW' },
      },
      suppressionRecord: { findMany: async () => [] },
    };
    const deps = {
      prisma: {
        withWorkspace: async <T>(_ws: string, fn: (client: typeof tx) => Promise<T>) => fn(tx),
        monitoredSource: {
          findUnique: async () => null,
          create: async (input: unknown) => {
            created.push(input);
            return { id: 'watch-1' };
          },
        },
      },
      providers: {},
      gateway: {},
    } as unknown as Parameters<typeof createDiscoveryActivities>[0];
    await expect(
      createDiscoveryActivities(deps).registerWatchesForRun({ workspaceId: 'ws', runId: 'run', icpId: 'icp' }),
    ).resolves.toEqual({ candidates: 2, registered: 1 });
    expect(created).toHaveLength(1);
  });
});
