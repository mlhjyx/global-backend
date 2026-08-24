import { describe, expect, it, vi } from 'vitest';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';

const receiptMocks = vi.hoisted(() => ({
  applyDomainAckConsumerTransactions: vi.fn(async (input: {
    transaction: unknown;
    apply: (transaction: unknown) => Promise<unknown>;
    acknowledgements: Array<{ producerId: string }>;
  }) => ({
    status: 'APPLIED',
    acknowledgements: input.acknowledgements.map(({ producerId }) => ({
      producerId,
      status: 'APPLIED',
    })),
    value: await input.apply(input.transaction),
  })),
  persistDiscoveredContacts: vi.fn(async () => ({
    created: 1,
    merged: 0,
    skippedSuppressed: 0,
    skippedInvalid: 0,
  })),
}));

vi.mock('../durable-results/domain-ack-consumer-bindings', () => ({
  applyDomainAckConsumerTransactions:
    receiptMocks.applyDomainAckConsumerTransactions,
}));
vi.mock('../discovery/contact-persist', () => ({
  persistDiscoveredContacts: receiptMocks.persistDiscoveredContacts,
}));
import { createBacklogActivities } from './backlog.activities';
import { BudgetLedger } from '../tools/budget';
import { InMemoryBudgetStoreAdapter } from '../tools/budget-store';

const budgetLedger = new BudgetLedger();
import type { ContactDiscoveryResult, ExecutionContext } from '../discovery/provider-contract';

/**
 * 存量联系人 sweep 预算处理单测（Codex PR #51 P1，根治版）：`sweep:contact` 预算打穿时，**真实 adapter
 * （decision_maker/public_web/companies_house）各自的 fail-safe catch 会把 BudgetExceededError 吞成空结果**
 * ——所以不能靠源抛错判断。若不检出，后续每家被误当「无决策人」跳过，然后 stamp-all 把整批（含从未处理的
 * 公司）盖 contactDiscoveryAttemptedAt，令其离开水位、TTL 内永不重试。正解：用 BudgetLedger.wasExhausted
 * 检出 → 停止本页、只 stamp 真正处理过的公司、nextCursor=null。本测用「reserve 打穿→自吞」假 adapter 复刻生产形态。
 */

const WS = 'ws-1';
const ICP = 'icp-1';
const RECEIPT = Object.freeze({
  schemaVersion: 'durable-execution-receipt/v1',
  scopeKey: WS,
  authorityId: '11111111-1111-4111-8111-111111111111',
  accountId: '22222222-2222-4222-8222-222222222222',
  operationId: '33333333-3333-4333-8333-333333333333',
  operationKey: 'backlog-contact-receipt',
  resultStrategy: 'typed_projection',
  resultSchema: 'crawl4ai-fetch/v1',
  resultDigest: 'a'.repeat(64),
  artifactId: null,
  usage: {
    currency: 'USD', unit: 'microusd', callCount: 1,
    upperBoundMicrousd: '10000',
  },
  costBasis: 'estimated_upper_bound',
}) satisfies DurableExecutionReceipt;

interface FakeCompany {
  id: string;
  name: string;
  domain: string | null;
  country: string | null;
  dedupeKey: string;
}

function makeDeps(opts: {
  companies: FakeCompany[];
  syntheticCompanyIds?: string[];
  suspendedDomains?: string[];
  suppressionRows?: { type: string; value: string }[];
  onDiscover: (company: { name: string }, ctx: ExecutionContext) => Promise<ContactDiscoveryResult>;
}) {
  const updateManyCalls: { ids: string[]; data: Record<string, unknown> }[] = [];
  const discoverCalls: string[] = [];

  const tx = {
    $queryRaw: async () => [{ locked: true }],
    canonicalCompany: {
      findMany: async ({ skip = 0, take }: { skip?: number; take?: number }) =>
        (take != null ? opts.companies.slice(skip, skip + take) : opts.companies.slice(skip)).map((c) => ({ ...c })),
      updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
        const ids = Array.isArray(where.id.in) ? where.id.in : [where.id as unknown as string];
        updateManyCalls.push({ ids, data });
        return { count: ids.length };
      },
      findUnique: async ({ where }: { where: { id: string } }) => opts.companies.find((c) => c.id === where.id) ?? null,
    },
    fieldEvidence: {
      findMany: async ({ where }: { where: { entityId: { in: string[] } } }) =>
        where.entityId.in
          .filter((id) => opts.syntheticCompanyIds?.includes(id))
          .map((entityId) => ({ entityId, providerKey: 'sandbox', license: 'sandbox' })),
    },
    icpDefinition: {
      findUnique: async () => ({ company: { name: 'Seller', summary: null }, roles: [] as unknown[] }),
    },
    suppressionRecord: { findMany: async () => opts.suppressionRows ?? [] },
  };

  const prisma = {
    withWorkspace: async <T>(_ws: string, fn: (tx: unknown) => Promise<T>): Promise<T> => fn(tx),
    sourcePolicy: { findMany: async () => (opts.suspendedDomains ?? []).map((d) => ({ domain: d })) },
  };
  const adapter = {
    key: 'decision_maker',
    classes: [],
    discoverContacts: async (company: { name: string }, ctx: ExecutionContext) => {
      discoverCalls.push(company.name);
      return opts.onDiscover(company, ctx);
    },
  };
  const providers = { routeContactDiscovery: async () => [adapter] };
  const deps = {
    prisma,
    providers,
    gateway: {},
    ownerDb: {},
    budgetStore: new InMemoryBudgetStoreAdapter(budgetLedger),
  } as unknown as Parameters<typeof createBacklogActivities>[0];
  return { deps, tx, updateManyCalls, discoverCalls };
}

const C = (id: string, domain: string): FakeCompany => ({ id, name: id.toUpperCase(), domain, country: 'DE', dedupeKey: domain });

/** 模拟真实 adapter：LLM/crawl 的 reserve 打穿本 sweep:contact 账户 → adapter 自己 fail-safe 吞成空结果。 */
async function swallowBudget(ctx: ExecutionContext): Promise<ContactDiscoveryResult> {
  try {
    budgetLedger.reserve(ctx.runId ?? ctx.workspaceId, 10_000_000);
  } catch {
    /* 如真实 adapter：吞掉 BudgetExceededError */
  }
  return { contacts: [], costCents: 0 };
}

describe('discoverContactsBacklog —— 预算打穿停机 + 不 stamp 跳过尾部（靠 ledger 而非源抛错）', () => {
  it('中途预算打穿（被 adapter 吞掉）→ ledger 检出，只 stamp 已处理的 c1；c2/c3 保留水位、nextCursor=null', async () => {
    const companies = [C('c1', 'c1.de'), C('c2', 'c2.de'), C('c3', 'c3.de')];
    const { deps, updateManyCalls, discoverCalls } = makeDeps({
      companies,
      onDiscover: async (company, ctx) =>
        company.name === 'C2' ? swallowBudget(ctx) : { contacts: [], costCents: 0 },
    });
    const r = await createBacklogActivities(deps).discoverContactsBacklog({ workspaceId: WS, icpId: ICP, limit: 3 });

    // 🔴 只 stamp 真正处理过的 c1；绝不 stamp 预算打穿/未触达的 c2、c3。
    expect(updateManyCalls).toHaveLength(1);
    expect(updateManyCalls[0].ids).toEqual(['c1']);
    expect(updateManyCalls[0].data.contactDiscoveryAttemptedAt).toBeInstanceOf(Date);
    // 预算打穿即收手：不再翻页触发同账户连环超限。
    expect(r.nextCursor).toBeNull();
    expect(r.attempted).toBe(1); // 只有 c1 完整处理
    expect(r.scanned).toBe(3);
    // c3 在 c2 打穿后不应再被触达。
    expect(discoverCalls).toEqual(['C1', 'C2']);
  });

  it('无预算打穿 → 全批 stamp、attempted 计全、cursor 前进（既有行为不回退）', async () => {
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

  it('历史非规范 domain suppression 在 adapter 出网前复核，修复公司状态且零调用', async () => {
    const { deps, updateManyCalls, discoverCalls } = makeDeps({
      companies: [C('c1', 'acme.de')],
      suppressionRows: [{ type: 'domain', value: ' https://www.ACME.de/path ' }],
      onDiscover: async () => ({ contacts: [], costCents: 0 }),
    });
    const r = await createBacklogActivities(deps).discoverContactsBacklog({ workspaceId: WS, icpId: ICP, limit: 1 });
    expect(discoverCalls).toHaveLength(0);
    expect(r.attempted).toBe(0);
    expect(updateManyCalls.some((call) => call.data.status === 'SUPPRESSED')).toBe(true);
  });

  it('历史 sandbox evidence 在 backlog 候选加载时隔离，且不会占满 take 饿死后续产品公司', async () => {
    const syntheticIds = Array.from({ length: 55 }, (_, index) => `sandbox-${index + 1}`);
    const { deps, updateManyCalls, discoverCalls } = makeDeps({
      companies: [
        ...syntheticIds.map((id) => C(id, `${id}.example`)),
        C('real-1', 'real.example'),
      ],
      syntheticCompanyIds: syntheticIds,
      onDiscover: async () => ({ contacts: [], costCents: 0 }),
    });

    const result = await createBacklogActivities(deps).discoverContactsBacklog({
      workspaceId: WS,
      icpId: ICP,
      limit: 1,
    });

    expect(discoverCalls).toEqual(['REAL-1']);
    expect(updateManyCalls.at(-1)?.ids).toEqual(['real-1']);
    expect(result.scanned).toBe(1);
  });

  it('collects contact Tool receipts and applies ACK plus contact persistence on the same backlog transaction', async () => {
    receiptMocks.applyDomainAckConsumerTransactions.mockClear();
    receiptMocks.persistDiscoveredContacts.mockClear();
    const { deps, tx } = makeDeps({
      companies: [C('c1', 'c1.de')],
      onDiscover: async (_company, ctx) => {
        ctx.onDurableReceipt?.('crawl4ai.fetch', RECEIPT);
        return {
          contacts: [{
            externalId: 'public-1',
            fullName: 'Named Person',
            personalData: true,
          }],
          costCents: 0,
        };
      },
    });

    await expect(createBacklogActivities(deps).discoverContactsBacklog({
      workspaceId: WS,
      icpId: ICP,
      limit: 1,
    })).resolves.toMatchObject({ contactsCreated: 1 });

    expect(receiptMocks.applyDomainAckConsumerTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        transaction: tx,
        acknowledgements: [expect.objectContaining({
          producerId: 'crawl4ai.fetch',
          receipt: RECEIPT,
        })],
      }),
    );
    expect(receiptMocks.persistDiscoveredContacts).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ adapterKey: 'decision_maker' }),
    );
  });

  it('does not swallow an unexpected receipt producer from the contact adapter', async () => {
    const { deps } = makeDeps({
      companies: [C('c1', 'c1.de')],
      onDiscover: async (_company, ctx) => {
        ctx.onDurableReceipt?.('unexpected.tool', RECEIPT);
        return { contacts: [], costCents: 0 };
      },
    });

    await expect(createBacklogActivities(deps).discoverContactsBacklog({
      workspaceId: WS,
      icpId: ICP,
      limit: 1,
    })).rejects.toThrow('DOMAIN_ACK_CONSUMER_BINDING_MISSING');
  });
});
