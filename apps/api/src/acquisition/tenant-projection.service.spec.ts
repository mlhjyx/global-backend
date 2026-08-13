import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';

const identityMocks = vi.hoisted(() => ({
  appendCompanyIdentityDecisionEvidence: vi.fn(async () => undefined),
  companyIdentityResolutionProjection: vi.fn(() => ({ decision: 'AUTO_LINK' })),
  resolveCompanyIdentityForWriter: vi.fn(),
}));

vi.mock('../discovery/company-identity-persistence', () => identityMocks);

import { TenantProjectionService } from './tenant-projection.service';

function decision(dedupeKey: string, prior: Record<string, unknown> | null = null) {
  return {
    decision: {
      decision: 'AUTO_LINK',
      action: 'LINK',
      ruleVersion: 'company-identity-resolution/2026-08-07-v1',
      identity: { dedupeKey, matchRule: 'domain_exact' },
      recommendationEligible: true,
      ambiguous: false,
      reasons: ['domain_exact'],
    },
    candidateDedupeKey: `candidate:${dedupeKey}`,
    targetExisting: prior,
  };
}

function entity(overrides: Record<string, unknown> = {}) {
  return {
    id: 'raw-1',
    name: 'Acme Pumps',
    domain: 'acme.example',
    country: 'DE',
    cleaned: {},
    lastSeenAt: new Date('2026-08-08T00:00:00.000Z'),
    ...overrides,
  };
}

function harness(args?: {
  source?: Record<string, unknown> | null;
  entities?: Record<string, unknown>[];
  suppressions?: { type: string; value: string }[];
  linkExists?: boolean;
  canonicalPrior?: Record<string, unknown> | null;
}) {
  const source = args && 'source' in args
    ? args.source
    : { id: 'source-1', sourceKey: 'fair:2026', providerKey: 'trade_fair' };
  const entities = args?.entities ?? [];
  const suppressionRecord = {
    findMany: vi.fn(async () => args?.suppressions ?? []),
  };
  const canonicalCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'co-created', ...data }));
  const canonicalUpdate = vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
    id: where.id,
    ...data,
  }));
  const identityLinkCreate = vi.fn(async () => ({ id: 'link-new' }));
  const fieldEvidenceCreate = vi.fn(async () => ({ id: 'evidence-new' }));
  const tx = {
    $queryRaw: vi.fn(async () => [{ locked: true }]),
    suppressionRecord,
    canonicalCompany: {
      findUnique: vi.fn(async () => args?.canonicalPrior ?? null),
      create: canonicalCreate,
      update: canonicalUpdate,
    },
    identityLink: {
      findFirst: vi.fn(async () => (args?.linkExists ? { id: 'link-existing' } : null)),
      create: identityLinkCreate,
    },
    fieldEvidence: { create: fieldEvidenceCreate },
  };
  const prisma = {
    monitoredSource: { findUnique: vi.fn(async () => source) },
    sourceEntity: { findMany: vi.fn(async () => entities) },
    withWorkspace: vi.fn(async (_workspaceId: string, fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;

  return {
    service: new TenantProjectionService({ prisma }),
    prisma,
    tx,
    canonicalCreate,
    canonicalUpdate,
    identityLinkCreate,
    fieldEvidenceCreate,
  };
}

describe('TenantProjectionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails closed for an unknown monitored source', async () => {
    await expect(harness({ source: null }).service.projectSource('ws-1', 'missing')).rejects.toThrow(
      'monitored_source missing not found',
    );
  });

  it('returns an explicit skipped receipt when the source has no active entities', async () => {
    await expect(harness().service.projectSource('ws-1', 'source-1')).resolves.toEqual({
      sourceId: 'source-1',
      sourceKey: 'fair:2026',
      entities: 0,
      projected: 0,
      suppressed: 0,
      personalContactsWithheld: 0,
      status: 'SKIPPED',
      reason: 'no active entities',
    });
  });

  it('blocks a suppressed company before materialization and withholds its personal mailbox', async () => {
    const row = entity({
      cleaned: {
        legal_name: 'Acme Pumpen GmbH',
        products: ['pump'],
        email_kind: 'personal',
        email: 'person@acme.example',
        shared_group_domain: true,
        source_fair: 'Pump Expo',
      },
    });
    const h = harness({
      entities: [row],
      suppressions: [{ type: 'domain', value: 'ACME.EXAMPLE' }],
    });
    identityMocks.resolveCompanyIdentityForWriter.mockResolvedValueOnce(decision('d:acme.example'));

    await expect(h.service.projectSource('ws-1', 'source-1', { limit: 1 })).resolves.toEqual({
      sourceId: 'source-1',
      sourceKey: 'fair:2026',
      entities: 1,
      projected: 0,
      suppressed: 1,
      personalContactsWithheld: 0,
      status: 'DONE',
    });
    expect(h.canonicalCreate).not.toHaveBeenCalled();
    expect(h.identityLinkCreate).not.toHaveBeenCalled();
    expect(identityMocks.appendCompanyIdentityDecisionEvidence).not.toHaveBeenCalled();
    expect(h.fieldEvidenceCreate).not.toHaveBeenCalled();
  });

  it('updates an existing identity, merges products and preserves prior namespaces', async () => {
    const prior = {
      id: 'co-existing',
      dedupeKey: 'd:acme.example',
      name: 'Acme',
      domain: null,
      country: null,
      status: 'ACTIVE',
      attributes: {
        products: ['legacy', 'pump'],
        legal_name: 'Existing Legal Name',
        gleif: { lei: 'LEI-1' },
        shared_group_domain: true,
      },
    };
    const h = harness({
      entities: [
        entity({
          cleaned: {
            products: ['pump', 'valve'],
            legal_name: 'Incoming Legal Name',
            email_kind: 'role',
            email: 'sales@acme.example',
            source_kind: 'directory',
          },
        }),
      ],
      suppressions: [{ type: 'company_name', value: 'someone else' }],
      canonicalPrior: prior,
    });
    identityMocks.resolveCompanyIdentityForWriter.mockResolvedValueOnce(decision('d:acme.example', prior));

    await expect(h.service.projectSource('ws-1', 'source-1')).resolves.toMatchObject({
      projected: 1,
      suppressed: 0,
      personalContactsWithheld: 0,
      status: 'DONE',
    });
    const data = h.canonicalUpdate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      domain: { set: 'acme.example' },
      country: { set: 'DE' },
      version: { increment: 1 },
    });
    expect(data.status).toBeUndefined();
    expect(data.attributes).toMatchObject({
      products: ['legacy', 'pump', 'valve'],
      legal_name: 'Existing Legal Name',
      gleif: { lei: 'LEI-1' },
      shared_group_domain: true,
      contact_email: 'sales@acme.example',
    });
  });

  it('does not duplicate immutable provenance when the source identity link already exists', async () => {
    const h = harness({
      entities: [entity({ domain: null, country: null, cleaned: { products: 'not-an-array' } })],
      linkExists: true,
      suppressions: [{ type: 'company_name', value: 'acme pumps' }],
    });
    identityMocks.resolveCompanyIdentityForWriter.mockResolvedValueOnce(decision('n:acme-pumps'));

    await expect(h.service.projectSource('ws-1', 'source-1')).resolves.toMatchObject({
      projected: 0,
      suppressed: 1,
    });
    expect(h.identityLinkCreate).not.toHaveBeenCalled();
    expect(identityMocks.appendCompanyIdentityDecisionEvidence).not.toHaveBeenCalled();
    expect(h.fieldEvidenceCreate).not.toHaveBeenCalled();
    expect(h.canonicalCreate).not.toHaveBeenCalled();
  });
});
