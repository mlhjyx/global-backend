import { afterEach, describe, expect, it } from 'vitest';
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
