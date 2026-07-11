import { describe, expect, it } from 'vitest';
import { createBacklogActivities } from './backlog.activities';
import { BudgetExceededError } from '../tools/budget';
import type { ContactDiscoveryResult } from '../discovery/provider-contract';

/**
 * 存量联系人 sweep 预算处理单测（Codex PR #51 P1）：`sweep:contact` 预算打穿时，adapter 抛
 * BudgetExceededError 绝不能被单公司 fail-safe catch 吞掉——那会令后续每家都被跳过，然后 stamp-all
 * 把整批（含从未真正处理的公司）都盖上 contactDiscoveryAttemptedAt，令未处理公司离开水位、TTL 内
 * 永不重试。正解：预算异常单独处理 → 停止本页、**只 stamp 真正处理过的公司**、nextCursor=null。
 */

const WS = 'ws-1';
const ICP = 'icp-1';

interface FakeCompany {
  id: string;
  name: string;
  domain: string | null;
  country: string | null;
  dedupeKey: string;
}

function makeDeps(opts: {
  companies: FakeCompany[];
  suspendedDomains?: string[];
  onDiscover: (company: { name: string; domain?: string }) => Promise<ContactDiscoveryResult>;
}) {
  const updateManyCalls: { ids: string[]; data: Record<string, unknown> }[] = [];
  const discoverCalls: string[] = [];

  const tx = {
    canonicalCompany: {
      findMany: async ({ take }: { take?: number }) =>
        (take != null ? opts.companies.slice(0, take) : opts.companies).map((c) => ({ ...c })),
      updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
        updateManyCalls.push({ ids: where.id.in, data });
        return { count: where.id.in.length };
      },
    },
    icpDefinition: {
      findUnique: async () => ({ company: { name: 'Seller', summary: null }, roles: [] as unknown[] }),
    },
    suppressionRecord: { findMany: async () => [] as { value: string }[] },
  };

  const prisma = {
    withWorkspace: async <T>(_ws: string, fn: (tx: unknown) => Promise<T>): Promise<T> => fn(tx),
    sourcePolicy: { findMany: async () => (opts.suspendedDomains ?? []).map((d) => ({ domain: d })) },
  };
  const adapter = {
    key: 'decision_maker',
    classes: [],
    discoverContacts: async (company: { name: string; domain?: string }) => {
      discoverCalls.push(company.name);
      return opts.onDiscover(company);
    },
  };
  const providers = { routeContactDiscovery: async () => [adapter] };
  const deps = { prisma, providers, gateway: {}, ownerDb: {} } as unknown as Parameters<typeof createBacklogActivities>[0];
  return { deps, updateManyCalls, discoverCalls };
}

const C = (id: string, domain: string): FakeCompany => ({ id, name: id.toUpperCase(), domain, country: 'DE', dedupeKey: domain });

describe('discoverContactsBacklog —— 预算耗尽停机 + 不 stamp 跳过尾部', () => {
  it('中途预算耗尽 → 只 stamp 已处理的 c1；c2(耗尽)/c3(未触达) 保留水位、nextCursor=null', async () => {
    const companies = [C('c1', 'c1.de'), C('c2', 'c2.de'), C('c3', 'c3.de')];
    const { deps, updateManyCalls, discoverCalls } = makeDeps({
      companies,
      onDiscover: async (company) => {
        if (company.name === 'C2') throw new BudgetExceededError('sweep:contact:ws-1', 20, 0);
        return { contacts: [], costCents: 0 };
      },
    });
    const r = await createBacklogActivities(deps).discoverContactsBacklog({ workspaceId: WS, icpId: ICP, limit: 3 });

    // 🔴 只 stamp 真正处理过的 c1；绝不 stamp 预算耗尽/未触达的 c2、c3。
    expect(updateManyCalls).toHaveLength(1);
    expect(updateManyCalls[0].ids).toEqual(['c1']);
    expect(updateManyCalls[0].data.contactDiscoveryAttemptedAt).toBeInstanceOf(Date);
    // 预算耗尽即收手：不再翻页触发同账户连环超限。
    expect(r.nextCursor).toBeNull();
    expect(r.attempted).toBe(1); // 只有 c1 完整处理
    expect(r.scanned).toBe(3);
    // c3 在 c2 打穿后不应再被触达。
    expect(discoverCalls).toEqual(['C1', 'C2']);
  });

  it('无预算耗尽 → 全批 stamp、attempted 计全、cursor 前进（既有行为不回退）', async () => {
    const companies = [C('c1', 'c1.de'), C('c2', 'c2.de'), C('c3', 'c3.de')];
    const { deps, updateManyCalls } = makeDeps({
      companies,
      onDiscover: async () => ({ contacts: [], costCents: 0 }),
    });
    const r = await createBacklogActivities(deps).discoverContactsBacklog({ workspaceId: WS, icpId: ICP, limit: 3 });
    expect(updateManyCalls).toHaveLength(1);
    expect(updateManyCalls[0].ids).toEqual(['c1', 'c2', 'c3']);
    expect(r.attempted).toBe(3);
    expect(r.nextCursor).toBe('c3');
  });

  it('DAT-011：SUSPENDED 域跳过 discoverContacts 但仍 stamp（防每 sweep 重扫），不计 attempted', async () => {
    const { deps, updateManyCalls, discoverCalls } = makeDeps({
      companies: [C('c1', 'susp.de')],
      suspendedDomains: ['susp.de'],
      onDiscover: async () => ({ contacts: [], costCents: 0 }),
    });
    const r = await createBacklogActivities(deps).discoverContactsBacklog({ workspaceId: WS, icpId: ICP, limit: 1 });
    expect(discoverCalls).toHaveLength(0); // 被 DAT-011 跳过，不触网
    expect(updateManyCalls[0].ids).toEqual(['c1']); // 仍 stamp（离开当批过滤集）
    expect(r.attempted).toBe(0);
  });
});
