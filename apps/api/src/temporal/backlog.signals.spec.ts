import { describe, expect, it } from 'vitest';
import { createBacklogActivities } from './backlog.activities';
import { budgetLedger } from '../tools/budget';
import type { EnrichmentResult, ExecutionContext } from '../discovery/provider-contract';

/**
 * 存量信号 sweep 预算处理单测（Codex PR #51 P2 backlog.activities.ts:351）：信号阶段此前用裸 workspace
 * 建 ExecutionContext（无 runId），DigitalFootprint/StructuredHarvest 的 crawl4ai/http 计入**无预算账户**
 * → SWEEP_BUDGET_CENTS 管不住慢站点/sitemap 抓取。正解：开 `sweep:signals:<ws>` 账户、ctx.runId=budget.key，
 * 并用 ledger.wasExhausted 检出打穿 → 停机、只 stamp 已处理的公司（与 contact/fit 阶段同纪律）。
 */

const WS = 'ws-1';

interface FakeCompany {
  id: string;
  name: string;
  domain: string | null;
  country: string | null;
  region: string | null;
  attributes: Record<string, unknown> | null;
}

function makeDeps(opts: {
  companies: FakeCompany[];
  suspendedDomains?: string[];
  onEnrich: (input: { name: string }, ctx: ExecutionContext) => Promise<EnrichmentResult>;
}) {
  const updateManyCalls: { ids: string[]; data: Record<string, unknown> }[] = [];
  const enrichCalls: string[] = [];
  const seenRunIds: (string | undefined)[] = [];

  const tx = {
    canonicalCompany: {
      findMany: async ({ take }: { take?: number }) =>
        (take != null ? opts.companies.slice(0, take) : opts.companies).map((c) => ({ ...c })),
      update: async () => ({}),
      updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
        updateManyCalls.push({ ids: where.id.in, data });
        return { count: where.id.in.length };
      },
    },
    fieldEvidence: { create: async () => ({}) },
  };

  const prisma = {
    withWorkspace: async <T>(_ws: string, fn: (tx: unknown) => Promise<T>): Promise<T> => fn(tx),
    sourcePolicy: { findMany: async () => (opts.suspendedDomains ?? []).map((d) => ({ domain: d })) },
  };
  const enricher = {
    key: 'digital_footprint',
    enrichCompany: async (input: { name: string }, ctx: ExecutionContext) => {
      enrichCalls.push(input.name);
      seenRunIds.push(ctx.runId);
      return opts.onEnrich(input, ctx);
    },
  };
  const providers = { routeSignalEnrichment: async () => [enricher] };
  const deps = { prisma, providers, gateway: {}, ownerDb: {} } as unknown as Parameters<typeof createBacklogActivities>[0];
  return { deps, updateManyCalls, enrichCalls, seenRunIds };
}

const C = (id: string, domain: string): FakeCompany => ({
  id, name: id.toUpperCase(), domain, country: 'DE', region: null, attributes: null,
});

const MISS: EnrichmentResult = { matched: false, attributes: {}, confidence: 0 };

/** 模拟真实信号 provider：crawl 的 reserve 打穿本 sweep:signals 账户 → provider fail-safe 吞成空结果。 */
async function swallowBudget(ctx: ExecutionContext): Promise<EnrichmentResult> {
  try {
    budgetLedger.reserve(ctx.runId ?? ctx.workspaceId, 10_000_000);
  } catch {
    /* 如真实 provider：吞掉 BudgetExceededError */
  }
  return MISS;
}

describe('enrichSignalsBacklog —— 信号抓取计入 sweep:signals 预算 + 打穿停机（#51 P2）', () => {
  it('信号 provider ctx.runId = sweep:signals:<ws>（抓取计入阶段预算账户，不再计裸 workspace）', async () => {
    const { deps, seenRunIds } = makeDeps({ companies: [C('c1', 'c1.de')], onEnrich: async () => MISS });
    await createBacklogActivities(deps).enrichSignalsBacklog({ workspaceId: WS, limit: 1 });
    expect(seenRunIds).toEqual(['sweep:signals:ws-1']);
  });

  it('中途预算打穿（被 provider 吞掉）→ ledger 检出，只 stamp 已处理的 c1；c2/c3 保留水位、nextCursor=null', async () => {
    const companies = [C('c1', 'c1.de'), C('c2', 'c2.de'), C('c3', 'c3.de')];
    const { deps, updateManyCalls, enrichCalls } = makeDeps({
      companies,
      onEnrich: async (input, ctx) => (input.name === 'C2' ? swallowBudget(ctx) : MISS),
    });
    const r = await createBacklogActivities(deps).enrichSignalsBacklog({ workspaceId: WS, limit: 3 });

    expect(updateManyCalls).toHaveLength(1);
    expect(updateManyCalls[0].ids).toEqual(['c1']); // 只 stamp 真正处理过的 c1
    expect(updateManyCalls[0].data.lastSignalAt).toBeInstanceOf(Date);
    expect(r.nextCursor).toBeNull(); // 打穿即收手，不再翻页
    expect(r.attempted).toBe(1);
    expect(enrichCalls).toEqual(['C1', 'C2']); // c3 在 c2 打穿后不再被触达
  });

  it('无预算打穿 → 全批 stamp、cursor 前进（既有行为不回退）', async () => {
    const companies = [C('c1', 'c1.de'), C('c2', 'c2.de'), C('c3', 'c3.de')];
    const { deps, updateManyCalls } = makeDeps({ companies, onEnrich: async () => MISS });
    const r = await createBacklogActivities(deps).enrichSignalsBacklog({ workspaceId: WS, limit: 3 });
    expect(updateManyCalls[0].ids).toEqual(['c1', 'c2', 'c3']);
    expect(r.nextCursor).toBe('c3');
  });

  it('DAT-011：SUSPENDED 域跳过信号抓取但仍 stamp（防每 sweep 重扫）', async () => {
    const { deps, updateManyCalls, enrichCalls } = makeDeps({
      companies: [C('c1', 'susp.de')],
      suspendedDomains: ['susp.de'],
      onEnrich: async () => MISS,
    });
    const r = await createBacklogActivities(deps).enrichSignalsBacklog({ workspaceId: WS, limit: 1 });
    expect(enrichCalls).toHaveLength(0);
    expect(updateManyCalls[0].ids).toEqual(['c1']);
    expect(r.attempted).toBe(0);
  });

  it('本家内首个 enricher 打穿 → 后续 enricher 不再出网（逐 enricher 检 kill-switch，#82 P2）', async () => {
    const calls: string[] = [];
    const e1 = { key: 'digital_footprint', enrichCompany: async (_i: unknown, ctx: ExecutionContext) => { calls.push('e1'); return swallowBudget(ctx); } };
    const e2 = { key: 'structured_harvest', enrichCompany: async () => { calls.push('e2'); return MISS; } };
    const tx = {
      canonicalCompany: {
        findMany: async ({ take }: { take?: number }) => [C('c1', 'c1.de')].slice(0, take ?? 1),
        update: async () => ({}),
        updateMany: async () => ({ count: 1 }),
      },
      fieldEvidence: { create: async () => ({}) },
    };
    const prisma = {
      withWorkspace: async <T>(_ws: string, fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
      sourcePolicy: { findMany: async () => [] as { domain: string }[] },
    };
    const providers = { routeSignalEnrichment: async () => [e1, e2] };
    const deps = { prisma, providers, gateway: {}, ownerDb: {} } as unknown as Parameters<typeof createBacklogActivities>[0];

    await createBacklogActivities(deps).enrichSignalsBacklog({ workspaceId: WS, limit: 1 });

    expect(calls).toEqual(['e1']); // e1 打穿 sweep:signals 后，structured_harvest(e2) 不再出网探测
  });
});
