import { describe, expect, it } from 'vitest';
import { inferCountryFromCcTld } from './domain-country';

describe('inferCountryFromCcTld (Batch 1.4-D)', () => {
  it('maps unambiguous country-code TLDs to uppercase ISO2', () => {
    expect(inferCountryFromCcTld('sopimenergia.it')).toBe('IT');
    expect(inferCountryFromCcTld('https://www.acme-gmbh.de/impressum')).toBe('DE');
    expect(inferCountryFromCcTld('solar.co.uk')).toBe('GB');
    expect(inferCountryFromCcTld('energia.es')).toBe('ES');
    expect(inferCountryFromCcTld('groupe.fr')).toBe('FR');
    expect(inferCountryFromCcTld('energie.nl')).toBe('NL');
  });

  it('returns undefined for generic or globally repurposed TLDs', () => {
    expect(inferCountryFromCcTld('coenergia.com')).toBeUndefined();
    expect(inferCountryFromCcTld('raylyst.eu')).toBeUndefined();
    expect(inferCountryFromCcTld('startup.io')).toBeUndefined();
    expect(inferCountryFromCcTld('solar.ai')).toBeUndefined();
    expect(inferCountryFromCcTld('brand.co')).toBeUndefined();
    expect(inferCountryFromCcTld(null)).toBeUndefined();
  });
});
