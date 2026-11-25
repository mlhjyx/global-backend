import { describe, expect, it } from 'vitest';
import {
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
});
