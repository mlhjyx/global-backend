import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailEnrichmentAdapter } from '../finders/email-enrichment-provider';
import type { EmailVerificationProvider } from '../verification/email-verification-provider';
import { enrichContactEmail } from './enrich-contact-email';

const WS = '00000000-0000-4000-8000-0000000000aa';
const CONTACT = '00000000-0000-4000-8000-0000000000bb';
const NOW = new Date('2026-11-25T10:00:00.000Z');

beforeEach(() => {
  delete process.env.EMAIL_VERIFY_ALLOW_PERSONAL_WITHOUT_BASIS;
});

function buildMockDb() {
  const art14Creates: Array<Record<string, unknown>> = [];
  const pointUpserts: Array<Record<string, unknown>> = [];
  const tx = {
    $executeRawUnsafe: vi.fn(async () => 1),
    contactPoint: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
        pointUpserts.push(create);
        return { id: 'pt-1', verificationState: 'UNKNOWN', validSince: null, nextReverifyAt: null };
      }),
      update: vi.fn(async () => ({ id: 'pt-1' })),
    },
    contactPointVerificationEvent: {
      count: vi.fn(async () => 0),
      create: vi.fn(async () => ({ id: 'ev-1' })),
      findUnique: vi.fn(async () => null),
    },
    contactEnrichmentAttempt: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'att-1',
        ...data,
        attemptedAt: NOW,
      })),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async () => ({ id: 'att-1' })),
    },
    suppressionRecord: {
      findFirst: vi.fn(async () => null),
    },
    article14Notice: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        art14Creates.push(data);
        return { id: 'a14-1', dueAt: new Date(NOW.getTime() + 30 * 86_400_000) };
      }),
    },
  };
  return {
    prisma: {
      withWorkspace: vi.fn(async (_ws: string, fn: (c: unknown) => Promise<unknown>) => fn(tx)),
    },
    art14Creates,
    pointUpserts,
  };
}

function fakeVerifier(
  state: 'VALID' | 'INVALID' | 'CATCH_ALL_RISKY',
  costMicrousd = 200,
  key: 'millionverifier' | 'emailable' = 'millionverifier',
): EmailVerificationProvider {
  const catchAll = state === 'CATCH_ALL_RISKY' ? 'catch_all' : 'not_catch_all';
  const catchAllClass = state === 'CATCH_ALL_RISKY' ? 'true_catch_all' : 'not_catch_all';
  return {
    key,
    domain: `api.${key}.com`,
    isConfigured: () => true,
    verify: vi.fn(async () => ({
      providerKey: key,
      state,
      catchAll,
      catchAllClass,
      score: state === 'VALID' ? 95 : 0,
      acceptAll: state === 'CATCH_ALL_RISKY',
      disposable: null,
      role: null,
      detail: 'mock_verdict',
      costMicrousd,
      latencyMs: 12,
      error: null,
    })),
  } as unknown as EmailVerificationProvider;
}

function fakeFinder(email: string): { adapter: EmailEnrichmentAdapter; findEmail: ReturnType<typeof vi.fn> } {
  const findEmail = vi.fn(async () => ({
    status: 'hit' as const,
    hit: { email },
    costMicrousd: 19_800,
    latencyMs: 25,
  }));
  return {
    findEmail,
    adapter: {
      key: 'prospeo',
      domain: 'api.prospeo.io',
      class: 'b2b_company_person',
      costMicrousd: 19_800,
      isConfigured: () => true,
      requestHash: () => 'h'.repeat(64),
      findEmail,
    },
  };
}

describe('Batch 1.4-C Step 0 零成本邮箱反推、other fail-closed 与 GDPR Art.14 排期', () => {
  it('同公司已有 VALID 样本 → Step 0 零 finder 成本直验 VALID 落库并排期 EU Art.14 通知', async () => {
    const db = buildMockDb();
    const finder = fakeFinder('marco.rossi@refeel-epc.it');
    const v1 = fakeVerifier('VALID', 150, 'millionverifier');
    const v2 = fakeVerifier('VALID', 150, 'emailable');

    const res = await enrichContactEmail(
      {
        prisma: db.prisma as never,
        finders: [finder.adapter],
        verifiers: [v1, v2],
        gate: async () => ({ ok: true }),
        mayUseExternalProcessing: async () => true,
        clock: () => NOW,
      },
      {
        workspaceId: WS,
        contactId: CONTACT,
        fullName: 'Marco Rossi',
        domain: 'refeel-epc.it',
        country: 'IT',
        accountKey: 'acc-1',
        lawfulBasis: 'legitimate_interest',
        knownCompanyEmailSamples: [{ fullName: 'Mattia Masotti', email: 'm.masotti@refeel-epc.it' }],
      },
    );

    expect(res).toMatchObject({
      status: 'stored',
      state: 'VALID',
      provider: 'pattern_inferred',
      finderAttempts: 0,
      costMicrousd: 300,
    });
    expect(finder.findEmail).not.toHaveBeenCalled();
    expect(db.pointUpserts[0]?.value).toBe('m.rossi@refeel-epc.it');
    expect(db.art14Creates).toHaveLength(1);
    expect(db.art14Creates[0]).toMatchObject({ jurisdiction: 'EU', subjectId: CONTACT });
  });

  it('Step 0 验证非 VALID 时自动回退付费 finder 瀑布', async () => {
    const db = buildMockDb();
    const finder = fakeFinder('marco.rossi@refeel-epc.it');
    const v1 = fakeVerifier('INVALID', 100, 'millionverifier');
    const v2 = fakeVerifier('VALID', 100, 'emailable');
    (v1.verify as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        providerKey: 'millionverifier',
        state: 'INVALID',
        catchAll: 'not_catch_all',
        catchAllClass: 'not_catch_all',
        score: 0,
        acceptAll: false,
        disposable: null,
        role: null,
        detail: 'step0_miss',
        costMicrousd: 100,
        latencyMs: 10,
        error: null,
      })
      .mockResolvedValueOnce({
        providerKey: 'millionverifier',
        state: 'VALID',
        catchAll: 'not_catch_all',
        catchAllClass: 'not_catch_all',
        score: 95,
        acceptAll: false,
        disposable: null,
        role: null,
        detail: 'finder_valid',
        costMicrousd: 100,
        latencyMs: 10,
        error: null,
      });

    const res = await enrichContactEmail(
      {
        prisma: db.prisma as never,
        finders: [finder.adapter],
        verifiers: [v1, v2],
        gate: async () => ({ ok: true }),
        mayUseExternalProcessing: async () => true,
        clock: () => NOW,
      },
      {
        workspaceId: WS,
        contactId: CONTACT,
        fullName: 'Marco Rossi',
        domain: 'refeel-epc.it',
        country: 'US',
        accountKey: 'acc-1',
        lawfulBasis: 'legitimate_interest',
        knownCompanyEmailSamples: [{ fullName: 'Mattia Masotti', email: 'm.masotti@refeel-epc.it' }],
      },
    );

    expect(finder.findEmail).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({
      status: 'stored',
      state: 'VALID',
      provider: 'prospeo',
      finderAttempts: 1,
    });
    expect(db.art14Creates).toHaveLength(0); // US does not require GDPR Art.14
  });

  it('other 类型单段邮箱缺少 lawfulBasis 时 fail-closed，不调用第三方验证器', async () => {
    const db = buildMockDb();
    const finder = fakeFinder('mrossi@refeel-epc.it');
    const verifier = fakeVerifier('VALID', 150);

    const res = await enrichContactEmail(
      {
        prisma: db.prisma as never,
        finders: [finder.adapter],
        verifiers: [verifier],
        gate: async () => ({ ok: true }),
        mayUseExternalProcessing: async () => true,
        clock: () => NOW,
      },
      {
        workspaceId: WS,
        contactId: CONTACT,
        fullName: 'Marco Rossi',
        domain: 'refeel-epc.it',
        accountKey: 'acc-1',
      },
    );

    expect(res).toMatchObject({
      status: 'stored',
      state: 'UNKNOWN',
      note: 'personal_email_no_lawful_basis',
    });
    expect(verifier.verify).not.toHaveBeenCalled();
  });
});
