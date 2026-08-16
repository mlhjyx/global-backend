import { describe, expect, it, vi } from 'vitest';
import { commitNppesLifecycleFact } from './nppes-lifecycle';

const NOW = new Date('2026-08-13T16:00:00.000Z');
const RAW = {
  id: 'raw-deactivated',
  providerKey: 'nppes',
  sourceUrl: 'https://npiregistry.cms.hhs.gov/api/?number=1234567893&version=2.1',
  fetchedAt: NOW,
  contentHash: 'a'.repeat(64),
  parserVersion: 'nppes-v2.1/1',
};
const RECORD = {
  name: 'Deactivated Clinic',
  country: 'US',
  identifiers: [{ scheme: 'us_npi', jurisdiction: 'US', value: '1234567893' }],
  attributes: { nppes: { npi: '1234567893', entity_type: 'NPI-2', status: 'D', candidate_eligible: false, observation_scope: 'exact_npi' } },
};

function txHarness(args?: { leadStatus?: string; delivered?: number; aliases?: string[] }) {
  const identifier = {
    id: 'identifier-1',
    companyId: 'company-1',
    status: 'ACTIVE',
    provenance: { admittedBy: 'raw-active' },
  };
  const updateIdentifier = vi.fn(async () => identifier);
  const updateLeads = vi.fn(async () => ({
    count: !args?.delivered && args?.leadStatus && ['DISCOVERED', 'ENRICHING', 'REVIEW'].includes(args.leadStatus) ? 1 : 0,
  }));
  const createLink = vi.fn(async () => ({}));
  const updateCompanies = vi.fn(async () => ({ count: 1 }));
  const upsertEvidence = vi.fn(async () => ({}));
  const tx = {
    $queryRaw: vi.fn(async () => [{ locked: '' }]),
    organizationCanonicalMapping: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => (args?.aliases ?? []).map((sourceCompanyId) => ({ sourceCompanyId }))),
    },
    canonicalCompany: { updateMany: updateCompanies },
    organizationIdentifier: {
      findFirst: vi.fn(async ({ where }: { where: { status?: string } }) =>
        !where.status || where.status === identifier.status ? identifier : null),
      update: updateIdentifier,
    },
    identityLink: { upsert: createLink },
    fieldEvidence: { upsert: upsertEvidence },
    lead: {
      findMany: vi.fn(async () => args?.leadStatus ? [{ id: 'lead-1', status: args.leadStatus }] : []),
      updateMany: updateLeads,
    },
    outboxEvent: {
      findMany: vi.fn(async () => args?.delivered ? [{ aggregateId: 'lead-1' }] : []),
    },
  };
  return { tx, updateIdentifier, updateLeads, createLink, updateCompanies, upsertEvidence };
}

describe('NPPES exact-NPI lifecycle commit', () => {
  it('keeps the NPI identity active while suppressing the company and non-terminal candidate', async () => {
    const h = txHarness({ leadStatus: 'REVIEW' });

    await expect(commitNppesLifecycleFact(h.tx as never, {
      workspaceId: 'workspace-1', raw: RAW, record: RECORD, now: NOW,
    })).resolves.toEqual({ kind: 'deactivated', companyId: 'company-1', suppressedLeads: 1, requiresManualFollowup: false });

    expect(h.updateIdentifier).not.toHaveBeenCalled();
    expect(h.updateCompanies).toHaveBeenCalledWith({
      where: { id: { in: ['company-1'] }, status: { not: 'SUPPRESSED' } },
      data: { status: 'SUPPRESSED', version: { increment: 1 } },
    });
    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(h.updateLeads).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ['DISCOVERED', 'ENRICHING', 'REVIEW'] } }),
      data: expect.objectContaining({ status: 'SUPPRESSED', queue: 'suppressed' }),
    }));
    expect(h.createLink).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ rawRecordId: 'raw-deactivated', status: 'ACTIVE' }),
    }));
    expect(h.upsertEvidence).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        entityId: 'company-1', field: 'nppes.status', value: 'D', rawRecordId: 'raw-deactivated',
      }),
    }));
  });

  it.each(['QUALIFIED', 'CONTACTED', 'CONVERTED'])(
    'preserves a %s Lead but suppresses the organization and requests manual follow-up',
    async (leadStatus) => {
      const h = txHarness({ leadStatus });
      await expect(commitNppesLifecycleFact(h.tx as never, {
        workspaceId: 'workspace-1', raw: RAW, record: RECORD, now: NOW,
      })).resolves.toEqual({
        kind: 'deactivated', companyId: 'company-1', suppressedLeads: 0, requiresManualFollowup: true,
      });
      expect(h.updateIdentifier).not.toHaveBeenCalled();
      expect(h.updateCompanies).toHaveBeenCalledOnce();
      expect(h.updateLeads).toHaveBeenCalledOnce();
      expect(h.createLink).toHaveBeenCalledOnce();
      expect(h.upsertEvidence).toHaveBeenCalledOnce();
    },
  );

  it('preserves a delivered LeadQualified fact while suppressing later acquisition actions', async () => {
    const h = txHarness({ leadStatus: 'REVIEW', delivered: 1 });
    await expect(commitNppesLifecycleFact(h.tx as never, {
      workspaceId: 'workspace-1', raw: RAW, record: RECORD, now: NOW,
    })).resolves.toEqual({
      kind: 'deactivated', companyId: 'company-1', suppressedLeads: 0, requiresManualFollowup: true,
    });
    expect(h.updateIdentifier).not.toHaveBeenCalled();
    expect(h.updateCompanies).toHaveBeenCalledOnce();
    expect(h.upsertEvidence).toHaveBeenCalledOnce();
    expect(h.updateLeads).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { notIn: ['lead-1'] } }),
    }));
  });

  it('keeps an unmatched deactivation only in Raw and never synthesizes a company or Lead', async () => {
    const h = txHarness();
    h.tx.organizationIdentifier.findFirst = vi.fn(async () => null);
    await expect(commitNppesLifecycleFact(h.tx as never, {
      workspaceId: 'workspace-1', raw: RAW, record: RECORD, now: NOW,
    })).resolves.toEqual({ kind: 'unmatched' });
    expect(h.updateIdentifier).not.toHaveBeenCalled();
    expect(h.updateLeads).not.toHaveBeenCalled();
    expect(h.createLink).not.toHaveBeenCalled();
    expect(h.updateCompanies).not.toHaveBeenCalled();
    expect(h.upsertEvidence).not.toHaveBeenCalled();
  });

  it('uses upserts for the lifecycle link and field evidence so the same Raw replay is idempotent', async () => {
    const h = txHarness();
    await commitNppesLifecycleFact(h.tx as never, {
      workspaceId: 'workspace-1', raw: RAW, record: RECORD, now: NOW,
    });
    expect(h.createLink).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_canonicalType_canonicalId_rawRecordId: expect.any(Object) },
      update: expect.objectContaining({ status: 'ACTIVE' }),
    }));
    expect(h.upsertEvidence).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_entityType_entityId_field_rawRecordId: expect.any(Object) },
      update: expect.objectContaining({ value: 'D' }),
    }));
  });

  it('suppresses the root and every active alias in the identity group', async () => {
    const h = txHarness({ aliases: ['alias-1', 'alias-2'] });
    await commitNppesLifecycleFact(h.tx as never, {
      workspaceId: 'workspace-1', raw: RAW, record: RECORD, now: NOW,
    });
    expect(h.updateCompanies).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['company-1', 'alias-1', 'alias-2'] }, status: { not: 'SUPPRESSED' } },
    }));
    expect(h.updateLeads).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ canonicalCompanyId: { in: ['company-1', 'alias-1', 'alias-2'] } }),
    }));
    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(2);
    const rowLock = h.tx.$queryRaw.mock.calls[1]?.[0] as { strings?: string[] } | undefined;
    expect(rowLock?.strings?.join('')).toContain('id IN (::uuid,::uuid,::uuid)');
  });

  it('ignores active or non-NPPES records', async () => {
    const h = txHarness();
    await expect(commitNppesLifecycleFact(h.tx as never, {
      workspaceId: 'workspace-1', raw: RAW, record: { ...RECORD, attributes: { nppes: { status: 'A' } } }, now: NOW,
    })).resolves.toEqual({ kind: 'not_applicable' });
    await expect(commitNppesLifecycleFact(h.tx as never, {
      workspaceId: 'workspace-1', raw: { ...RAW, providerKey: 'wikidata' }, record: RECORD, now: NOW,
    })).resolves.toEqual({ kind: 'not_applicable' });
  });
});
