import { ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateSuppressionReleaseRequest } from '../compliance/suppression-release-policy';
import { evaluateEmailGate } from './compliance/email-verification-gate';
import { persistDiscoveredContacts } from './contact-persist';
import { DiscoveryService } from './discovery.service';
import { buildGuessTargets } from './email-guess-targets';
import { persistGuessedEmail } from './email-guess-persist';

const guessEmail = vi.fn();

vi.mock('./contact-persist', () => ({ persistDiscoveredContacts: vi.fn() }));
vi.mock('./email-guess-persist', () => ({ persistGuessedEmail: vi.fn() }));
vi.mock('./email-guess-targets', () => ({ buildGuessTargets: vi.fn() }));
vi.mock('./email-guesser', () => ({
  EmailGuesser: class {
    guess = guessEmail;
  },
}));
vi.mock('./compliance/email-verification-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./compliance/email-verification-gate')>();
  return { ...actual, evaluateEmailGate: vi.fn() };
});
vi.mock('../compliance/suppression-release-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../compliance/suppression-release-policy')>();
  return { ...actual, evaluateSuppressionReleaseRequest: vi.fn() };
});

const ctx = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  userId: 'operator-1',
  roles: ['acquisition-operator'],
};

function company(overrides: Record<string, unknown> = {}) {
  return {
    id: 'company-1',
    workspaceId: ctx.workspaceId,
    name: 'Pump GmbH',
    domain: 'pump.example',
    country: 'DE',
    status: 'ENRICHED',
    dedupeKey: 'domain:pump.example',
    ...overrides,
  };
}

function harness() {
  const tx = {
    discoveryQueryPlan: { findUnique: vi.fn(async () => ({ id: 'plan-1', icpId: 'icp-1', status: 'READY' })) },
    discoveryRun: {
      create: vi.fn(async () => ({ id: 'run-1', planId: 'plan-1', icpId: 'icp-1' })),
      findUnique: vi.fn(async () => ({ id: 'run-1' })),
    },
    outboxEvent: { create: vi.fn(async () => ({})) },
    canonicalCompany: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => company()),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    fieldEvidence: {
      findMany: vi.fn(async () => [{ id: 'evidence-1' }]),
      create: vi.fn(async () => ({})),
    },
    suppressionRecord: {
      findMany: vi.fn(async () => [{ type: 'email', value: 'blocked@pump.example' }]),
      findFirst: vi.fn(async () => null),
      createMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => ({ id: 'suppression-1', reason: 'manual' })),
    },
    suppressionReleaseDecision: {
      create: vi.fn(async ({ data }: any) => ({ id: 'release-1', ...data })),
    },
    canonicalContact: {
      findMany: vi.fn(async () => [
        { id: 'contact-1', fullName: 'Jane Doe', contactPoints: [] },
      ]),
    },
    usageLedger: { create: vi.fn(async () => ({})) },
    contactPoint: {
      findUnique: vi.fn(async () => ({ id: 'point-1', contactId: 'contact-1', type: 'email', value: 'info@pump.example' })),
      update: vi.fn(async ({ data }: any) => ({ id: 'point-1', ...data })),
    },
    dataProvider: { findMany: vi.fn(async () => [{ key: 'smtp_self' }]) },
  } as any;
  const prisma = {
    withWorkspace: vi.fn(async (_workspaceId: string, work: (value: typeof tx) => unknown) => work(tx)),
  };
  const providers = {
    routeContactDiscovery: vi.fn(async () => []),
    routeEmailVerification: vi.fn(async () => []),
  };
  return { service: new DiscoveryService(prisma as any, providers as any), prisma, providers, tx };
}

describe('DiscoveryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(persistDiscoveredContacts).mockResolvedValue({
      inserted: 1,
      updated: 0,
      skippedSuppressed: 0,
    } as any);
    vi.mocked(buildGuessTargets).mockReturnValue({
      knownSamples: [],
      emailless: [],
      emaillessTotal: 0,
    });
    vi.mocked(evaluateEmailGate).mockReturnValue({
      allowed: true,
      kind: 'role',
      reason: 'ROLE_MAILBOX',
    } as any);
    vi.mocked(evaluateSuppressionReleaseRequest).mockReturnValue({
      decisionStatus: 'PENDING_REVIEW',
    } as any);
  });

  it('executes only READY plans and emits a transactional request event', async () => {
    const { service, tx } = harness();
    tx.discoveryQueryPlan.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'plan-1', status: 'DRAFT', icpId: 'icp-1' })
      .mockResolvedValueOnce({ id: 'plan-1', status: 'READY', icpId: 'icp-1' });

    await expect(service.executePlan(ctx, 'missing')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.executePlan(ctx, 'plan-1')).rejects.toBeInstanceOf(ConflictException);
    await expect(service.executePlan(ctx, 'plan-1')).resolves.toMatchObject({ id: 'run-1' });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: 'DiscoveryRunRequested', aggregateId: 'run-1' }),
    });
  });

  it('gets a run, rejects an absent run, and paginates canonical companies', async () => {
    const { service, tx } = harness();
    await expect(service.getRun(ctx, 'run-1')).resolves.toEqual({ id: 'run-1' });
    tx.discoveryRun.findUnique.mockResolvedValueOnce(null);
    await expect(service.getRun(ctx, 'missing')).rejects.toBeInstanceOf(NotFoundException);

    tx.canonicalCompany.findMany
      .mockResolvedValueOnce([company({ id: 'a' }), company({ id: 'b' }), company({ id: 'c' })])
      .mockResolvedValueOnce([company({ id: 'z' })]);
    await expect(service.listCanonicalCompanies(ctx, { status: 'ENRICHED', limit: 2, cursor: 'before' })).resolves.toMatchObject({
      data: [{ id: 'a' }, { id: 'b' }],
      nextCursor: 'b',
      hasMore: true,
    });
    await expect(service.listCanonicalCompanies(ctx, { limit: 2 })).resolves.toMatchObject({
      data: [{ id: 'z' }],
      nextCursor: null,
      hasMore: false,
    });
    expect(tx.canonicalCompany.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { status: 'ENRICHED' }, cursor: { id: 'before' }, skip: 1 }),
    );
    expect(tx.canonicalCompany.findMany.mock.calls[1]?.[0]).toMatchObject({ where: {} });
  });

  it('returns a company with evidence and uses a tenant-scoped 404', async () => {
    const { service, tx } = harness();
    await expect(service.getCanonicalCompany(ctx, 'company-1')).resolves.toMatchObject({
      company: { id: 'company-1' },
      evidence: [{ id: 'evidence-1' }],
    });
    tx.canonicalCompany.findUnique.mockResolvedValueOnce(null);
    await expect(service.getCanonicalCompany(ctx, 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('fails contact discovery for absent, suppressed, or provider-less companies', async () => {
    const missing = harness();
    missing.tx.canonicalCompany.findUnique.mockResolvedValue(null);
    await expect(missing.service.discoverContacts(ctx, 'missing')).rejects.toBeInstanceOf(NotFoundException);

    const suppressed = harness();
    suppressed.tx.canonicalCompany.findUnique.mockResolvedValue(company({ status: 'SUPPRESSED' }));
    await expect(suppressed.service.discoverContacts(ctx, 'company-1')).rejects.toBeInstanceOf(ConflictException);

    const noProvider = harness();
    await expect(noProvider.service.discoverContacts(ctx, 'company-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('fans out contact providers, isolates failures, persists sequentially, and charges only positive cost', async () => {
    const successful = {
      key: 'decision_maker',
      discoverContacts: vi.fn(async () => ({
        contacts: [{ externalId: 'jane', fullName: 'Jane Doe', personalData: true }],
        costCents: 25,
      })),
    };
    const free = {
      key: 'companies_house',
      discoverContacts: vi.fn(async () => ({ contacts: [], costCents: 0 })),
    };
    const failed = {
      key: 'broken',
      discoverContacts: vi.fn(async () => { throw new Error('private upstream text'); }),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { service, providers, tx } = harness();
    providers.routeContactDiscovery.mockResolvedValue([successful, failed, free]);
    vi.mocked(persistDiscoveredContacts)
      .mockResolvedValueOnce({ inserted: 1, updated: 0, skippedSuppressed: 2 } as any)
      .mockResolvedValueOnce({ inserted: 0, updated: 0, skippedSuppressed: 0 } as any);

    const result = await service.discoverContacts(ctx, 'company-1');

    expect(result).toMatchObject({ skippedSuppressed: 2, contacts: [{ id: 'contact-1' }] });
    expect(persistDiscoveredContacts).toHaveBeenCalledTimes(2);
    expect(tx.usageLedger.create).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[discoverContacts\].*ERROR_TEXT_SHA256:/));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private upstream text');
    warn.mockRestore();
  });

  it('guards email guessing load prerequisites', async () => {
    const missing = harness();
    missing.tx.canonicalCompany.findUnique.mockResolvedValue(null);
    await expect(missing.service.guessEmailsForCompany(ctx, 'missing')).rejects.toBeInstanceOf(NotFoundException);

    const suppressed = harness();
    suppressed.tx.canonicalCompany.findUnique.mockResolvedValue(company({ status: 'SUPPRESSED' }));
    await expect(suppressed.service.guessEmailsForCompany(ctx, 'company-1')).rejects.toBeInstanceOf(ConflictException);

    const noDomain = harness();
    noDomain.tx.canonicalCompany.findUnique.mockResolvedValue(company({ domain: null }));
    await expect(noDomain.service.guessEmailsForCompany(ctx, 'company-1')).rejects.toBeInstanceOf(ConflictException);

    const noProvider = harness();
    await expect(noProvider.service.guessEmailsForCompany(ctx, 'company-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('guesses outside the transaction and summarizes persisted, unverified, and blocked outcomes', async () => {
    const verifier = { key: 'smtp_self', verifyEmail: vi.fn() };
    const { service, providers } = harness();
    providers.routeEmailVerification.mockResolvedValue([verifier]);
    vi.mocked(buildGuessTargets).mockReturnValue({
      knownSamples: [{ fullName: 'Known', email: 'known@pump.example' }],
      emailless: [
        { contactId: 'contact-1', fullName: 'Jane Doe' },
        { contactId: 'contact-2', fullName: 'John Doe' },
        { contactId: 'contact-3', fullName: 'Blocked Person' },
      ],
      emaillessTotal: 4,
    });
    guessEmail
      .mockResolvedValueOnce({ status: 'guessed', email: 'jane@pump.example', verdict: { status: 'VALID' }, lawfulBasis: { basis: 'legitimate_interest' } })
      .mockResolvedValueOnce({ status: 'guessed', email: 'john@pump.example', verdict: { status: 'RISKY' } })
      .mockResolvedValueOnce({ status: 'blocked', reason: 'lawful_basis_required' });
    vi.mocked(persistGuessedEmail)
      .mockResolvedValueOnce({ persisted: true, email: 'jane@pump.example', status: 'VALID' } as any)
      .mockResolvedValueOnce({ persisted: true, email: 'john@pump.example', status: 'RISKY' } as any)
      .mockResolvedValueOnce({ persisted: false } as any);

    const result = await service.guessEmailsForCompany(ctx, 'company-1', {
      lawfulBasis: { basis: 'legitimate_interest' } as any,
      maxContacts: 3,
      maxProbe: 2,
    });

    expect(result).toMatchObject({
      emaillessContacts: 4,
      attempted: 3,
      persisted: 2,
      verified: 1,
      unverified: 1,
      blocked: 1,
    });
    expect(persistGuessedEmail).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ lawfulBasis: { basis: 'legitimate_interest' } }),
    );
    expect(result.perContact[2]).toMatchObject({ email: null, pointStatus: null });
  });

  it('rejects absent and non-email contact points before verification', async () => {
    const missing = harness();
    missing.tx.contactPoint.findUnique.mockResolvedValue(null);
    await expect(missing.service.verifyContactPoint(ctx, 'missing')).rejects.toBeInstanceOf(NotFoundException);

    const phone = harness();
    phone.tx.contactPoint.findUnique.mockResolvedValue({ id: 'point-1', type: 'phone', value: '+493012345678' });
    await expect(phone.service.verifyContactPoint(ctx, 'point-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('records a blocked compliance decision without calling a verifier', async () => {
    vi.mocked(evaluateEmailGate).mockReturnValue({
      allowed: false,
      kind: 'invalid',
      reason: 'SUPPRESSED',
      lawfulBasis: undefined,
    } as any);
    const { service, tx } = harness();
    tx.contactPoint.findUnique.mockResolvedValue({
      id: 'point-1',
      contactId: 'contact-1',
      type: 'email',
      value: 'invalid-email',
    });
    tx.suppressionRecord.findFirst.mockResolvedValue({ id: 'suppression-1' });

    const result = await service.verifyContactPoint(ctx, 'point-1');

    expect(result.verification).toMatchObject({
      status: 'BLOCKED',
      providerKey: 'compliance_gate',
      kind: null,
    });
    expect(tx.fieldEvidence.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ allowedActions: [], license: 'public' }),
    });
  });

  it('requires a provider after an allowed gate and persists VALID or RISKY verifier results', async () => {
    const noProvider = harness();
    await expect(noProvider.service.verifyContactPoint(ctx, 'point-1')).rejects.toBeInstanceOf(ConflictException);

    for (const verdict of [
      { status: 'VALID', detail: 'mx and rcpt', kind: 'role', lawfulBasis: undefined },
      { status: 'RISKY', detail: undefined, kind: undefined, lawfulBasis: { basis: 'consent' } },
    ]) {
      const current = harness();
      const adapter = { key: verdict.status === 'VALID' ? 'sandbox' : 'smtp_self', verifyEmail: vi.fn(async () => verdict) };
      current.providers.routeEmailVerification.mockResolvedValue([adapter]);
      vi.mocked(evaluateEmailGate).mockReturnValue({
        allowed: true,
        kind: 'role',
        reason: 'ROLE_MAILBOX',
        lawfulBasis: verdict.lawfulBasis,
      } as any);

      const result = await current.service.verifyContactPoint(ctx, 'point-1', {
        allowPersonalWithoutBasis: true,
      });

      expect(result.verification.status).toBe(verdict.status);
      expect(adapter.verifyEmail).toHaveBeenCalledWith(
        'info@pump.example',
        expect.objectContaining({ workspaceId: ctx.workspaceId, kind: 'role' }),
      );
      expect(current.tx.fieldEvidence.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          providerKey: adapter.key,
          license: adapter.key === 'sandbox' ? 'sandbox' : 'public',
          allowedActions:
            verdict.status === 'VALID'
              ? ['display', 'match', 'outreach']
              : ['display', 'match'],
        }),
      });
    }
  });

  it('adds normalized suppressions, verifies writes, and immediately suppresses domains', async () => {
    const { service, tx } = harness();
    await expect(service.addSuppression(ctx, { type: 'domain', value: ' PUMP.EXAMPLE ' })).resolves.toMatchObject({ id: 'suppression-1' });
    expect(tx.suppressionRecord.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ value: 'pump.example', reason: 'manual' })],
      skipDuplicates: true,
    });
    expect(tx.canonicalCompany.updateMany).toHaveBeenCalledOnce();

    await service.addSuppression(ctx, { type: 'email', value: 'A@PUMP.EXAMPLE', reason: 'unsubscribe' });
    expect(tx.canonicalCompany.updateMany).toHaveBeenCalledOnce();

    tx.suppressionRecord.findUnique.mockResolvedValueOnce(null);
    await expect(service.addSuppression(ctx, { type: 'email', value: 'x@example.com' })).rejects.toThrow('SUPPRESSION_WRITE_UNVERIFIED');
  });

  it('lists providers/suppressions and keeps deprecated removal fail-closed', async () => {
    const { service, tx } = harness();
    await expect(service.listSuppressions(ctx)).resolves.toEqual([{ type: 'email', value: 'blocked@pump.example' }]);
    await expect(service.listProviders(ctx)).resolves.toEqual([{ key: 'smtp_self' }]);
    tx.suppressionRecord.findUnique.mockResolvedValueOnce(null);
    await expect(service.removeSuppression(ctx, 'missing')).rejects.toBeInstanceOf(NotFoundException);
    tx.suppressionRecord.findUnique.mockResolvedValueOnce({ id: 'suppression-1' });
    await expect(service.removeSuppression(ctx, 'suppression-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('creates a reviewed release request and normalizes Error or non-Error policy rejections', async () => {
    const { service, tx } = harness();
    await expect(service.requestSuppressionRelease(ctx, 'suppression-1', {
      requestKind: 'USER_PREFERENCE',
      justification: 'recorded by mistake',
      evidenceRef: null,
    })).resolves.toMatchObject({
      status: 'PENDING_REVIEW',
      actorId: ctx.userId,
    });

    tx.suppressionRecord.findUnique.mockResolvedValueOnce(null);
    await expect(service.requestSuppressionRelease(ctx, 'missing', {
      requestKind: 'USER_PREFERENCE',
      justification: 'missing',
      evidenceRef: null,
    })).rejects.toBeInstanceOf(NotFoundException);

    vi.mocked(evaluateSuppressionReleaseRequest)
      .mockImplementationOnce(() => { throw new Error('LEGAL_SUPPRESSION_NOT_RELEASABLE'); })
      .mockImplementationOnce(() => { throw 'unknown'; });
    for (const expectedCode of ['LEGAL_SUPPRESSION_NOT_RELEASABLE', 'SUPPRESSION_RELEASE_REJECTED']) {
      await expect(service.requestSuppressionRelease(ctx, 'suppression-1', {
        requestKind: 'USER_PREFERENCE',
        justification: 'bad request',
        evidenceRef: 'FIELD_EVIDENCE:evidence-1',
      })).rejects.toMatchObject({ response: { error: { code: expectedCode } } });
    }
  });
});
