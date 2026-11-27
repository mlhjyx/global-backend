import type { OsmPlace } from '../adapters/openstreetmap';
import type { WikidataCompany } from '../adapters/wikidata';
import type { FairExhibitor } from '../adapters/trade-fair-algolia';
import { registerCatalogResultProjections } from '../durable-results/catalog-result-projections';
import { registerSourceResultProjections } from '../durable-results/source-result-projections';
import { TypedProjectionRegistry } from '../durable-results/typed-projection.registry';
import type { GenericOperationProjection } from '../tools/generic-operation-projection';
import type { CompaniesHouseOutput, OpenCorporatesSearchOutput, TedSearchOutput } from '../tools/source-tools';
import type { ToolResult } from '../tools/tool-contract';
import { DISCOVERY_V3_LOCAL_COMPANY_QUERY, DiscoveryV3OperationError } from './discovery-v3-operations';
import type { DiscoveryV3ResultLink } from './discovery-v3-operation-scope';
import type { CompanyDiscoveryQuery, ProviderCompanyRecord } from './provider-contract';
import { mapCompanyHitToRecord } from './providers/companies-house-registry.provider';
import { mapCompanyToRecord } from './providers/opencorporates.provider';
import { mapOsmPlaceToRecord } from './providers/osm.provider';
import { mapNoticeToRecords } from './providers/ted.provider';
import { mapTradeFairExhibitorToRecord } from './providers/trade-fair.provider';
import { mapWikidataCompanyToRecord } from './providers/wikidata.provider';
import { TRADE_FAIRS } from './trade-fairs';

const projections = registerSourceResultProjections(registerCatalogResultProjections(new TypedProjectionRegistry()));
projections.freeze();

const sourceProofs = {
  wikidata: { tool: 'wikidata.sparql', schema: 'wikidata-sparql/v1' },
  openstreetmap: { tool: 'osm.overpass', schema: 'osm-overpass/v1' },
  companies_house_registry: { tool: 'companies_house.search', schema: 'companies-house-search/v1' },
  opencorporates: { tool: 'opencorporates.search', schema: 'opencorporates-search/v1' },
  ted: { tool: 'ted.search', schema: 'ted-search/v1' },
  trade_fair: { tool: 'tradefair.algolia', schema: 'tradefair-algolia/v1' },
  channel_catalog: { tool: 'channel_catalog.query', schema: DISCOVERY_V3_LOCAL_COMPANY_QUERY },
} as const;

export type DiscoveryV3CompanySource = keyof typeof sourceProofs;

export function supportsDiscoveryV3CompanySource(key: string): key is DiscoveryV3CompanySource {
  return Object.hasOwn(sourceProofs, key);
}

export interface IndexedDiscoveryV3Company {
  readonly index: number;
  readonly record: ProviderCompanyRecord;
}

/** Build Raw evidence only from the exact tool projection verified by the operation store. */
export function companiesFromDiscoveryV3Proof(
  provider: DiscoveryV3CompanySource,
  query: CompanyDiscoveryQuery,
  link: DiscoveryV3ResultLink,
  proof: GenericOperationProjection,
  claimedAt: Date,
): IndexedDiscoveryV3Company[] {
  const { tool, schema } = sourceProofs[provider];
  if (link.operation.action !== tool || link.operation.provider !== tool || proof.kind !== 'tool' || proof.schema !== schema) {
    throw new DiscoveryV3OperationError('DISCOVERY_V3_OPERATION_BINDING_MISMATCH');
  }
  if (provider === 'channel_catalog') {
    const body = proof.data as { records: ProviderCompanyRecord[] };
    if (link.operation.method !== 'local-query' || !Array.isArray(body.records) || body.records.length > query.limit) {
      throw new DiscoveryV3OperationError('DISCOVERY_V3_OPERATION_INVALID');
    }
    return body.records.map((record, index) => ({ index, record }));
  }
  const result = projections.restore(proof.data) as ToolResult<unknown>;
  const fetchedAt = result.provenance?.fetchedAt ?? claimedAt.toISOString();
  let records: (ProviderCompanyRecord | null)[];
  switch (provider) {
    case 'wikidata':
      records = (result.data as { companies: WikidataCompany[] }).companies.map((company) =>
        mapWikidataCompanyToRecord({ company, sourceClass: query.sourceClass, fetchedAt }));
      break;
    case 'openstreetmap':
      records = (result.data as { places: OsmPlace[] }).places.map((place) =>
        mapOsmPlaceToRecord({ place, sourceClass: query.sourceClass, fetchedAt }));
      break;
    case 'companies_house_registry': {
      const data = result.data as CompaniesHouseOutput;
      if (!data.companies || data.officers) throw new DiscoveryV3OperationError('DISCOVERY_V3_OPERATION_INVALID');
      records = data.companies.map((company) => mapCompanyHitToRecord(company, fetchedAt));
      break;
    }
    case 'opencorporates':
      records = (result.data as OpenCorporatesSearchOutput).companies.map((company) => mapCompanyToRecord(company, fetchedAt));
      break;
    case 'ted': {
      const data = result.data as TedSearchOutput;
      if (!data.awards || data.notices) throw new DiscoveryV3OperationError('DISCOVERY_V3_OPERATION_INVALID');
      records = data.awards.flatMap((notice) => mapNoticeToRecords(notice, fetchedAt));
      break;
    }
    case 'trade_fair': {
      const data = result.data as { exhibitors: FairExhibitor[]; pagination?: { fairSlug: string; page: number } };
      const fair = TRADE_FAIRS.find(({ slug }) => slug === data.pagination?.fairSlug);
      if (!fair) throw new DiscoveryV3OperationError('DISCOVERY_V3_OPERATION_INVALID');
      records = data.exhibitors.map((exhibitor) => mapTradeFairExhibitorToRecord({
        fair, exhibitor, fetchedAt, sourceClass: query.sourceClass,
      }));
      break;
    }
  }
  return records.slice(0, query.limit).flatMap((record, index) => record ? [{ index, record }] : []);
}
