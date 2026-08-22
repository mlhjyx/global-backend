import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDiscoveryActivities } from './discovery.activities';
import { resolveRunStatus } from './discovery.run-status';
import { BudgetExceededError, BudgetLedger } from '../tools/budget';
import {
  BudgetOperationReplayError,
  BudgetUnsettledOperationsError,
  InMemoryBudgetStoreAdapter,
  type BudgetStore,
} from '../tools/budget-store';

const budgetLedger = new BudgetLedger();
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
  return {
    prisma,
    providers,
    gateway: {},
    budgetStore: authorityBudgetStore(),
  } as unknown as Parameters<typeof createDiscoveryActivities>[0];
}

const QUERY = { source_class: 'public_intelligence', filters: {}, keywords: [], priority: 1 };
const DISCOVERY_BINDING = Object.freeze({
  authorityId: '20000000-0000-4000-8000-000000000002',
  replay: false,
  scopeKey: '10000000-0000-4000-8000-000000000001',
  accountKey: `discovery.run:discovery_run:request:${'a'.repeat(64)}:${'a'.repeat(64)}`,
  purpose: 'discovery.run' as const,
  subjectType: 'discovery_run',
  subjectId: `request:${'a'.repeat(64)}`,
  requestSha256: 'a'.repeat(64),
});

function authorityBudgetStore(): BudgetStore {
  const store = new InMemoryBudgetStoreAdapter(budgetLedger);
  if (!Number.isFinite(budgetLedger.remainingCents(DISCOVERY_BINDING.accountKey))) {
    budgetLedger.open(DISCOVERY_BINDING.accountKey, 100);
  }
  store.attestAuthorized = vi.fn(async (input) => {
    return {
      accountId: '40000000-0000-4000-8000-000000000004',
      authorityId: input.authorityId,
      authorizedCapMicrousd: 1_000_000n,
      generation: 1,
    };
  });
  return store;
}

function discoveryArgs<T extends object>(runId: string, extra: T) {
  return {
    workspaceId: DISCOVERY_BINDING.scopeKey,
    runId,
    executionContractVersion: 2 as const,
    executionBudget: DISCOVERY_BINDING,
    ...extra,
  };
}

// executeQuery/enrichRun 不 close run 预算账户（finalizeRun 才 close）→ 测试自行 force-close，清打标防单例泄漏。
afterEach(() => {
  for (const k of ['run-budget-x', 'run-ok-x', 'run-enrich-x', 'run-enrich-ok', 'run-signal-x', 'run-leak']) {
    budgetLedger.close(k, { force: true });
  }
  budgetLedger.close(DISCOVERY_BINDING.accountKey, { force: true });
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
  return {
    prisma,
    providers,
    gateway: {},
    budgetStore: authorityBudgetStore(),
  } as unknown as Parameters<typeof createDiscoveryActivities>[0];
}

describe('executeQuery —— 预算截断显性上报（不假 DONE），靠 ledger 而非源抛错', () => {
  it('uses the relayed authority account and rejects missing binding before provider execution', async () => {
    const discoverCompanies = vi.fn(async () => ({ records: [], costCents: 0 }));
    const open = vi.fn(async () => undefined);
    const attestAuthorized = vi.fn(async () => ({
      accountId: '40000000-0000-4000-8000-000000000004',
      authorityId: DISCOVERY_BINDING.authorityId,
      authorizedCapMicrousd: 1_000_000n,
      generation: 1,
    }));
    const deps = makeDeps([
      { ...okAdapter('wikidata', []), discoverCompanies },
    ]);
    deps.budgetStore = {
      open,
      attestAuthorized,
      status: vi.fn(async () => ({ remainingCents: 100, exhausted: false, open: true })),
    } as never;
    const acts = createDiscoveryActivities(deps);

    await acts.executeQuery({
      workspaceId: DISCOVERY_BINDING.scopeKey,
      runId: 'run-row-id',
      query: QUERY,
      executionContractVersion: 2,
      executionBudget: DISCOVERY_BINDING,
    });

    expect(attestAuthorized).toHaveBeenCalledWith({
      authorityId: DISCOVERY_BINDING.authorityId,
      scopeKey: DISCOVERY_BINDING.scopeKey,
      accountKey: DISCOVERY_BINDING.accountKey,
    });
    expect(open).not.toHaveBeenCalled();
    expect(discoverCompanies).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        workspaceId: DISCOVERY_BINDING.scopeKey,
        runId: DISCOVERY_BINDING.accountKey,
      }),
      expect.any(Object),
    );

    discoverCompanies.mockClear();
    await expect(
      acts.executeQuery({
        workspaceId: DISCOVERY_BINDING.scopeKey,
        runId: 'run-row-id',
        query: QUERY,
      } as never),
    ).rejects.toMatchObject({
      type: 'EXECUTION_BUDGET_LEGACY_HISTORY_PARKED',
      nonRetryable: true,
    });
    expect(discoverCompanies).not.toHaveBeenCalled();
  });

  it('产品路径在调用 provider 和持久化之前拒绝 synthetic sandbox adapter', async () => {
    const discoverCompanies = vi.fn(async () => ({ records: [REC], costCents: 0 }));
    const deps = makeDeps([
      {
        key: 'sandbox',
        classes: ['public_intelligence'],
        discoverCompanies,
      } as CompanyDiscoveryAdapter,
    ]);
    const acts = createDiscoveryActivities(deps);

    await expect(
      acts.executeQuery(discoveryArgs('run-ok-x', { query: QUERY })),
    ).rejects.toMatchObject({ code: 'SYNTHETIC_DISCOVERY_PROVENANCE' });
    expect(discoverCompanies).not.toHaveBeenCalled();
  });

  it('某源打穿 run 预算并被 fail-safe 吞掉 → wasExhausted 检出 budgetTruncated=true，其余源记录仍落库', async () => {
    const deps = makeDeps([budgetSwallowingAdapter('public_web'), okAdapter('wikidata', [REC])]);
    const acts = createDiscoveryActivities(deps);
    const r = await acts.executeQuery(discoveryArgs('run-budget-x', { query: QUERY }));
    expect(r.budgetTruncated).toBe(true);
    expect(r.rawCount).toBe(1); // wikidata 的记录不因 public_web 打穿而丢失
  });

  it('全部源正常 → budgetTruncated=false，记录照常落库', async () => {
    const deps = makeDeps([okAdapter('wikidata', [REC])]);
    const acts = createDiscoveryActivities(deps);
    const r = await acts.executeQuery(discoveryArgs('run-ok-x', { query: QUERY }));
    expect(r.budgetTruncated).toBe(false);
    expect(r.rawCount).toBe(1);
  });

  it('generic replay 不可恢复时拒绝 activity，而不是把已付费结果吞成空成功', async () => {
    const deps = makeDeps([{
      ...okAdapter('ted', []),
      discoverCompanies: async () => { throw new BudgetOperationReplayError('ted-op'); },
    }]);
    const acts = createDiscoveryActivities(deps);

    await expect(
      acts.executeQuery(discoveryArgs('run-ok-x', { query: QUERY })),
    ).rejects.toBeInstanceOf(BudgetOperationReplayError);
  });
});

describe('canonicalizeRun —— suppression authority 线性化', () => {
  it.each([
    { providerKey: 'sandbox', payload: { name: 'Synthetic Co' } },
    { providerKey: 'public_web', payload: { name: 'Synthetic Co', license: 'sandbox' } },
  ])('quarantines historical synthetic raw rows from canonical materialization: %j', async (raw) => {
    const canonicalUpsert = vi.fn();
    const identityCreate = vi.fn();
    const evidenceCreate = vi.fn();
    const tx = {
      $queryRaw: async () => [{ pg_advisory_xact_lock: null }],
      rawSourceRecord: { findMany: async () => [{ id: 'raw-synthetic', ...raw }] },
      suppressionRecord: { findMany: async () => [] },
      canonicalCompany: { upsert: canonicalUpsert },
      identityLink: { findFirst: vi.fn(), create: identityCreate },
      fieldEvidence: { create: evidenceCreate },
    };
    const prisma = {
      withWorkspace: async <T>(_workspaceId: string, callback: (client: typeof tx) => Promise<T>): Promise<T> =>
        callback(tx),
    };
    const activities = createDiscoveryActivities({
      prisma, providers: {}, gateway: {}, budgetStore: authorityBudgetStore(),
    } as never);

    await expect(activities.canonicalizeRun(discoveryArgs('run-1', {}))).resolves.toEqual({
      companies: 0,
      suppressed: 0,
    });
    expect(canonicalUpsert).not.toHaveBeenCalled();
    expect(identityCreate).not.toHaveBeenCalled();
    expect(evidenceCreate).not.toHaveBeenCalled();
  });

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
      budgetStore: authorityBudgetStore(),
    } as never);

    await activities.canonicalizeRun(discoveryArgs('run-1', {}));

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
    const activities = createDiscoveryActivities({
      prisma, providers: {}, gateway: {}, budgetStore: authorityBudgetStore(),
    } as never);

    await expect(activities.canonicalizeRun(discoveryArgs('run-1', {}))).resolves.toEqual({
      companies: 0,
      suppressed: 1,
    });
    expect(updateMany).toHaveBeenCalledOnce();
    expect(upsert).not.toHaveBeenCalled();
    expect(linkCreate).not.toHaveBeenCalled();
    expect(evidenceCreate).not.toHaveBeenCalled();
  });
});

describe('enrichRun / resetRunBudget —— 富集阶段截断也上报 + 未知调用不重试', () => {
  it.each(['enrichRun', 'enrichSignalsRun'] as const)(
    '%s parks a pending legacy activity before provider routing or early success',
    async (activityName) => {
      const routeEnrichment = vi.fn(async () => []);
      const routeSignalEnrichment = vi.fn(async () => []);
      const withWorkspace = vi.fn(async (_workspaceId: string, callback: (tx: unknown) => Promise<unknown>) =>
        callback({}),
      );
      const activities = createDiscoveryActivities({
        prisma: { withWorkspace } as never,
        providers: { routeEnrichment, routeSignalEnrichment } as never,
        gateway: {} as never,
        budgetStore: authorityBudgetStore(),
      });

      await expect(activities[activityName]({
        workspaceId: DISCOVERY_BINDING.scopeKey,
        runId: 'legacy-run',
        icpId: 'icp-1',
      } as never)).rejects.toMatchObject({
        type: 'EXECUTION_BUDGET_LEGACY_HISTORY_PARKED',
        nonRetryable: true,
      });
      expect(withWorkspace).not.toHaveBeenCalled();
      expect(routeEnrichment).not.toHaveBeenCalled();
      expect(routeSignalEnrichment).not.toHaveBeenCalled();
    },
  );

  it('富集源预算控制失败上抛，不降级为 PARTIAL', async () => {
    const deps = makeEnrichDeps([budgetSwallowingEnricher]);
    const acts = createDiscoveryActivities(deps);
    await expect(acts.enrichRun(discoveryArgs('run-enrich-x', { icpId: 'icp-1' })))
      .rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('富集正常 → enrichRun.budgetTruncated=false', async () => {
    const deps = makeEnrichDeps([{ key: 'gleif', enrichCompany: async () => ({ matched: false }) }]);
    const acts = createDiscoveryActivities(deps);
    const r = await acts.enrichRun(discoveryArgs('run-enrich-ok', { icpId: 'icp-1' }));
    expect(r.budgetTruncated).toBe(false);
  });

  it('信号富集预算控制失败上抛，不降级为 best-effort', async () => {
    const deps = makeEnrichDeps([budgetSwallowingEnricher]);
    const acts = createDiscoveryActivities(deps);
    await expect(acts.enrichSignalsRun(discoveryArgs('run-signal-x', { icpId: 'icp-1' })))
      .rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('authority workflow compatibility activity never closes a legacy run account', async () => {
    const deps = makeEnrichDeps([]);
    const close = vi.spyOn(deps.budgetStore!, 'close');
    const acts = createDiscoveryActivities(deps);

    await acts.resetRunBudget(discoveryArgs('run-leak', {}));

    expect(close).not.toHaveBeenCalled();
  });

  it('propagates authority account open failures before provider execution', async () => {
    const close = vi.fn(async () => undefined);
    const attestAuthorized = vi.fn(async () => {
      throw new BudgetUnsettledOperationsError('run-unknown');
    });
    const adapter = vi.fn(async () => ({ records: [], costCents: 0 }));
    const deps = makeDeps([{ ...okAdapter('public-web', []), discoverCompanies: adapter }]);
    deps.budgetStore = {
      open: vi.fn(),
      attestAuthorized,
      close,
      reserve: vi.fn(),
      settle: vi.fn(),
      release: vi.fn(),
      status: vi.fn(),
    } as unknown as BudgetStore;
    const acts = createDiscoveryActivities(deps);

    await expect(
      acts.executeQuery(discoveryArgs('run-unknown', { query: QUERY })),
    ).rejects.toBeInstanceOf(BudgetUnsettledOperationsError);
    expect(close).not.toHaveBeenCalled();
    expect(adapter).not.toHaveBeenCalled();
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
    const deps = {
      prisma, providers: {}, gateway: {}, budgetStore: authorityBudgetStore(),
    } as unknown as Parameters<typeof createDiscoveryActivities>[0];
    const acts = createDiscoveryActivities(deps);
    const res = await acts.enqueuePatentLookupsForRun(discoveryArgs('run', { icpId: 'icp' }));
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
    const deps = {
      prisma, providers: {}, gateway: {}, budgetStore: authorityBudgetStore(),
    } as unknown as Parameters<typeof createDiscoveryActivities>[0];
    const acts = createDiscoveryActivities(deps);
    const res = await acts.enqueuePatentLookupsForRun(discoveryArgs('run', { icpId: 'icp' }));
    expect(res).toEqual({ candidates: 1, enqueued: 1 });
    expect(upserts).toHaveLength(1);
  });
});
