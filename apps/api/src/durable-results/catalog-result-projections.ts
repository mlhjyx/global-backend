import { types } from 'node:util';
import { normForMatch } from '../discovery/name-match';
import { normalizePersonName } from '../discovery/person-name';
import type { TypedProjectionSchema } from './durable-result-strategy';
import { TypedProjectionRegistry } from './typed-projection.registry';
import type { TypedProjectionDefinition } from './typed-projection.types';

type JsonSchema = Readonly<Record<string, unknown>>;
type UnknownRecord = Record<string, unknown>;
type Transform = (value: unknown) => unknown;
export const CATALOG_RESULT_TOOL_IDS = Object.freeze([
  'searxng.search', 'wikidata.sparql', 'osm.overpass', 'wikidata.entity',
  'gleif.fetch', 'companies_house.search', 'inpi_rne.search',
  'google_patents.search', 'tradefair.algolia', 'mapyourshow.fetch',
] as const);
export type CatalogResultToolId = (typeof CATALOG_RESULT_TOOL_IDS)[number];
export const CATALOG_RESULT_PROJECTION_SCHEMAS = Object.freeze({
  'searxng.search': 'searxng-search/v1',
  'wikidata.sparql': 'wikidata-sparql/v1',
  'osm.overpass': 'osm-overpass/v1',
  'wikidata.entity': 'wikidata-entity/v1',
  'gleif.fetch': 'gleif-fetch/v1',
  'companies_house.search': 'companies-house-search/v1',
  'inpi_rne.search': 'inpi-rne-search/v1',
  'google_patents.search': 'google-patents-search/v1',
  'tradefair.algolia': 'tradefair-algolia/v1',
  'mapyourshow.fetch': 'mapyourshow-fetch/v1',
} satisfies Readonly<Record<CatalogResultToolId, TypedProjectionSchema>>);
const TOOL_RESULT_KEYS = ['data', 'costCents', 'degraded'] as const;
const TOOL_RESULT_WITH_PROVENANCE_KEYS = [...TOOL_RESULT_KEYS, 'provenance'] as const;
const PROVENANCE_KEYS = ['sourceUrl', 'fetchedAt', 'contentHash', 'parserVersion'] as const;
const SEARX_RESULT_KEYS = ['url', 'title'] as const;
const WIKIDATA_COMPANY_KEYS = [
  'qid', 'name', 'website', 'employees', 'countryCode', 'latitude', 'longitude',
] as const;
const OSM_PLACE_KEYS = [
  'osmId', 'name', 'website', 'city', 'countryCode', 'latitude', 'longitude', 'tags',
] as const;
const ENTITY_PROPERTIES = Object.freeze([
  'P1056', 'P159', 'P17', 'P31', 'P355', 'P414', 'P452', 'P749',
] as const);
const STRING_PROPERTIES = Object.freeze(['P1278', 'P856', 'P946'] as const);
const ALL_CLAIM_PROPERTIES = Object.freeze([
  ...ENTITY_PROPERTIES, 'P1128', ...STRING_PROPERTIES, 'P571',
] as const);
const GLEIF_RECORD_KEYS = [
  'lei', 'legalName', 'legalFormId', 'entityStatus', 'registrationStatus',
  'country', 'city', 'hasDirectParent', 'hasUltimateParent',
] as const;
const GLEIF_PARENT_KEYS = ['lei', 'legalName', 'country'] as const;
const CH_COMPANY_KEYS = ['companyNumber', 'title', 'companyStatus'] as const;
const CH_OFFICER_KEYS = ['name', 'officerRole', 'resignedOn', 'officerId'] as const;
const INPI_COMPANY_KEYS = ['siren', 'name', 'etatAdministratif', 'dirigeants'] as const;
const INPI_DIRIGEANT_KEYS = ['nom', 'prenoms', 'qualite'] as const;
const PATENT_KEYS = ['applicants', 'inventors'] as const;
const PATENT_APPLICANT_KEYS = ['name', 'country'] as const;
const PATENT_INVENTOR_KEYS = ['name'] as const;
const FAIR_EXHIBITOR_KEYS = [
  'externalId', 'companyName', 'website', 'email', 'phone', 'country', 'stand',
  'description', 'products', 'hiring',
] as const;
const MYS_RAW_FIELD_KEYS = [
  'exhid_l', 'exhname_t', 'exhdesc_t', 'boothsdisplay_la', 'hallid_la',
] as const;
const MYS_PROJECTED_FIELD_KEYS = ['exhid', 'name', 'description', 'booths', 'halls'] as const;
const MYS_ARRAY_FIELDS = new Set(['boothsdisplay_la', 'hallid_la', 'booths', 'halls']);
function projectionInvalid(): never { throw new Error('CATALOG_RESULT_PROJECTION_INVALID'); }
function ownDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
): UnknownRecord {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
      projectionInvalid();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) projectionInvalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))) {
      projectionInvalid();
    }
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !('value' in descriptor)) projectionInvalid();
    }
    if (requiredKeys.some((key) => !Object.hasOwn(descriptors, key))) projectionInvalid();
    return value as UnknownRecord;
  } catch (error) {
    if (error instanceof Error && error.message === 'CATALOG_RESULT_PROJECTION_INVALID') {
      throw error;
    }
    projectionInvalid();
  }
}
function ownOpenDataRecord(value: unknown): UnknownRecord {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
      projectionInvalid();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) projectionInvalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      const descriptor = descriptors[key as never];
      if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) {
        projectionInvalid();
      }
    }
    return value as UnknownRecord;
  } catch (error) {
    if (error instanceof Error && error.message === 'CATALOG_RESULT_PROJECTION_INVALID') {
      throw error;
    }
    projectionInvalid();
  }
}
function denseArray(value: unknown): unknown[] {
  try {
    if (!Array.isArray(value) || types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype) projectionInvalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol')) projectionInvalid();
    for (const key of keys as string[]) {
      if (key === 'length') continue;
      const descriptor = descriptors[key];
      if (!/^(0|[1-9][0-9]*)$/.test(key) || !descriptor?.enumerable ||
        !('value' in descriptor)) projectionInvalid();
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(descriptors, String(index))) projectionInvalid();
    }
    if (keys.length !== value.length + 1) projectionInvalid();
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === 'CATALOG_RESULT_PROJECTION_INVALID') {
      throw error;
    }
    projectionInvalid();
  }
}
function field(record: UnknownRecord, name: string): unknown {
  return Object.getOwnPropertyDescriptor(record, name)?.value;
}
function hasDefinedField(record: UnknownRecord, name: string): boolean {
  return Object.hasOwn(record, name) && field(record, name) !== undefined;
}
function copyDefined(record: UnknownRecord, keys: readonly string[]): UnknownRecord {
  return Object.fromEntries(keys.flatMap((key) => (
    hasDefinedField(record, key) ? [[key, field(record, key)]] : []
  )));
}
function copyRenamed(
  record: UnknownRecord,
  sourceKeys: readonly string[],
  targetKeys: readonly string[],
): UnknownRecord {
  return Object.fromEntries(sourceKeys.flatMap((key, index) => !hasDefinedField(record, key)
    ? []
    : [[targetKeys[index]!, MYS_ARRAY_FIELDS.has(key)
        ? mapStringArray(field(record, key)) : field(record, key)]]));
}
function mapClosedRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  transforms: Readonly<Record<string, Transform>> = {},
): UnknownRecord {
  const source = ownDataRecord(value, allowedKeys, requiredKeys);
  const output: UnknownRecord = {};
  for (const key of allowedKeys) {
    if (!hasDefinedField(source, key)) continue;
    const raw = field(source, key);
    output[key] = Object.hasOwn(transforms, key) ? transforms[key]!(raw) : raw;
  }
  return output;
}
function mapArray(value: unknown, mapper: Transform): unknown[] { return denseArray(value).map(mapper); }
function mapStringArray(value: unknown): unknown[] { return mapArray(value, (entry) => entry); }
function projectProvenance(value: unknown): UnknownRecord {
  return mapClosedRecord(value, PROVENANCE_KEYS, ['fetchedAt', 'parserVersion']);
}
function readToolResult(raw: unknown, provenance: boolean): UnknownRecord {
  return ownDataRecord(
    raw,
    provenance ? TOOL_RESULT_WITH_PROVENANCE_KEYS : TOOL_RESULT_KEYS,
    ['data', 'costCents'],
  );
}
function resultMetadata(result: UnknownRecord, provenance: boolean): UnknownRecord {
  return {
    costCents: field(result, 'costCents'),
    ...(hasDefinedField(result, 'degraded') ? { degraded: field(result, 'degraded') } : {}),
    ...(provenance && hasDefinedField(result, 'provenance')
      ? { provenance: projectProvenance(field(result, 'provenance')) }
      : {}),
  };
}
const stringSchema = (maxLength: number, extra?: JsonSchema): JsonSchema => (
  { type: 'string', maxLength, ...extra }
);
const numberSchema = (minimum: number, maximum: number, integer = false): JsonSchema => (
  { type: integer ? 'integer' : 'number', minimum, maximum }
);
const arraySchema = (maxItems: number, items: JsonSchema): JsonSchema => (
  { type: 'array', maxItems, items }
);
function objectSchema(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[],
): JsonSchema {
  return { type: 'object', additionalProperties: false, required, properties };
}
const provenanceSchema = objectSchema({
  sourceUrl: stringSchema(2048),
  fetchedAt: stringSchema(100),
  contentHash: stringSchema(128),
  parserVersion: stringSchema(120),
}, ['fetchedAt', 'parserVersion']);
function toolResultSchema(data: JsonSchema, provenance = false): JsonSchema {
  return objectSchema({
    data,
    costCents: numberSchema(0, 1_000_000_000, true),
    degraded: { type: 'boolean' },
    ...(provenance ? { provenance: provenanceSchema } : {}),
  }, ['data', 'costCents']);
}
function deepFreeze(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value as UnknownRecord)) {
    deepFreeze(child, seen);
  }
  Object.freeze(value);
}
function definition(
  schema: TypedProjectionSchema,
  dataSchema: JsonSchema,
  projectData: Transform,
  restoreData: Transform = projectData,
  provenance = false,
): TypedProjectionDefinition<unknown, unknown> {
  const result: TypedProjectionDefinition<unknown, unknown> = {
    schema,
    jsonSchema: toolResultSchema(dataSchema, provenance),
    project(raw) {
      const source = readToolResult(raw, provenance);
      return { data: projectData(field(source, 'data')), ...resultMetadata(source, provenance) };
    },
    restore(projected) {
      const source = readToolResult(projected, provenance);
      return { data: restoreData(field(source, 'data')), ...resultMetadata(source, provenance) };
    },
  };
  deepFreeze(result.jsonSchema);
  return Object.freeze(result);
}
const searxResultSchema = objectSchema({
  url: stringSchema(2048), title: stringSchema(2000),
}, ['url']);
const searxData = (value: unknown) => mapClosedRecord(value, ['results'], ['results'], {
  results: (results) => mapArray(results, (item) => (
    mapClosedRecord(item, SEARX_RESULT_KEYS, ['url'])
  )),
});
const searxDefinition = definition(
  'searxng-search/v1',
  objectSchema({ results: arraySchema(20, searxResultSchema) }, ['results']),
  searxData,
);

const wikidataCompanySchema = objectSchema({
  qid: stringSchema(80), name: stringSchema(500), website: stringSchema(2048),
  employees: numberSchema(0, 1_000_000_000_000), countryCode: stringSchema(16),
  latitude: numberSchema(-90, 90), longitude: numberSchema(-180, 180),
}, ['qid', 'name']);
const wikidataCompany = (value: unknown) => mapClosedRecord(
  value, WIKIDATA_COMPANY_KEYS, ['qid', 'name'],
);
const wikidataSparqlDefinition = definition(
  'wikidata-sparql/v1',
  objectSchema({ companies: arraySchema(200, wikidataCompanySchema) }, ['companies']),
  (value) => mapClosedRecord(value, ['companies'], ['companies'], {
    companies: (items) => mapArray(items, wikidataCompany),
  }),
  undefined,
  true,
);

const OSM_SAFE_TAG_PAIRS = Object.freeze([
  Object.freeze(['craft', 'blacksmith'] as const),
  Object.freeze(['craft', 'metal_construction'] as const),
]);
function isOsmSafeTagPair(key: unknown, value: unknown): key is string {
  return typeof key === 'string' && typeof value === 'string' &&
    OSM_SAFE_TAG_PAIRS.some(([allowedKey, allowedValue]) => (
      key === allowedKey && value === allowedValue
    ));
}
function assertOsmSafeTagPair(key: unknown, value: unknown): asserts key is string {
  if (!isOsmSafeTagPair(key, value)) projectionInvalid();
}

function projectTagEntries(value: unknown): UnknownRecord[] {
  const tags = ownOpenDataRecord(value);
  return Object.keys(tags).sort().flatMap((key) => {
    const tagValue = field(tags, key);
    return isOsmSafeTagPair(key, tagValue) ? [{ key, value: tagValue }] : [];
  });
}

function restoreTagEntries(value: unknown): UnknownRecord {
  const tags: UnknownRecord = {};
  let previous: string | undefined;
  for (const rawEntry of denseArray(value)) {
    const entry = ownDataRecord(rawEntry, ['key', 'value'], ['key', 'value']);
    const key = field(entry, 'key');
    const tagValue = field(entry, 'value');
    assertOsmSafeTagPair(key, tagValue);
    if (previous !== undefined && key <= previous) projectionInvalid();
    previous = key;
    tags[key] = tagValue;
  }
  return tags;
}

const tagEntrySchema = { oneOf: OSM_SAFE_TAG_PAIRS.map(([key, value]) => objectSchema({
  key: stringSchema(120, { const: key }), value: stringSchema(120, { const: value }),
}, ['key', 'value'])) };
const osmPlaceSchema = objectSchema({
  osmId: stringSchema(120), name: stringSchema(500), website: stringSchema(2048),
  city: stringSchema(500), countryCode: stringSchema(16),
  latitude: numberSchema(-90, 90), longitude: numberSchema(-180, 180),
  tagEntries: arraySchema(1, tagEntrySchema),
}, ['osmId', 'name', 'latitude', 'longitude', 'tagEntries']);
function projectOsmPlace(value: unknown): UnknownRecord {
  const place = ownDataRecord(value, OSM_PLACE_KEYS, [
    'osmId', 'name', 'latitude', 'longitude', 'tags',
  ]);
  return {
    ...copyDefined(place, [
      'osmId', 'name', 'website', 'city', 'countryCode', 'latitude', 'longitude',
    ]),
    tagEntries: projectTagEntries(field(place, 'tags')),
  };
}
function restoreOsmPlace(value: unknown): UnknownRecord {
  const keys = [...OSM_PLACE_KEYS.filter((key) => key !== 'tags'), 'tagEntries'];
  const place = ownDataRecord(value, keys, [
    'osmId', 'name', 'latitude', 'longitude', 'tagEntries',
  ]);
  return {
    ...copyDefined(place, [
      'osmId', 'name', 'website', 'city', 'countryCode', 'latitude', 'longitude',
    ]),
    tags: restoreTagEntries(field(place, 'tagEntries')),
  };
}
const osmDefinition = definition(
  'osm-overpass/v1',
  objectSchema({ places: arraySchema(80, osmPlaceSchema) }, ['places']),
  (value) => mapClosedRecord(value, ['places'], ['places'], {
    places: (items) => mapArray(items, projectOsmPlace),
  }),
  (value) => mapClosedRecord(value, ['places'], ['places'], {
    places: (items) => mapArray(items, restoreOsmPlace),
  }),
  true,
);

function statementValue(value: unknown): {
  value: unknown; qualifiers?: UnknownRecord;
} | null {
  const statement = ownDataRecord(value, [
    'mainsnak', 'qualifiers', 'qualifiers-order', 'id', 'type', 'rank', 'references',
  ], ['mainsnak']);
  const mainsnak = ownDataRecord(field(statement, 'mainsnak'), [
    'datavalue', 'snaktype', 'property', 'datatype',
  ], []);
  if (!hasDefinedField(mainsnak, 'datavalue')) return null;
  const datavalue = ownDataRecord(field(mainsnak, 'datavalue'), ['value', 'type'], ['value']);
  return {
    value: field(datavalue, 'value'),
    ...(hasDefinedField(statement, 'qualifiers')
      ? { qualifiers: ownOpenDataRecord(field(statement, 'qualifiers')) }
      : {}),
  };
}

function projectPointInTime(qualifiers: UnknownRecord | undefined): unknown {
  if (!qualifiers) return undefined;
  if (Object.keys(qualifiers).some((key) => !/^P[1-9][0-9]*$/.test(key))) {
    projectionInvalid();
  }
  if (!hasDefinedField(qualifiers, 'P585')) return undefined;
  const entries = denseArray(field(qualifiers, 'P585'));
  if (!entries.length) return undefined;
  const qualifier = ownDataRecord(entries[0], [
    'datavalue', 'hash', 'snaktype', 'property', 'datatype',
  ], []);
  if (!hasDefinedField(qualifier, 'datavalue')) return undefined;
  const datavalue = ownDataRecord(field(qualifier, 'datavalue'), ['value', 'type'], ['value']);
  const timeValue = ownDataRecord(field(datavalue, 'value'), [
    'time', 'timezone', 'before', 'after', 'precision', 'calendarmodel',
  ], ['time']);
  return field(timeValue, 'time');
}

function projectClaim(property: string, value: unknown): UnknownRecord {
  const statements = denseArray(value);
  if (ENTITY_PROPERTIES.includes(property as never)) {
    return {
      property,
      entityIds: statements.flatMap((statement) => {
        const parsed = statementValue(statement);
        if (!parsed) return [];
        const entity = ownDataRecord(parsed.value, [
          'id', 'numeric-id', 'entity-type',
        ], ['id']);
        return [field(entity, 'id')];
      }),
    };
  }
  if (STRING_PROPERTIES.includes(property as never)) {
    return {
      property,
      stringValues: statements.flatMap((statement) => {
        const parsed = statementValue(statement);
        return parsed ? [parsed.value] : [];
      }),
    };
  }
  if (property === 'P1128') {
    return {
      property,
      quantities: statements.flatMap((statement) => {
        const parsed = statementValue(statement);
        if (!parsed) return [];
        const quantity = ownDataRecord(parsed.value, [
          'amount', 'unit', 'upperBound', 'lowerBound',
        ], ['amount']);
        const pointInTime = projectPointInTime(parsed.qualifiers);
        return [{
          amount: field(quantity, 'amount'),
          ...(pointInTime === undefined ? {} : { pointInTime }),
        }];
      }),
    };
  }
  if (property !== 'P571') projectionInvalid();
  return {
    property,
    times: statements.flatMap((statement) => {
      const parsed = statementValue(statement);
      if (!parsed) return [];
      const timeValue = ownDataRecord(parsed.value, [
        'time', 'timezone', 'before', 'after', 'precision', 'calendarmodel',
      ], ['time']);
      return [field(timeValue, 'time')];
    }),
  };
}

function rawEntityId(id: unknown): UnknownRecord {
  return { mainsnak: { datavalue: { value: { id } } } };
}
function rawString(value: unknown): UnknownRecord {
  return { mainsnak: { datavalue: { value } } };
}
function rawTime(time: unknown): UnknownRecord {
  return { mainsnak: { datavalue: { value: { time } } } };
}
function rawQuantity(value: unknown): UnknownRecord {
  const quantity = ownDataRecord(value, ['amount', 'pointInTime'], ['amount']);
  return {
    mainsnak: { datavalue: { value: { amount: field(quantity, 'amount') } } },
    ...(hasDefinedField(quantity, 'pointInTime')
      ? {
          qualifiers: {
            P585: [{ datavalue: { value: { time: field(quantity, 'pointInTime') } } }],
          },
        }
      : {}),
  };
}

function restoreClaim(value: unknown): readonly [string, unknown[]] {
  const entry = ownDataRecord(value, [
    'property', 'entityIds', 'stringValues', 'quantities', 'times',
  ], ['property']);
  const property = field(entry, 'property');
  if (typeof property !== 'string') projectionInvalid();
  if (ENTITY_PROPERTIES.includes(property as never)) {
    ownDataRecord(entry, ['property', 'entityIds'], ['property', 'entityIds']);
    return [property, mapArray(field(entry, 'entityIds'), rawEntityId)];
  }
  if (STRING_PROPERTIES.includes(property as never)) {
    ownDataRecord(entry, ['property', 'stringValues'], ['property', 'stringValues']);
    return [property, mapArray(field(entry, 'stringValues'), rawString)];
  }
  if (property === 'P1128') {
    ownDataRecord(entry, ['property', 'quantities'], ['property', 'quantities']);
    return [property, mapArray(field(entry, 'quantities'), rawQuantity)];
  }
  if (property !== 'P571') projectionInvalid();
  ownDataRecord(entry, ['property', 'times'], ['property', 'times']);
  return [property, mapArray(field(entry, 'times'), rawTime)];
}

function assertCanonicalEntityMetadata(entity: UnknownRecord): void {
  for (const name of ['pageid', 'ns']) {
    if (hasDefinedField(entity, name) && !Number.isSafeInteger(field(entity, name))) {
      projectionInvalid();
    }
  }
  if (hasDefinedField(entity, 'title')) {
    const title = field(entity, 'title');
    if (typeof title !== 'string' || title.length > 500 || title.includes('\0') ||
      title !== title.normalize('NFC')) projectionInvalid();
  }
}
function projectEntity(entityId: string, value: unknown): UnknownRecord {
  if (!/^Q[1-9][0-9]*$/.test(entityId)) projectionInvalid();
  const entity = ownDataRecord(value, [
    'claims', 'labels', 'id', 'type', 'pageid', 'ns', 'title',
    'lastrevid', 'modified', 'sitelinks',
  ], []);
  assertCanonicalEntityMetadata(entity);
  let label: unknown;
  if (hasDefinedField(entity, 'labels')) {
    const labels = ownOpenDataRecord(field(entity, 'labels'));
    if (Object.keys(labels).some((key) => !/^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/.test(key))) {
      projectionInvalid();
    }
    if (hasDefinedField(labels, 'en')) {
      const english = ownDataRecord(field(labels, 'en'), ['value', 'language'], ['value']);
      label = field(english, 'value');
    }
  }
  let claimEntries: UnknownRecord[] | undefined;
  if (hasDefinedField(entity, 'claims')) {
    const claims = ownOpenDataRecord(field(entity, 'claims'));
    if (Object.keys(claims).some((key) => !/^P[1-9][0-9]*$/.test(key))) {
      projectionInvalid();
    }
    claimEntries = Object.keys(claims).filter(
      (property) => ALL_CLAIM_PROPERTIES.includes(property as never),
    ).sort().map(
      (property) => projectClaim(property, field(claims, property)),
    );
  }
  return {
    entityId,
    ...(label === undefined ? {} : { label }),
    ...(claimEntries === undefined ? {} : { claimEntries }),
  };
}

function projectEntityEntries(value: unknown): UnknownRecord[] {
  const entities = ownOpenDataRecord(value);
  return Object.keys(entities).sort().map((entityId) => (
    projectEntity(entityId, field(entities, entityId))
  ));
}

function restoreEntityEntries(value: unknown): UnknownRecord {
  const entities: UnknownRecord = {};
  let previous: string | undefined;
  for (const rawEntry of denseArray(value)) {
    const entry = ownDataRecord(rawEntry, ['entityId', 'label', 'claimEntries'], ['entityId']);
    const entityId = field(entry, 'entityId');
    if (typeof entityId !== 'string' || !/^Q[1-9][0-9]*$/.test(entityId) ||
      (previous !== undefined && entityId <= previous)) projectionInvalid();
    previous = entityId;
    const entity: UnknownRecord = {};
    if (hasDefinedField(entry, 'label')) {
      entity.labels = { en: { value: field(entry, 'label') } };
    }
    if (hasDefinedField(entry, 'claimEntries')) {
      const claims: UnknownRecord = {};
      let previousProperty: string | undefined;
      for (const rawClaim of denseArray(field(entry, 'claimEntries'))) {
        const [property, statements] = restoreClaim(rawClaim);
        if (previousProperty !== undefined && property <= previousProperty) projectionInvalid();
        previousProperty = property;
        claims[property] = statements;
      }
      entity.claims = claims;
    }
    entities[entityId] = entity;
  }
  return entities;
}

const propertySchema = (values: readonly string[]) => stringSchema(120, { enum: [...values] });
const entityClaimSchema = objectSchema({
  property: propertySchema(ENTITY_PROPERTIES),
  entityIds: arraySchema(64, stringSchema(80)),
}, ['property', 'entityIds']);
const stringClaimSchema = objectSchema({
  property: propertySchema(STRING_PROPERTIES),
  stringValues: arraySchema(64, stringSchema(2048)),
}, ['property', 'stringValues']);
const quantityClaimSchema = objectSchema({
  property: stringSchema(120, { const: 'P1128' }),
  quantities: arraySchema(64, objectSchema({
    amount: stringSchema(120), pointInTime: stringSchema(120),
  }, ['amount'])),
}, ['property', 'quantities']);
const timeClaimSchema = objectSchema({
  property: stringSchema(120, { const: 'P571' }),
  times: arraySchema(64, stringSchema(120)),
}, ['property', 'times']);
const claimEntrySchema = { oneOf: [
  entityClaimSchema, stringClaimSchema, quantityClaimSchema, timeClaimSchema,
] };
const entityEntrySchema = objectSchema({
  entityId: stringSchema(80), label: stringSchema(500),
  claimEntries: arraySchema(14, claimEntrySchema),
}, ['entityId']);
const searchEntrySchema = objectSchema({
  qid: stringSchema(80), label: stringSchema(500), description: stringSchema(2000),
}, ['qid', 'label']);
function projectWikidataEntityData(value: unknown): UnknownRecord {
  const data = ownDataRecord(value, ['search', 'entities'], []);
  return {
    ...(hasDefinedField(data, 'search')
      ? {
          search: mapArray(field(data, 'search'), (item) => (
            mapClosedRecord(item, ['qid', 'label', 'description'], ['qid', 'label'])
          )),
        }
      : {}),
    ...(hasDefinedField(data, 'entities')
      ? { entityEntries: projectEntityEntries(field(data, 'entities')) }
      : {}),
  };
}
function restoreWikidataEntityData(value: unknown): UnknownRecord {
  const data = ownDataRecord(value, ['search', 'entityEntries'], []);
  return {
    ...(hasDefinedField(data, 'search')
      ? {
          search: mapArray(field(data, 'search'), (item) => (
            mapClosedRecord(item, ['qid', 'label', 'description'], ['qid', 'label'])
          )),
        }
      : {}),
    ...(hasDefinedField(data, 'entityEntries')
      ? { entities: restoreEntityEntries(field(data, 'entityEntries')) }
      : {}),
  };
}
const wikidataEntityDefinition = definition(
  'wikidata-entity/v1',
  objectSchema({
    search: arraySchema(20, searchEntrySchema),
    entityEntries: arraySchema(50, entityEntrySchema),
  }, []),
  projectWikidataEntityData,
  restoreWikidataEntityData,
);

const gleifRecordSchema = objectSchema({
  lei: stringSchema(40), legalName: stringSchema(500), legalFormId: stringSchema(80),
  entityStatus: stringSchema(80), registrationStatus: stringSchema(80),
  country: stringSchema(16), city: stringSchema(500),
  hasDirectParent: { type: 'boolean' }, hasUltimateParent: { type: 'boolean' },
}, ['lei', 'legalName']);
const gleifParentSchema = objectSchema({
  lei: stringSchema(40), legalName: stringSchema(500), country: stringSchema(16),
}, ['lei', 'legalName']);
const gleifRecord = (value: unknown) => mapClosedRecord(
  value, GLEIF_RECORD_KEYS, ['lei', 'legalName'],
);
const gleifParent = (value: unknown) => value === null ? null : mapClosedRecord(
  value, GLEIF_PARENT_KEYS, ['lei', 'legalName'],
);
const gleifData = (value: unknown) => mapClosedRecord(value, ['records', 'parent'], [], {
  records: (items) => mapArray(items, gleifRecord), parent: gleifParent,
});
const gleifDefinition = definition(
  'gleif-fetch/v1',
  objectSchema({
    records: arraySchema(50, gleifRecordSchema),
    parent: { oneOf: [{ type: 'null' }, gleifParentSchema] },
  }, []),
  gleifData,
);

const chCompanySchema = objectSchema({
  companyNumber: stringSchema(80), title: stringSchema(500), companyStatus: stringSchema(80),
}, ['companyNumber', 'title', 'companyStatus']);
const chOfficerSchema = objectSchema({
  name: stringSchema(500), officerRole: stringSchema(120),
  resignedOn: stringSchema(80), officerId: stringSchema(160),
}, ['name', 'officerRole']);
const companiesHouseData = (value: unknown) => mapClosedRecord(
  value, ['companies', 'officers'], [], {
    companies: (items) => mapArray(items, (item) => (
      mapClosedRecord(item, CH_COMPANY_KEYS, ['companyNumber', 'title', 'companyStatus'])
    )),
    officers: (items) => mapArray(items, (item) => (
      mapClosedRecord(item, CH_OFFICER_KEYS, ['name', 'officerRole'])
    )),
  },
);
const companiesHouseDefinition = definition(
  'companies-house-search/v1',
  objectSchema({
    companies: arraySchema(5, chCompanySchema), officers: arraySchema(50, chOfficerSchema),
  }, []),
  companiesHouseData,
);

const dirigeantSchema = objectSchema({
  nom: stringSchema(500), prenoms: stringSchema(500), qualite: stringSchema(200),
}, ['nom', 'qualite']);
const inpiCompanySchema = objectSchema({
  siren: stringSchema(32), name: stringSchema(500), etatAdministratif: stringSchema(16),
  dirigeants: arraySchema(25, dirigeantSchema),
}, ['siren', 'name', 'etatAdministratif', 'dirigeants']);
function projectInpiDirigeants(value: unknown): unknown[] {
  const entries = mapArray(value, (entry) => (
    mapClosedRecord(entry, INPI_DIRIGEANT_KEYS, ['nom', 'qualite'])
  ));
  const selected: unknown[] = [];
  const seen = new Set<string>();
  for (const entry of entries as UnknownRecord[]) {
    const key = normalizePersonName([
      field(entry, 'prenoms'), field(entry, 'nom'),
    ].filter((part): part is string => typeof part === 'string').join(' '));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    selected.push(entry);
    if (selected.length === 25) break;
  }
  return selected;
}
const inpiData = (value: unknown) => mapClosedRecord(value, ['companies'], [], {
  companies: (items) => mapArray(items, (item) => mapClosedRecord(
    item, INPI_COMPANY_KEYS, ['siren', 'name', 'etatAdministratif', 'dirigeants'], {
      dirigeants: projectInpiDirigeants,
    },
  )),
});
const inpiDefinition = definition(
  'inpi-rne-search/v1',
  objectSchema({ companies: arraySchema(10, inpiCompanySchema) }, []),
  inpiData,
);

const patentApplicantSchema = objectSchema({
  name: stringSchema(500), country: stringSchema(16),
}, ['name']);
const patentInventorSchema = objectSchema({ name: stringSchema(500) }, ['name']);
const patentSchema = objectSchema({
  applicants: arraySchema(32, patentApplicantSchema),
  inventors: arraySchema(25, patentInventorSchema),
}, ['applicants', 'inventors']);
function projectPatentRecords(value: unknown): unknown[] {
  const groupSeen = new Map<string, Set<string>>();
  return mapArray(value, (item) => {
    const patent = ownDataRecord(item, PATENT_KEYS, ['applicants', 'inventors']);
    const applicants = mapArray(field(patent, 'applicants'), (entry) => (
      mapClosedRecord(entry, PATENT_APPLICANT_KEYS, ['name'])
    )) as UnknownRecord[];
    const inputInventors = mapArray(field(patent, 'inventors'), (entry) => (
      mapClosedRecord(entry, PATENT_INVENTOR_KEYS, ['name'])
    )) as UnknownRecord[];
    if (applicants.length !== 1) return { applicants, inventors: [] };
    const sole = applicants[0];
    const applicantKey = normForMatch(String(field(sole, 'name') ?? ''));
    if (!applicantKey) return { applicants, inventors: [] };
    const country = typeof field(sole, 'country') === 'string'
      ? String(field(sole, 'country')).toLowerCase() : '';
    const groupKey = `${applicantKey}\0${country}`;
    const seen = groupSeen.get(groupKey) ?? new Set<string>();
    groupSeen.set(groupKey, seen);
    const inventors: UnknownRecord[] = [];
    for (const inventor of inputInventors) {
      const nameKey = normalizePersonName(String(field(inventor, 'name') ?? ''));
      if (!nameKey || seen.has(nameKey) || seen.size >= 25) continue;
      seen.add(nameKey);
      inventors.push(inventor);
    }
    return { applicants, inventors };
  });
}
const patentsData = (value: unknown) => mapClosedRecord(value, ['patents'], [], {
  patents: projectPatentRecords,
});
const googlePatentsDefinition = definition(
  'google-patents-search/v1',
  objectSchema({ patents: arraySchema(2000, patentSchema) }, []),
  patentsData,
);

const fairExhibitorSchema = objectSchema({
  externalId: stringSchema(200), companyName: stringSchema(500), website: stringSchema(2048),
  email: stringSchema(320), phone: stringSchema(80), country: stringSchema(200),
  stand: stringSchema(200), description: stringSchema(500),
  products: arraySchema(12, stringSchema(500)), hiring: { type: 'boolean' },
}, ['externalId', 'companyName', 'products']);
const fairData = (value: unknown) => mapClosedRecord(value, ['exhibitors'], ['exhibitors'], {
  exhibitors: (items) => mapArray(items, (item) => mapClosedRecord(
    item, FAIR_EXHIBITOR_KEYS, ['externalId', 'companyName', 'products'], {
      products: mapStringArray,
    },
  )),
});
const tradeFairDefinition = definition(
  'tradefair-algolia/v1',
  objectSchema({ exhibitors: arraySchema(2000, fairExhibitorSchema) }, ['exhibitors']),
  fairData,
);

const mysFieldsSchema = objectSchema({
  exhid: stringSchema(200), name: stringSchema(500), description: stringSchema(4000),
  booths: arraySchema(32, stringSchema(200)), halls: arraySchema(32, stringSchema(200)),
}, []);
const mysHitSchema = objectSchema({ fields: mysFieldsSchema }, []);
function projectMysHit(value: unknown): UnknownRecord {
  const hit = ownDataRecord(value, ['fields'], []);
  if (!hasDefinedField(hit, 'fields')) return {};
  const fields = ownDataRecord(field(hit, 'fields'), MYS_RAW_FIELD_KEYS, []);
  return {
    fields: copyRenamed(fields, MYS_RAW_FIELD_KEYS, MYS_PROJECTED_FIELD_KEYS),
  };
}
function restoreMysHit(value: unknown): UnknownRecord {
  const hit = ownDataRecord(value, ['fields'], []);
  if (!hasDefinedField(hit, 'fields')) return {};
  const fields = ownDataRecord(field(hit, 'fields'), MYS_PROJECTED_FIELD_KEYS, []);
  return {
    fields: copyRenamed(fields, MYS_PROJECTED_FIELD_KEYS, MYS_RAW_FIELD_KEYS),
  };
}
const mapYourShowDefinition = definition(
  'mapyourshow-fetch/v1',
  objectSchema({ hits: arraySchema(5000, mysHitSchema) }, ['hits']),
  (value) => mapClosedRecord(value, ['hits'], ['hits'], {
    hits: (items) => mapArray(items, projectMysHit),
  }),
  (value) => mapClosedRecord(value, ['hits'], ['hits'], {
    hits: (items) => mapArray(items, restoreMysHit),
  }),
);

export const CATALOG_RESULT_PROJECTION_DEFINITIONS = Object.freeze([
  searxDefinition, wikidataSparqlDefinition, osmDefinition, wikidataEntityDefinition,
  gleifDefinition, companiesHouseDefinition, inpiDefinition, googlePatentsDefinition,
  tradeFairDefinition, mapYourShowDefinition,
] as const);

export function getCatalogResultProjectionSchema(toolId: string): TypedProjectionSchema {
  if (!Object.hasOwn(CATALOG_RESULT_PROJECTION_SCHEMAS, toolId)) {
    throw new Error('CATALOG_RESULT_PROJECTION_TOOL_UNKNOWN');
  }
  return CATALOG_RESULT_PROJECTION_SCHEMAS[toolId as CatalogResultToolId];
}

export function registerCatalogResultProjections(
  registry: TypedProjectionRegistry,
): TypedProjectionRegistry {
  for (const item of CATALOG_RESULT_PROJECTION_DEFINITIONS) registry.register(item);
  return registry;
}
