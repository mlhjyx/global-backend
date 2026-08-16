import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { commitCompanyEnrichmentResults } from './company-enrichment-commit';
import { organizationIdentitySnapshotFingerprint } from './organization-identity-root';

const EMPTY_CO_1_SNAPSHOT = organizationIdentitySnapshotFingerprint({
  rootCompanyId: 'co-1',
  relatedCompanyIds: ['co-1'],
  identifiers: [],
});

describe('company enrichment commit suppression boundary', () => {
  it('merges a follow-up provider observation into its existing namespace and binds evidence to the sanitized Raw', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const create = vi.fn(async () => ({}));
    const findFirst = vi.fn(async () => null);
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: 'co-1' }]),
      canonicalCompany: {
        findUnique: vi.fn(async () => ({
          id: 'co-1',
          name: 'ACME CORPORATION',
          domain: null,
          status: 'NEW',
          attributes: { sec_edgar: { cik: '0000000123', ticker: 'ACME' } },
        })),
        updateMany,
      },
      suppressionRecord: { findMany: vi.fn(async () => []) },
      fieldEvidence: { findFirst, create },
    } as unknown as Prisma.TransactionClient;

    await expect(commitCompanyEnrichmentResults(tx, {
      workspaceId: 'ws-1',
      companyId: 'co-1',
      hits: [{
        key: 'sec_edgar',
        rawRecordId: 'raw-submission-1',
        license: 'US-GOV-PUBLIC-INFO',
        allowedActions: ['display'],
        result: {
          matched: true,
          confidence: 1,
          attributes: {
            submission_entity_type: 'operating',
            submission_semantic_scope: 'sec_filer_classification_only',
          },
          costCents: 0,
        },
      }],
      expectedIdentitySnapshot: EMPTY_CO_1_SNAPSHOT,
    })).resolves.toBe(true);

    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        attributes: {
          sec_edgar: {
            cik: '0000000123',
            ticker: 'ACME',
            submission_entity_type: 'operating',
            submission_semantic_scope: 'sec_filer_classification_only',
          },
        },
      }),
    }));
    expect(create).toHaveBeenCalledTimes(2);
    for (const call of create.mock.calls) {
      expect(call[0]).toMatchObject({
        data: {
          providerKey: 'sec_edgar',
          rawRecordId: 'raw-submission-1',
          license: 'US-GOV-PUBLIC-INFO',
          dataClass: 'green',
          allowedActions: ['display'],
        },
      });
    }
  });

  it('fails closed before writes when the identity graph changed during the external call', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const create = vi.fn(async () => ({}));
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: 'root-2' }]),
      organizationCanonicalMapping: {
        findFirst: vi.fn(async () => ({ canonicalCompanyId: 'root-2' })),
        findMany: vi.fn(async () => [{ sourceCompanyId: 'co-1', canonicalCompanyId: 'root-2' }]),
      },
      organizationIdentifier: {
        findMany: vi.fn(async () => [{
          companyId: 'root-2',
          scheme: 'lei',
          jurisdiction: 'GLOBAL',
          normalizedValue: '529900T8BM49AURSDO55',
        }]),
      },
      canonicalCompany: { updateMany },
      fieldEvidence: { create },
    } as unknown as Prisma.TransactionClient;

    await expect(commitCompanyEnrichmentResults(tx, {
      workspaceId: 'ws-1',
      companyId: 'co-1',
      hits: [{
        key: 'wikidata',
        result: { matched: true, confidence: 1, attributes: { qid: 'Q1' }, costCents: 0 },
      }],
      expectedIdentitySnapshot: 'snapshot-before-merge',
    })).resolves.toBe(false);

    expect(updateMany).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('merges only owned namespaces into current scrubbed attributes after a pre-wire snapshot becomes stale', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const create = vi.fn(async () => ({}));
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: 'co-1' }]),
      canonicalCompany: {
        findUnique: vi.fn(async () => ({
          id: 'co-1',
          name: 'Acme GmbH',
          domain: 'acme.example',
          status: 'NEW',
          attributes: { keep: 'current' },
        })),
        updateMany,
      },
      suppressionRecord: {
        findMany: vi.fn(async () => [{ type: 'email', value: 'sales@agency.example' }]),
      },
      fieldEvidence: { create },
    } as unknown as Prisma.TransactionClient;

    await expect(commitCompanyEnrichmentResults(tx, {
      workspaceId: 'ws-1',
      companyId: 'co-1',
      hits: [{
        key: 'digital_footprint',
        result: {
          matched: true,
          confidence: 0.9,
          attributes: { ads: true },
          costCents: 0,
        },
      }],
      signalTimestamp: new Date('2026-08-10T00:00:00.000Z'),
      expectedIdentitySnapshot: EMPTY_CO_1_SNAPSHOT,
    })).resolves.toBe(true);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'co-1', status: { not: 'SUPPRESSED' } },
      data: {
        attributes: {
          keep: 'current',
          digital_footprint: { ads: true, _ts: '2026-08-10T00:00:00.000Z' },
        },
        version: { increment: 1 },
      },
    });
    expect(JSON.stringify(updateMany.mock.calls)).not.toContain('contact_email');
    expect(create).toHaveBeenCalledOnce();
  });

  it('writes neither company attributes nor evidence after company-level authority denies the commit', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const create = vi.fn(async () => ({}));
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: 'co-1' }]),
      canonicalCompany: {
        findUnique: vi.fn(async () => ({
          id: 'co-1', name: 'Acme GmbH', domain: 'blocked.example', status: 'NEW', attributes: {},
        })),
        updateMany,
      },
      suppressionRecord: {
        findMany: vi.fn(async () => [{ type: 'domain', value: 'blocked.example' }]),
      },
      fieldEvidence: { create },
    } as unknown as Prisma.TransactionClient;

    await expect(commitCompanyEnrichmentResults(tx, {
      workspaceId: 'ws-1',
      companyId: 'co-1',
      hits: [{
        key: 'gleif',
        result: { matched: true, confidence: 1, attributes: { lei: 'X' }, costCents: 0 },
      }],
      status: 'ENRICHED',
      expectedIdentitySnapshot: EMPTY_CO_1_SNAPSHOT,
    })).resolves.toBe(false);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'co-1', status: { not: 'SUPPRESSED' } },
      data: { status: 'SUPPRESSED', version: { increment: 1 } },
    });
    expect(create).not.toHaveBeenCalled();
  });
});
