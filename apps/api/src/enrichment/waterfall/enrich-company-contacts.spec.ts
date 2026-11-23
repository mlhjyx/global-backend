import { describe, expect, it, vi } from 'vitest';
import type { EmailEnrichmentAdapter, FindEmailInput, FindEmailOutcome } from '../finders/email-enrichment-provider';
import { enrichmentRequestHash } from '../finders/email-enrichment-provider';
import type { EmailVerificationProvider, EmailVerificationProviderResult } from '../verification/email-verification-provider';
import type { EmailVerificationState } from '../../discovery/contact-point-verification-state';
import { CapBudget, CompositeBudget, DEFAULT_PER_CONTACT_CAP_MICROUSD } from './enrichment-budget';
import { enrichCompanyContacts, loadContactEnrichmentTargets, loadCompanyContactEnrichmentTier, reachableContactEnrichmentFinders, type EnrichCompanyContactsDeps } from './enrich-company-contacts';
import { enrichContactEmail } from './enrich-contact-email';
import { emptyCircuitState } from './circuit-breaker';
import { checkProviderGates } from '../provider-gates';
import { HunterProvider } from '../finders/hunter.provider';
import { FindymailProvider } from '../finders/findymail.provider';
import { MillionVerifierProvider } from '../verification/millionverifier.provider';

/**
 * P1-10：公司级富集核心——形状上限（≤10 联系人、每公司 ≤10 finder 调用、软截止）、
 * A 档尾池路由、预算透传与逐联系人状态汇总。假 prisma/ownerPrisma + 假 provider，零出网。
 */
const NOW = new Date('2026-11-09T12:00:00.000Z');
const WORKSPACE = '00000000-0000-4000-8000-0000000000aa';
const COMPANY = '00000000-0000-4000-8000-0000000000cc';
const CONTACT_1 = '00000000-0000-4000-8000-0000000000d1';
const CONTACT_2 = '00000000-0000-4000-8000-0000000000d2';

function fakeWorld(options: {
  domain?: string | null;
  contacts?: Array<{ id: string; fullName: string }>;
  topLead?: { id: string } | null;
  suppressionHit?: boolean;
  /** data_provider 门关闭的 provider key（其余 ENABLED）。 */
  gateClosedKeys?: string[];
  /** 公司/域名级抑制行（合规门命中 → 零调用）。 */
  suppressionRows?: Array<{ type: string; value: string }>;
}) {
  const attemptCreates: Array<Record<string, unknown>> = [];
  const pointUpserts: Array<Record<string, unknown>> = [];
  const pointUpdates: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const tx = {
    $executeRawUnsafe: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ locked: 'true' }]),
    canonicalCompany: {
      findUnique: vi.fn(async () => ({
        id: COMPANY,
        name: 'Acme GmbH',
        domain: options.domain === undefined ? 'acme.example' : options.domain,
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    canonicalContact: {
      findUnique: vi.fn(async () => ({
        fullName: 'Jürgen Müller',
        company: {
          id: COMPANY,
          name: 'Acme GmbH',
          domain: 'acme.example',
          status: 'ACTIVE',
          dedupeKey: 'acme',
          attributes: {},
        },
      })),
      findMany: vi.fn(async () => options.contacts ?? []),
    },
    lead: { findFirst: vi.fn(async () => options.topLead ?? null) },
    suppressionRecord: {
      findMany: vi.fn(async () => options.suppressionRows ?? []),
      findFirst: vi.fn(async () => (options.suppressionHit ? { id: 's-1' } : null)),
    },
    contactPoint: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
        pointUpserts.push(create);
        return { id: `point-${pointUpserts.length}`, verificationState: 'UNKNOWN', validSince: null, nextReverifyAt: null };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        pointUpdates.push(data);
        return { id: 'point-1' };
      }),
    },
    contactPointVerificationEvent: {
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return { id: `event-${events.length}` };
      }),
      findUnique: vi.fn(async () => null),
    },
    contactEnrichmentAttempt: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        attemptCreates.push(data);
        return {
          id: `attempt-${attemptCreates.length}`,
          providerKey: data.providerKey as string,
          requestHash: data.requestHash as string,
          outcome: data.outcome as string,
          errorCode: (data.errorCode as string | null) ?? null,
          emailState: (data.emailState as string | null) ?? null,
          costMicrousd: data.costMicrousd as bigint,
          attemptedAt: (data.attemptedAt as Date | undefined) ?? NOW,
        };
      }),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        id: where.id,
        ...data,
      })),
    },
  };
  const prisma = {
    withWorkspace: vi.fn(async (_workspaceId: string, fn: (client: unknown) => Promise<unknown>) => fn(tx)),
  };
  const ownerPrisma = {
    dataProvider: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => ({
        status: options.gateClosedKeys?.includes(where.key) ? 'DISABLED' : 'ENABLED',
        config: null,
      })),
    },
    sourcePolicy: { findUnique: vi.fn(async () => ({ reviewStatus: 'APPROVED', allowedPurpose: ['enrichment'] })) },
  };
  return { prisma, ownerPrisma, tx, attemptCreates, pointUpserts, pointUpdates, events };
}

interface FinderHandle {
  adapter: EmailEnrichmentAdapter;
  calls: FindEmailInput[];
}

function finder(
  key: EmailEnrichmentAdapter['key'],
  outcome: FindEmailOutcome | ((input: FindEmailInput) => FindEmailOutcome),
  trace?: string[],
): FinderHandle {
  const calls: FindEmailInput[] = [];
  const adapter: EmailEnrichmentAdapter = {
    key,
    domain: `api.${key}.io`,
    class: 'b2b_company_person',
    costMicrousd: 10_000,
    isConfigured: () => true,
    requestHash: (input) => enrichmentRequestHash(input.contactId, key, input),
    findEmail: async (input) => {
      calls.push(input);
      trace?.push(`${key}:${input.contactId}`);
      return typeof outcome === 'function' ? outcome(input) : outcome;
    },
  };
  return { adapter, calls };
}

const hit = (email: string): FindEmailOutcome => ({
  status: 'hit',
  hit: { email, raw: { provider: 'fixture' } },
  costMicrousd: 10_000,
  latencyMs: 10,
});
const miss = (): FindEmailOutcome => ({ status: 'miss', costMicrousd: 0, latencyMs: 5, detail: 'no_match' });

function verifier(key: string, state: EmailVerificationState, trace?: string[]): EmailVerificationProvider {
  return {
    key,
    domain: `api.${key}.io`,
    isConfigured: () => true,
    verify: async (): Promise<EmailVerificationProviderResult> => {
      trace?.push(key);
      return {
        providerKey: key,
        state,
        catchAll: state === 'CATCH_ALL_RISKY' ? 'catch_all' : state === 'UNKNOWN' ? 'unknown' : 'not_catch_all',
        catchAllClass: state === 'CATCH_ALL_RISKY' ? 'true_catch_all' : state === 'UNKNOWN' ? 'unknown' : 'not_catch_all',
        score: 0,
        acceptAll: state === 'CATCH_ALL_RISKY' ? true : false,
        disposable: null,
        role: null,
        detail: `fixture:${state}`,
        error: null,
        costMicrousd: 1_000,
        latencyMs: 5,
      };
    },
  };
}

function depsFor(
  world: ReturnType<typeof fakeWorld>,
  finders: FinderHandle[],
  overrides: Partial<EnrichCompanyContactsDeps> = {},
): EnrichCompanyContactsDeps {
  return {
    prisma: world.prisma as never,
    ownerPrisma: world.ownerPrisma as never,
    finders: finders.map((handle) => handle.adapter),
    verifiers: [verifier('millionverifier', 'VALID'), verifier('emailable', 'VALID')],
    clock: () => NOW,
    ...overrides,
  };
}

const INPUT = {
  workspaceId: WORKSPACE,
  companyId: COMPANY,
  accountKey: 'acct-1',
  lawfulBasis: { basis: 'legitimate_interest' as const },
};

describe('enrichCompanyContacts：跳过与形状', () => {
  it('公司无域 → skipped=no_domain；无缺邮箱联系人 → skipped=no_contacts', async () => {
    const noDomain = fakeWorld({ domain: null });
    expect(
      await enrichCompanyContacts(depsFor(noDomain, [finder('hunter', miss())]), INPUT),
    ).toMatchObject({ skipped: 'no_domain', attempted: 0 });

    const noContacts = fakeWorld({ contacts: [] });
    expect(
      await enrichCompanyContacts(depsFor(noContacts, [finder('hunter', miss())]), INPUT),
    ).toMatchObject({ skipped: 'no_contacts', attempted: 0 });
  });

  it('B 档（无 A 档 lead）：只走主池；缺 tail 时 tier=B', async () => {
    const world = fakeWorld({ contacts: [{ id: CONTACT_1, fullName: 'Jürgen Müller' }] });
    const hunter = finder('hunter', hit('juergen.mueller@acme.example'));
    const apollo = finder('apollo', hit('x@acme.example'));
    const result = await enrichCompanyContacts(
      depsFor(world, [hunter], { tailFinders: [apollo.adapter] }),
      INPUT,
    );
    expect(result).toMatchObject({ tier: 'B', attempted: 1 });
    expect(result.results[0]).toMatchObject({ contactId: CONTACT_1, status: 'stored' });
    expect(hunter.calls).toHaveLength(1);
    expect(apollo.calls).toHaveLength(0);
    expect(world.pointUpserts[0]).toMatchObject({ sourceType: 'provider' });
    expect(result.costMicrousd).toBe(12_000);
  });

  it('A 档（lead.totalScore ≥80）：主池 miss 后追加 Apollo 尾池', async () => {
    const world = fakeWorld({
      contacts: [{ id: CONTACT_1, fullName: 'Jürgen Müller' }],
      topLead: { id: 'lead-1' },
    });
    const hunter = finder('hunter', miss());
    const apollo = finder('apollo', hit('j.mueller@acme.example'));
    const result = await enrichCompanyContacts(
      depsFor(world, [hunter], { tailFinders: [apollo.adapter] }),
      INPUT,
    );
    expect(result).toMatchObject({ tier: 'A', attempted: 1 });
    expect(result.results[0]).toMatchObject({ status: 'stored' });
    expect(hunter.calls).toHaveLength(1);
    expect(apollo.calls).toHaveLength(1);
  });
});

describe('enrichCompanyContacts：上限与截止', () => {
  it('每公司 finder 调用上限：用尽后剩余联系人 skipped_company_cap', async () => {
    const world = fakeWorld({
      contacts: [
        { id: CONTACT_1, fullName: 'Jürgen Müller' },
        { id: CONTACT_2, fullName: 'Anna Schmidt' },
      ],
    });
    const hunter = finder('hunter', miss());
    const result = await enrichCompanyContacts(depsFor(world, [hunter]), {
      ...INPUT,
      maxFinderCallsPerCompany: 1,
    });
    expect(result.results.map((entry) => entry.status)).toEqual(['not_found', 'skipped_company_cap']);
    expect(hunter.calls).toHaveLength(1);
  });

  it('软截止到期 → 剩余联系人 skipped_deadline（不发起新调用）', async () => {
    const world = fakeWorld({
      contacts: [
        { id: CONTACT_1, fullName: 'Jürgen Müller' },
        { id: CONTACT_2, fullName: 'Anna Schmidt' },
      ],
    });
    const hunter = finder('hunter', hit('juergen.mueller@acme.example'));
    const result = await enrichCompanyContacts(depsFor(world, [hunter]), {
      ...INPUT,
      deadlineAtMs: NOW.getTime() - 1,
    });
    expect(result.deadlineHit).toBe(true);
    expect(result.results.every((entry) => entry.status === 'skipped_deadline')).toBe(true);
    expect(hunter.calls).toHaveLength(0);
  });

  it('预算为 0 → 联系人 skipped_budget（不发请求），attempt 记 skipped_budget', async () => {
    const world = fakeWorld({ contacts: [{ id: CONTACT_1, fullName: 'Jürgen Müller' }] });
    const hunter = finder('hunter', hit('juergen.mueller@acme.example'));
    const result = await enrichCompanyContacts(
      depsFor(world, [hunter], { budget: new CapBudget(0) }),
      INPUT,
    );
    expect(result.results[0]).toMatchObject({ status: 'skipped_budget' });
    expect(hunter.calls).toHaveLength(0);
    expect(world.attemptCreates[0]).toMatchObject({ outcome: 'skipped_budget' });
  });
});

const CONTACT_3 = '00000000-0000-4000-8000-0000000000d3';
const CONTACT_4 = '00000000-0000-4000-8000-0000000000d4';
const FOUR_CONTACTS = [
  { id: CONTACT_1, fullName: 'Jürgen Müller' },
  { id: CONTACT_2, fullName: 'Anna Schmidt' },
  { id: CONTACT_3, fullName: 'Peter Weber' },
  { id: CONTACT_4, fullName: 'Sabine Koch' },
];

function circuitsWithOpen(openKeys: string[], openedAt: Date = NOW) {
  const openState = {
    ...emptyCircuitState(),
    status: 'OPEN' as const,
    windowStartedAt: openedAt.toISOString(),
    windowFailures: 5,
    consecutiveFailures: 5,
    openedAt: openedAt.toISOString(),
  };
  return {
    load: vi.fn(async (key: string) => (openKeys.includes(key) ? openState : emptyCircuitState())),
    save: vi.fn(async () => undefined),
  };
}

function callsByContact(handles: FinderHandle[]): Map<string, number> {
  const perContact = new Map<string, number>();
  for (const handle of handles) {
    for (const call of handle.calls) {
      perContact.set(call.contactId, (perContact.get(call.contactId) ?? 0) + 1);
    }
  }
  return perContact;
}

function isOrderedSubsequence(sub: string[], full: string[]): boolean {
  let index = 0;
  for (const item of full) {
    if (index < sub.length && sub[index] === item) index += 1;
  }
  return index === sub.length;
}

/**
 * S2-S0：既有公司 finder 次数帽向单人 core 透传。
 * 修前四人×三家全 miss 会各买 3 次（共 12，越过平台默认 10 帽），末人仍 3 次。
 * 修后总帽 10、末人仅剩余额 1 次；减记仍按真实调用，不事后 clamp。
 */
describe('enrichCompanyContacts：公司帽向单人 core 透传（S2-S0）', () => {
  it('四人×三家全 miss：总 finder=10、末人仅 1 次（修前 12 为功能 RED）', async () => {
    const world = fakeWorld({ contacts: FOUR_CONTACTS });
    const hunter = finder('hunter', miss());
    const findymail = finder('findymail', miss());
    const prospeo = finder('prospeo', miss());
    const result = await enrichCompanyContacts(depsFor(world, [hunter, findymail, prospeo]), INPUT);
    const perContact = callsByContact([hunter, findymail, prospeo]);
    const total = hunter.calls.length + findymail.calls.length + prospeo.calls.length;
    expect(total).toBe(10);
    expect(FOUR_CONTACTS.map((contact) => perContact.get(contact.id) ?? 0)).toEqual([3, 3, 3, 1]);
    expect(result.results.map((entry) => entry.status)).toEqual([
      'not_found',
      'not_found',
      'not_found',
      'not_found',
    ]);
  });

  it('传入公司帽大于平台 10：夹紧到 10，不放大', async () => {
    const world = fakeWorld({ contacts: FOUR_CONTACTS });
    const hunter = finder('hunter', miss());
    const findymail = finder('findymail', miss());
    const prospeo = finder('prospeo', miss());
    await enrichCompanyContacts(depsFor(world, [hunter, findymail, prospeo]), {
      ...INPUT,
      maxFinderCallsPerCompany: 50,
    });
    const total = hunter.calls.length + findymail.calls.length + prospeo.calls.length;
    expect(total).toBe(10);
  });

  it('更小公司帽 1/2 与单人更小帽：全部取最小值，后人沿 skipped_company_cap', async () => {
    {
      const world = fakeWorld({ contacts: [{ id: CONTACT_1, fullName: 'Jürgen Müller' }, { id: CONTACT_2, fullName: 'Anna Schmidt' }] });
      const hunter = finder('hunter', miss());
      const findymail = finder('findymail', miss());
      const prospeo = finder('prospeo', miss());
      const result = await enrichCompanyContacts(depsFor(world, [hunter, findymail, prospeo]), {
        ...INPUT,
        maxFinderCallsPerCompany: 2,
      });
      expect(result.results.map((entry) => entry.status)).toEqual(['not_found', 'skipped_company_cap']);
      expect(finderTotal([hunter, findymail, prospeo])).toBe(2);
    }
    {
      const world = fakeWorld({ contacts: FOUR_CONTACTS.slice(0, 3) });
      const hunter = finder('hunter', miss());
      const findymail = finder('findymail', miss());
      const prospeo = finder('prospeo', miss());
      const result = await enrichCompanyContacts(depsFor(world, [hunter, findymail, prospeo]), {
        ...INPUT,
        maxFinderCallsPerCompany: 3,
        maxProvidersPerContact: 2,
      });
      expect(result.results.map((entry) => entry.status)).toEqual([
        'not_found',
        'not_found',
        'skipped_company_cap',
      ]);
      expect(callsByContact([hunter, findymail, prospeo]).get(CONTACT_1)).toBe(2);
      expect(callsByContact([hunter, findymail, prospeo]).get(CONTACT_2)).toBe(1);
    }
    {
      const world = fakeWorld({ contacts: FOUR_CONTACTS });
      const hunter = finder('hunter', miss());
      const result = await enrichCompanyContacts(depsFor(world, [hunter]), {
        ...INPUT,
        maxProvidersPerContact: 1,
      });
      expect(result.results.map((entry) => entry.status)).toEqual([
        'not_found',
        'not_found',
        'not_found',
        'not_found',
      ]);
      expect(hunter.calls).toHaveLength(4);
    }
  });

  it('gate 关闭/熔断 OPEN 与真实调用交错：只按真实调用减记，attempt 行数不是 wire 数', async () => {
    const world = fakeWorld({ contacts: FOUR_CONTACTS.slice(0, 2), gateClosedKeys: ['hunter'] });
    const hunter = finder('hunter', miss());
    const findymail = finder('findymail', miss());
    const prospeo = finder('prospeo', miss());
    const result = await enrichCompanyContacts(
      depsFor(world, [hunter, findymail, prospeo], { circuits: circuitsWithOpen(['findymail']) as never }),
      { ...INPUT, maxFinderCallsPerCompany: 2 },
    );
    expect(result.results.map((entry) => entry.status)).toEqual(['not_found', 'not_found']);
    expect(hunter.calls).toHaveLength(0);
    expect(findymail.calls).toHaveLength(0);
    expect(prospeo.calls).toHaveLength(2);
    // 每个联系人各写 gate 关闭 + 熔断 OPEN + 真实调用 3 条 attempt；wire 只有 2 次。
    expect(world.attemptCreates).toHaveLength(6);
  });

  it('INVALID 缓存 hit：0 finder 调用且 reused，不占公司帽、不重验证', async () => {
    const world = fakeWorld({ contacts: FOUR_CONTACTS.slice(0, 2) });
    const hunter = finder('hunter', miss());
    (
      world.tx.contactEnrichmentAttempt.findUnique as unknown as {
        mockResolvedValueOnce(value: unknown): void;
      }
    ).mockResolvedValueOnce({
      id: 'attempt-cached',
      providerKey: 'hunter',
      requestHash: 'cached-hash',
      outcome: 'hit',
      errorCode: null,
      emailState: 'INVALID',
      costMicrousd: 10_000n,
      attemptedAt: new Date(NOW.getTime() - 60_000),
    });
    const result = await enrichCompanyContacts(
      depsFor(world, [hunter], { verifiers: [verifier('millionverifier', 'VALID')] }),
      { ...INPUT, maxFinderCallsPerCompany: 1 },
    );
    expect(result.results.map((entry) => entry.status)).toEqual(['reused', 'not_found']);
    expect(hunter.calls).toHaveLength(1);
    expect(hunter.calls[0]?.contactId).toBe(CONTACT_2);
  });

  it('budget=0 / 抑制 / 无配置 / deadline：保留 0 出网守卫', async () => {
    {
      const world = fakeWorld({ contacts: FOUR_CONTACTS });
      const hunter = finder('hunter', miss());
      const result = await enrichCompanyContacts(
        depsFor(world, [hunter], { budget: new CapBudget(0) }),
        INPUT,
      );
      expect(result.results.map((entry) => entry.status)).toEqual([
        'skipped_budget',
        'skipped_budget',
        'skipped_budget',
        'skipped_budget',
      ]);
      expect(hunter.calls).toHaveLength(0);
    }
    {
      const world = fakeWorld({
        contacts: FOUR_CONTACTS,
        suppressionRows: [{ type: 'domain', value: 'acme.example' }],
      });
      const hunter = finder('hunter', miss());
      const result = await enrichCompanyContacts(depsFor(world, [hunter]), INPUT);
      expect(result.results.map((entry) => entry.status)).toEqual([
        'skipped_compliance',
        'skipped_compliance',
        'skipped_compliance',
        'skipped_compliance',
      ]);
      expect(hunter.calls).toHaveLength(0);
    }
    {
      const fetchImpl = vi.fn(async () => {
        throw new Error('unexpected wire call');
      });
      const unconfigured = new HunterProvider(
        { apiKey: null, baseUrl: 'https://api.hunter.io', timeoutMs: 1_000, costMicrousd: 1_700 },
        fetchImpl as unknown as typeof fetch,
      );
      const world = fakeWorld({ contacts: FOUR_CONTACTS.slice(0, 2) });
      const result = await enrichCompanyContacts(
        depsFor(world, [], { finders: [unconfigured] }),
        INPUT,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(result.results.map((entry) => entry.status)).toEqual(['not_found', 'not_found']);
      expect(world.attemptCreates.every((row) => row.errorCode === 'provider_unconfigured')).toBe(true);
    }
    {
      const world = fakeWorld({ contacts: FOUR_CONTACTS });
      const hunter = finder('hunter', miss());
      const result = await enrichCompanyContacts(depsFor(world, [hunter]), {
        ...INPUT,
        deadlineAtMs: NOW.getTime() - 1,
      });
      expect(result.results.every((entry) => entry.status === 'skipped_deadline')).toBe(true);
      expect(hunter.calls).toHaveLength(0);
    }
    {
      const world = fakeWorld({ contacts: FOUR_CONTACTS });
      const result = await enrichCompanyContacts(depsFor(world, []), INPUT);
      expect(result.results.every((entry) => entry.status === 'no_finders')).toBe(true);
    }
  });

  it('A 档尾池仍按原顺序，且同受剩余帽约束', async () => {
    const world = fakeWorld({
      contacts: FOUR_CONTACTS.slice(0, 2),
      topLead: { id: 'lead-1' },
    });
    const hunter = finder('hunter', miss());
    const apollo = finder('apollo', miss());
    const result = await enrichCompanyContacts(
      depsFor(world, [hunter], { tailFinders: [apollo.adapter] }),
      { ...INPUT, maxFinderCallsPerCompany: 3 },
    );
    expect(result.tier).toBe('A');
    expect(result.results.map((entry) => entry.status)).toEqual(['not_found', 'not_found']);
    expect(hunter.calls.map((call) => call.contactId)).toEqual([CONTACT_1, CONTACT_2]);
    expect(apollo.calls.map((call) => call.contactId)).toEqual([CONTACT_1]);
  });

  it('验证 INVALID 继续下一 finder、UNKNOWN 落库停止（原语义不变）', async () => {
    {
      const world = fakeWorld({ contacts: [FOUR_CONTACTS[0]!] });
      const hunter = finder('hunter', hit('j.mueller@acme.example'));
      const findymail = finder('findymail', hit('j.mueller@acme.example'));
      const result = await enrichCompanyContacts(
        depsFor(world, [hunter, findymail], { verifiers: [verifier('millionverifier', 'INVALID')] }),
        INPUT,
      );
      expect(result.results[0]).toMatchObject({ status: 'invalid_all' });
      expect(hunter.calls).toHaveLength(1);
      expect(findymail.calls).toHaveLength(1);
    }
    {
      const world = fakeWorld({ contacts: [FOUR_CONTACTS[0]!] });
      const hunter = finder('hunter', hit('j.mueller@acme.example'));
      const findymail = finder('findymail', hit('j.mueller@acme.example'));
      const result = await enrichCompanyContacts(
        depsFor(world, [hunter, findymail], { verifiers: [verifier('millionverifier', 'UNKNOWN')] }),
        INPUT,
      );
      expect(result.results[0]).toMatchObject({ status: 'stored' });
      expect(hunter.calls).toHaveLength(1);
      expect(findymail.calls).toHaveLength(0);
    }
  });

  it('固定输入重放：新请求 trace 是旧序列的有序子序列，finder/verifier 分别不增', async () => {
    const makeScenario = (finderTrace: string[], verifierTrace: string[]) => {
      const world = fakeWorld({ contacts: FOUR_CONTACTS });
      const hunter = finder('hunter', miss(), finderTrace);
      const findymail = finder('findymail', hit('j.mueller@acme.example'), finderTrace);
      const millionverifier = verifier('millionverifier', 'INVALID', verifierTrace);
      return { world, finders: [hunter, findymail], verifiers: [millionverifier] };
    };

    const newFinderTrace: string[] = [];
    const newVerifierTrace: string[] = [];
    const current = makeScenario(newFinderTrace, newVerifierTrace);
    const result = await enrichCompanyContacts(
      depsFor(current.world, current.finders, {
        verifiers: current.verifiers,
        budget: new CapBudget(1_000_000),
      }),
      { ...INPUT, maxFinderCallsPerCompany: 5 },
    );
    expect(result.results.map((entry) => entry.status)).toEqual([
      'invalid_all',
      'invalid_all',
      'not_found',
      'skipped_company_cap',
    ]);

    // 旧编排等价 oracle：逐联系人直接跑真实单人 core，复刻 BASE 外层帽/减记/skip，
    // 但每人不透传剩余余额（旧行为）。
    const oldFinderTrace: string[] = [];
    const oldVerifierTrace: string[] = [];
    const legacy = makeScenario(oldFinderTrace, oldVerifierTrace);
    const shared = new CapBudget(1_000_000);
    let legacyRemaining = 5;
    for (const contact of FOUR_CONTACTS) {
      if (legacyRemaining <= 0) continue;
      const legacyResult = await enrichContactEmail(
        {
          prisma: legacy.world.prisma as never,
          finders: legacy.finders.map((handle) => handle.adapter),
          verifiers: legacy.verifiers,
          gate: (candidate) => checkProviderGates(legacy.world.ownerPrisma as never, candidate),
          budget: new CompositeBudget([shared, new CapBudget(DEFAULT_PER_CONTACT_CAP_MICROUSD)]),
          clock: () => NOW,
          actorId: 'legacy-oracle',
        },
        {
          workspaceId: WORKSPACE,
          contactId: contact.id,
          fullName: contact.fullName,
          domain: 'acme.example',
          companyName: 'Acme GmbH',
          accountKey: 'acct-1',
          lawfulBasis: 'legitimate_interest',
        },
      );
      if (legacyResult.status !== 'skipped_compliance' && legacyResult.status !== 'no_finders') {
        legacyRemaining -= 'finderAttempts' in legacyResult ? legacyResult.finderAttempts : 0;
      }
    }

    expect(newFinderTrace.length).toBeLessThanOrEqual(oldFinderTrace.length);
    expect(newVerifierTrace.length).toBeLessThanOrEqual(oldVerifierTrace.length);
    expect(isOrderedSubsequence(newFinderTrace, oldFinderTrace)).toBe(true);
    expect(isOrderedSubsequence(newVerifierTrace, oldVerifierTrace)).toBe(true);
    // 钉住 BASE 外层口径：帽 5、前三人各 2 finder + 1 verifier，末人 skip → 6/3；
    // 修后末人只用剩余 1 次 → 5/2。oracle 若漏掉外层减记/skip 会得 8/4，这里必须失败。
    expect(oldFinderTrace).toHaveLength(6);
    expect(oldVerifierTrace).toHaveLength(3);
    expect(newFinderTrace).toHaveLength(5);
    expect(newVerifierTrace).toHaveLength(2);
  });

  it('真实 core + 真实 Hunter/Findymail/MillionVerifier adapter：计数 fake fetch 分别核对 finder/verifier', async () => {
    const wire = { finder: [] as string[], verifier: [] as string[] };
    const jsonResponse = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === 'api.hunter.io') {
        wire.finder.push('hunter');
        return jsonResponse({ data: { emails: [], accept_all: false, pattern: null } });
      }
      if (url.hostname === 'app.findymail.com') {
        wire.finder.push('findymail');
        return jsonResponse({ email: 'j.mueller@acme.example', status: 'valid' });
      }
      if (url.hostname === 'api.millionverifier.com') {
        wire.verifier.push('millionverifier');
        return jsonResponse({ result: 'invalid', subresult: 'invalid.mailbox', accept_all: false });
      }
      throw new Error(`unexpected wire host ${url.hostname}`);
    });
    const hunter = new HunterProvider(
      { apiKey: 'test', baseUrl: 'https://api.hunter.io', timeoutMs: 1_000, costMicrousd: 1_700 },
      fetchImpl as unknown as typeof fetch,
    );
    const findymail = new FindymailProvider(
      { apiKey: 'test', baseUrl: 'https://app.findymail.com', timeoutMs: 1_000, costMicrousd: 19_800 },
      fetchImpl as unknown as typeof fetch,
    );
    const millionverifier = new MillionVerifierProvider(
      {
        apiKey: 'test',
        baseUrl: 'https://api.millionverifier.com',
        timeoutMs: 1_000,
        costMicrousd: 1_780,
      },
      fetchImpl as unknown as typeof fetch,
    );
    const world = fakeWorld({ contacts: FOUR_CONTACTS });
    const result = await enrichCompanyContacts(
      depsFor(world, [], {
        finders: [hunter, findymail],
        verifiers: [millionverifier],
      }),
      { ...INPUT, maxFinderCallsPerCompany: 7 },
    );
    expect(result.results.map((entry) => entry.status)).toEqual([
      'invalid_all',
      'invalid_all',
      'invalid_all',
      'not_found',
    ]);
    expect(wire.finder).toEqual([
      'hunter',
      'findymail',
      'hunter',
      'findymail',
      'hunter',
      'findymail',
      'hunter',
    ]);
    expect(wire.verifier).toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledTimes(10);
  });
});

function finderTotal(handles: FinderHandle[]): number {
  return handles.reduce((sum, handle) => sum + handle.calls.length, 0);
}


describe('shared contact selector/tier ports for the frozen safety lane', () => {
  it('preserves the none-email selector, explicit subset, order and cap', async () => {
    const world = fakeWorld({ contacts: [{ id: CONTACT_1, fullName: 'Synthetic Person' }] });
    const selected = await loadContactEnrichmentTargets(world.tx as never, { companyId: COMPANY, contactIds: [CONTACT_1] }, 3);
    expect(selected.company?.domain).toBe('acme.example');
    expect(selected.contacts).toEqual([{ id: CONTACT_1, fullName: 'Synthetic Person' }]);
    expect(world.tx.canonicalContact.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { companyId: COMPANY, id: { in: [CONTACT_1] }, contactPoints: { none: { type: 'email' } } },
      select: { id: true, fullName: true }, orderBy: { createdAt: 'asc' }, take: 3,
    });
    expect(world.tx.contactPoint.upsert).not.toHaveBeenCalled();
    expect(world.tx.contactEnrichmentAttempt.create).not.toHaveBeenCalled();
  });
  it('preserves an explicitly empty subset rather than selecting every contact', async () => {
    const world = fakeWorld({});
    await loadContactEnrichmentTargets(world.tx as never, { companyId: COMPANY, contactIds: [] }, 10);
    expect(world.tx.canonicalContact.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: COMPANY, id: { in: [] }, contactPoints: { none: { type: 'email' } } },
    }));
  });
  it('does not select contacts when the company has no domain', async () => {
    const world = fakeWorld({ domain: null });
    expect(await loadContactEnrichmentTargets(world.tx as never, { companyId: COMPANY }, 10)).toEqual({ company: null, contacts: [] });
    expect(world.tx.canonicalContact.findMany).not.toHaveBeenCalled();
  });
  it('does not invent an A tier when no configured tail is reachable', async () => {
    const world = fakeWorld({ topLead: { id: 'synthetic-top-lead' } });
    expect(await loadCompanyContactEnrichmentTier(world.prisma as never, INPUT, false)).toBe('B');
    expect(world.tx.lead.findFirst).not.toHaveBeenCalled();
  });
  it.each([[true, 'A'], [false, 'B']] as const)('uses the original any-ICP threshold, topLead=%s', async (hit, expected) => {
    const world = fakeWorld({ topLead: hit ? { id: 'synthetic-top-lead' } : null });
    expect(await loadCompanyContactEnrichmentTier(world.prisma as never, INPUT, true)).toBe(expected);
    expect(world.tx.lead.findFirst).toHaveBeenCalledWith({ where: { canonicalCompanyId: COMPANY, totalScore: { gte: 80 } }, select: { id: true } });
  });
  it('does not omit a configured unsupported finder from the reachable set', () => {
    const primary = [finder('hunter', miss()).adapter, finder('findymail', miss()).adapter];
    const tail = [finder('apollo', miss()).adapter];
    expect(reachableContactEnrichmentFinders(primary, tail, 'B')).toBe(primary);
    expect(reachableContactEnrichmentFinders(primary, tail, 'A').map((p) => p.key)).toEqual(['hunter', 'findymail', 'apollo']);
    expect(primary.map((p) => p.key)).toEqual(['hunter', 'findymail']);
  });
});


describe('shared selector cannot widen the frozen target cap', () => {
  it.each([0, -1, 11, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid trusted cap %s before database selection', async (cap) => {
    const world = fakeWorld({});
    await expect(loadContactEnrichmentTargets(world.tx as never, { companyId: COMPANY }, cap)).rejects.toThrow();
    expect(world.tx.canonicalCompany.findUnique).not.toHaveBeenCalled();
    expect(world.tx.canonicalContact.findMany).not.toHaveBeenCalled();
  });
});
