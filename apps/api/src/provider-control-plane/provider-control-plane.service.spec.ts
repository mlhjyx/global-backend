import { describe, expect, it, vi } from 'vitest';
import { ProviderControlPlaneService } from './provider-control-plane.service';

const CTX = {
  userId: 'operator-1',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  roles: ['ops'],
};

function prismaFixture() {
  const providerQualityRunContribution = {
    findMany: vi.fn(async () => [
      {
        providerKey: 'nppes',
        runId: '22222222-2222-4222-8222-222222222222',
        terminalStatus: 'DONE',
        rawCount: 2,
        acceptedCount: 2,
        boundCount: 1,
        domainCount: 0,
        authorityCount: 1,
        conflictCount: 0,
        duplicateCount: 0,
        completedAt: new Date('2026-08-16T00:00:00.000Z'),
      },
      {
        providerKey: 'nppes',
        runId: '33333333-3333-4333-8333-333333333333',
        terminalStatus: 'DONE',
        rawCount: 1,
        acceptedCount: 1,
        boundCount: 1,
        domainCount: 0,
        authorityCount: 1,
        conflictCount: 0,
        duplicateCount: 0,
        completedAt: new Date('2026-08-15T00:00:00.000Z'),
      },
    ]),
  };
  return {
    dataProvider: {
      findMany: vi.fn(async () => [
        { key: 'public_web', status: 'ENABLED' },
        { key: 'nppes', status: 'ENABLED' },
        { key: 'koneps', status: 'DISABLED' },
      ]),
    },
    sourcePolicy: {
      findMany: vi.fn(async () => [
        {
          domain: 'google.serper.dev',
          reviewStatus: 'SUSPENDED',
          allowedPurpose: ['discovery'],
          robotsStatus: 'ALLOWS',
          termsStatus: 'UNREVIEWED',
          personalData: false,
          updatedAt: new Date('2026-08-16T00:00:00.000Z'),
        },
        {
          domain: 'api.search.brave.com',
          reviewStatus: 'APPROVED',
          allowedPurpose: ['discovery'],
          robotsStatus: 'ALLOWS',
          termsStatus: 'REVIEWED_OK',
          personalData: false,
          updatedAt: new Date('2026-08-16T00:00:00.000Z'),
        },
        {
          domain: 'npiregistry.cms.hhs.gov',
          reviewStatus: 'APPROVED',
          allowedPurpose: ['discovery', 'enrichment'],
          robotsStatus: 'UNREVIEWED',
          termsStatus: 'REVIEWED_OK',
          personalData: true,
          updatedAt: new Date('2026-08-14T00:00:00.000Z'),
        },
      ]),
    },
    withWorkspace: vi.fn(async (_workspaceId: string, fn: (tx: unknown) => unknown) =>
      fn({ providerQualityRunContribution }),
    ),
    __qualityFindMany: providerQualityRunContribution.findMany,
  };
}

describe('ProviderControlPlaneService', () => {
  it('keeps every evidence dimension separate and uses only the latest immutable provider ledger row', async () => {
    const prisma = prismaFixture();
    const service = new ProviderControlPlaneService(
      prisma as never,
      (envKey) => envKey === 'KONEPS_SERVICE_KEY' || envKey === 'SERPER_API_KEY',
    );

    const result = await service.list(CTX);
    const nppes = result.providers.find(({ key }) => key === 'nppes');
    const koneps = result.providers.find(({ key }) => key === 'koneps');

    expect(result.scope).toEqual({
      platform: ['registration', 'credentialPresence', 'searchBackends', 'enablement', 'sourcePolicies', 'route', 'live'],
      workspace: ['persisted', 'evidenceRail'],
    });
    expect(nppes).toMatchObject({
      registration: { status: 'IMPLEMENTED' },
      credentialPresence: { requirement: 'NOT_REQUIRED', status: 'NOT_REQUIRED', fields: [] },
      enablement: { status: 'ENABLED' },
      sourcePolicies: { status: 'ROBOTS_UNREVIEWED' },
      route: { status: 'DECLARED' },
      live: { status: 'NEVER_TESTED' },
      persisted: {
        status: 'AVAILABLE',
        latestRunId: '22222222-2222-4222-8222-222222222222',
        rawCount: 2,
        acceptedCount: 2,
        boundCount: 1,
      },
      evidenceRail: {
        raw: 'PROVEN',
        canonicalBinding: 'PROVEN',
        evidence: 'UNAVAILABLE',
        lead: 'UNAVAILABLE',
        outbox: 'UNAVAILABLE',
        replay: 'UNAVAILABLE',
      },
    });
    expect(koneps).toMatchObject({
      credentialPresence: {
        requirement: 'REQUIRED',
        status: 'LEGACY_EXTERNAL',
        fields: [{ key: 'serviceKey', configured: true, secret: true, writeOnly: true }],
      },
      enablement: { status: 'DISABLED' },
      persisted: { status: 'UNKNOWN' },
    });
    expect(result.providers.find(({ key }) => key === 'public_web')?.searchBackends).toEqual([
      {
        id: 'searxng.search',
        displayName: 'SearXNG',
        kind: 'SELF_HOSTED',
        credentialStatus: 'NOT_REQUIRED',
        policyStatus: 'NOT_REQUIRED',
        routingStatus: 'DEFAULT',
      },
      {
        id: 'serper.search',
        displayName: 'Serper (Google)',
        kind: 'BYOK',
        credentialStatus: 'CONFIGURED',
        policyStatus: 'SUSPENDED',
        routingStatus: 'BLOCKED',
      },
      {
        id: 'brave.search',
        displayName: 'Brave Search',
        kind: 'BYOK',
        credentialStatus: 'MISSING',
        policyStatus: 'READY',
        routingStatus: 'BLOCKED',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('KONEPS_SERVICE_KEY');
    expect(JSON.stringify(result)).not.toContain('credential-value');
    expect(prisma.dataProvider.findMany).toHaveBeenCalledWith({
      where: { key: { in: expect.arrayContaining(['nppes', 'koneps']) } },
      select: { key: true, status: true },
      orderBy: { key: 'asc' },
      take: 34,
    });
    expect(prisma.withWorkspace).toHaveBeenCalledWith(CTX.workspaceId, expect.any(Function));
    expect(prisma.__qualityFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        distinct: ['providerKey'],
        take: 34,
        orderBy: [
          { providerKey: 'asc' },
          { completedAt: 'desc' },
          { id: 'desc' },
        ],
      }),
    );
  });

  it('does not collapse restricted policies or alternative legacy credentials into ready', async () => {
    const prisma = prismaFixture();
    prisma.sourcePolicy.findMany.mockResolvedValue([
      {
        domain: 'npiregistry.cms.hhs.gov',
        reviewStatus: 'APPROVED',
        allowedPurpose: ['discovery'],
        robotsStatus: 'RESTRICTS',
        termsStatus: 'REVIEWED_RESTRICTED',
        personalData: true,
        updatedAt: new Date('2026-08-14T00:00:00.000Z'),
      },
    ]);
    const service = new ProviderControlPlaneService(
      prisma as never,
      (envKey) => envKey === 'GOOGLE_APPLICATION_CREDENTIALS' || envKey === 'GOOGLE_PATENTS_PROJECT',
    );

    const result = await service.list(CTX);
    expect(result.providers.find(({ key }) => key === 'nppes')?.sourcePolicies.status).toBe(
      'TERMS_RESTRICTED',
    );
    expect(result.providers.find(({ key }) => key === 'google_patents')?.credentialPresence).toMatchObject({
      requirement: 'REQUIRED',
      status: 'UNKNOWN',
      fields: [
        { key: 'serviceAccountPath', configured: false },
        { key: 'applicationCredentialsPath', configured: true },
        { key: 'projectId', configured: true },
      ],
    });
  });

  it('fails closed for unknown policy status values and missing purpose metadata', async () => {
    const prisma = prismaFixture();
    prisma.sourcePolicy.findMany.mockResolvedValue([
      {
        domain: 'npiregistry.cms.hhs.gov',
        reviewStatus: 'FUTURE_REVIEW_STATE',
        allowedPurpose: null,
        robotsStatus: 'FUTURE_ROBOTS_STATE',
        termsStatus: 'FUTURE_TERMS_STATE',
        personalData: true,
        updatedAt: new Date('2026-08-14T00:00:00.000Z'),
      },
    ]);

    const result = await new ProviderControlPlaneService(prisma as never, () => false).list(CTX);
    expect(result.providers.find(({ key }) => key === 'nppes')?.sourcePolicies.status).toBe('UNKNOWN');
  });

  it('does not turn missing policy, DB rows, credentials, or runtime evidence into readiness', async () => {
    const prisma = prismaFixture();
    prisma.dataProvider.findMany.mockResolvedValue([]);
    prisma.sourcePolicy.findMany.mockResolvedValue([]);
    const service = new ProviderControlPlaneService(prisma as never, () => false);

    const result = await service.list(CTX);
    const fmcsa = result.providers.find(({ key }) => key === 'fmcsa_qcmobile');

    expect(fmcsa).toMatchObject({
      credentialPresence: { requirement: 'REQUIRED', status: 'MISSING' },
      enablement: { status: 'MISSING' },
      sourcePolicies: { status: 'MISSING' },
      live: { status: 'NEVER_TESTED' },
      persisted: { status: 'UNKNOWN' },
      allowedActions: {
        canConfigureCredential: false,
        canEnable: false,
        canDisable: false,
        canTestConnection: false,
      },
    });
  });
});
