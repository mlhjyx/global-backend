import { afterEach, describe, expect, it } from 'vitest';
import { createDiscoveryActivities } from './discovery.activities';
import { resolveRunStatus } from './discovery.run-status';
import { budgetLedger } from '../tools/budget';
import {
  AcquisitionBudgetError,
  InMemoryAcquisitionBudgetLedger,
  acquisitionBudgetDigest,
} from '../tools/acquisition-budget-ledger';
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
  for (const k of [
    'run-budget-x',
    'run-ok-x',
    'run-enrich-x',
    'run-enrich-ok',
    'run-signal-x',
    'run-leak',
    '22222222-2222-4222-8222-222222222222',
  ]) {
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
    rawSourceRecord: { findMany: async () => [{ id: 'raw1' }] },
    identityLink: { findMany: async () => [{ canonicalId: 'c1' }] },
    canonicalCompany: {
      findMany: async () => [{ id: 'c1', name: 'C1', domain: 'c1.de', country: 'DE', region: null, attributes: {} }],
      updateMany: async () => ({ count: 1 }),
      update: async () => ({}),
    },
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

  it('openFDA production seam opens one finite account and passes exact execution/attempt/target binding', async () => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const runId = '22222222-2222-4222-8222-222222222222';
    const ledger = new InMemoryAcquisitionBudgetLedger(
      () => new Date('2026-08-07T12:00:00.000Z'),
    );
    let seen: ExecutionContext | undefined;
    const openFda = {
      key: 'openfda',
      classes: ['public_intelligence'],
      discoverCompanies: async (_q: unknown, ctx: ExecutionContext) => {
        seen = ctx;
        return { records: [], costCents: 0 };
      },
    } as CompanyDiscoveryAdapter;
    const deps = makeDeps([openFda]);
    deps.acquisitionBudget = ledger;
    deps.activityExecution = () => ({
      attempt: 2,
      activityId: 'execute-query-7',
      workflowId: 'discovery-workflow-1',
      workflowRunId: 'temporal-run-1',
      firstScheduledAtMs: Date.parse('2026-08-07T12:00:00.000Z'),
    });
    const acts = createDiscoveryActivities(deps);

    await acts.executeQuery({
      workspaceId,
      runId,
      query: {
        ...QUERY,
        filters: { product_code: 'LLZ', source_hint: 'openfda' },
      },
    });

    expect(seen?.acquisitionBudget).toMatchObject({
      purpose: 'discovery',
      targetKind: 'TOOL',
      targetId: 'openfda.search',
      attempt: 2,
      maximum: {
        requestCount: 1n,
        callCount: 1n,
        recordCount: 250n,
        modelCallCount: 0n,
        costMinor: 0n,
      },
    });
    expect(seen?.acquisitionBudget?.executionId).toMatch(/^exec_[0-9a-f]{64}$/);
    const binding = seen?.acquisitionBudget;
    if (!binding) throw new Error('expected acquisition binding');
    await expect(
      ledger.reserve({
        accountId: binding.accountId,
        workspaceId,
        runId,
        purpose: binding.purpose,
        targetKind: binding.targetKind,
        targetId: binding.targetId,
        executionId: binding.executionId,
        attempt: binding.attempt,
        requestFingerprint: acquisitionBudgetDigest({ productCode: 'LLZ' }),
        maximum: binding.maximum,
      }),
    ).resolves.toMatchObject({ kind: 'reserved' });
  });

  it('marks a durable openFDA rejection as truncated while preserving other provider records', async () => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const runId = '22222222-2222-4222-8222-222222222222';
    const openFda = {
      key: 'openfda',
      classes: ['public_intelligence'],
      discoverCompanies: async () => {
        throw new AcquisitionBudgetError('ACCOUNT_FROZEN', 'durable settlement unknown');
      },
    } as CompanyDiscoveryAdapter;
    const deps = makeDeps([openFda, okAdapter('wikidata', [REC])]);
    deps.acquisitionBudget = new InMemoryAcquisitionBudgetLedger(
      () => new Date('2026-08-07T12:00:00.000Z'),
    );
    deps.activityExecution = () => ({
      attempt: 1,
      activityId: 'execute-query-8',
      workflowId: 'discovery-workflow-1',
      workflowRunId: 'temporal-run-1',
      firstScheduledAtMs: Date.parse('2026-08-07T12:00:00.000Z'),
    });

    const result = await createDiscoveryActivities(deps).executeQuery({
      workspaceId,
      runId,
      query: {
        ...QUERY,
        filters: { product_code: 'LLZ' },
      },
    });

    expect(result).toMatchObject({ rawCount: 1, budgetTruncated: true });
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

describe('discovery activity orchestration edges', () => {
  it('loads only executable plans and sorts null/default priorities last', async () => {
    const plan = { status: 'READY', queries: [
      { source_class: 'a', filters: {}, keywords: [], priority: 3 },
      { source_class: 'b', filters: {}, keywords: [], priority: 1 },
      { source_class: 'c', filters: {}, keywords: [] },
    ] };
    const tx = { discoveryQueryPlan: { findUnique: async () => plan } };
    const deps = {
      prisma: { withWorkspace: async <T>(_ws: string, fn: (client: typeof tx) => Promise<T>) => fn(tx) },
      providers: {},
      gateway: {},
    } as unknown as Parameters<typeof createDiscoveryActivities>[0];
    await expect(createDiscoveryActivities(deps).loadPlanQueries({ workspaceId: 'ws', planId: 'plan' })).resolves.toEqual({
      queries: [plan.queries[1], plan.queries[0], plan.queries[2]],
    });

    plan.status = 'DRAFT';
    await expect(createDiscoveryActivities(deps).loadPlanQueries({ workspaceId: 'ws', planId: 'plan' })).rejects.toThrow(
      'must be READY',
    );
    const missing = {
      ...deps,
      prisma: { withWorkspace: async <T>(_ws: string, fn: (client: typeof tx) => Promise<T>) => fn({ discoveryQueryPlan: { findUnique: async () => null } } as never) },
    };
    await expect(createDiscoveryActivities(missing).loadPlanQueries({ workspaceId: 'ws', planId: 'missing' })).rejects.toThrow(
      'not found',
    );
  });

  it('normalizes taxonomy filters, applies source hints, deduplicates raw rows, and records paid usage', async () => {
    const createdRows: unknown[][] = [];
    const usage: unknown[] = [];
    const tx = {
      rawSourceRecord: {
        createMany: async ({ data }: { data: unknown[] }) => {
          createdRows.push(data);
          return { count: data.length };
        },
      },
      usageLedger: { create: async (input: unknown) => usage.push(input) },
    };
    let seenQuery: Record<string, unknown> | undefined;
    let seenBlocked: string[] | undefined;
    const adapter = {
      key: 'directory_de',
      classes: ['public_intelligence'],
      discoverCompanies: async (query: Record<string, unknown>, _ctx: ExecutionContext, options: { blockedDomains: string[] }) => {
        seenQuery = query;
        seenBlocked = options.blockedDomains;
        return {
          records: [
            REC,
            REC,
            { name: 'No Id', country: 'DE', provenance: undefined },
            { name: 'No Id', country: 'DE', provenance: undefined },
          ],
          costCents: 25,
        };
      },
    } as unknown as CompanyDiscoveryAdapter;
    const ignored = okAdapter('wikidata', [REC]);
    const deps = {
      prisma: {
        sourcePolicy: { findMany: async () => [{ domain: 'blocked.example' }] },
        withWorkspace: async <T>(_ws: string, fn: (client: typeof tx) => Promise<T>) => fn(tx),
      },
      providers: { routeCompanyDiscovery: async () => [adapter, ignored] },
      gateway: {},
      taxonomy: {
        resolveMany: async () => [{ wikidataQid: 'Q1', osmTags: ['craft=pump'], code: 'pump' }],
        resolve: async (_kind: string, term: string) => term === 'Germany' ? { wikidataQid: 'Q183', code: 'DE' } : null,
      },
    } as unknown as Parameters<typeof createDiscoveryActivities>[0];

    const result = await createDiscoveryActivities(deps).executeQuery({
      workspaceId: 'ws',
      runId: 'run-taxonomy',
      query: {
        source_class: 'public_intelligence',
        filters: { source_hint: 'directory', industry: ['pumps'], sub_industry: null, country: 'Germany', region: 'EU' },
        keywords: undefined as unknown as string[],
        priority: 1,
      },
    });
    expect(result).toEqual({ rawCount: 2, costCents: 25, provider: 'directory_de', budgetTruncated: false });
    expect((seenQuery?.filters as Record<string, unknown>)).toMatchObject({
      _industryQids: ['Q1'],
      _osmTags: ['craft=pump'],
      _industryCodes: ['pump'],
      _countryQid: 'Q183',
      _countryCode: 'DE',
    });
    expect(seenBlocked).toEqual(['blocked.example']);
    expect(createdRows.flat()).toHaveLength(2);
    expect(usage).toHaveLength(1);
    budgetLedger.close('run-taxonomy', { force: true });
  });

  it('returns an empty receipt when a source hint filters every adapter', async () => {
    const deps = makeDeps([okAdapter('wikidata', [REC])]);
    await expect(
      createDiscoveryActivities(deps).executeQuery({
        workspaceId: 'ws',
        runId: 'run-no-route',
        query: { ...QUERY, filters: { source_hint: 'ted' } },
      }),
    ).resolves.toEqual({ rawCount: 0, costCents: 0, provider: null, budgetTruncated: false });
  });

  it('canonicalizes complete records, suppresses exact matches, and writes immutable evidence once', async () => {
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
          name: 'Acme Pumps', legalName: 'Acme Pumpen GmbH', domain: 'acme.example', country: 'DE', region: 'EU',
          industry: 'pumps', employeeCount: 10, revenueUsd: 100, attributes: { products: ['pump'] },
          identifier: { scheme: 'vat', value: 'DE123' }, sharedGroupAmbiguity: true, license: 'CC-BY-4.0',
        },
      },
    ];
    const tx = {
      rawSourceRecord: { findMany: async () => raws },
      suppressionRecord: { findMany: async () => [{ type: 'company_name', value: 'ACME PUMPS' }] },
      canonicalCompany: {
        findUnique: async () => null,
        findMany: async () => [],
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
      providers: {}, gateway: {},
    } as unknown as Parameters<typeof createDiscoveryActivities>[0];

    await expect(createDiscoveryActivities(deps).canonicalizeRun({ workspaceId: 'ws', runId: 'run' })).resolves.toEqual({
      companies: 1,
      suppressed: 1,
      reviewRequired: 1,
    });
    expect(upserts).toHaveLength(1);
    expect(links).toHaveLength(1);
    expect(evidence.length).toBeGreaterThan(5);
    expect(JSON.stringify(upserts[0])).toContain('SUPPRESSED');
    expect(JSON.stringify(upserts[0])).toContain('shared_group_domain');
  });

  it('does not duplicate identity evidence when a raw link already exists', async () => {
    const evidence: unknown[] = [];
    const tx = {
      rawSourceRecord: { findMany: async () => [{ id: 'raw-1', providerKey: 'directory', fetchedAt: null, payload: { name: 'Acme', domain: 'acme.example' } }] },
      suppressionRecord: { findMany: async () => [] },
      canonicalCompany: {
        findUnique: async () => null,
        findMany: async () => [],
        upsert: async () => ({ id: 'co-1' }),
      },
      identityLink: { findFirst: async () => ({ id: 'link-1' }), create: async () => ({}) },
      fieldEvidence: { create: async (input: unknown) => evidence.push(input) },
    };
    const deps = {
      prisma: { withWorkspace: async <T>(_ws: string, fn: (client: typeof tx) => Promise<T>) => fn(tx) },
      providers: {}, gateway: {},
    } as unknown as Parameters<typeof createDiscoveryActivities>[0];
    await expect(createDiscoveryActivities(deps).canonicalizeRun({ workspaceId: 'ws', runId: 'run' })).resolves.toMatchObject({ companies: 1 });
    expect(evidence).toEqual([]);
  });

  it('finalizes DONE/FAILED runs with exact downstream event semantics and closes the run budget', async () => {
    const planUpdates: unknown[] = [];
    const events: unknown[] = [];
    const tx = {
      discoveryRun: { update: async () => ({}) },
      discoveryQueryPlan: { update: async (input: unknown) => planUpdates.push(input) },
      outboxEvent: { create: async (input: unknown) => events.push(input) },
    };
    const deps = {
      prisma: { withWorkspace: async <T>(_ws: string, fn: (client: typeof tx) => Promise<T>) => fn(tx) },
      providers: {}, gateway: {},
    } as unknown as Parameters<typeof createDiscoveryActivities>[0];
    budgetLedger.open('run-final', 1);
    const acts = createDiscoveryActivities(deps);
    await acts.finalizeRun({ workspaceId: 'ws', runId: 'run-final', planId: 'plan', icpId: 'icp', status: 'DONE', stats: { found: 1 } });
    expect(planUpdates).toHaveLength(1);
    expect(events).toHaveLength(2);
    expect(budgetLedger.wasExhausted('run-final')).toBe(false);

    await acts.finalizeRun({ workspaceId: 'ws', runId: 'run-failed', planId: 'plan', status: 'FAILED', stats: {} });
    expect(planUpdates).toHaveLength(1);
    expect(events).toHaveLength(3);
  });

  it('merges complementary enrichment hits, skips existing namespaces, and omits null evidence', async () => {
    const updates: unknown[] = [];
    const evidence: unknown[] = [];
    const calls: string[] = [];
    const companies = [
      { id: 'co-1', name: 'Existing', domain: 'existing.example', country: 'DE', region: 'EU', attributes: { gleif: { lei: 'LEI' } } },
      { id: 'co-2', name: 'New', domain: null, country: null, region: null, attributes: null },
    ];
    const tx = {
      rawSourceRecord: { findMany: async () => [{ id: 'raw-1' }] },
      identityLink: { findMany: async () => companies.map((company) => ({ canonicalId: company.id })) },
      canonicalCompany: {
        findMany: async () => companies,
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
      prisma: { withWorkspace: async <T>(_ws: string, fn: (client: typeof tx) => Promise<T>) => fn(tx) },
      providers: { routeEnrichment: async () => enrichers }, gateway: {},
    } as unknown as Parameters<typeof createDiscoveryActivities>[0];
    const result = await createDiscoveryActivities(deps).enrichRun({ workspaceId: 'ws', runId: 'run-enrich-hit', icpId: 'icp' });
    expect(result).toMatchObject({ enriched: 2, matched: 2, provider: 'wikidata', budgetTruncated: false });
    expect(calls).not.toContain('gleif:Existing');
    expect(calls).toContain('gleif:New');
    expect(updates).toHaveLength(2);
    expect(evidence).toHaveLength(2);
    budgetLedger.close('run-enrich-hit', { force: true });
  });

  it('honors signal suspension/TTL while persisting one stale matched signal namespace', async () => {
    const updates: unknown[] = [];
    const evidence: unknown[] = [];
    const calls: string[] = [];
    const companies = [
      { id: 'blocked', name: 'Blocked', domain: 'blocked.example', country: 'DE', region: null, attributes: {} },
      { id: 'fresh', name: 'Fresh', domain: 'fresh.example', country: 'DE', region: null, attributes: { signal: { _ts: new Date().toISOString() } } },
      { id: 'stale', name: 'Stale', domain: 'stale.example', country: null, region: null, attributes: { signal: { _ts: '2020-01-01T00:00:00.000Z' } } },
    ];
    const tx = {
      rawSourceRecord: { findMany: async () => [{ id: 'raw-1' }] },
      identityLink: { findMany: async () => companies.map((company) => ({ canonicalId: company.id })) },
      canonicalCompany: {
        findMany: async () => companies,
        update: async (input: unknown) => updates.push(input),
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
    const result = await createDiscoveryActivities(deps).enrichSignalsRun({ workspaceId: 'ws', runId: 'run-signal-hit', icpId: 'icp' });
    expect(result).toMatchObject({ enriched: 2, matched: 1, provider: 'signal', budgetTruncated: false });
    expect(calls).toEqual(['Stale']);
    expect(updates).toHaveLength(1);
    expect(evidence).toHaveLength(1);
    budgetLedger.close('run-signal-hit', { force: true });
  });

  it('registers valid company watches best-effort and counts failed companies without aborting', async () => {
    const created: unknown[] = [];
    const tx = {
      rawSourceRecord: { findMany: async () => [{ id: 'raw-1' }] },
      identityLink: { findMany: async () => [{ canonicalId: 'co-1' }, { canonicalId: 'co-2' }] },
      canonicalCompany: {
        findMany: async () => [{ id: 'co-1' }, { id: 'co-2' }],
        findUnique: async ({ where }: { where: { id: string } }) =>
          where.id === 'co-1'
            ? { name: 'Acme', domain: 'acme.example', region: 'DE' }
            : { name: 'No Domain', domain: null, region: null },
      },
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
      providers: {}, gateway: {},
    } as unknown as Parameters<typeof createDiscoveryActivities>[0];
    await expect(createDiscoveryActivities(deps).registerWatchesForRun({ workspaceId: 'ws', runId: 'run', icpId: 'icp' })).resolves.toEqual({
      candidates: 2,
      registered: 1,
    });
    expect(created).toHaveLength(1);
  });
});
