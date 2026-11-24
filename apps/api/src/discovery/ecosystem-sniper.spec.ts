import { describe, expect, it } from 'vitest';
import {
  buildEcosystemSniperQueries,
  parseCustomerSeedCsv,
} from './ecosystem-sniper';
import {
  KNOWN_SOLAR_PV_BRANDS,
  knownBrandsForIndustry,
  matchCarriedBrands,
} from './website-profile/brands';

describe('L0 ecosystem & competitor replacement sniper + customer seed CSV', () => {
  it('generates bounded competitor-replacement and complementary-ecosystem queries', () => {
    const queries = buildEcosystemSniperQueries({
      competitorBrands: ['LONGi', 'JinkoSolar'],
      ecosystemBrands: ['SMA', 'Sungrow'],
      buyerRoleTerms: ['distributor', 'EPC'],
      countryHint: 'Italy',
      maxQueries: 4,
    });
    expect(queries).toEqual([
      '"LONGi" (distributor OR EPC) Italy',
      '"JinkoSolar" (distributor OR EPC) Italy',
      '"SMA" distributor Italy',
      '"Sungrow" distributor Italy',
    ]);
  });

  it('parses customer seed CSV safely, strips CWE-1236 formula leads, and dedupes domains', () => {
    const csv = [
      'company_name,website,country',
      '"=HYPERLINK(""http://evil"",""Krannich Solar"")",https://www.krannich-solar.com/en/,Germany',
      'BayWa r.e.,baywa-re.de,DE',
      'Duplicate Krannich,krannich-solar.com,DE',
      '+Solaria Energia,solariaenergia.es,Spain',
      'Invalid Row,not-a-domain,US',
    ].join('\n');

    const seeds = parseCustomerSeedCsv(csv);
    expect(seeds).toEqual([
      {
        domain: 'krannich-solar.com',
        companyName: 'HYPERLINK("http://evil","Krannich Solar")',
        country: 'DE',
      },
      { domain: 'baywa-re.de', companyName: 'BayWa r.e.', country: 'DE' },
      { domain: 'solariaenergia.es', companyName: 'Solaria Energia', country: 'ES' },
    ]);
  });

  it('matches Tier-1 solar PV brands via KNOWN_SOLAR_PV_BRANDS and knownBrandsForIndustry', () => {
    const dict = knownBrandsForIndustry('HJT photovoltaic solar modules');
    expect(dict).toBe(KNOWN_SOLAR_PV_BRANDS);
    const matched = matchCarriedBrands(
      'We distribute LONGi Solar panels, SMA inverters and Fronius BESS across Italy.',
      'IT',
      dict,
    );
    expect(matched.brands.map((b) => b.name)).toEqual(['LONGi', 'SMA', 'Fronius']);
    expect(matched.carriesChineseBrand).toBe(true);
    expect(matched.carriesForeignBrand).toBe(true);
  });
});
