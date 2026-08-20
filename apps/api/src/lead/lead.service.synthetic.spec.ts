import { describe, expect, it, vi } from 'vitest';
import { LeadService } from './lead.service';

const ctx = { workspaceId: 'ws-1', userId: 'user-1', roles: [] } as never;

function serviceWithTx(tx: unknown): LeadService {
  return new LeadService(
    { withWorkspace: async <T>(_workspaceId: string, callback: (client: unknown) => Promise<T>) => callback(tx) } as never,
    {} as never,
    {} as never,
  );
}

describe('LeadService synthetic provenance read quarantine', () => {
  it('preserves all list filters and the caller cursor while scanning product rows', async () => {
    const lead = { id: 'lead-filtered', canonicalCompanyId: 'company-filtered' };
    const tx = {
      lead: { findMany: vi.fn(async () => [lead]) },
      canonicalCompany: {
        findMany: vi.fn(async () => [{ id: 'company-filtered', name: 'Filtered Co' }]),
      },
      fieldEvidence: { findMany: vi.fn(async () => []) },
    };

    await expect(
      serviceWithTx(tx).list(ctx, {
        icpId: 'icp-1',
        queue: 'review',
        status: 'QUALIFIED',
        limit: 2,
        cursor: 'lead-before',
      }),
    ).resolves.toMatchObject({
      data: [{ ...lead, company: { id: 'company-filtered', name: 'Filtered Co' } }],
      nextCursor: null,
      hasMore: false,
    });
    expect(tx.lead.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { icpId: 'icp-1', queue: 'review', status: 'QUALIFIED' },
        cursor: { id: 'lead-before' },
        skip: 1,
      }),
    );
  });

  it('returns a product lead with no company summary without querying empty evidence', async () => {
    const lead = { id: 'lead-orphan', canonicalCompanyId: 'company-missing' };
    const tx = {
      lead: { findMany: vi.fn(async () => [lead]) },
      canonicalCompany: { findMany: vi.fn(async () => []) },
      fieldEvidence: { findMany: vi.fn(async () => []) },
    };

    await expect(serviceWithTx(tx).list(ctx, { limit: 2 })).resolves.toEqual({
      data: [{ ...lead, company: null }],
      nextCursor: null,
      hasMore: false,
    });
    expect(tx.fieldEvidence.findMany).not.toHaveBeenCalled();
  });

  it('scans past a full synthetic batch to return the next product leads in the same page', async () => {
    const syntheticLeads = [
      { id: 'lead-synthetic-1', canonicalCompanyId: 'company-synthetic-1' },
      { id: 'lead-synthetic-2', canonicalCompanyId: 'company-synthetic-2' },
      { id: 'lead-synthetic-3', canonicalCompanyId: 'company-synthetic-3' },
    ];
    const productLeads = [
      { id: 'lead-real-1', canonicalCompanyId: 'company-real-1' },
      { id: 'lead-real-2', canonicalCompanyId: 'company-real-2' },
    ];
    const tx = {
      lead: {
        findMany: vi.fn(async (query: { cursor?: { id: string } }) =>
          query.cursor?.id === 'lead-synthetic-3' ? productLeads : syntheticLeads,
        ),
      },
      canonicalCompany: {
        findMany: vi.fn(async (query: { where: { id: { in: string[] } } }) =>
          query.where.id.in.map((id) => ({ id, name: id })),
        ),
      },
      fieldEvidence: {
        findMany: vi.fn(async (query: { where: { entityId: { in: string[] } } }) =>
          query.where.entityId.in[0]?.startsWith('company-synthetic')
            ? query.where.entityId.in.map((entityId) => ({
                entityId,
                providerKey: 'sandbox',
                license: 'fixture',
              }))
            : [],
        ),
      },
    };

    await expect(serviceWithTx(tx).list(ctx, { limit: 2 })).resolves.toEqual({
      data: productLeads.map((lead) => ({
        ...lead,
        company: { id: lead.canonicalCompanyId, name: lead.canonicalCompanyId },
      })),
      nextCursor: null,
      hasMore: false,
    });
    expect(tx.lead.findMany).toHaveBeenCalledTimes(2);
  });

  it('fills the product page across an interleaved synthetic lead and proves exhaustion', async () => {
    const leads = [
      { id: 'lead-real', canonicalCompanyId: 'company-real' },
      { id: 'lead-synthetic', canonicalCompanyId: 'company-synthetic' },
      { id: 'lead-next', canonicalCompanyId: 'company-next' },
    ];
    const tx = {
      lead: {
        findMany: vi.fn().mockResolvedValueOnce(leads).mockResolvedValueOnce([]),
      },
      canonicalCompany: {
        findMany: vi.fn(async () => [
          { id: 'company-real', name: 'Real Co' },
          { id: 'company-synthetic', name: 'Synthetic Co' },
          { id: 'company-next', name: 'Next Co' },
        ]),
      },
      fieldEvidence: {
        findMany: vi.fn(async () => [
          { entityId: 'company-synthetic', providerKey: 'public_web', license: 'fixture' },
        ]),
      },
    };

    await expect(serviceWithTx(tx).list(ctx, { limit: 2 })).resolves.toEqual({
      data: [
        { ...leads[0], company: { id: 'company-real', name: 'Real Co' } },
        { ...leads[2], company: { id: 'company-next', name: 'Next Co' } },
      ],
      nextCursor: null,
      hasMore: false,
    });
    expect(tx.lead.findMany).toHaveBeenCalledTimes(2);
  });

  it('returns a stable quarantine conflict for a direct read backed by synthetic contact evidence', async () => {
    const tx = {
      lead: { findUnique: vi.fn(async () => ({ id: 'lead-synthetic', canonicalCompanyId: 'company-1', decisions: [] })) },
      canonicalCompany: {
        findUnique: vi.fn(async () => ({
          id: 'company-1',
          name: 'Company',
          contacts: [{ id: 'contact-synthetic', contactPoints: [] }],
        })),
      },
      fieldEvidence: {
        findMany: vi.fn(async () => [
          { entityId: 'contact-synthetic', providerKey: 'fake', license: 'synthetic' },
        ]),
      },
    };

    await expect(serviceWithTx(tx).get(ctx, 'lead-synthetic')).rejects.toMatchObject({
      response: { error: { code: 'SYNTHETIC_PROVENANCE_QUARANTINED' } },
    });
  });

  it('returns a direct lead read when the company is absent or has only product evidence', async () => {
    const lead = { id: 'lead-real', canonicalCompanyId: 'company-real', decisions: [] };
    const company = { id: 'company-real', contacts: [] };
    const canonicalCompany = {
      findUnique: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(company),
    };
    const fieldEvidence = { findMany: vi.fn(async () => [{ providerKey: 'ted', license: 'CC0-1.0' }]) };
    const service = serviceWithTx({
      lead: { findUnique: vi.fn(async () => lead) },
      canonicalCompany,
      fieldEvidence,
    });

    await expect(service.get(ctx, 'lead-real')).resolves.toEqual({ ...lead, company: null });
    await expect(service.get(ctx, 'lead-real')).resolves.toEqual({ ...lead, company });
    expect(fieldEvidence.findMany).toHaveBeenCalledTimes(1);
  });
});
