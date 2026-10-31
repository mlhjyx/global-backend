import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDiscoveryActivities } from './discovery.activities';
import type { BudgetStore } from '../tools/budget-store';
import type {
  ContactDiscoveryAdapter,
  EmailVerificationAdapter,
  ProviderContactRecord,
} from '../discovery/provider-contract';

/**
 * D7 联系人阶段独立预算账户（设计稿 §5.3d）在 run 内的接线：
 *  - 派生 scope=contact.discovery、按 run 命名的子账户；
 *  - 上限 = 每家上限 × 本轮公司数（默认对齐 D5：$0.5 / 8 家），撞顶即停；
 *  - 结果进现有 contacts.budgetTruncated 口径（run stats → PARTIAL）；
 *  - email_guess M3 双闸：data_provider.email_guess ENABLED + lawfulBasis，每公司 ≤6 探测。
 */

const WS = '10000000-0000-4000-8000-000000000001';
const RUN_ID = '60000000-0000-4000-8000-000000000006';
const SHA = 'a'.repeat(64);
const DISCOVERY_BINDING = Object.freeze({
  authorityId: '20000000-0000-4000-8000-000000000002',
  replay: false,
  scopeKey: WS,
  accountKey: `discovery.run:discovery_run:request:${SHA}:${SHA}`,
  purpose: 'discovery.run' as const,
  subjectType: 'discovery_run',
  subjectId: `request:${SHA}`,
  requestSha256: SHA,
});
const GLOBAL_LIA = { basis: 'legitimate_interest', ref: 'OWNER-DECISION-2026-10-11' };

const persistMock = vi.hoisted(() =>
  vi.fn(async () => ({
    created: 0,
    merged: 0,
    skippedSuppressed: 0,
    skippedInvalid: 0,
  })),
);
vi.mock('../discovery/contact-persist', () => ({
  persistDiscoveredContacts: persistMock,
}));

const ackMock = vi.hoisted(() =>
  vi.fn(async (input: {
    transaction: unknown;
    apply: (transaction: unknown) => Promise<unknown>;
  }) => ({
    status: 'APPLIED',
    acknowledgements: [],
    value: await input.apply(input.transaction),
  })),
);
vi.mock('../durable-results/domain-ack-consumer-bindings', () => ({
  applyDomainAckConsumerTransactions: ackMock,
}));

const runGuessMock = vi.hoisted(() => vi.fn());
vi.mock('../discovery/contact-stage-email-guess', () => ({
  guessEmailsForRunCompany: runGuessMock,
}));

vi.mock('@temporalio/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/activity')>()),
  heartbeat: vi.fn(),
}));

interface FakeCompany {
  id: string;
  name: string;
  domain: string | null;
  country: string | null;
  status: string;
  dedupeKey: string;
  attributes?: Record<string, unknown>;
}

function makeDeps(opts: {
  companies: FakeCompany[];
  contactsByCompany?: Record<string, ProviderContactRecord[]>;
  adapters: ContactDiscoveryAdapter[];
  remainingMicrousd?: bigint;
  /** status() reports exhausted from this call on (1-based), like the real account hitting zero. */
  exhaustAfterStatusCalls?: number;
  decisionMakerConfig?: unknown;
  emailGuessStatus?: 'ENABLED' | 'DISABLED' | null;
  verifiers?: EmailVerificationAdapter[];
}) {
  let remaining = opts.remainingMicrousd ?? 10_000_000n;
  let statusCalls = 0;
  const companyById = new Map(opts.companies.map((company) => [company.id, company]));
  const tx = {
    $queryRaw: async () => [{ locked: 'ok' }],
    discoveryCompanyMaterializationOutcome: {
      findMany: async () => opts.companies.map((company) => ({ canonicalCompanyId: company.id })),
    },
    lead: {
      findMany: async ({ take }: { take?: number }) =>
        opts.companies
          .slice(0, take ?? opts.companies.length)
          .map((company) => ({ canonicalCompanyId: company.id })),
    },
    canonicalCompany: {
      findUnique: async ({ where }: { where: { id: string } }) => companyById.get(where.id) ?? null,
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in
          .map((id) => companyById.get(id))
          .filter((company): company is FakeCompany => Boolean(company))
          .map((company) => ({ id: company.id, domain: company.domain })),
      updateMany: async () => ({ count: 0 }),
    },
    canonicalContact: {
      findMany: async ({ where }: { where: { companyId: string } }) =>
        (opts.contactsByCompany?.[where.companyId] ?? []).map((contact) => ({
          id: contact.externalId,
          fullName: contact.fullName,
          contactPoints: [],
        })),
    },
    fieldEvidence: { findMany: async () => [], create: async () => ({}) },
    suppressionRecord: { findMany: async () => [] },
    usageLedger: { create: async () => ({}) },
  };
  const prisma = {
    dataProvider: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        if (where.key === 'decision_maker') {
          return { config: opts.decisionMakerConfig ?? { lawfulBasis: GLOBAL_LIA } };
        }
        if (where.key === 'email_guess') {
          return opts.emailGuessStatus === null || opts.emailGuessStatus === undefined
            ? null
            : { status: opts.emailGuessStatus };
        }
        return null;
      },
    },
    withWorkspace: async <T>(_ws: string, fn: (tx: unknown) => Promise<T>): Promise<T> => fn(tx),
  };
  const providers = {
    routeContactDiscovery: async () => opts.adapters,
    routeEmailVerification: async () => opts.verifiers ?? [],
  };
  const budgetStore = {
    attestAuthorized: async (input: { authorityId: string }) => ({
      accountId: '40000000-0000-4000-8000-000000000004',
      authorityId: input.authorityId,
      authorizedCapMicrousd: 10_000_000n,
      generation: 1,
    }),
    status: async () => {
      statusCalls += 1;
      return {
        remainingMicrousd: remaining,
        exhausted:
          opts.exhaustAfterStatusCalls !== undefined &&
          statusCalls > opts.exhaustAfterStatusCalls,
        open: true,
      };
    },
  } as unknown as BudgetStore;
  const drain = (microusd: bigint) => {
    remaining -= microusd;
  };
  return {
    deps: { prisma, providers, gateway: {}, budgetStore } as unknown as Parameters<
      typeof createDiscoveryActivities
    >[0],
    drain,
    remaining: () => remaining,
  };
}

function contactAdapter(
  key: string,
  options?: { drain?: () => void; contacts?: ProviderContactRecord[] },
): ContactDiscoveryAdapter & { discoverContacts: ReturnType<typeof vi.fn> } {
  const adapter = {
    key,
    classes: ['contact_discovery'],
    discoverContacts: vi.fn(async () => {
      options?.drain?.();
      return { contacts: options?.contacts ?? [], costCents: 0 };
    }),
  };
  return adapter as unknown as ContactDiscoveryAdapter & {
    discoverContacts: ReturnType<typeof vi.fn>;
  };
}

function company(id: string): FakeCompany {
  return {
    id,
    name: `Acme ${id}`,
    domain: 'acme.de',
    country: 'DE',
    status: 'ACTIVE',
    dedupeKey: `acme-${id}.de`,
    attributes: {},
  };
}

function args(extra: Record<string, unknown> = {}) {
  return {
    workspaceId: WS,
    runId: RUN_ID,
    icpId: 'icp-1',
    executionContractVersion: 2 as const,
    executionBudget: DISCOVERY_BINDING,
    ...extra,
  };
}

const CONTACT_RECORD: ProviderContactRecord = {
  externalId: 'ct1',
  fullName: 'Hans Herold',
  title: 'Geschäftsführer',
  personalData: true,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('discoverRunContacts —— D7 独立预算子账户', () => {
  it('按 run 派生 contact.discovery 账户，上限 = 每家 × 公司数，撞顶即停并上报 budgetTruncated', async () => {
    const adapter = contactAdapter('decision_maker');
    const harness = makeDeps({
      companies: [company('c1'), company('c2'), company('c3')],
      adapters: [adapter],
    });
    adapter.discoverContacts.mockImplementation(async () => {
      harness.drain(100_000n);
      return { contacts: [CONTACT_RECORD], costCents: 0 };
    });

    const result = await createDiscoveryActivities(harness.deps).discoverRunContacts(args());

    // 3 家 → 上限 3 × $0.0625 = $0.1875；每家用 $0.10 → 第 3 家不再启动。
    expect(adapter.discoverContacts).toHaveBeenCalledTimes(2);
    expect(result.companies).toBe(2);
    expect(result.budgetTruncated).toBe(true);
    expect(result.contactBudget).toMatchObject({
      accountKey: `contact.discovery:${RUN_ID}`,
      capMicrousd: '187500',
      exhausted: true,
    });
    expect(result.contactBudget?.spentMicrousd).toBe('200000');
  });

  it('公司数减少时上限同步收缩：2 家 × $0.0625 = $0.125，最后一家跑完才撞顶不算截断', async () => {
    const adapter = contactAdapter('decision_maker');
    const harness = makeDeps({
      companies: [company('c1'), company('c2')],
      adapters: [adapter],
    });
    adapter.discoverContacts.mockImplementation(async () => {
      harness.drain(100_000n);
      return { contacts: [CONTACT_RECORD], costCents: 0 };
    });

    const result = await createDiscoveryActivities(harness.deps).discoverRunContacts(args());

    expect(adapter.discoverContacts).toHaveBeenCalledTimes(2);
    expect(result.companies).toBe(2);
    // 全部目标公司都跑过：撞顶发生在最后一家 → 没有漏活，不上报截断。
    expect(result.budgetTruncated).toBe(false);
    expect(result.contactBudget?.capMicrousd).toBe('125000');
    expect(result.contactBudget?.exhausted).toBe(true);
  });

  it('单家公司内子账户撞顶 → 后续 adapter 不再调用，并上报截断', async () => {
    const first = contactAdapter('decision_maker');
    const second = contactAdapter('social_presence');
    const harness = makeDeps({
      companies: [company('c1')],
      adapters: [first, second],
    });
    first.discoverContacts.mockImplementation(async () => {
      harness.drain(70_000n); // 单家上限 $0.0625 → 70k microusd 已撞顶
      return { contacts: [CONTACT_RECORD], costCents: 0 };
    });

    const result = await createDiscoveryActivities(harness.deps).discoverRunContacts(args());

    expect(first.discoverContacts).toHaveBeenCalledTimes(1);
    expect(second.discoverContacts).not.toHaveBeenCalled();
    expect(result.budgetTruncated).toBe(true);
    expect(result.contactBudget?.exhausted).toBe(true);
  });

  it('run 账户自身耗尽 → 沿用原口径 budgetTruncated，停止后续公司', async () => {
    const adapter = contactAdapter('decision_maker');
    const harness = makeDeps({
      companies: [company('c1'), company('c2')],
      adapters: [adapter],
      // core 每家一次 + 活动每家一次 status：第 2 次（活动）起报耗尽 → 第 1 家处理完即停。
      exhaustAfterStatusCalls: 1,
    });

    const result = await createDiscoveryActivities(harness.deps).discoverRunContacts(args());

    expect(adapter.discoverContacts).toHaveBeenCalledTimes(1);
    expect(result.companies).toBe(1);
    expect(result.budgetTruncated).toBe(true);
  });
});

describe('discoverRunContacts —— email_guess M3 双闸接线', () => {
  it('kill switch DISABLED → 不调用邮箱补全（即使 lawfulBasis 已配置）', async () => {
    const adapter = contactAdapter('decision_maker', { contacts: [CONTACT_RECORD] });
    const harness = makeDeps({
      companies: [company('c1')],
      adapters: [adapter],
      emailGuessStatus: 'DISABLED',
      verifiers: [{ key: 'smtp_self', verifyEmail: vi.fn() } as unknown as EmailVerificationAdapter],
    });

    const result = await createDiscoveryActivities(harness.deps).discoverRunContacts(args());

    expect(runGuessMock).not.toHaveBeenCalled();
    expect(result.emailGuess).toBeUndefined();
  });

  it('双闸通过 → 每公司一次、≤6 探测额度、沿用全局 interim basis', async () => {
    runGuessMock.mockResolvedValue({
      emaillessContacts: 1,
      attempted: 1,
      probes: 2,
      persisted: 1,
      verified: 0,
      risky: 1,
      blocked: 0,
    });
    const adapter = contactAdapter('decision_maker', { contacts: [CONTACT_RECORD] });
    const harness = makeDeps({
      companies: [company('c1'), company('c2')],
      contactsByCompany: { c1: [CONTACT_RECORD], c2: [] },
      adapters: [adapter],
      emailGuessStatus: 'ENABLED',
      verifiers: [{ key: 'smtp_self', verifyEmail: vi.fn() } as unknown as EmailVerificationAdapter],
    });

    const result = await createDiscoveryActivities(harness.deps).discoverRunContacts(args());

    expect(runGuessMock).toHaveBeenCalledTimes(2);
    const firstCall = runGuessMock.mock.calls[0]![1] as {
      workspaceId: string;
      runId: string;
      accountKey: string;
      companyId: string;
      domain: string;
      maxProbes: number;
      lawfulBasis: { basis: string; recordedBy?: string };
      contacts: Array<{ id: string; fullName: string }>;
    };
    expect(firstCall.workspaceId).toBe(WS);
    expect(firstCall.runId).toBe(RUN_ID);
    expect(firstCall.accountKey).toBe(DISCOVERY_BINDING.accountKey);
    expect(firstCall.companyId).toBe('c1');
    expect(firstCall.domain).toBe('acme.de');
    expect(firstCall.maxProbes).toBe(6);
    expect(firstCall.lawfulBasis).toMatchObject({
      basis: 'legitimate_interest',
      ref: 'OWNER-DECISION-2026-10-11',
      recordedBy: `discovery-run:${RUN_ID}`,
    });
    expect(firstCall.contacts).toEqual([{ id: 'ct1', fullName: 'Hans Herold', contactPoints: [] }]);

    // 两家各自的补全结果聚合进 contacts stats。
    expect(result.emailGuess).toMatchObject({
      enabled: true,
      attempted: 2,
      probes: 4,
      persisted: 2,
      verified: 0,
      risky: 2,
      blocked: 0,
    });
  });

  it('kill switch 开但无验证器 → 跳过补全，不失败', async () => {
    const adapter = contactAdapter('decision_maker', { contacts: [CONTACT_RECORD] });
    const harness = makeDeps({
      companies: [company('c1')],
      contactsByCompany: { c1: [CONTACT_RECORD] },
      adapters: [adapter],
      emailGuessStatus: 'ENABLED',
      verifiers: [],
    });

    const result = await createDiscoveryActivities(harness.deps).discoverRunContacts(args());

    expect(runGuessMock).not.toHaveBeenCalled();
    expect(result.companies).toBe(1);
  });

  it('补全抛错不影响公司级联系人结果（best-effort）', async () => {
    runGuessMock.mockRejectedValue(new Error('smtp blew up'));
    const adapter = contactAdapter('decision_maker', { contacts: [CONTACT_RECORD] });
    const harness = makeDeps({
      companies: [company('c1')],
      contactsByCompany: { c1: [CONTACT_RECORD] },
      adapters: [adapter],
      emailGuessStatus: 'ENABLED',
      verifiers: [{ key: 'smtp_self', verifyEmail: vi.fn() } as unknown as EmailVerificationAdapter],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await createDiscoveryActivities(harness.deps).discoverRunContacts(args());

    expect(result.companies).toBe(1);
    expect(result.people).toBe(1);
    expect(result.failed).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
