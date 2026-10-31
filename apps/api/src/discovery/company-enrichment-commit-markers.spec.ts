import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { commitCompanyEnrichmentResults } from './company-enrichment-commit';

// Synthetic `.example` company only.
function makeTx() {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const create = vi.fn(async () => ({}));
  const tx = {
    $queryRaw: vi.fn(async () => [{ locked: true }]),
    canonicalCompany: {
      findUnique: vi.fn(async () => ({
        id: 'co-1',
        name: 'Pumpen Handel GmbH',
        domain: 'pumpen-handel.example',
        status: 'NEW',
        attributes: {},
      })),
      updateMany,
    },
    suppressionRecord: { findMany: vi.fn(async () => []) },
    fieldEvidence: { create },
  } as unknown as Prisma.TransactionClient;
  return { tx, updateMany, create };
}

const HIT = {
  key: 'website_profile',
  result: { matched: true, confidence: 0.7, attributes: { trade_role: 'distributor' }, costCents: 0 },
};

describe('company enrichment commit namespace markers (BI-14)', () => {
  it('stores a marker next to the signal timestamp without writing it as field evidence', async () => {
    const { tx, updateMany, create } = makeTx();

    await expect(
      commitCompanyEnrichmentResults(tx, {
        workspaceId: 'ws-1',
        companyId: 'co-1',
        hits: [HIT],
        signalTimestamp: new Date('2026-10-11T09:00:00.000Z'),
        namespaceMarkers: { _contact_parser: 'company_contact/v1' },
      }),
    ).resolves.toBe(true);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'co-1', status: { not: 'SUPPRESSED' } },
      data: {
        attributes: {
          website_profile: {
            trade_role: 'distributor',
            _ts: '2026-10-11T09:00:00.000Z',
            _contact_parser: 'company_contact/v1',
          },
        },
        version: { increment: 1 },
      },
    });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ field: 'website_profile.trade_role' }) }),
    ]);
  });

  it('refuses a marker that is not an underscore key with a code-token value, before any write', async () => {
    for (const namespaceMarkers of [
      { contact_parser: 'company_contact/v1' },
      { _contact_parser: 'not a token' },
      { _ts: 'company_contact/v1' },
    ]) {
      const { tx, updateMany, create } = makeTx();
      await expect(
        commitCompanyEnrichmentResults(tx, {
          workspaceId: 'ws-1',
          companyId: 'co-1',
          hits: [HIT],
          namespaceMarkers,
        }),
      ).rejects.toThrow('COMPANY_ENRICHMENT_NAMESPACE_MARKER_INVALID');
      expect(updateMany).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    }
  });
});
