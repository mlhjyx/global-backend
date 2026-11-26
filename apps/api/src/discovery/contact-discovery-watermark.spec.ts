import { describe, expect, it, vi } from 'vitest';
import { discoverContactsCore } from './contact-discovery-core';

const WS = '11111111-1111-4111-8111-111111111111';
const COMPANY_ID = '22222222-2222-4222-8222-222222222222';

function makeHarness(opts: {
  companyCountry?: string | null;
  companyChannels?: Array<{ channel: 'phone' | 'email' | 'form_url'; value: string; sourceUrl: string; providerKey: string }>;
  budgetExhausted?: boolean;
} = {}) {
  const companyUpdateMany = vi.fn(async () => ({ count: 1 }));
  const fieldEvidenceCreate = vi.fn(async () => ({}));
  const companyChannelUpsert = vi.fn(async () => ({}));

  const tx = {
    $queryRaw: vi.fn(async () => [{ status: 'ENRICHED', name: 'IO Solar', domain: 'iosolar.com', country: opts.companyCountry ?? null, attributes: {} }]),
    canonicalCompany: {
      findUnique: vi.fn(async () => ({
        id: COMPANY_ID,
        name: 'IO Solar',
        domain: 'iosolar.com',
        country: opts.companyCountry ?? null,
        dedupeKey: 'd:iosolar.com',
        status: 'ENRICHED',
        attributes: {},
      })),
      updateMany: companyUpdateMany,
    },
    fieldEvidence: {
      findMany: vi.fn(async () => [{ providerKey: 'public_web', license: 'public' }]),
      create: fieldEvidenceCreate,
    },
    suppressionRecord: { findMany: vi.fn(async () => []) },
    canonicalContact: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({ id: 'ct-1' })),
    },
    contactPoint: { upsert: vi.fn(async () => ({})) },
    companyContactChannel: {
      findMany: vi.fn(async () => []),
      upsert: companyChannelUpsert,
    },
    usageLedger: { create: vi.fn(async () => ({})) },
    personalDataAccessAudit: { create: vi.fn(async () => ({})) },
  };

  const prisma = {
    withWorkspace: vi.fn(async <T>(_ws: string, work: (client: unknown) => Promise<T>) => work(tx)),
  };
  const adapter = {
    key: 'public_web',
    discoverContacts: vi.fn(async () => ({
      contacts: [],
      costCents: 0,
      ...(opts.companyChannels ? { companyChannels: opts.companyChannels } : {}),
    })),
  };
  const providers = {
    routeContactDiscovery: vi.fn(async () => [adapter]),
  };
  const budgetStore = {
    attestAuthorized: vi.fn(async () => {}),
    status: vi.fn(async () => ({ remainingMicrousd: 1_000_000n, exhausted: false })),
  };
  const contactBudget = opts.budgetExhausted
    ? { exhausted: () => true, observe: vi.fn() }
    : undefined;

  return { tx, prisma, providers, budgetStore, companyUpdateMany, fieldEvidenceCreate, contactBudget };
}

describe('discoverContactsCore · contactDiscoveryAttemptedAt 水印与 #96-5 电话国家回填', () => {
  const baseInput = {
    workspaceId: WS,
    companyId: COMPANY_ID,
    lawfulBasis: {
      basis: 'legitimate_interest' as const,
      ref: 'lia-1',
      recordedBy: 'tester',
      recordedAt: '2026-11-26T10:00:00.000Z',
    },
    binding: { authorityId: 'auth-1', scopeKey: WS, accountKey: 'run:1' },
    audit: {
      actorId: 'tester',
      actorKind: 'user' as const,
      purpose: 'contact_discovery' as const,
    },
  };

  it('stamps contactDiscoveryAttemptedAt on non-suppressed company and backfills country from +39 phone channel', async () => {
    const h = makeHarness({
      companyCountry: null,
      companyChannels: [
        {
          channel: 'phone',
          value: '+39 0543 097431',
          sourceUrl: 'https://iosolar.com/contatti',
          providerKey: 'public_web',
        },
      ],
    });

    await discoverContactsCore(
      { prisma: h.prisma as never, providers: h.providers as never, budgetStore: h.budgetStore as never },
      baseInput,
    );

    expect(h.companyUpdateMany).toHaveBeenCalledWith({
      where: { id: COMPANY_ID, country: null, status: { not: 'SUPPRESSED' } },
      data: { country: 'IT', version: { increment: 1 } },
    });
    expect(h.companyUpdateMany).toHaveBeenCalledWith({
      where: { id: COMPANY_ID, status: { not: 'SUPPRESSED' } },
      data: { contactDiscoveryAttemptedAt: expect.any(Date) },
    });
  });

  it('does NOT stamp contactDiscoveryAttemptedAt when truncated by sub-budget before running adapters', async () => {
    const h = makeHarness({ budgetExhausted: true });

    const res = await discoverContactsCore(
      { prisma: h.prisma as never, providers: h.providers as never, budgetStore: h.budgetStore as never },
      { ...baseInput, contactBudget: h.contactBudget as never },
    );

    expect(res.budgetTruncated).toBe(true);
    expect(h.companyUpdateMany).not.toHaveBeenCalled();
  });
});
