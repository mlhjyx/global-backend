import { describe, expect, it, vi } from 'vitest';
import type { EmailEnrichmentAdapter, FindEmailInput, FindEmailOutcome } from '../finders/email-enrichment-provider';
import { enrichmentRequestHash } from '../finders/email-enrichment-provider';
import type { EmailVerificationProvider, EmailVerificationProviderResult } from '../verification/email-verification-provider';
import type { EmailVerificationState } from '../../discovery/contact-point-verification-state';
import { CapBudget } from './enrichment-budget';
import { enrichCompanyContacts, type EnrichCompanyContactsDeps } from './enrich-company-contacts';

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
      findMany: vi.fn(async () => []),
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
    dataProvider: { findUnique: vi.fn(async () => ({ status: 'ENABLED', config: null })) },
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

function verifier(key: string, state: EmailVerificationState): EmailVerificationProvider {
  return {
    key,
    domain: `api.${key}.io`,
    isConfigured: () => true,
    verify: async (): Promise<EmailVerificationProviderResult> => ({
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
    }),
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
