import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { companyMayUseExternalProcessing } from './company-suppression-gate';

function fakeTx(opts: {
  company: { id: string; name: string; domain: string | null; status: string } | null;
  suppressions?: { type: string; value: string }[];
}) {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const tx = {
    canonicalCompany: {
      findUnique: vi.fn(async () => opts.company),
      updateMany,
    },
    suppressionRecord: {
      findMany: vi.fn(async () => opts.suppressions ?? []),
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, updateMany };
}

describe('company suppression terminal gate', () => {
  it('canonicalizes a legacy URL-shaped domain and repairs the company status before external processing', async () => {
    const { tx, updateMany } = fakeTx({
      company: { id: 'co-1', name: 'Acme GmbH', domain: 'acme.de', status: 'NEW' },
      suppressions: [{ type: 'domain', value: ' HTTPS://WWW.Acme.DE/path ' }],
    });

    await expect(companyMayUseExternalProcessing(tx, 'co-1')).resolves.toBe(false);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'co-1', status: { not: 'SUPPRESSED' } },
      data: { status: 'SUPPRESSED', version: { increment: 1 } },
    });
  });

  it('canonicalizes a legacy company-name value and blocks it', async () => {
    const { tx } = fakeTx({
      company: { id: 'co-1', name: '  Müller   Pumpen GmbH ', domain: null, status: 'NEW' },
      suppressions: [{ type: 'company_name', value: 'MÜLLER PUMPEN GMBH' }],
    });
    await expect(companyMayUseExternalProcessing(tx, 'co-1')).resolves.toBe(false);
  });

  it('fails closed for missing or already-suppressed companies and permits an unmatched active company', async () => {
    const missing = fakeTx({ company: null });
    await expect(companyMayUseExternalProcessing(missing.tx, 'missing')).resolves.toBe(false);

    const suppressed = fakeTx({ company: { id: 'co-1', name: 'Acme', domain: 'acme.de', status: 'SUPPRESSED' } });
    await expect(companyMayUseExternalProcessing(suppressed.tx, 'co-1')).resolves.toBe(false);

    const active = fakeTx({ company: { id: 'co-1', name: 'Acme', domain: 'acme.de', status: 'NEW' } });
    await expect(companyMayUseExternalProcessing(active.tx, 'co-1')).resolves.toBe(true);
    expect(active.updateMany).not.toHaveBeenCalled();
  });
});
