import { describe, expect, it } from 'vitest';
import {
  assembleEvidenceBundle,
  buildEvidenceBundle,
  entriesFromStoredAttributes,
  entryFromEnrichment,
  readEvidenceBundle,
} from './evidence-bundle';
import type { CompanyEnrichmentAdapter, EnrichmentResult } from './provider-contract';

const ATTRIBUTES = {
  gleif: {
    lei: '529900DI47YZJ5P7QQ76',
    legal_name: 'AVAG-Pumpen Import-Export GmbH',
    legal_form: 'GmbH',
    entity_status: 'ACTIVE',
    registered_country: 'DE',
    registered_city: 'Bad Wünnenberg',
    match_confidence: 1,
    is_subsidiary: true,
    parent_name: 'AVAG Holding SE',
  },
  ted: {
    cpv: ['42123000', '42123100', '45200000'],
    notice_type: 'can-standard',
    buyer_countries: ['DEU'],
    publication_number: '727192-2026',
  },
  fda: { fei_number: '3014483751', product_codes: ['PBF', 'LLZ'], state_code: 'FL', status_code: '1' },
  wikidata_qid: 'Q81230',
  website_profile: {
    _ts: '2026-11-02T11:12:44.819Z',
    source_url: 'https://albinpump.com/',
    trade_role: 'manufacturer',
    own_manufacturing: true,
    carries_chinese_brand: false,
    trade_role_confidence: 0.95,
    vat_id: 'DE136762735',
  },
  digital_footprint: { tech_platform: 'wordpress', served_langs: ['de', 'en'], is_advertiser: false },
};

describe('entriesFromStoredAttributes', () => {
  it('assembles tiered entries from stored provider namespaces', () => {
    const entries = entriesFromStoredAttributes(ATTRIBUTES);
    const bySource = Object.fromEntries(entries.map((entry) => [entry.source_key, entry]));
    expect(bySource.gleif?.tier).toBe('T1');
    expect(bySource.gleif?.facts.registry_lei).toBe('529900DI47YZJ5P7QQ76');
    expect(bySource.ted?.tier).toBe('T1');
    expect(bySource.fda?.tier).toBe('T1');
    expect(bySource.wikidata?.tier).toBe('T2');
    expect(bySource.wikidata?.facts.entity_qid).toBe('Q81230');
    expect(bySource.website_profile?.tier).toBe('T3');
    expect(bySource.website_profile?.source_page).toBe('https://albinpump.com/');
    expect(bySource.digital_footprint?.tier).toBe('T3');
  });

  it('splits long identifiers so they survive the attribute sanitizer', () => {
    const entries = entriesFromStoredAttributes(ATTRIBUTES);
    const ted = entries.find((entry) => entry.source_key === 'ted')!;
    // "727192-2026" 是电话形态（≥7 位连续数字）→ 拆成两个 number
    expect(ted.facts.notice_id).toBe(727192);
    expect(ted.facts.notice_year).toBe(2026);
    expect(ted.facts.publication_number).toBeUndefined();
    // CPV 存去尾零前缀，不存 8 位原码
    expect(ted.facts.cpv_prefixes).toEqual([42123, 421231, 452]);
    // VAT 号（9 位连续数字）不进入 facts
    expect(entries.find((entry) => entry.source_key === 'website_profile')!.facts.vat_id).toBeUndefined();
  });

  it('extracts all four additional T1 sources (companies_house/ch_registry, inpi_rne, google_patents, samgov) and survives sanitizer round-trip', async () => {
    const { sanitizeCanonicalCompanyAttributes } = await import('./canonical-company-attributes');
    const extendedAttributes = {
      ch_registry: {
        company_number: '04123456',
        company_status: 'active',
        jurisdiction: 'england-wales',
        sic_codes: ['35110'],
      },
      inpi_rne: {
        siren: '552100554',
        denomination: 'Solaire France SAS',
        nature_juridique: 'SAS',
        activite_principale: '35.11Z',
        etat_administratif: 'A',
      },
      google_patents: {
        applicant_name: 'Solaire France SAS',
        patent_count: 14,
        cpc_codes: ['H01L31/02'],
        latest_filing_year: 2025,
      },
      sam_market_signal: true,
      government_buyer: true,
      intent: {
        events: [
          {
            type: 'US_FED_SOURCES_SOUGHT',
            at: '2026-11-20T00:00:00.000Z',
            evidence: { source: 'samgov', naics: ['335999'] },
          },
        ],
      },
      website_profile: ATTRIBUTES.website_profile,
    };
    const entries = entriesFromStoredAttributes(extendedAttributes);
    const bySource = Object.fromEntries(entries.map((entry) => [entry.source_key, entry]));
    expect(bySource.companies_house?.tier).toBe('T1');
    expect(bySource.companies_house?.facts.registry_company_no).toBe(4123456);
    expect(bySource.companies_house?.source_page).toBe('https://find-and-update.company-information.service.gov.uk/');
    expect(bySource.inpi_rne?.tier).toBe('T1');
    expect(bySource.inpi_rne?.facts.registry_siren).toBe(552100554);
    expect(bySource.inpi_rne?.source_page).toBe('https://annuaire-entreprises.data.gouv.fr/');
    expect(bySource.google_patents?.tier).toBe('T1');
    expect(bySource.google_patents?.facts.patent_count).toBe(14);
    expect(bySource.samgov?.tier).toBe('T1');
    expect(bySource.samgov?.facts.market_signal).toBe(true);
    expect(bySource.samgov?.facts.naics_codes).toEqual(['335999']);

    const bundle = assembleEvidenceBundle(
      { name: 'Solaire France SAS', domain: 'solaire-france.example', country: 'FR' },
      entries,
      new Date('2026-11-24T00:00:00.000Z'),
    );
    expect(bundle.coverage.tiers.T1).toBe(4);
    expect(bundle.coverage.corroborated).toBe(true);
    const stored = sanitizeCanonicalCompanyAttributes({ evidence_bundle: bundle });
    expect(stored.evidence_bundle).toEqual(bundle);
  });

  it('returns nothing for empty or non-object attributes', () => {
    expect(entriesFromStoredAttributes(null)).toEqual([]);
    expect(entriesFromStoredAttributes({})).toEqual([]);
    expect(entriesFromStoredAttributes({ unknown_source: { a: 1 } })).toEqual([]);
  });
});

describe('assembleEvidenceBundle', () => {
  it('computes coverage and cross-source corroboration from tiers', () => {
    const bundle = assembleEvidenceBundle(
      { name: 'Acme', domain: 'acme.de', country: 'DE' },
      entriesFromStoredAttributes(ATTRIBUTES),
      new Date('2026-11-10T00:00:00.000Z'),
    );
    expect(bundle.version).toBe(1);
    expect(bundle.built_at).toBe('2026-11-10T00:00:00.000Z');
    expect(bundle.coverage.tiers).toEqual({ T1: 3, T2: 1, T3: 2 });
    expect(bundle.coverage.tier_list).toEqual(['T1', 'T2', 'T3']);
    expect(bundle.coverage.distinct_sources).toBe(6);
    expect(bundle.coverage.corroborated).toBe(true);
  });

  it('marks a single-tier bundle as not corroborated', () => {
    const entries = entriesFromStoredAttributes({ gleif: ATTRIBUTES.gleif });
    const bundle = assembleEvidenceBundle({ name: 'Acme' }, entries);
    expect(bundle.coverage.tier_list).toEqual(['T1']);
    expect(bundle.coverage.corroborated).toBe(false);
  });
});

describe('buildEvidenceBundle', () => {
  const stubEnricher = (key: string, result: EnrichmentResult | Error): CompanyEnrichmentAdapter => ({
    key,
    enrichCompany: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  });

  it('skips stored sources and probes only missing ones through the enrichers', async () => {
    const probed: string[] = [];
    const enrichers = [
      stubEnricher('gleif', new Error('should not be called')),
      {
        key: 'wikidata',
        enrichCompany: async (): Promise<EnrichmentResult> => {
          probed.push('wikidata');
          return {
            matched: true,
            confidence: 1,
            attributes: { qid: 'Q42', label: 'Acme', industries: ['pumps'] },
            provenance: {
              sourceUrl: 'https://www.wikidata.org/wiki/Q42',
              fetchedAt: '2026-11-10T00:00:00.000Z',
              contentHash: 'x',
              parserVersion: 'wikidata-enrich/v1',
            },
            costCents: 0,
          };
        },
      },
      stubEnricher('unsupported_source', new Error('should not be called')),
    ];
    const { bundle, probed: probedList } = await buildEvidenceBundle({
      subject: { name: 'Acme', domain: 'acme.de' },
      attributes: { gleif: ATTRIBUTES.gleif },
      enrichers,
      ctx: { workspaceId: 'ws' },
      now: new Date('2026-11-10T00:00:00.000Z'),
    });
    expect(probedList).toEqual(['wikidata']);
    expect(probed).toEqual(['wikidata']);
    const sources = bundle.entries.map((entry) => entry.source_key);
    expect(sources).toContain('gleif');
    expect(sources).toContain('wikidata');
    const wikidata = bundle.entries.find((entry) => entry.source_key === 'wikidata')!;
    expect(wikidata.source_page).toBe('https://www.wikidata.org/wiki/Q42');
    expect(wikidata.captured_at).toBe('2026-11-10T00:00:00.000Z');
  });

  it('records per-source errors without failing the bundle', async () => {
    const { bundle, errors } = await buildEvidenceBundle({
      subject: { name: 'Acme' },
      attributes: { website_profile: ATTRIBUTES.website_profile },
      enrichers: [stubEnricher('gleif', new Error('HTTP 503'))],
      ctx: { workspaceId: 'ws' },
    });
    expect(errors.gleif).toBe('HTTP 503');
    expect(bundle.entries.map((entry) => entry.source_key)).toEqual(['website_profile']);
  });
});

describe('entryFromEnrichment', () => {
  it('returns null on a miss or an unsupported source', () => {
    expect(entryFromEnrichment('gleif', { matched: false, confidence: 0, attributes: {}, costCents: 0 })).toBeNull();
    expect(entryFromEnrichment('mystery', { matched: true, confidence: 1, attributes: { a: 1 }, costCents: 0 })).toBeNull();
  });
});

describe('readEvidenceBundle', () => {
  it('reads back a stored bundle and rejects malformed ones', () => {
    const bundle = assembleEvidenceBundle({ name: 'Acme' }, entriesFromStoredAttributes(ATTRIBUTES));
    expect(readEvidenceBundle({ evidence_bundle: bundle })?.coverage.corroborated).toBe(true);
    expect(readEvidenceBundle({ evidence_bundle: { version: 2, entries: [], coverage: {} } })).toBeNull();
    expect(readEvidenceBundle({ evidence_bundle: { version: 1 } })).toBeNull();
    expect(readEvidenceBundle({})).toBeNull();
  });
});

describe('sanitizer round-trip（证据包必须在公司合并清洗后原样存活）', () => {
  it('keeps every bundle field the audit and the gate rely on', async () => {
    const { sanitizeCanonicalCompanyAttributes } = await import('./canonical-company-attributes');
    const bundle = assembleEvidenceBundle({ name: 'Acme', domain: 'acme.de', country: 'DE' }, entriesFromStoredAttributes(ATTRIBUTES));
    const stored = sanitizeCanonicalCompanyAttributes({ evidence_bundle: bundle });
    // 严格相等：source_page/facts 键名均避开 sanitizer 的保留键黑名单（'source_url'/'fei_number'
    // 这类键会在清洗时被静默丢弃——2026-11-10 独立审查发现，已改名）。
    expect(stored.evidence_bundle).toEqual(bundle);
  });
});

describe('crossSourceEvidenceSummary', () => {
  it('retains up to 10 facts per source instead of truncating at 3', async () => {
    const { crossSourceEvidenceSummary } = await import('./evidence-bundle');
    const summary = crossSourceEvidenceSummary({
      gleif: {
        legal_name: 'Solartechnik GmbH',
        legal_form: 'GmbH',
        entity_status: 'ACTIVE',
        registration_status: 'ISSUED',
        registered_country: 'DE',
        registered_city: 'Munich',
      },
    });
    expect(summary?.sources[0]?.facts).toHaveLength(6);
  });
});
