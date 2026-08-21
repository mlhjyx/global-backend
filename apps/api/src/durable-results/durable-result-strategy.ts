/**
 * A durable result strategy is declarative configuration.  Product wiring is
 * deliberately deferred: this module neither chooses a strategy from the
 * environment nor performs a physical call.
 */
export const DURABLE_RESULT_STRATEGY_KINDS = [
  'typed_projection',
  'artifact_reference',
  'no_physical_call',
] as const;

export type DurableResultStrategyKind =
  (typeof DURABLE_RESULT_STRATEGY_KINDS)[number];

export type TypedProjectionSchema =
  | 'icp-design/v1'
  | 'icp-query-plan/v1'
  | 'understanding-claims/v1'
  | 'understanding-profile/v1'
  | 'understanding-offerings/v1'
  | 'taxonomy-code/v1'
  | 'fit-judgment/v1'
  | 'discovery-extract-company/v1'
  | 'discovery-extract-list/v1'
  | 'contact-decision-makers/v1'
  | 'ted-search/v1'
  | 'openfda-search/v1'
  | 'samgov-search/v1'
  | 'smtp-probe-verdict/v1'
  | 'searxng-search/v1'
  | 'wikidata-sparql/v1'
  | 'osm-overpass/v1'
  | 'wikidata-entity/v1'
  | 'gleif-fetch/v1'
  | 'companies-house-search/v1'
  | 'inpi-rne-search/v1'
  | 'google-patents-search/v1'
  | 'tradefair-algolia/v1'
  | 'mapyourshow-fetch/v1';

export type DurableResultStrategy =
  | Readonly<{ kind: 'typed_projection'; schema: TypedProjectionSchema }>
  | Readonly<{ kind: 'artifact_reference'; schema: string }>
  | Readonly<{ kind: 'no_physical_call' }>;
