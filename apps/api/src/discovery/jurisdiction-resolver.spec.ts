import { describe, expect, it, vi } from 'vitest';
import {
  backfillCompanyCountryFromChannels,
  conservativeCountryCodeForFallback,
  inferConservativeEuUkFallback,
  resolveCompanyJurisdiction,
} from './jurisdiction-resolver';

describe('jurisdiction-resolver (Batch 1.5-A entity country hub + GDPR fail-closed)', () => {
  it('resolves unambiguous single-country signals across ccTLD, legal suffix, VAT, GLEIF, and dial code', () => {
    expect(resolveCompanyJurisdiction({ name: 'Coenergia S.r.l.', domain: 'coenergia.com' })).toMatchObject({
      iso: 'IT',
      source: 'legal_suffix',
    });
    expect(resolveCompanyJurisdiction({ name: 'Duowatt', domain: 'duowatt.it' })).toMatchObject({
      iso: 'IT',
      source: 'cctld',
    });
    expect(
      resolveCompanyJurisdiction({
        name: 'Centroplan GmbH',
        domain: 'centroplan.com',
        attributes: { website_profile: { vat_id: 'DE255123456' } },
      }),
    ).toMatchObject({
      iso: 'DE',
      source: 'vat_id',
    });
    expect(
      resolveCompanyJurisdiction({
        name: 'Centroplan GmbH',
        domain: 'centroplan.com',
        attributes: { website_profile: { phone: '+49 2452 9788-0' } },
      }),
    ).toMatchObject({
      iso: 'DE',
      source: 'dial_code',
    });
  });

  it('triggers conservative EU/UK Art.14 fallback for .eu, GmbH, and EU-only ICP markets without false-positives on US/ME', () => {
    // Centroplan GmbH on centroplan.com before VAT/phone is extracted -> must NOT fail-open on Art.14.
    expect(inferConservativeEuUkFallback({ name: 'Centroplan GmbH', domain: 'centroplan.com' })).toBe('EU');
    expect(inferConservativeEuUkFallback({ name: 'Italia Solare', domain: 'italiasolare.eu' })).toBe('EU');
    expect(inferConservativeEuUkFallback({ name: 'Solar Corp', domain: 'solarcorp.com' }, ['意大利'])).toBe('EU');
    expect(inferConservativeEuUkFallback({ name: 'Solar Corp', domain: 'solarcorp.com' }, ['英国'])).toBe('UK');
    expect(conservativeCountryCodeForFallback('EU')).toBe('DE');
    expect(conservativeCountryCodeForFallback('UK')).toBe('GB');

    // Non-EU / mixed global targets on .com must NOT false-trigger EU GDPR Art.14.
    expect(inferConservativeEuUkFallback({ name: 'SunPower Inc.', domain: 'sunpower.com' }, ['美国'])).toBeNull();
    expect(inferConservativeEuUkFallback({ name: 'Global Solar Ltd', domain: 'globalsolar.com' }, ['意大利', '美国'])).toBeNull();
    expect(inferConservativeEuUkFallback({ name: 'Global Solar Ltd', domain: 'globalsolar.com' })).toBeNull();
  });

  it('infers country from contactChannels phone dial code and backfills canonicalCompany.country + field_evidence (#96-5)', async () => {
    expect(
      resolveCompanyJurisdiction({
        name: 'IO Solar',
        domain: 'iosolar.com',
        contactChannels: [{ channel: 'phone', value: '+390543097431' }],
      }),
    ).toMatchObject({ iso: 'IT', source: 'dial_code' });

    const updateMany = vi.fn(async () => ({ count: 1 }));
    const fieldEvidenceCreate = vi.fn(async () => ({}));
    const tx = {
      companyContactChannel: {
        findMany: vi.fn(async () => [{ channel: 'phone', value: '+39 0543 097431' }]),
      },
      canonicalCompany: { updateMany },
      fieldEvidence: { create: fieldEvidenceCreate },
    };

    const resolved = await backfillCompanyCountryFromChannels(tx as never, {
      workspaceId: 'ws-1',
      company: { id: 'co-iosolar', name: 'IO Solar', domain: 'iosolar.com', country: null, attributes: {} },
    });
    expect(resolved).toMatchObject({ iso: 'IT', source: 'dial_code' });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'co-iosolar', country: null, status: { not: 'SUPPRESSED' } },
      data: { country: 'IT', version: { increment: 1 } },
    });
    expect(fieldEvidenceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entityId: 'co-iosolar',
          field: 'country',
          value: { iso: 'IT', source: 'dial_code', evidence: '+39' },
          providerKey: 'jurisdiction_resolver',
        }),
      }),
    );
  });
});
