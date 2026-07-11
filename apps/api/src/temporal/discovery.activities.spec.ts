import { describe, expect, it } from 'vitest';
import { createDiscoveryActivities } from './discovery.activities';
import { resolveRunStatus } from './discovery.run-status';
import { BudgetExceededError } from '../tools/budget';
import type { CompanyDiscoveryAdapter, DiscoveryResult, ProviderCompanyRecord } from '../discovery/provider-contract';

/**
 * executeQuery 预算截断透传单测（Codex PR #51 P1）：fan-out 中某源打穿 run 预算并抛
 * BudgetExceededError 时，executeQuery 不能被外层 Promise.allSettled 吞成假成功——它必须显性
 * 上报 budgetTruncated，让 workflow 把 run 判成 PARTIAL 而非 DONE（其余源已拉到的记录照常落库）。
 */

const REC: ProviderCompanyRecord = {
  externalId: 'acme.de',
  name: 'Acme',
  domain: 'acme.de',
  attributes: {},
  provenance: { sourceUrl: 'https://acme.de/', fetchedAt: '2026-07-11T00:00:00.000Z', contentHash: 'h', parserVersion: 'v1' },
};

function adapter(key: string, impl: () => Promise<DiscoveryResult>): CompanyDiscoveryAdapter {
  return { key, classes: ['public_intelligence'], discoverCompanies: impl } as unknown as CompanyDiscoveryAdapter;
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

describe('executeQuery —— 预算截断显性上报（不假 DONE）', () => {
  it('某源预算耗尽 → budgetTruncated=true，其余源记录仍落库', async () => {
    const deps = makeDeps([
      adapter('public_web', async () => {
        throw new BudgetExceededError('run-x', 20, 0);
      }),
      adapter('wikidata', async () => ({ records: [REC], costCents: 0 })),
    ]);
    const acts = createDiscoveryActivities(deps);
    const r = await acts.executeQuery({ workspaceId: 'ws-1', runId: 'run-budget-x', query: QUERY });
    expect(r.budgetTruncated).toBe(true);
    expect(r.rawCount).toBe(1); // wikidata 的记录不因 public_web 打穿而丢失
  });

  it('全部源正常 → budgetTruncated 假/未置，记录照常落库', async () => {
    const deps = makeDeps([adapter('wikidata', async () => ({ records: [REC], costCents: 0 }))]);
    const acts = createDiscoveryActivities(deps);
    const r = await acts.executeQuery({ workspaceId: 'ws-1', runId: 'run-ok-x', query: QUERY });
    expect(r.budgetTruncated ?? false).toBe(false);
    expect(r.rawCount).toBe(1);
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
