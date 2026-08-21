/**
 * Durable result strategies are declarative only. Product composition and
 * strategy selection remain deliberately outside this foundation layer.
 */
export const DURABLE_RESULT_STRATEGY_KINDS = [
  'typed_projection',
  'artifact_reference',
  'no_physical_call',
] as const;

export type DurableResultStrategyKind =
  (typeof DURABLE_RESULT_STRATEGY_KINDS)[number];

const typedProjectionSchemaValues = [
  'icp-design/v1', 'icp-query-plan/v1', 'understanding-claims/v1',
  'understanding-profile/v1', 'understanding-offerings/v1', 'taxonomy-code/v1',
  'fit-judgment/v1', 'discovery-extract-company/v1', 'discovery-extract-list/v1',
  'contact-decision-makers/v1', 'ted-search/v1', 'openfda-search/v1',
  'samgov-search/v1', 'smtp-probe-verdict/v1', 'searxng-search/v1',
  'wikidata-sparql/v1', 'osm-overpass/v1', 'wikidata-entity/v1',
  'gleif-fetch/v1', 'companies-house-search/v1', 'inpi-rne-search/v1',
  'google-patents-search/v1', 'tradefair-algolia/v1', 'mapyourshow-fetch/v1',
] as const;

export const TYPED_PROJECTION_SCHEMAS = Object.freeze([
  ...typedProjectionSchemaValues,
]) as readonly [...typeof typedProjectionSchemaValues];

export type TypedProjectionSchema = (typeof typedProjectionSchemaValues)[number];

const TYPED_PROJECTION_SCHEMA_SET: ReadonlySet<string> = new Set(
  typedProjectionSchemaValues,
);

export function isTypedProjectionSchema(value: unknown): value is TypedProjectionSchema {
  return typeof value === 'string' && TYPED_PROJECTION_SCHEMA_SET.has(value);
}

const artifactPrivacyClassValues = [
  'PUBLIC_ORGANIZATION', 'CONFIDENTIAL_TENANT', 'PERSONAL_DATA',
] as const;

export const ARTIFACT_PRIVACY_CLASSES = Object.freeze([
  ...artifactPrivacyClassValues,
]) as readonly [...typeof artifactPrivacyClassValues];

export type ArtifactPrivacyClass = (typeof artifactPrivacyClassValues)[number];

const ARTIFACT_PRIVACY_CLASS_SET: ReadonlySet<string> = new Set(
  artifactPrivacyClassValues,
);

export type DurableResultStrategy =
  | Readonly<{ kind: 'typed_projection'; schema: TypedProjectionSchema }>
  | Readonly<{
      kind: 'artifact_reference'; schema: string; maxBytes: number;
      mediaTypes: readonly string[]; privacyClass: ArtifactPrivacyClass;
      ttlSeconds: number;
    }>
  | Readonly<{ kind: 'no_physical_call' }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Runtime guard for declarations read from configuration or a future registry. */
export function isDurableResultStrategy(value: unknown): value is DurableResultStrategy {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'typed_projection') {
    return exactKeys(value, ['kind', 'schema']) && isTypedProjectionSchema(value.schema);
  }
  if (value.kind === 'no_physical_call') return exactKeys(value, ['kind']);
  if (value.kind !== 'artifact_reference') return false;
  return (
    exactKeys(value, ['kind', 'maxBytes', 'mediaTypes', 'privacyClass', 'schema', 'ttlSeconds']) &&
    typeof value.schema === 'string' && value.schema.length > 0 &&
    isPositiveSafeInteger(value.maxBytes) && Array.isArray(value.mediaTypes) &&
    value.mediaTypes.length > 0 && value.mediaTypes.every(
      (mediaType) => typeof mediaType === 'string' && mediaType.length > 0,
    ) && typeof value.privacyClass === 'string' &&
    ARTIFACT_PRIVACY_CLASS_SET.has(value.privacyClass) &&
    isPositiveSafeInteger(value.ttlSeconds)
  );
}
