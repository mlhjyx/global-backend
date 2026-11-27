import { describe, expect, it } from 'vitest';
import {
  cleanDirectoryCompanyName,
  dedupeDirectoryRecords,
  isDirectoryNoiseEntry,
  normalizeDirectoryWebsiteDomain,
  resolveDirectoryCompanyCountry,
} from './directory-record-cleaner';
import { mapDirectoryCompanyToRecord } from './providers/directory.provider';
import { validateRawSourceProviderPayload } from './raw-source-provider-schema';

describe('directory-record-cleaner（名录抽取清洗与跨名录去重）', () => {
  it('normalizes company names: strips list numbers, membership/sponsor badges, quotes, trademarks, and trailing punctuation', () => {
    expect(cleanDirectoryCompanyName('1. Axitec Energy GmbH™ (Gold Member) | Visit Website')).toBe(
      'Axitec Energy GmbH',
    );
    expect(cleanDirectoryCompanyName('• "Pekat Solar" Sdn. Bhd. [Premium Partner],')).toBe(
      'Pekat Solar Sdn. Bhd.',
    );
    expect(cleanDirectoryCompanyName('#12 - BayWa r.e. AG – Platinum Sponsor')).toBe('BayWa r.e. AG');
    expect(cleanDirectoryCompanyName('ABB（中国）有限公司')).toBe('ABB(中国)有限公司');
    expect(cleanDirectoryCompanyName('   ')).toBeNull();
    expect(cleanDirectoryCompanyName('123456')).toBeNull();
  });

  it('rejects association self-entries, sponsors, navigation items, and social labels', () => {
    expect(
      isDirectoryNoiseEntry({
        name: 'BSW-Solar',
        sourceDirectoryDomain: 'solarwirtschaft.de',
      }),
    ).toBe(true);
    expect(
      isDirectoryNoiseEntry({
        name: 'Bundesverband Solarwirtschaft e.V.',
        sourceDirectoryDomain: 'solarwirtschaft.de',
      }),
    ).toBe(true);
    expect(
      isDirectoryNoiseEntry({
        name: 'ABSOLAR',
        sourceDirectoryDomain: 'absolar.org.br',
      }),
    ).toBe(true);
    expect(
      isDirectoryNoiseEntry({
        name: 'SolarPower Europe',
        sourceDirectoryDomain: 'solarpowereurope.org',
      }),
    ).toBe(true);

    for (const noise of [
      'Gold Sponsor',
      'Platinum Partner',
      'Become a Member',
      'Visit Website',
      'Privacy Policy',
      'Impressum',
      'Mitglied werden',
      'Onze leden',
      'Portal do Associado',
      'Üye Girişi',
      'Skip to main content',
      'Next Page',
      'Facebook',
    ]) {
      expect(
        isDirectoryNoiseEntry({
          name: noise,
          sourceDirectoryDomain: 'solarwirtschaft.de',
        }),
        `expected noise: ${noise}`,
      ).toBe(true);
    }

    expect(
      isDirectoryNoiseEntry({
        name: 'Axitec Energy GmbH',
        domain: 'axitecsolar.com',
        sourceDirectoryDomain: 'solarwirtschaft.de',
      }),
    ).toBe(false);
  });

  it('normalizes website domains: strips tracking params/fragments, drops invalid paths, non-HTTP schemes, noise hosts, and source association hosts', () => {
    expect(
      normalizeDirectoryWebsiteDomain(
        'https://www.AxitecSolar.com/en/products/?utm_source=bsw&fbclid=abc123#footer',
        'solarwirtschaft.de',
      ),
    ).toBe('axitecsolar.com');
    expect(
      normalizeDirectoryWebsiteDomain('www.pekat.com.my/?ref=mpsea', 'mpsea.org.my'),
    ).toBe('pekat.com.my');
    expect(normalizeDirectoryWebsiteDomain('acme-solar.de:443/about', 'bves.de')).toBe('acme-solar.de');

    // Invalid schemes, paths, noise hosts, and self-association domains return null
    for (const bad of [
      'mailto:info@acme-solar.de',
      'tel:+4930123456',
      'javascript:void(0)',
      'https://127.0.0.1/solar',
      'https://localhost/members',
      'https://acme-solar.de/brochure.pdf',
      'https://acme-solar.de/wp-login.php',
      'https://twitter.com/intent/tweet?url=https://acme-solar.de',
      'https://www.linkedin.com/company/acme-solar',
      'https://gmpg.org/xfn/11',
      'https://www.solarwirtschaft.de/member/axitec/',
      'https://bsw-solar-shop.de/catalog',
    ]) {
      expect(
        normalizeDirectoryWebsiteDomain(bad, 'solarwirtschaft.de'),
        `expected null for ${bad}`,
      ).toBeNull();
    }
  });

  it('resolves country from explicit location first and falls back to single-country directory ISO (never guessing for pan-EU)', () => {
    expect(
      resolveDirectoryCompanyCountry({
        location: 'Zurich, Switzerland',
        pageUrl: 'https://www.solarwirtschaft.de/unsere-mitglieder/mitgliedersuche/',
      }),
    ).toBe('CH');
    expect(
      resolveDirectoryCompanyCountry({
        location: 'Munich',
        pageUrl: 'https://www.solarwirtschaft.de/unsere-mitglieder/mitgliedersuche/',
      }),
    ).toBe('DE');
    expect(
      resolveDirectoryCompanyCountry({
        location: null,
        pageUrl: 'https://mpsea.org.my/membership/',
      }),
    ).toBe('MY');
    expect(
      resolveDirectoryCompanyCountry({
        location: 'São Paulo - SP',
        pageUrl: 'https://www.absolar.org.br/associados/',
      }),
    ).toBe('BR');
    expect(
      resolveDirectoryCompanyCountry({
        location: 'Istanbul',
        pageUrl: 'https://gensed.org/uyelerimiz/',
      }),
    ).toBe('TR');
    expect(
      resolveDirectoryCompanyCountry({
        location: 'Brussels',
        pageUrl: 'https://www.solarpowereurope.org/membership/meet-our-members',
      }),
    ).toBeUndefined();
    expect(
      resolveDirectoryCompanyCountry({
        location: 'Amsterdam, Nederland',
        pageUrl: 'https://www.solarpowereurope.org/membership/meet-our-members',
      }),
    ).toBe('NL');
  });

  it('deduplicates across directories by domain and normalized multi-country company name while upgrading domain-less records', () => {
    const recBswNoDomain = mapDirectoryCompanyToRecord({
      company: { name: 'BayWa r.e. AG' },
      pageUrl: 'https://www.solarwirtschaft.de/unsere-mitglieder/mitgliedersuche/',
      sourceClass: 'industry_data',
    });
    const recBneWithDomain = mapDirectoryCompanyToRecord({
      company: { name: 'BayWa r.e.', website: 'https://www.baywa-re.com/?utm_source=bne' },
      pageUrl: 'https://www.bne-online.de/verband/unsere-mitglieder/',
      sourceClass: 'industry_data',
    });
    const recEuDuplicateDomain = mapDirectoryCompanyToRecord({
      company: { name: 'BayWa r.e. Renewable Energy', website: 'https://baywa-re.com' },
      pageUrl: 'https://www.solarpowereurope.org/membership/meet-our-members',
      sourceClass: 'industry_data',
    });
    // Malaysian Sdn Bhd suffix variant across two MY directories
    const recMy1 = mapDirectoryCompanyToRecord({
      company: { name: 'Pekat Solar Sdn. Bhd.' },
      pageUrl: 'https://mpsea.org.my/membership/',
      sourceClass: 'industry_data',
    });
    const recMy2 = mapDirectoryCompanyToRecord({
      company: { name: 'Pekat Solar Berhad' },
      pageUrl: 'https://services.seda.gov.my/spqp/listing',
      sourceClass: 'industry_data',
    });
    // Same name in different countries must stay separate
    const recDeSun = mapDirectoryCompanyToRecord({
      company: { name: 'SunPower Energy GmbH' },
      pageUrl: 'https://www.bves.de/der-bves/mitglieder/',
      sourceClass: 'industry_data',
    });
    const recBrSun = mapDirectoryCompanyToRecord({
      company: { name: 'SunPower Energy Ltda.' },
      pageUrl: 'https://www.absolar.org.br/associados/',
      sourceClass: 'industry_data',
    });

    const deduped = dedupeDirectoryRecords([
      { record: recBswNoDomain, collector: 'c-bsw' },
      { record: recBneWithDomain, collector: 'c-bne' },
      { record: recEuDuplicateDomain, collector: 'c-spe' },
      { record: recMy1, collector: 'c-mpsea' },
      { record: recMy2, collector: 'c-seda' },
      { record: recDeSun, collector: 'c-bves' },
      { record: recBrSun, collector: 'c-absolar' },
    ]);

    expect(deduped).toHaveLength(4);
    // Upgraded to the record with domain + collector c-bne, retaining DE country
    expect(deduped[0]).toMatchObject({
      collector: 'c-bne',
      record: { domain: 'baywa-re.com', country: 'DE', externalId: 'directory:baywa-re.com' },
    });
    expect(deduped[1]).toMatchObject({
      collector: 'c-mpsea',
      record: { name: 'Pekat Solar Sdn. Bhd.', country: 'MY' },
    });
    expect(deduped[2]?.record.country).toBe('DE');
    expect(deduped[3]?.record.country).toBe('BR');

    for (const item of deduped) {
      expect(validateRawSourceProviderPayload('directory', item.record).ok).toBe(true);
    }
  });
});
