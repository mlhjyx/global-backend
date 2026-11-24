import { describe, expect, it } from 'vitest';
import {
  inferCountryFromDialCode,
  inferCountryFromDomainTld,
  inferCountryFromLegalSuffix,
  inferPrefilterCountry,
} from './prefilter-country';
import { prefilterAttributes, prefilterCompany } from './run2/quick-scan';

describe('L1 deterministic pre-country inference (prefilter-country)', () => {
  it('infers single-country ccTLDs and rejects commercialized/generic ccTLDs', () => {
    expect(inferCountryFromDomainTld('energia-solare.it')).toMatchObject({ iso: 'IT', source: 'cctld' });
    expect(inferCountryFromDomainTld('solar-epc.com.br')).toMatchObject({ iso: 'BR', source: 'cctld' });
    expect(inferCountryFromDomainTld('grid-solar.co.uk')).toMatchObject({ iso: 'GB', source: 'cctld' });
    expect(inferCountryFromDomainTld('gulf-pv.ae')).toMatchObject({ iso: 'AE', source: 'cctld' });

    for (const generic of ['startup.ai', 'cloud.io', 'brand.co', 'media.tv', 'app.me', 'shop.cc', 'site.com']) {
      expect(inferCountryFromDomainTld(generic), generic).toBeNull();
    }
  });

  it('infers single-country legal suffixes and refuses multi-country suffixes (GmbH/Ltd/S.A.)', () => {
    expect(inferCountryFromLegalSuffix('Sole Energia S.r.l.')).toMatchObject({ iso: 'IT', source: 'legal_suffix' });
    expect(inferCountryFromLegalSuffix('Zon Energie B.V.')).toMatchObject({ iso: 'NL', source: 'legal_suffix' });
    expect(inferCountryFromLegalSuffix('Helios Soluciones S.L.')).toMatchObject({ iso: 'ES', source: 'legal_suffix' });
    expect(inferCountryFromLegalSuffix('Nordic Solar GmbH & Co. KG')).toMatchObject({ iso: 'DE', source: 'legal_suffix' });
    expect(inferCountryFromLegalSuffix('AusSun Pty Ltd')).toMatchObject({ iso: 'AU', source: 'legal_suffix' });
    expect(inferCountryFromLegalSuffix('Energia Solar Ltda.')).toMatchObject({ iso: 'BR', source: 'legal_suffix' });
    expect(inferCountryFromLegalSuffix('株式会社サンソーラー')).toMatchObject({ iso: 'JP', source: 'legal_suffix' });

    expect(inferCountryFromLegalSuffix('Alpen Solar GmbH')).toBeNull();
    expect(inferCountryFromLegalSuffix('Global Energy Ltd')).toBeNull();
    expect(inferCountryFromLegalSuffix('Euro Energy S.A.')).toBeNull();
  });

  it('infers single-country dial prefixes and refuses shared +1 / +7', () => {
    expect(inferCountryFromDialCode('+39 02 1234567')).toMatchObject({ iso: 'IT', source: 'dial_code' });
    expect(inferCountryFromDialCode('00971 4 555 0199')).toMatchObject({ iso: 'AE', source: 'dial_code' });
    expect(inferCountryFromDialCode('+1 415 555 0199')).toBeNull();
    expect(inferCountryFromDialCode('+7 495 123 4567')).toBeNull();
  });

  it('wires deterministic country inference into quick-scan prefilterAttributes & prefilterCompany', () => {
    const nullCountryItalian = {
      id: 'c-it',
      name: 'Sole Fotovoltaico S.r.l.',
      domain: 'solefotovoltaico.com',
      country: null,
      industry: 'solar EPC',
      attributes: {},
    };
    expect(prefilterAttributes(nullCountryItalian)).toMatchObject({
      country: 'IT',
      country_inferred_by: 'legal_suffix',
    });

    const decision = prefilterCompany(
      [{ kind: 'MUST_HAVE', field: 'country', operator: 'in', value: ['IT', 'DE'] }],
      nullCountryItalian,
    );
    expect(decision.decision).toBe('candidate');
    expect(decision.verdict).toBe('match');

    const excluded = prefilterCompany(
      [{ kind: 'EXCLUSION', field: 'country', operator: 'in', value: ['IT'] }],
      nullCountryItalian,
    );
    expect(excluded.decision).toBe('prefiltered_out');
    expect(excluded.verdict).toBe('exclude');

    expect(
      inferPrefilterCountry({
        name: 'Unknown Brand',
        domain: 'brand.ai',
        country: null,
        attributes: { website_profile: { vat_id: 'DE123456789' } },
      }),
    ).toMatchObject({ iso: 'DE', source: 'vat_id' });
  });
});
