import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { commitCompanyEnrichmentResults } from './company-enrichment-commit';

describe('company enrichment commit suppression boundary', () => {
  it('merges only owned namespaces into current scrubbed attributes after a pre-wire snapshot becomes stale', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const create = vi.fn(async () => ({}));
    const tx = {
      $queryRaw: vi.fn(async () => [{ locked: true }]),
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
    })).resolves.toBe(true);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'co-1', status: { not: 'SUPPRESSED' } },
      data: {
        attributes: {
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
      $queryRaw: vi.fn(async () => [{ locked: true }]),
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
    })).resolves.toBe(false);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'co-1', status: { not: 'SUPPRESSED' } },
      data: { status: 'SUPPRESSED', version: { increment: 1 } },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('sanitizes each new enrichment hit before both CanonicalCompany and FieldEvidence persistence', async () => {
    const updateMany = vi.fn(async (_input: unknown) => ({ count: 1 }));
    const create = vi.fn(async (_input: unknown) => ({}));
    const tx = {
      $queryRaw: vi.fn(async () => [{ locked: true }]),
      canonicalCompany: {
        findUnique: vi.fn(async () => ({
          id: 'co-1',
          name: 'Acme GmbH',
          domain: 'acme.example',
          status: 'NEW',
          attributes: { products: ['pump', 'SECRET'] },
        })),
        updateMany,
      },
      suppressionRecord: { findMany: vi.fn(async () => []) },
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
          attributes: {
            structured_org: {
              name: 'Bearer secret',
              phone: '٥٥٥-٠١٠٠',
              url: 'https://acme.example',
            },
          },
          costCents: 0,
        },
      }],
    })).resolves.toBe(true);

    const update = updateMany.mock.calls[0]![0] as {
      data: { attributes: Record<string, unknown> };
    };
    expect(update.data.attributes).toEqual({
      products: ['pump'],
      digital_footprint: {
        structured_org: { url: 'https://acme.example' },
      },
    });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]![0]).toMatchObject({
      data: {
        field: 'digital_footprint.structured_org',
        value: { url: 'https://acme.example' },
      },
    });
    expect(JSON.stringify({ update: updateMany.mock.calls, evidence: create.mock.calls }))
      .not.toMatch(/Bearer secret|٥٥٥-٠١٠٠|SECRET/u);
  });
});
