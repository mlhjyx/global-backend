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
 *  - 上限 = min(每家上限 × 本轮公司数, 整轮上限)（D5 重校 2026-11-02：每家 20¢、封顶 $2），撞顶即停；
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
  /** Reads the run's admission lease (milliseconds left); absent → unbounded. */
  runLease?: () => Promise<number>;
  /** suppression_record 行（A1 公司级渠道过滤用）。 */
  suppressions?: { type: string; value: string }[];
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
    suppressionRecord: { findMany: async () => opts.suppressions ?? [] },
    companyContactChannel: { upsert: vi.fn(async () => ({})) },
    usageLedger: { create: async () => ({}) },
    personalDataAccessAudit: { create: async () => ({}) },
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
    deps: {
      prisma,
      providers,
      gateway: {},
      budgetStore,
      ...(opts.runLease ? { runLease: opts.runLease } : {}),
    } as unknown as Parameters<
      typeof createDiscoveryActivities
    >[0],
    drain,
    remaining: () => remaining,
    channelUpsert: tx.companyContactChannel.upsert,
  };
}

function contactAdapter(
  key: string,
  options?: {
    drain?: () => void;
    contacts?: ProviderContactRecord[];
    channels?: import('../discovery/company-contact-channel').CompanyChannelInput[];
  },
): ContactDiscoveryAdapter & { discoverContacts: ReturnType<typeof vi.fn> } {
  const adapter = {
    key,
    classes: ['contact_discovery'],
    discoverContacts: vi.fn(async () => {
      options?.drain?.();
      return {
        contacts: options?.contacts ?? [],
        costCents: 0,
        ...(options?.channels?.length ? { companyChannels: options.channels } : {}),
      };
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
  it('按 run 派生 contact.discovery 账户，上限 = 每家 × 公司数（整轮封顶 $2），未撞顶则全部跑完', async () => {
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

    // D5 重校（2026-11-02）：3 家 → 上限 min(3 × $0.20, $2) = $0.60；每家用 $0.10 → 全部 3 家跑完，
    // 花费 $0.30 未撞顶。
    expect(adapter.discoverContacts).toHaveBeenCalledTimes(3);
    expect(result.companies).toBe(3);
    expect(result.budgetTruncated).toBe(false);
    expect(result.contactBudget).toMatchObject({
      accountKey: `contact.discovery:${RUN_ID}`,
      capMicrousd: '600000',
      exhausted: false,
    });
    expect(result.contactBudget?.spentMicrousd).toBe('300000');
  });

  it('公司数减少时上限同步收缩：2 家 × $0.20 = $0.40，最后一家跑完才撞顶不算截断', async () => {
    const adapter = contactAdapter('decision_maker');
    const harness = makeDeps({
      companies: [company('c1'), company('c2')],
      adapters: [adapter],
    });
    adapter.discoverContacts.mockImplementation(async () => {
      harness.drain(250_000n); // 每家 $0.25 → 2 家共 $0.50，超出 $0.40 上限
      return { contacts: [CONTACT_RECORD], costCents: 0 };
    });

    const result = await createDiscoveryActivities(harness.deps).discoverRunContacts(args());

    expect(adapter.discoverContacts).toHaveBeenCalledTimes(2);
    expect(result.companies).toBe(2);
    // 撞顶发生在最后一家跑完之后 → 没有漏掉任何公司，不上报截断（截断只表示「有活被跳过」）。
    expect(result.budgetTruncated).toBe(false);
    expect(result.contactBudget).toMatchObject({ capMicrousd: '400000', exhausted: true });
    expect(result.contactBudget?.spentMicrousd).toBe('500000');
  });

  it('单家公司内子账户撞顶 → 后续 adapter 不再调用，并上报截断', async () => {
    const first = contactAdapter('decision_maker');
    const second = contactAdapter('social_presence');
    const harness = makeDeps({
      companies: [company('c1')],
      adapters: [first, second],
    });
    first.discoverContacts.mockImplementation(async () => {
      harness.drain(250_000n); // 单家上限 $0.20 → 250k microusd 已撞顶
      return { contacts: [CONTACT_RECORD], costCents: 0 };
    });

    const result = await createDiscoveryActivities(harness.deps).discoverRunContacts(args());

    expect(first.discoverContacts).toHaveBeenCalledTimes(1);
    expect(second.discoverContacts).not.toHaveBeenCalled();
    expect(result.budgetTruncated).toBe(true);
    expect(result.contactBudget).toMatchObject({ capMicrousd: '200000', exhausted: true });
    expect(result.contactBudget?.spentMicrousd).toBe('250000');
  });

  it('run 账户自身耗尽 → 沿用原口径 budgetTruncated，停止后续公司', async () => {
    const adapter = contactAdapter('decision_maker');
    const harness = makeDeps({
      companies: [company('c1'), company('c2'), company('c3')],
      adapters: [adapter],
      // status 调用序：基线 #1 → 第 1 家开工复读 #2（ok）→ core 内每家一次 #3（耗尽）；
      // 第 2 家的开工复读起全部报耗尽 → 只跑第 1 家。
      exhaustAfterStatusCalls: 2,
    });

    const result = await createDiscoveryActivities(harness.deps).discoverRunContacts(args());

    expect(adapter.discoverContacts).toHaveBeenCalledTimes(1);
    expect(result.companies).toBe(1);
    expect(result.budgetTruncated).toBe(true);
  });

  it('24 分钟软时限到点后不再开工新公司（30 分钟活动窗口保护）', async () => {
    const adapter = contactAdapter('decision_maker');
    const harness = makeDeps({
      companies: [company('c1'), company('c2'), company('c3')],
      adapters: [adapter],
    });
    let fakeNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    try {
      adapter.discoverContacts.mockImplementation(async () => {
        fakeNow += 25 * 60_000; // 每家用掉 25 分钟：第 3 家开工前已越过 24 分钟软时限
        return { contacts: [CONTACT_RECORD], costCents: 0 };
      });

      const result = await createDiscoveryActivities(harness.deps).discoverRunContacts(args());

      // 并发 2：c1、c2 同时开工（都在时限前），完成后 c3 不再开工，但已跑的两家结果照常返回。
      expect(adapter.discoverContacts).toHaveBeenCalledTimes(2);
      expect(result.companies).toBe(2);
      expect(result.budgetTruncated).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('准入租约无余量 → 不开工新公司、计 skippedForLease（收口 PARTIAL 而不是 FAILED）', async () => {
    const adapter = contactAdapter('decision_maker');
    const harness = makeDeps({
      companies: [company('c1'), company('c2'), company('c3')],
      adapters: [adapter],
      // 剩余 60 秒 < 最终保留 10 分钟 → 任何一家都放不进租约。
      runLease: async () => 60_000,
    });

    const result = await createDiscoveryActivities(harness.deps).discoverRunContacts(args());

    expect(adapter.discoverContacts).not.toHaveBeenCalled();
    expect(result.companies).toBe(0);
    expect(result.skippedForLease).toBe(3);
    expect(result.budgetTruncated).toBe(false);
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
      failed: 0,
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
      domain: string;
      maxProbes: number;
      lawfulBasis: { basis: string; recordedBy?: string };
      contacts: Array<{ id: string; fullName: string }>;
    };
    expect(firstCall.workspaceId).toBe(WS);
    expect(firstCall.runId).toBe(RUN_ID);
    expect(firstCall.accountKey).toBe(DISCOVERY_BINDING.accountKey);
    expect(firstCall.domain).toBe('acme.de');
    expect(firstCall.maxProbes).toBe(6);
    expect(firstCall.lawfulBasis).toMatchObject({
      basis: 'legitimate_interest',
      ref: 'OWNER-DECISION-2026-10-11',
      recordedBy: `discovery-run:${RUN_ID}`,
    });
    expect(firstCall.contacts).toEqual([{ id: 'ct1', fullName: 'Hans Herold', contactPoints: [] }]);

    // 两家各自的补全结果聚合进 contacts stats；落库的猜测邮箱计入 contacts.emails。
    expect(result.emailGuess).toMatchObject({
      enabled: true,
      emaillessContacts: 2,
      attempted: 2,
      probes: 4,
      persisted: 2,
      verified: 0,
      risky: 2,
      blocked: 0,
      failed: 0,
    });
    expect(result.emails).toBe(2);
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

  it('非 smtp_self 验证器（public_web 只剩 MX）不得服务自动补全', async () => {
    const adapter = contactAdapter('decision_maker', { contacts: [CONTACT_RECORD] });
    const harness = makeDeps({
      companies: [company('c1')],
      contactsByCompany: { c1: [CONTACT_RECORD] },
      adapters: [adapter],
      emailGuessStatus: 'ENABLED',
      verifiers: [{ key: 'public_web', verifyEmail: vi.fn() } as unknown as EmailVerificationAdapter],
    });

    const result = await createDiscoveryActivities(harness.deps).discoverRunContacts(args());

    expect(runGuessMock).not.toHaveBeenCalled();
    expect(result.emailGuess).toBeUndefined();
  });

  it('run 账户耗尽后，本公司的邮箱补全也不再发起（探测不落在已耗尽的账本上）', async () => {
    runGuessMock.mockResolvedValue({
      emaillessContacts: 0,
      attempted: 0,
      probes: 0,
      persisted: 0,
      verified: 0,
      risky: 0,
      blocked: 0,
      failed: 0,
    });
    const adapter = contactAdapter('decision_maker', { contacts: [CONTACT_RECORD] });
    const harness = makeDeps({
      companies: [company('c1')],
      contactsByCompany: { c1: [CONTACT_RECORD] },
      adapters: [adapter],
      emailGuessStatus: 'ENABLED',
      verifiers: [{ key: 'smtp_self', verifyEmail: vi.fn() } as unknown as EmailVerificationAdapter],
      // 基线 #1、开工复读 #2 均 ok；core 内 #3 报耗尽 → 公司跑完后不再发起邮箱补全。
      exhaustAfterStatusCalls: 2,
    });

    const result = await createDiscoveryActivities(harness.deps).discoverRunContacts(args());

    expect(runGuessMock).not.toHaveBeenCalled();
    expect(result.budgetTruncated).toBe(true);
  });

  it('美元子预算耗尽不影响零成本的邮箱补全；最后一家跑完不算截断', async () => {
    runGuessMock.mockResolvedValue({
      emaillessContacts: 1,
      attempted: 1,
      probes: 1,
      persisted: 1,
      verified: 0,
      risky: 1,
      blocked: 0,
      failed: 0,
    });
    const adapter = contactAdapter('decision_maker');
    const harness = makeDeps({
      companies: [company('c1')],
      contactsByCompany: { c1: [CONTACT_RECORD] },
      adapters: [adapter],
      emailGuessStatus: 'ENABLED',
      verifiers: [{ key: 'smtp_self', verifyEmail: vi.fn() } as unknown as EmailVerificationAdapter],
    });
    adapter.discoverContacts.mockImplementation(async () => {
      harness.drain(250_000n); // 单家上限 $0.20 → 这家已超过上限，但所有 adapter 都跑完了
      return { contacts: [CONTACT_RECORD], costCents: 0 };
    });

    const result = await createDiscoveryActivities(harness.deps).discoverRunContacts(args());

    expect(runGuessMock).toHaveBeenCalledTimes(1);
    expect(result.budgetTruncated).toBe(false);
    expect(result.contactBudget?.exhausted).toBe(true);
    expect(result.emailGuess?.persisted).toBe(1);
    expect(result.emails).toBe(1);
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
    expect(result.emailGuess?.failed).toBe(1);
    expect(warn).toHaveBeenCalled();
  });
});

describe('A1 —— 公司级渠道（company_contact_channel）', () => {
  it('经 suppression 过滤后同事务 upsert：email 禁联与 domain 禁联都丢弃', async () => {
    const adapter = contactAdapter('public_web', {
      channels: [
        { channel: 'email', value: 'info@acme.de', emailType: 'role', sourceType: 'impressum', sourceUrl: 'https://acme.de/impressum' },
        { channel: 'email', value: 'blocked@acme.de', emailType: 'role', sourceType: 'impressum' },
        { channel: 'email', value: 'anfrage@blocked.acme.de', emailType: 'role', sourceType: 'impressum' },
        { channel: 'phone', value: '+49891234567', sourceType: 'impressum' },
      ],
    });
    const harness = makeDeps({
      companies: [company('c1')],
      adapters: [adapter],
      suppressions: [
        { type: 'email', value: 'blocked@acme.de' },
        { type: 'domain', value: 'blocked.acme.de' },
      ],
    });

    await createDiscoveryActivities(harness.deps).discoverRunContacts(args());

    expect(harness.channelUpsert).toHaveBeenCalledTimes(2);
    const values = harness.channelUpsert.mock.calls.map(
      ([arg]) => (arg as { create: { value: string } }).create.value,
    );
    expect(values).toEqual(['info@acme.de', '+49891234567']);
    expect(harness.channelUpsert.mock.calls[0]![0]).toMatchObject({
      where: {
        workspaceId_companyId_channel_value: {
          workspaceId: WS,
          companyId: 'c1',
          channel: 'email',
          value: 'info@acme.de',
        },
      },
    });
  });

  it('公司被抑制（persist 返回 suppressed）时不写公司级渠道', async () => {
    const adapter = contactAdapter('public_web', {
      channels: [{ channel: 'email', value: 'info@acme.de', emailType: 'role', sourceType: 'impressum' }],
    });
    const harness = makeDeps({ companies: [company('c1')], adapters: [adapter] });
    persistMock.mockResolvedValueOnce({ created: 0, merged: 0, skippedSuppressed: 0, skippedInvalid: 0, suppressed: true });

    await createDiscoveryActivities(harness.deps).discoverRunContacts(args());

    expect(harness.channelUpsert).not.toHaveBeenCalled();
  });

  it('adapter 不返回公司级渠道时不写表', async () => {
    const adapter = contactAdapter('decision_maker', { contacts: [CONTACT_RECORD] });
    const harness = makeDeps({ companies: [company('c1')], adapters: [adapter] });

    await createDiscoveryActivities(harness.deps).discoverRunContacts(args());

    expect(harness.channelUpsert).not.toHaveBeenCalled();
  });
});
