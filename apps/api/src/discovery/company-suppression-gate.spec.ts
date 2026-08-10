import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { companyMayUseExternalProcessing, contactMayUseExternalProcessing } from './company-suppression-gate';
import { contactSuppressionKeys } from './identity';
import { blindContactKey } from '../compliance/pii-crypto';

function fakeTx(opts: {
  company: { id: string; name: string; domain: string | null; status: string } | null;
  suppressions?: { type: string; value: string }[];
}) {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const tx = {
    $queryRaw: vi.fn(async () => [{ locked: true }]),
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

    await expect(companyMayUseExternalProcessing(tx, 'ws-1', 'co-1')).resolves.toBe(false);
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
    await expect(companyMayUseExternalProcessing(tx, 'ws-1', 'co-1')).resolves.toBe(false);
  });

  it('fails closed for missing or already-suppressed companies and permits an unmatched active company', async () => {
    const missing = fakeTx({ company: null });
    await expect(companyMayUseExternalProcessing(missing.tx, 'ws-1', 'missing')).resolves.toBe(false);

    const suppressed = fakeTx({ company: { id: 'co-1', name: 'Acme', domain: 'acme.de', status: 'SUPPRESSED' } });
    await expect(companyMayUseExternalProcessing(suppressed.tx, 'ws-1', 'co-1')).resolves.toBe(false);

    const active = fakeTx({ company: { id: 'co-1', name: 'Acme', domain: 'acme.de', status: 'NEW' } });
    await expect(companyMayUseExternalProcessing(active.tx, 'ws-1', 'co-1')).resolves.toBe(true);
    expect(active.updateMany).not.toHaveBeenCalled();
  });
});

describe('contact external-processing authorization', () => {
  function contactTx(suppressions: { type: string; value: string }[]) {
    const order: string[] = [];
    const tx = {
      $queryRaw: vi.fn(async () => { order.push('lock'); return [{ locked: true }]; }),
      canonicalContact: {
        findUnique: vi.fn(async () => {
          order.push('contact');
          return {
            fullName: 'Hans Herold',
            company: { id: 'co-1', name: 'Acme GmbH', domain: 'acme.de', status: 'NEW', dedupeKey: 'd:acme.de' },
          };
        }),
      },
      suppressionRecord: {
        findMany: vi.fn(async () => { order.push('suppression'); return suppressions; }),
      },
      canonicalCompany: { updateMany: vi.fn(async () => ({ count: 1 })) },
    } as unknown as Prisma.TransactionClient;
    return { tx, order };
  }

  it('takes the policy lock before reading contact/suppression state', async () => {
    const { tx, order } = contactTx([]);
    await expect(contactMayUseExternalProcessing(tx, { workspaceId: 'ws-1', contactId: 'ct-1' })).resolves.toBe(true);
    expect(order).toEqual(['lock', 'contact', 'suppression']);
  });

  it('blocks blind contact_key and alternate suppressed email domains', async () => {
    const key = blindContactKey(contactSuppressionKeys('Hans Herold', 'd:acme.de')[0]);
    const frozen = contactTx([{ type: 'contact_key', value: key }]);
    await expect(contactMayUseExternalProcessing(frozen.tx, { workspaceId: 'ws-1', contactId: 'ct-1' })).resolves.toBe(false);

    const domain = contactTx([{ type: 'domain', value: 'agency.example' }]);
    await expect(contactMayUseExternalProcessing(domain.tx, {
      workspaceId: 'ws-1', contactId: 'ct-1', email: 'buyer@agency.example',
    })).resolves.toBe(false);
  });
});
