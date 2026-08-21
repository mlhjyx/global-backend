/**
 * Durable result strategies are declarative only. Product composition and
 * strategy selection remain deliberately outside this foundation layer.
 */
import { types } from 'node:util';
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

const ARTIFACT_SCHEMA_MAX_LENGTH = 256;
const ARTIFACT_MEDIA_TYPE_MAX_LENGTH = 128;

function isPlainOwnDataRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) return false;
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Reflect.ownKeys(value).every((key) =>
      typeof key === 'string' && Boolean(descriptors[key]) &&
      descriptors[key]!.enumerable && 'value' in descriptors[key]!,
    );
  } catch {
    return false;
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isBoundedTrimmedString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength && value.trim() === value;
}

function isDenseMediaTypeArray(value: unknown): value is readonly string[] {
  try {
    if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!Number.isSafeInteger(length) || length <= 0) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') return false;
      if (key === 'length') continue;
      const descriptor = descriptors[key];
      if (!/^(0|[1-9][0-9]*)$/.test(key) || !descriptor?.enumerable || !('value' in descriptor)) return false;
    }
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor) ||
        !isBoundedTrimmedString(descriptor.value, ARTIFACT_MEDIA_TYPE_MAX_LENGTH)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Runtime guard for declarations read from configuration or a future registry. */
export function isDurableResultStrategy(value: unknown): value is DurableResultStrategy {
  if (!isPlainOwnDataRecord(value)) return false;
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  if (!kindDescriptor || !('value' in kindDescriptor) || typeof kindDescriptor.value !== 'string') {
    return false;
  }
  const kind = kindDescriptor.value;
  if (kind === 'typed_projection') {
    if (!exactKeys(value, ['kind', 'schema'])) return false;
    return isTypedProjectionSchema(value.schema);
  }
  if (kind === 'no_physical_call') return exactKeys(value, ['kind']);
  if (kind !== 'artifact_reference') return false;
  if (!exactKeys(
    value,
    ['kind', 'maxBytes', 'mediaTypes', 'privacyClass', 'schema', 'ttlSeconds'],
  )) return false;
  return (
    isBoundedTrimmedString(value.schema, ARTIFACT_SCHEMA_MAX_LENGTH) &&
    isPositiveSafeInteger(value.maxBytes) && isDenseMediaTypeArray(value.mediaTypes) &&
    typeof value.privacyClass === 'string' &&
    ARTIFACT_PRIVACY_CLASS_SET.has(value.privacyClass) &&
    isPositiveSafeInteger(value.ttlSeconds)
  );
}
