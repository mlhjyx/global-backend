import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DurableExecutionReceipt } from '../../durable-results/durable-execution-receipt';
import { DailyCallQuotaExceededError } from '../../tools/daily-call-quota';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import { sanitizeCanonicalCompanyAttributes } from '../canonical-company-attributes';
import {
  DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
  parseDiscoveryCompanyResultLineage,
} from '../company-discovery-lineage';
import { validateRawSourceProviderPayload } from '../raw-source-provider-schema';
import {
  buildGooglePlacesDiscoveryQueries,
  detectSolarChannelCategories,
  isGooglePlacesNonCompanyDomain,
  resolveGooglePlacesCoverageFill,
} from './google-places-grid';
import {
  GOOGLE_PLACES_ID_SCHEME,
  GOOGLE_PLACES_LICENSE,
  GOOGLE_PLACES_PARSER_VERSION,
  GOOGLE_PLACES_SEARCH_URL,
  GooglePlacesDiscoveryProvider,
  mapGooglePlaceHitToRecord,
  resolveMaxGooglePlacesDiscoverQueries,
} from './google-places.provider';

function makeReceipt(index: number): DurableExecutionReceipt {
  const hex = String(index).padStart(12, '0');
  return Object.freeze({
    schemaVersion: 'durable-execution-receipt/v1',
    scopeKey: '10000000-0000-4000-8000-000000000001',
    authorityId: '20000000-0000-4000-8000-000000000002',
    accountId: '30000000-0000-4000-8000-000000000003',
    operationId: `40000000-0000-4000-8000-${hex}`,
    operationKey: `tool:google_places.discover:1.0.0:key-${index}`,
    resultStrategy: 'typed_projection',
    resultSchema: 'google-places-discover/v1',
    resultDigest: `${String(index).padStart(64, 'a')}`,
    artifactId: null,
    usage: Object.freeze({
      currency: 'USD',
      unit: 'microusd',
      callCount: 1,
      upperBoundMicrousd: '40000',
    }),
    costBasis: 'estimated_upper_bound',
    status: 'SETTLED',
  });
}

describe('google-places-grid (target-country key cities × localized industry categories)', () => {
  it('generates localized PV installer, EPC, and electrical distributor grid queries for DE and IT', () => {
    const deGrid = buildGooglePlacesDiscoveryQueries({
      keywords: ['Photovoltaik'],
      filters: { country: '德国', industry: '光伏安装与分销' },
    });
    expect(deGrid).toHaveLength(3);
    expect(deGrid.map((item) => item.city)).toEqual(['München', 'Frankfurt', 'Stuttgart']);
    expect(deGrid.map((item) => item.regionCode)).toEqual(['DE', 'DE', 'DE']);
    expect(deGrid.map((item) => item.languageCode)).toEqual(['de', 'de', 'de']);
    expect(deGrid.map((item) => item.textQuery)).toEqual([
      'Elektrogroßhandel Photovoltaik München',
      'Photovoltaik Installateur Frankfurt',
      'Photovoltaik EPC Projektentwicklung Stuttgart',
    ]);

    const itGrid = buildGooglePlacesDiscoveryQueries({
      keywords: ['fotovoltaico'],
      filters: { country: '意大利（IT）', industry: 'solar EPC', trade_side: 'distributor' },
    });
    expect(itGrid).toHaveLength(3);
    expect(itGrid.map((item) => item.city)).toEqual(['Milano', 'Bologna', 'Torino']);
    expect(itGrid.map((item) => item.regionCode)).toEqual(['IT', 'IT', 'IT']);
    expect(itGrid.map((item) => item.languageCode)).toEqual(['it', 'it', 'it']);
    expect(itGrid[0]?.textQuery).toBe('grossista materiale elettrico fotovoltaico Milano');
    expect(itGrid[1]?.textQuery).toBe('EPC fotovoltaico impianti solari Bologna');
    expect(itGrid[2]?.textQuery).toBe('installatore fotovoltaico Torino');
  });

  it('honors explicit filters.cities and falls back cleanly for non-PV industrial ICPs', () => {
    const generic = buildGooglePlacesDiscoveryQueries({
      keywords: ['Kreiselpumpen'],
      filters: { country: 'DE', cities: ['Bremen', 'Nürnberg'], trade_side: 'distributor' },
    }, 2);
    expect(generic).toHaveLength(2);
    expect(generic[0]?.textQuery).toBe('Kreiselpumpen Großhandel Bremen');
    expect(generic[1]?.textQuery).toBe('Kreiselpumpen Großhandel Nürnberg');
    expect(detectSolarChannelCategories({ keywords: ['Kreiselpumpen'], filters: { country: 'DE' } })).toEqual([]);
  });

  it('builds coverage-fill cities and localized PV terms for target markets', () => {
    const fill = resolveGooglePlacesCoverageFill({
      countryIso2: 'ES',
      industry: '光伏与储能系统',
      tradeSide: 'distributor',
      borrowedKeywords: [],
    });
    expect(fill.cities).toEqual(['Madrid', 'Barcelona', 'Valencia']);
    expect(fill.keywords).toEqual([
      'distribuidor material eléctrico fotovoltaico',
      'instalador solar fotovoltaico',
      'EPC solar fotovoltaica',
    ]);
  });

  it('blocks social networks, maps, yellow pages, and marketplaces as non-company domains', () => {
    for (const blocked of [
      'facebook.com',
      'm.facebook.com',
      'linkedin.com',
      'it.linkedin.com',
      'instagram.com',
      'maps.google.com',
      'paginegialle.it',
      'gelbeseiten.de',
      'amazon.de',
    ]) {
      expect(isGooglePlacesNonCompanyDomain(blocked), blocked).toBe(true);
    }
    expect(isGooglePlacesNonCompanyDomain('sonnenkraft-epc.de')).toBe(false);
    expect(isGooglePlacesNonCompanyDomain('coenergia.com')).toBe(false);
  });
});

describe('GooglePlacesDiscoveryProvider (§3.2.3 compliance, lineage, caps, and schema contracts)', () => {
  const fetchedAt = '2026-11-27T10:00:00.000Z';

  it('maps merchant entities strictly under Maps Terms §3.2.3 and passes Raw + Canonical validation', () => {
    const record = mapGooglePlaceHitToRecord(
      {
        placeId: 'ChIJ_987654321_SolarGmbH',
        name: 'Sonnenkraft EPC GmbH',
        websiteUri: 'https://www.sonnenkraft-epc.de/kontakt?utm=maps',
        countryCode: 'DE',
      },
      { fetchedAt, fallbackCountry: 'DE', sourceClass: 'industry_data' },
    );

    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      name: 'Sonnenkraft EPC GmbH',
      domain: 'sonnenkraft-epc.de',
      country: 'DE',
      identifier: { scheme: GOOGLE_PLACES_ID_SCHEME, value: 'ChIJ_987654321_SolarGmbH' },
      license: GOOGLE_PLACES_LICENSE,
      attributes: {
        google_places: {
          place_id: 'ChIJ_987654321_SolarGmbH',
          source_class: 'industry_data',
        },
      },
      provenance: {
        sourceUrl: GOOGLE_PLACES_SEARCH_URL,
        fetchedAt,
        parserVersion: GOOGLE_PLACES_PARSER_VERSION,
      },
    });
    expect(record?.externalId).toMatch(/^google_places:[0-9a-f]{64}$/u);

    // Must pass governed Raw payload validator and Canonical sanitizer cleanly.
    const rawValidation = validateRawSourceProviderPayload('google_places', record);
    expect(rawValidation.ok).toBe(true);
    expect(sanitizeCanonicalCompanyAttributes(record!.attributes)).toEqual({
      google_places: {
        place_id: 'ChIJ_987654321_SolarGmbH',
        source_class: 'industry_data',
      },
    });

    // Rejects Google Maps content leakage (address / phone / reviews) at Raw boundary.
    const leaked = {
      ...record!,
      attributes: {
        google_places: {
          place_id: 'ChIJ_987654321_SolarGmbH',
          source_class: 'industry_data',
          formatted_address: 'Sonnenweg 1, München',
        },
      },
    };
    expect(validateRawSourceProviderPayload('google_places', leaked)).toEqual({
      ok: false,
      reason: 'PROVIDER_PAYLOAD_SCHEMA_INVALID',
    });

    // Rejects missing first-party domain or wrong origin host.
    expect(
      validateRawSourceProviderPayload('google_places', { ...record!, domain: undefined }),
    ).toEqual({ ok: false, reason: 'PROVIDER_PAYLOAD_SCHEMA_INVALID' });
    expect(
      validateRawSourceProviderPayload('google_places', {
        ...record!,
        provenance: { ...record!.provenance, sourceUrl: 'https://maps.google.com/v1/places:searchText' },
      }),
    ).toEqual({ ok: false, reason: 'PROVIDER_PAYLOAD_SCHEMA_INVALID' });
  });

  it('drops places without a first-party website or with social/directory URLs', () => {
    expect(
      mapGooglePlaceHitToRecord(
        { placeId: 'ChIJ_no_web', name: 'Local Solar Shop', countryCode: 'DE' },
        { fetchedAt },
      ),
    ).toBeNull();
    expect(
      mapGooglePlaceHitToRecord(
        {
          placeId: 'ChIJ_social',
          name: 'Social Only Solar',
          websiteUri: 'https://www.facebook.com/socialsolar',
          countryCode: 'DE',
        },
        { fetchedAt },
      ),
    ).toBeNull();
    expect(
      mapGooglePlaceHitToRecord(
        {
          placeId: 'ChIJ_phone_name',
          name: 'Solar +49 89 12345678',
          websiteUri: 'https://valid-solar.de/',
          countryCode: 'DE',
        },
        { fetchedAt },
      ),
    ).toBeNull();
  });

  it('collects multi-attempt governed lineage, sums ToolBroker cost, deduplicates domains, and honors blockedDomains', async () => {
    let callIndex = 0;
    const forwarded: Array<{ producerId: string; receipt: DurableExecutionReceipt }> = [];
    const invoke = vi.fn(async (toolId: string, _input: unknown, ctx: ToolContext) => {
      expect(toolId).toBe('google_places.discover');
      expect(ctx.purpose).toBe('discovery');
      callIndex += 1;
      ctx.onDurableReceipt?.(toolId, makeReceipt(callIndex));
      if (callIndex === 1) {
        return {
          data: {
            places: [
              { placeId: 'ChIJ_1', name: 'Alpha Solar GmbH', websiteUri: 'https://alpha-solar.de/', countryCode: 'DE' },
              { placeId: 'ChIJ_blocked', name: 'Blocked Solar GmbH', websiteUri: 'https://blocked-solar.de/', countryCode: 'DE' },
              { placeId: 'ChIJ_fb', name: 'Facebook Only Solar', websiteUri: 'https://facebook.com/solar', countryCode: 'DE' },
            ],
          },
          costCents: 4,
        };
      }
      if (callIndex === 2) {
        return {
          data: {
            places: [
              { placeId: 'ChIJ_1_dup', name: 'Alpha Solar GmbH', websiteUri: 'https://www.alpha-solar.de/about', countryCode: 'DE' },
              { placeId: 'ChIJ_2', name: 'Beta EPC GmbH', websiteUri: 'https://beta-epc.de/', countryCode: 'DE' },
            ],
          },
          costCents: 4,
        };
      }
      return { data: { places: [] }, costCents: 4 };
    });

    const provider = new GooglePlacesDiscoveryProvider({
      broker: { invoke } as unknown as ExecutionBroker,
    });
    expect(provider.companyResultLineage).toBe(DISCOVERY_COMPANY_RESULT_LINEAGE_V1);

    const result = await provider.discoverCompanies(
      {
        sourceClass: 'industry_data',
        filters: { country: 'DE', industry: 'solar PV installer' },
        keywords: ['Photovoltaik'],
        limit: 25,
      },
      {
        workspaceId: '10000000-0000-4000-8000-000000000001',
        purpose: 'discovery',
        onDurableReceipt: (producerId, receipt) => forwarded.push({ producerId, receipt }),
      },
      { blockedDomains: ['blocked-solar.de'] },
    );

    expect(invoke).toHaveBeenCalledTimes(3);
    expect(result.costCents).toBe(12);
    expect(result.records.map((r) => r.domain)).toEqual(['alpha-solar.de', 'beta-epc.de']);
    expect(forwarded).toHaveLength(3);
    expect(result.lineage).toBeDefined();
    const parsed = parseDiscoveryCompanyResultLineage(result.lineage, 'google_places');
    expect(parsed.recordCount).toBe(2);
    expect(parsed.receiptCoverage).toHaveLength(2);
    expect(parsed.receiptCoverage[0]?.recordIndexes).toEqual([0]);
    expect(parsed.receiptCoverage[1]?.recordIndexes).toEqual([1]);
    expect(parsed.attemptReceipts).toHaveLength(1);
  });

  it('stops querying cleanly on daily quota error while preserving settled lineage for prior calls', async () => {
    let callIndex = 0;
    const invoke = vi.fn(async (toolId: string, _input: unknown, ctx: ToolContext) => {
      callIndex += 1;
      if (callIndex === 1) {
        ctx.onDurableReceipt?.(toolId, makeReceipt(1));
        return {
          data: {
            places: [
              { placeId: 'ChIJ_ok', name: 'Solar One S.r.l.', websiteUri: 'https://solar-one.it/', countryCode: 'IT' },
            ],
          },
          costCents: 4,
        };
      }
      throw new DailyCallQuotaExceededError('GOOGLE_PLACES_DAILY_LIMIT_EXCEEDED', {
        day: '2026-11-27',
        limit: 200,
        count: 200,
      });
    });

    const provider = new GooglePlacesDiscoveryProvider({
      broker: { invoke } as unknown as ExecutionBroker,
    });
    const result = await provider.discoverCompanies(
      {
        sourceClass: 'industry_data',
        filters: { country: 'IT', industry: 'fotovoltaico' },
        keywords: ['fotovoltaico'],
        limit: 25,
      },
      { workspaceId: '10000000-0000-4000-8000-000000000001', purpose: 'discovery' },
    );

    // Stopped immediately on 2nd call instead of making a 3rd call.
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.records).toHaveLength(1);
    expect(result.costCents).toBe(4);
    const parsed = parseDiscoveryCompanyResultLineage(result.lineage, 'google_places');
    expect(parsed.recordCount).toBe(1);
    expect(parsed.receiptCoverage).toHaveLength(1);
  });

  it('supports emergency env kill switch, per-query cap clamp, and degraded empty lineage without broker', async () => {
    expect(resolveMaxGooglePlacesDiscoverQueries({} as NodeJS.ProcessEnv)).toBe(3);
    expect(
      resolveMaxGooglePlacesDiscoverQueries({ GOOGLE_PLACES_MAX_SEARCHES_PER_QUERY: '2' } as NodeJS.ProcessEnv),
    ).toBe(2);
    expect(
      resolveMaxGooglePlacesDiscoverQueries({ GOOGLE_PLACES_MAX_SEARCHES_PER_QUERY: '99' } as NodeJS.ProcessEnv),
    ).toBe(3);

    const disabled = new GooglePlacesDiscoveryProvider({
      env: { GOOGLE_PLACES_PROVIDER: 'off' } as NodeJS.ProcessEnv,
    });
    expect(disabled.companyResultLineage).toBeUndefined();
    expect(
      await disabled.discoverCompanies(
        { sourceClass: 'industry_data', filters: { country: 'DE' }, keywords: ['solar'], limit: 10 },
        { workspaceId: 'ws', purpose: 'discovery' },
      ),
    ).toEqual({ records: [], costCents: 0 });

    const noBroker = new GooglePlacesDiscoveryProvider();
    const empty = await noBroker.discoverCompanies(
      { sourceClass: 'industry_data', filters: { country: 'DE' }, keywords: ['solar'], limit: 10 },
      { workspaceId: 'ws', purpose: 'discovery' },
    );
    expect(empty.records).toEqual([]);
    expect(empty.costCents).toBe(0);
    expect(parseDiscoveryCompanyResultLineage(empty.lineage, 'google_places').recordCount).toBe(0);
  });

  it('ships a forward-only SQL migration widening compliance matrix, lineage allowlist, and Raw writer guards', () => {
    const sqlPath = resolve(
      __dirname,
      '../../../../../packages/db/prisma/migrations/20261127180000_google_places_discovery_provider/migration.sql',
    );
    const sql = readFileSync(sqlPath, 'utf8');
    expect(sql).toContain("INSERT INTO \"source_compliance_matrix\"");
    expect(sql).toContain("'google_places', 'GOOGLE_MAPS_TERMS_3_2_3_PLACE_ID_ONLY'");
    expect(sql).toContain("append_discovery_query_lineage_v1");
    expect(sql).toContain("google_places.discover");
    expect(sql).toContain("GooglePlacesDiscoveryProvider");
    expect(sql).toContain("google-places-discover/v1");
    expect(sql).toContain("WHEN 'google_places'");
    expect(sql).toContain("google-place-id");
    expect(sql).toContain("GOOGLE_MAPS_PLACE_ID_ONLY");
    expect(sql).toContain("places.googleapis.com");
  });
});
