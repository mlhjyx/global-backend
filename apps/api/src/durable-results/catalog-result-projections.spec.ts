import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCompanyFacts } from '../adapters/wikidata';
import {
  osmOverpassTool,
  searxngSearchTool,
  wikidataTool,
} from '../tools/builtin-tools';
import {
  companiesHouseSearchTool,
  gleifFetchTool,
  googlePatentsSearchTool,
  inpiRneSearchTool,
  mapYourShowFetchTool,
  tradeFairAlgoliaTool,
  wikidataEntityTool,
} from '../tools/source-tools';
import { TypedProjectionRegistry } from './typed-projection.registry';
import type { PostgresJsonbByteExecutor } from './typed-projection.types';
import {
  CATALOG_RESULT_PROJECTION_DEFINITIONS,
  CATALOG_RESULT_PROJECTION_SCHEMAS,
  CATALOG_RESULT_TOOL_IDS,
  getCatalogResultProjectionSchema,
  registerCatalogResultProjections,
} from './catalog-result-projections';

type JsonRecord = Record<string, unknown>;

interface RawToolResult {
  data: JsonRecord;
  costCents: number;
  degraded?: boolean;
  provenance?: {
    sourceUrl?: string;
    fetchedAt: string;
    contentHash?: string;
    parserVersion: string;
  };
}

interface ProjectionFixture {
  readonly toolId: string;
  readonly schema: string;
  readonly raw: RawToolResult;
}

const URL_2048 = `https://x/${'u'.repeat(2038)}`;

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneRaw(raw: RawToolResult): RawToolResult & JsonRecord {
  return structuredClone(raw) as RawToolResult & JsonRecord;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as JsonRecord;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
  ).join(',')}}`;
}

function resignEnvelope<T extends {
  data: unknown; schema: string; schemaVersion: string; digest: string;
}>(envelope: T): T {
  const base = {
    data: envelope.data,
    schema: envelope.schema,
    schemaVersion: envelope.schemaVersion,
  };
  return {
    ...envelope,
    digest: createHash('sha256').update(canonicalJson(base)).digest('hex'),
  };
}

function entityIdSnak(id: string): JsonRecord {
  return { mainsnak: { datavalue: { value: { id } } } };
}

function stringSnak(value: string): JsonRecord {
  return { mainsnak: { datavalue: { value } } };
}

function quantitySnak(amount: string, pointInTime?: string): JsonRecord {
  return {
    mainsnak: { datavalue: { value: { amount } } },
    ...(pointInTime
      ? { qualifiers: { P585: [{ datavalue: { value: { time: pointInTime } } }] } }
      : {}),
  };
}

function timeSnak(time: string): JsonRecord {
  return { mainsnak: { datavalue: { value: { time } } } };
}

function osmTags(): JsonRecord {
  return Object.fromEntries(Array.from({ length: 64 }, (_, index) => [
    index === 0 ? 'k'.repeat(120) : `tag${String(index).padStart(3, '0')}`,
    index === 0 ? 'v'.repeat(1000) : `value-${index}`,
  ]));
}

const SEARX_RAW: RawToolResult = {
  data: {
    results: Array.from({ length: 20 }, (_, index) => ({
      url: index === 0 ? URL_2048 : `https://result-${index}.example/`,
      title: index === 0 ? 't'.repeat(2000) : `Result ${index}`,
    })),
  },
  costCents: 1_000_000_000,
  degraded: true,
};

const WIKIDATA_SPARQL_RAW: RawToolResult = {
  data: {
    companies: Array.from({ length: 200 }, (_, index) => ({
      qid: index === 0 ? 'q'.repeat(80) : `Q${index + 1}`,
      name: index === 0 ? 'n'.repeat(500) : `Company ${index}`,
      website: index === 0 ? URL_2048 : `https://company-${index}.example/`,
      employees: index === 0 ? 1_000_000_000_000 : index,
      countryCode: index === 0 ? 'c'.repeat(16) : 'DE',
      latitude: index === 0 ? 90 : 50,
      longitude: index === 0 ? 180 : 8,
    })),
  },
  costCents: 0,
  degraded: true,
  provenance: {
    sourceUrl: URL_2048,
    fetchedAt: 'f'.repeat(100),
    contentHash: 'h'.repeat(128),
    parserVersion: 'p'.repeat(120),
  },
};

const OSM_RAW: RawToolResult = {
  data: {
    places: Array.from({ length: 80 }, (_, index) => ({
      osmId: index === 0 ? 'o'.repeat(120) : `node/${index}`,
      name: index === 0 ? 'n'.repeat(500) : `Place ${index}`,
      website: index === 0 ? URL_2048 : `https://place-${index}.example/`,
      city: index === 0 ? 'c'.repeat(500) : 'Berlin',
      countryCode: index === 0 ? 'D'.repeat(16) : 'DE',
      latitude: index === 0 ? -90 : 50,
      longitude: index === 0 ? -180 : 8,
      tags: index === 0 ? osmTags() : { craft: 'metal_construction' },
    })),
  },
  costCents: 0,
  degraded: true,
  provenance: {
    sourceUrl: URL_2048,
    fetchedAt: 'f'.repeat(100),
    contentHash: 'h'.repeat(128),
    parserVersion: 'p'.repeat(120),
  },
};

const FIRST_WIKIDATA_ENTITY: JsonRecord = {
  labels: { en: { value: 'l'.repeat(500) } },
  claims: {
    P31: Array.from({ length: 64 }, (_, index) => entityIdSnak(`Q${index + 1}`)),
    P452: [entityIdSnak('Q100')],
    P1056: [entityIdSnak('Q200')],
    P1128: Array.from({ length: 64 }, (_, index) => quantitySnak(
      index === 0 ? '+'.repeat(120) : `+${index}`,
      index === 0 ? 't'.repeat(120) : `+202${index % 10}-01-01T00:00:00Z`,
    )),
    P571: Array.from({ length: 64 }, (_, index) => timeSnak(
      index === 0 ? 't'.repeat(120) : `+20${String(index).padStart(2, '0')}-01-01T00:00:00Z`,
    )),
    P749: [entityIdSnak('Q300')],
    P355: [entityIdSnak('Q401')],
    P1278: [stringSnak('529900TESTLEI0000')],
    P946: Array.from({ length: 64 }, (_, index) => stringSnak(`ISIN-${index}`)),
    P856: [stringSnak(URL_2048)],
    P17: [entityIdSnak('Q183')],
    P159: [entityIdSnak('Q500')],
    P414: [entityIdSnak('Q600')],
  },
};

const WIKIDATA_ENTITY_RAW: RawToolResult = {
  data: {
    search: Array.from({ length: 20 }, (_, index) => ({
      qid: index === 0 ? 'q'.repeat(80) : `Q${index + 1}`,
      label: index === 0 ? 'l'.repeat(500) : `Entity ${index}`,
      description: index === 0 ? 'd'.repeat(2000) : `Description ${index}`,
    })),
    entities: Object.fromEntries(Array.from({ length: 50 }, (_, index) => [
      index === 0 ? 'Q1' : `Q${index + 1}`,
      index === 0 ? FIRST_WIKIDATA_ENTITY : { labels: { en: { value: `Entity ${index}` } } },
    ])),
  },
  costCents: 0,
  degraded: true,
};

const GLEIF_RAW: RawToolResult = {
  data: {
    records: Array.from({ length: 50 }, (_, index) => ({
      lei: index === 0 ? 'l'.repeat(40) : `LEI-${index}`,
      legalName: index === 0 ? 'n'.repeat(500) : `Legal ${index}`,
      legalFormId: index === 0 ? 'f'.repeat(80) : 'AG',
      entityStatus: index === 0 ? 'e'.repeat(80) : 'ACTIVE',
      registrationStatus: index === 0 ? 'r'.repeat(80) : 'ISSUED',
      country: index === 0 ? 'c'.repeat(16) : 'DE',
      city: index === 0 ? 'y'.repeat(500) : 'Berlin',
      hasDirectParent: index % 2 === 0,
      hasUltimateParent: index % 3 === 0,
    })),
    parent: {
      lei: 'p'.repeat(40),
      legalName: 'n'.repeat(500),
      country: 'c'.repeat(16),
    },
  },
  costCents: 0,
  degraded: true,
};

const COMPANIES_HOUSE_RAW: RawToolResult = {
  data: {
    companies: Array.from({ length: 5 }, (_, index) => ({
      companyNumber: index === 0 ? 'c'.repeat(80) : `C-${index}`,
      title: index === 0 ? 't'.repeat(500) : `Company ${index}`,
      companyStatus: index === 0 ? 's'.repeat(80) : 'active',
    })),
    officers: Array.from({ length: 50 }, (_, index) => ({
      name: index === 0 ? 'n'.repeat(500) : `OFFICER, Given ${index}`,
      officerRole: index === 0 ? 'r'.repeat(120) : 'director',
      resignedOn: index === 0 ? 'd'.repeat(80) : '2026-08-20',
      officerId: index === 0 ? 'i'.repeat(160) : `OFF-${index}`,
    })),
  },
  costCents: 0,
  degraded: true,
};

const INPI_RAW: RawToolResult = {
  data: {
    companies: Array.from({ length: 10 }, (_, index) => ({
      siren: index === 0 ? 's'.repeat(32) : `SIREN-${index}`,
      name: index === 0 ? 'n'.repeat(500) : `Société ${index}`,
      etatAdministratif: index === 0 ? 'e'.repeat(16) : 'A',
      dirigeants: Array.from({ length: index === 0 ? 25 : 1 }, (_, dirigeantIndex) => ({
        nom: index === 0 && dirigeantIndex === 0 ? 'n'.repeat(500) : `Nom ${dirigeantIndex}`,
        prenoms: index === 0 && dirigeantIndex === 0 ? 'p'.repeat(500) : `Prénom ${dirigeantIndex}`,
        qualite: index === 0 && dirigeantIndex === 0 ? 'q'.repeat(200) : 'Président',
      })),
    })),
  },
  costCents: 0,
  degraded: true,
};

const GOOGLE_PATENTS_RAW: RawToolResult = {
  data: {
    patents: Array.from({ length: 2000 }, (_, index) => ({
      applicants: index === 0
        ? Array.from({ length: 32 }, (_, itemIndex) => ({
            name: itemIndex === 0 ? 'a'.repeat(500) : `Applicant ${itemIndex}`,
            country: itemIndex === 0 ? 'c'.repeat(16) : 'DE',
          }))
        : [],
      inventors: index === 0
        ? Array.from({ length: 25 }, (_, itemIndex) => ({
            name: itemIndex === 0 ? 'i'.repeat(500) : `Inventor ${itemIndex}`,
          }))
        : [],
    })),
  },
  costCents: 0,
  degraded: true,
};

const TRADE_FAIR_RAW: RawToolResult = {
  data: {
    exhibitors: Array.from({ length: 400 }, (_, index) => ({
      externalId: index === 0 ? 'i'.repeat(200) : `EX-${index}`,
      companyName: index === 0 ? 'n'.repeat(500) : `Exhibitor ${index}`,
      website: index === 0 ? URL_2048 : `https://exhibitor-${index}.example/`,
      email: index === 0 ? `${'e'.repeat(300)}@example.test` : `office-${index}@example.test`,
      phone: index === 0 ? 'p'.repeat(80) : '+49 30 1234',
      country: index === 0 ? 'c'.repeat(200) : 'Germany',
      stand: index === 0 ? 's'.repeat(200) : `A-${index}`,
      description: index === 0 ? 'd'.repeat(500) : `Description ${index}`,
      products: Array.from({ length: index === 0 ? 12 : 1 }, (_, productIndex) => (
        index === 0 && productIndex === 0 ? 'p'.repeat(500) : `Product ${productIndex}`
      )),
      hiring: index % 2 === 0,
    })),
  },
  costCents: 0,
  degraded: true,
};

const MAPYOURSHOW_RAW: RawToolResult = {
  data: {
    hits: Array.from({ length: 5000 }, (_, index) => (
      index === 0
        ? {
            fields: {
              exhid_l: 'i'.repeat(200),
              exhname_t: 'n'.repeat(500),
              exhdesc_t: 'd'.repeat(4000),
              boothsdisplay_la: Array.from({ length: 32 }, (_, itemIndex) => (
                itemIndex === 0 ? 'b'.repeat(200) : `B-${itemIndex}`
              )),
              hallid_la: Array.from({ length: 32 }, (_, itemIndex) => (
                itemIndex === 0 ? 'h'.repeat(200) : `H-${itemIndex}`
              )),
            },
          }
        : {}
    )),
  },
  costCents: 0,
  degraded: true,
};

const REPRESENTATIVE_LEGAL_BOUNDARY_FIXTURES: readonly ProjectionFixture[] = [
  { toolId: 'searxng.search', schema: 'searxng-search/v1', raw: SEARX_RAW },
  { toolId: 'wikidata.sparql', schema: 'wikidata-sparql/v1', raw: WIKIDATA_SPARQL_RAW },
  { toolId: 'osm.overpass', schema: 'osm-overpass/v1', raw: OSM_RAW },
  { toolId: 'wikidata.entity', schema: 'wikidata-entity/v1', raw: WIKIDATA_ENTITY_RAW },
  { toolId: 'gleif.fetch', schema: 'gleif-fetch/v1', raw: GLEIF_RAW },
  { toolId: 'companies_house.search', schema: 'companies-house-search/v1', raw: COMPANIES_HOUSE_RAW },
  { toolId: 'inpi_rne.search', schema: 'inpi-rne-search/v1', raw: INPI_RAW },
  { toolId: 'google_patents.search', schema: 'google-patents-search/v1', raw: GOOGLE_PATENTS_RAW },
  { toolId: 'tradefair.algolia', schema: 'tradefair-algolia/v1', raw: TRADE_FAIR_RAW },
  { toolId: 'mapyourshow.fetch', schema: 'mapyourshow-fetch/v1', raw: MAPYOURSHOW_RAW },
];

function schemaTypes(node: JsonRecord): readonly string[] {
  return typeof node.type === 'string' ? [node.type] : node.type as string[];
}

function expectClosedAndBounded(value: unknown, names: string[] = []): void {
  const node = value as JsonRecord;
  for (const combination of ['oneOf', 'anyOf', 'allOf']) {
    for (const branch of (node[combination] as unknown[] | undefined) ?? []) {
      expectClosedAndBounded(branch, names);
    }
  }
  if (!node.type) return;
  const types = schemaTypes(node);
  if (types.includes('object')) {
    expect(node.additionalProperties).toBe(false);
    expect(node.properties).toBeTruthy();
    for (const [name, child] of Object.entries(node.properties as JsonRecord)) {
      names.push(name);
      expectClosedAndBounded(child, names);
    }
  }
  if (types.includes('array')) {
    expect(Number.isSafeInteger(node.maxItems)).toBe(true);
    expectClosedAndBounded(node.items, names);
  }
  if (types.includes('string')) expect(Number.isSafeInteger(node.maxLength)).toBe(true);
  if (types.includes('number') || types.includes('integer')) {
    expect(typeof node.minimum).toBe('number');
    expect(typeof node.maximum).toBe('number');
  }
}

function bounds(value: unknown, path = '$', result: JsonRecord = {}): JsonRecord {
  const node = value as JsonRecord;
  for (const bound of ['maxItems', 'maxLength', 'minimum', 'maximum']) {
    if (node[bound] !== undefined) result[`${path}.${bound}`] = node[bound];
  }
  for (const [key, child] of Object.entries((node.properties as JsonRecord | undefined) ?? {})) {
    bounds(child, `${path}.${key}`, result);
  }
  if (node.items) bounds(node.items, `${path}[]`, result);
  for (const combination of ['oneOf', 'anyOf', 'allOf']) {
    ((node[combination] as unknown[] | undefined) ?? []).forEach(
      (branch, index) => bounds(branch, `${path}.${combination}[${index}]`, result),
    );
  }
  return result;
}

function expectSchemaDeeplyFrozen(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Array.isArray(value) ? value : Object.values(value as JsonRecord)) {
    expectSchemaDeeplyFrozen(child, seen);
  }
}

const COMMON_RESULT_BOUNDS = {
  '$.costCents.minimum': 0,
  '$.costCents.maximum': 1_000_000_000,
};

const PROVENANCE_BOUNDS = {
  '$.provenance.sourceUrl.maxLength': 2048,
  '$.provenance.fetchedAt.maxLength': 100,
  '$.provenance.contentHash.maxLength': 128,
  '$.provenance.parserVersion.maxLength': 120,
};

const EXPECTED_BOUNDS: Readonly<Record<string, JsonRecord>> = {
  'searxng-search/v1': {
    ...COMMON_RESULT_BOUNDS,
    '$.data.results.maxItems': 20,
    '$.data.results[].url.maxLength': 2048,
    '$.data.results[].title.maxLength': 2000,
  },
  'wikidata-sparql/v1': {
    ...COMMON_RESULT_BOUNDS,
    ...PROVENANCE_BOUNDS,
    '$.data.companies.maxItems': 200,
    '$.data.companies[].qid.maxLength': 80,
    '$.data.companies[].name.maxLength': 500,
    '$.data.companies[].website.maxLength': 2048,
    '$.data.companies[].employees.minimum': 0,
    '$.data.companies[].employees.maximum': 1_000_000_000_000,
    '$.data.companies[].countryCode.maxLength': 16,
    '$.data.companies[].latitude.minimum': -90,
    '$.data.companies[].latitude.maximum': 90,
    '$.data.companies[].longitude.minimum': -180,
    '$.data.companies[].longitude.maximum': 180,
  },
  'osm-overpass/v1': {
    ...COMMON_RESULT_BOUNDS,
    ...PROVENANCE_BOUNDS,
    '$.data.places.maxItems': 80,
    '$.data.places[].osmId.maxLength': 120,
    '$.data.places[].name.maxLength': 500,
    '$.data.places[].website.maxLength': 2048,
    '$.data.places[].city.maxLength': 500,
    '$.data.places[].countryCode.maxLength': 16,
    '$.data.places[].latitude.minimum': -90,
    '$.data.places[].latitude.maximum': 90,
    '$.data.places[].longitude.minimum': -180,
    '$.data.places[].longitude.maximum': 180,
    '$.data.places[].tagEntries.maxItems': 64,
    '$.data.places[].tagEntries[].key.maxLength': 120,
    '$.data.places[].tagEntries[].value.maxLength': 1000,
  },
  'wikidata-entity/v1': {
    ...COMMON_RESULT_BOUNDS,
    '$.data.search.maxItems': 20,
    '$.data.search[].qid.maxLength': 80,
    '$.data.search[].label.maxLength': 500,
    '$.data.search[].description.maxLength': 2000,
    '$.data.entityEntries.maxItems': 50,
    '$.data.entityEntries[].entityId.maxLength': 80,
    '$.data.entityEntries[].label.maxLength': 500,
    '$.data.entityEntries[].claimEntries.maxItems': 14,
    '$.data.entityEntries[].claimEntries[].oneOf[0].property.maxLength': 120,
    '$.data.entityEntries[].claimEntries[].oneOf[0].entityIds.maxItems': 64,
    '$.data.entityEntries[].claimEntries[].oneOf[0].entityIds[].maxLength': 80,
    '$.data.entityEntries[].claimEntries[].oneOf[1].property.maxLength': 120,
    '$.data.entityEntries[].claimEntries[].oneOf[1].stringValues.maxItems': 64,
    '$.data.entityEntries[].claimEntries[].oneOf[1].stringValues[].maxLength': 2048,
    '$.data.entityEntries[].claimEntries[].oneOf[2].property.maxLength': 120,
    '$.data.entityEntries[].claimEntries[].oneOf[2].quantities.maxItems': 64,
    '$.data.entityEntries[].claimEntries[].oneOf[2].quantities[].amount.maxLength': 120,
    '$.data.entityEntries[].claimEntries[].oneOf[2].quantities[].pointInTime.maxLength': 120,
    '$.data.entityEntries[].claimEntries[].oneOf[3].property.maxLength': 120,
    '$.data.entityEntries[].claimEntries[].oneOf[3].times.maxItems': 64,
    '$.data.entityEntries[].claimEntries[].oneOf[3].times[].maxLength': 120,
  },
  'gleif-fetch/v1': {
    ...COMMON_RESULT_BOUNDS,
    '$.data.records.maxItems': 50,
    '$.data.records[].lei.maxLength': 40,
    '$.data.records[].legalName.maxLength': 500,
    '$.data.records[].legalFormId.maxLength': 80,
    '$.data.records[].entityStatus.maxLength': 80,
    '$.data.records[].registrationStatus.maxLength': 80,
    '$.data.records[].country.maxLength': 16,
    '$.data.records[].city.maxLength': 500,
    '$.data.parent.oneOf[1].lei.maxLength': 40,
    '$.data.parent.oneOf[1].legalName.maxLength': 500,
    '$.data.parent.oneOf[1].country.maxLength': 16,
  },
  'companies-house-search/v1': {
    ...COMMON_RESULT_BOUNDS,
    '$.data.companies.maxItems': 5,
    '$.data.companies[].companyNumber.maxLength': 80,
    '$.data.companies[].title.maxLength': 500,
    '$.data.companies[].companyStatus.maxLength': 80,
    '$.data.officers.maxItems': 50,
    '$.data.officers[].name.maxLength': 500,
    '$.data.officers[].officerRole.maxLength': 120,
    '$.data.officers[].resignedOn.maxLength': 80,
    '$.data.officers[].officerId.maxLength': 160,
  },
  'inpi-rne-search/v1': {
    ...COMMON_RESULT_BOUNDS,
    '$.data.companies.maxItems': 10,
    '$.data.companies[].siren.maxLength': 32,
    '$.data.companies[].name.maxLength': 500,
    '$.data.companies[].etatAdministratif.maxLength': 16,
    '$.data.companies[].dirigeants.maxItems': 25,
    '$.data.companies[].dirigeants[].nom.maxLength': 500,
    '$.data.companies[].dirigeants[].prenoms.maxLength': 500,
    '$.data.companies[].dirigeants[].qualite.maxLength': 200,
  },
  'google-patents-search/v1': {
    ...COMMON_RESULT_BOUNDS,
    '$.data.patents.maxItems': 2000,
    '$.data.patents[].applicants.maxItems': 32,
    '$.data.patents[].applicants[].name.maxLength': 500,
    '$.data.patents[].applicants[].country.maxLength': 16,
    '$.data.patents[].inventors.maxItems': 25,
    '$.data.patents[].inventors[].name.maxLength': 500,
  },
  'tradefair-algolia/v1': {
    ...COMMON_RESULT_BOUNDS,
    '$.data.exhibitors.maxItems': 2000,
    '$.data.exhibitors[].externalId.maxLength': 200,
    '$.data.exhibitors[].companyName.maxLength': 500,
    '$.data.exhibitors[].website.maxLength': 2048,
    '$.data.exhibitors[].email.maxLength': 320,
    '$.data.exhibitors[].phone.maxLength': 80,
    '$.data.exhibitors[].country.maxLength': 200,
    '$.data.exhibitors[].stand.maxLength': 200,
    '$.data.exhibitors[].description.maxLength': 500,
    '$.data.exhibitors[].products.maxItems': 12,
    '$.data.exhibitors[].products[].maxLength': 500,
  },
  'mapyourshow-fetch/v1': {
    ...COMMON_RESULT_BOUNDS,
    '$.data.hits.maxItems': 5000,
    '$.data.hits[].fields.exhid.maxLength': 200,
    '$.data.hits[].fields.name.maxLength': 500,
    '$.data.hits[].fields.description.maxLength': 4000,
    '$.data.hits[].fields.booths.maxItems': 32,
    '$.data.hits[].fields.booths[].maxLength': 200,
    '$.data.hits[].fields.halls.maxItems': 32,
    '$.data.hits[].fields.halls[].maxLength': 200,
  },
};

function selectedOneOfIndex(schema: JsonRecord, value: unknown): number {
  const branches = schema.oneOf as JsonRecord[];
  const index = branches.findIndex((branch) => {
    const types = branch.type ? schemaTypes(branch) : [];
    if (types.includes('null')) return value === null;
    if (types.includes('object') && value && typeof value === 'object' && !Array.isArray(value)) {
      const objectValue = value as JsonRecord;
      const required = branch.required as string[] | undefined;
      if (required?.some((key) => !Object.hasOwn(objectValue, key))) return false;
      const properties = branch.properties as JsonRecord | undefined;
      return Object.entries(properties ?? {}).every(([key, child]) => (
        !(child as JsonRecord).const || objectValue[key] === (child as JsonRecord).const
      ));
    }
    return false;
  });
  if (index < 0) throw new Error('fixture does not match a oneOf branch');
  return index;
}

type Path = readonly (string | number)[];
interface BoundaryMutation {
  readonly label: string;
  readonly path: Path;
  readonly value: unknown;
}

function minimalForSchema(schema: JsonRecord): unknown {
  if (schema.oneOf) return minimalForSchema((schema.oneOf as JsonRecord[])[0]);
  const types = schemaTypes(schema);
  if (types.includes('null')) return null;
  if (types.includes('string')) return (schema.enum as unknown[] | undefined)?.[0] ?? '';
  if (types.includes('number') || types.includes('integer')) return schema.minimum;
  if (types.includes('boolean')) return false;
  if (types.includes('array')) return [];
  const output: JsonRecord = {};
  const properties = schema.properties as JsonRecord;
  for (const key of (schema.required as string[] | undefined) ?? []) {
    output[key] = minimalForSchema(properties[key] as JsonRecord);
  }
  return output;
}

function collectBoundaryMutations(
  schema: JsonRecord,
  value: unknown,
  path: Path = [],
  output: BoundaryMutation[] = [],
): BoundaryMutation[] {
  if (schema.oneOf) {
    const index = selectedOneOfIndex(schema, value);
    return collectBoundaryMutations(
      (schema.oneOf as JsonRecord[])[index], value, path, output,
    );
  }
  const types = schemaTypes(schema);
  if (types.includes('string')) {
    output.push({ label: `${path.join('.')} maxLength+1`, path, value: 'x'.repeat(Number(schema.maxLength) + 1) });
  }
  if (types.includes('number') || types.includes('integer')) {
    output.push({ label: `${path.join('.')} minimum-1`, path, value: Number(schema.minimum) - 1 });
    output.push({ label: `${path.join('.')} maximum+1`, path, value: Number(schema.maximum) + 1 });
  }
  if (types.includes('array')) {
    const items = schema.items as JsonRecord;
    output.push({
      label: `${path.join('.')} maxItems+1`,
      path,
      value: Array.from({ length: Number(schema.maxItems) + 1 }, () => minimalForSchema(items)),
    });
    const seenVariants = new Set<string>();
    for (let index = 0; index < (value as unknown[]).length; index += 1) {
      const item = (value as unknown[])[index];
      const variant = items.oneOf ? String(selectedOneOfIndex(items, item)) : 'single';
      if (seenVariants.has(variant)) continue;
      seenVariants.add(variant);
      collectBoundaryMutations(items, item, [...path, index], output);
    }
  }
  if (types.includes('object')) {
    const objectValue = value as JsonRecord;
    for (const [key, child] of Object.entries(schema.properties as JsonRecord)) {
      if (Object.hasOwn(objectValue, key)) {
        collectBoundaryMutations(child as JsonRecord, objectValue[key], [...path, key], output);
      }
    }
  }
  return output;
}

function setAtPath(root: unknown, path: Path, value: unknown): void {
  let target = root as JsonRecord | unknown[];
  for (const segment of path.slice(0, -1)) {
    target = target[segment as never] as JsonRecord | unknown[];
  }
  target[path[path.length - 1] as never] = value as never;
}

describe('closed catalog Tool result projections', () => {
  it('locks the exact immutable toolId-to-schema mapping and definition order', () => {
    expect(CATALOG_RESULT_TOOL_IDS).toEqual([
      'searxng.search', 'wikidata.sparql', 'osm.overpass', 'wikidata.entity',
      'gleif.fetch', 'companies_house.search', 'inpi_rne.search',
      'google_patents.search', 'tradefair.algolia', 'mapyourshow.fetch',
    ]);
    expect(CATALOG_RESULT_PROJECTION_SCHEMAS).toEqual({
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
    });
    expect(CATALOG_RESULT_PROJECTION_DEFINITIONS.map((definition) => definition.schema))
      .toEqual(Object.values(CATALOG_RESULT_PROJECTION_SCHEMAS));
    expect(Object.isFrozen(CATALOG_RESULT_TOOL_IDS)).toBe(true);
    expect(Object.isFrozen(CATALOG_RESULT_PROJECTION_SCHEMAS)).toBe(true);
    expect(Object.isFrozen(CATALOG_RESULT_PROJECTION_DEFINITIONS)).toBe(true);
  });

  it('fails closed for unknown tools, missing definitions, and duplicate registration', () => {
    expect(() => getCatalogResultProjectionSchema('http.get')).toThrow(
      'CATALOG_RESULT_PROJECTION_TOOL_UNKNOWN',
    );
    expect(() => new TypedProjectionRegistry().project('searxng-search/v1', SEARX_RAW))
      .toThrow('TYPED_PROJECTION_INVALID');
    const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
    expect(() => registerCatalogResultProjections(registry)).toThrow(
      'DURABLE_RESULT_SCHEMA_DUPLICATE',
    );
  });

  it('registers only recursively closed, bounded, ASCII-camelCase, non-sensitive schemas', () => {
    for (const definition of CATALOG_RESULT_PROJECTION_DEFINITIONS) {
      const names: string[] = [];
      expectClosedAndBounded(definition.jsonSchema, names);
      for (const name of names) {
        expect(name).toMatch(/^[a-z][A-Za-z0-9]*$/);
        expect(name).not.toMatch(
          /prompt|raw|responseBody|credential|accessToken|headers|dateOfBirth|nationality|address|residence/i,
        );
      }
    }
  });

  it('locks every literal nested bound exactly', () => {
    for (const definition of CATALOG_RESULT_PROJECTION_DEFINITIONS) {
      expect(bounds(definition.jsonSchema), definition.schema)
        .toEqual(EXPECTED_BOUNDS[definition.schema]);
    }
  });

  it('deep-freezes every definition and nested JSON Schema object/array', () => {
    for (const definition of CATALOG_RESULT_PROJECTION_DEFINITIONS) {
      expect(Object.isFrozen(definition)).toBe(true);
      expectSchemaDeeplyFrozen(definition.jsonSchema);
    }
  });

  it.each(REPRESENTATIVE_LEGAL_BOUNDARY_FIXTURES)(
    '$toolId projects/restores its representative boundary below 120 KiB',
    (fixture) => {
      const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
      registry.freeze();
      const envelope = registry.project(
        getCatalogResultProjectionSchema(fixture.toolId), fixture.raw,
      );
      expect(envelope.schema).toBe(fixture.schema);
      expect(Buffer.byteLength(JSON.stringify(envelope), 'utf8')).toBeLessThanOrEqual(120 * 1024);
      expect(registry.restore(envelope)).toEqual(jsonRoundTrip(fixture.raw));
    },
  );

  it('rejects every present max+1/min-1 nested boundary through a digest-valid envelope', () => {
    const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
    for (const [index, fixture] of REPRESENTATIVE_LEGAL_BOUNDARY_FIXTURES.entries()) {
      const definition = CATALOG_RESULT_PROJECTION_DEFINITIONS[index];
      const envelope = registry.project(definition.schema, fixture.raw);
      const mutations = collectBoundaryMutations(
        definition.jsonSchema as JsonRecord,
        envelope.data,
      );
      expect(mutations.length, fixture.toolId).toBeGreaterThanOrEqual(5);
      for (const mutation of mutations) {
        const tampered = structuredClone(envelope) as typeof envelope;
        setAtPath(tampered.data, mutation.path, mutation.value);
        expect(
          () => registry.restore(resignEnvelope(tampered)),
          `${fixture.toolId}: ${mutation.label}`,
        ).toThrow(/TYPED_PROJECTION_(INVALID|TOO_LARGE)/);
      }
    }
  });

  it('rejects unknown, raw-provider, credential, prompt, header, and unrestricted attribute fields', () => {
    const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
    const cases: readonly [string, string, RawToolResult][] = [
      ['searx raw attributes', 'searxng-search/v1', (() => {
        const raw = cloneRaw(SEARX_RAW);
        (raw.data.results as JsonRecord[])[0].attributes = [{ label: 'email', value: 'x' }];
        return raw;
      })()],
      ['searx snippet', 'searxng-search/v1', (() => {
        const raw = cloneRaw(SEARX_RAW);
        (raw.data.results as JsonRecord[])[0].content = 'raw snippet';
        return raw;
      })()],
      ['wikidata raw response', 'wikidata-entity/v1', (() => {
        const raw = cloneRaw(WIKIDATA_ENTITY_RAW);
        ((raw.data.entities as JsonRecord).Q1 as JsonRecord).sitelinks = {};
        return raw;
      })()],
      ['top-level credential', 'gleif-fetch/v1', { ...cloneRaw(GLEIF_RAW), credentialRef: 'vault://x' }],
      ['response body', 'companies-house-search/v1', { ...cloneRaw(COMPANIES_HOUSE_RAW), responseBody: '{}' }],
      ['prompt', 'google-patents-search/v1', { ...cloneRaw(GOOGLE_PATENTS_RAW), prompt: 'hidden' }],
      ['headers', 'wikidata-sparql/v1', (() => {
        const raw = cloneRaw(WIKIDATA_SPARQL_RAW);
        (raw.provenance as JsonRecord).headers = { authorization: 'secret' };
        return raw;
      })()],
      ['map raw provider field', 'mapyourshow-fetch/v1', (() => {
        const raw = cloneRaw(MAPYOURSHOW_RAW);
        ((raw.data.hits as JsonRecord[])[0].fields as JsonRecord).rawProviderRecord = {};
        return raw;
      })()],
    ];
    for (const [name, schema, raw] of cases) {
      expect(() => registry.project(schema as never, raw), name).toThrow(
        'TYPED_PROJECTION_INVALID',
      );
    }
  });

  it('rejects personal fields outside current minimized registry/patent/fair contracts', () => {
    const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
    const ch = cloneRaw(COMPANIES_HOUSE_RAW);
    Object.assign((ch.data.officers as JsonRecord[])[0], {
      dateOfBirth: '1970-01', nationality: 'British', address: 'private',
    });
    expect(() => registry.project('companies-house-search/v1', ch)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
    const inpi = cloneRaw(INPI_RAW);
    Object.assign((((inpi.data.companies as JsonRecord[])[0].dirigeants as JsonRecord[])[0]), {
      dateDeNaissance: '1970-01-01', nationalite: 'FR', address: 'private',
    });
    expect(() => registry.project('inpi-rne-search/v1', inpi)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
    const patent = cloneRaw(GOOGLE_PATENTS_RAW);
    Object.assign((((patent.data.patents as JsonRecord[])[0].inventors as JsonRecord[])[0]), {
      country: 'DE', residence: 'Berlin', email: 'inventor@example.test',
    });
    expect(() => registry.project('google-patents-search/v1', patent)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
    const fair = cloneRaw(TRADE_FAIR_RAW);
    Object.assign((fair.data.exhibitors as JsonRecord[])[0], {
      contactName: 'Named person', homeAddress: 'private',
    });
    expect(() => registry.project('tradefair-algolia/v1', fair)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
    const map = cloneRaw(MAPYOURSHOW_RAW);
    Object.assign(((map.data.hits as JsonRecord[])[0].fields as JsonRecord), {
      email: 'person@example.test', phone: '+1 555 0100', contactName: 'Named person',
    });
    expect(() => registry.project('mapyourshow-fetch/v1', map)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
    const osm = cloneRaw(OSM_RAW);
    (((osm.data.places as JsonRecord[])[0].tags as JsonRecord))['contact:email'] =
      'person@example.test';
    expect(() => registry.project('osm-overpass/v1', osm)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
  });

  it('rejects Proxy, accessor, sparse, custom-prototype, and symbol containers', () => {
    const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
    expect(() => registry.project('searxng-search/v1', new Proxy(SEARX_RAW, {})))
      .toThrow('TYPED_PROJECTION_INVALID');
    const accessor = cloneRaw(OSM_RAW);
    Object.defineProperty(accessor, 'data', { enumerable: true, get: () => OSM_RAW.data });
    expect(() => registry.project('osm-overpass/v1', accessor)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
    const sparse = cloneRaw(COMPANIES_HOUSE_RAW);
    sparse.data.officers = new Array(1);
    expect(() => registry.project('companies-house-search/v1', sparse)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
    const custom = cloneRaw(GOOGLE_PATENTS_RAW);
    Object.setPrototypeOf((custom.data.patents as JsonRecord[])[0], { inherited: true });
    expect(() => registry.project('google-patents-search/v1', custom)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
    const symbol = cloneRaw(GLEIF_RAW);
    Object.defineProperty((symbol.data.records as JsonRecord[])[0], Symbol('hidden'), {
      enumerable: true, value: 'secret',
    });
    expect(() => registry.project('gleif-fetch/v1', symbol)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
  });

  it('normalizes OSM tags and Wikidata entity/claim maps to sorted unique entries', () => {
    const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
    const osmEnvelope = registry.project('osm-overpass/v1', OSM_RAW);
    const osmEntries = (((osmEnvelope.data as JsonRecord).data as JsonRecord)
      .places as JsonRecord[])[0].tagEntries as JsonRecord[];
    expect(osmEntries.map((entry) => entry.key)).toEqual(
      [...osmEntries.map((entry) => entry.key as string)].sort(),
    );

    const wikidataEnvelope = registry.project('wikidata-entity/v1', WIKIDATA_ENTITY_RAW);
    const entityEntries = (((wikidataEnvelope.data as JsonRecord).data as JsonRecord)
      .entityEntries as JsonRecord[]);
    expect(entityEntries.map((entry) => entry.entityId)).toEqual(
      [...entityEntries.map((entry) => entry.entityId as string)].sort(),
    );
    const claimEntries = entityEntries[0].claimEntries as JsonRecord[];
    expect(claimEntries.map((entry) => entry.property)).toEqual(
      [...claimEntries.map((entry) => entry.property as string)].sort(),
    );
  });

  it('refuses digest-valid duplicate/out-of-order OSM, Wikidata entity, and claim entries', () => {
    const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
    const osmEnvelope = registry.project('osm-overpass/v1', OSM_RAW);
    const osmDuplicate = structuredClone(osmEnvelope) as typeof osmEnvelope;
    const osmEntries = ((((osmDuplicate.data as JsonRecord).data as JsonRecord)
      .places as JsonRecord[])[0].tagEntries as JsonRecord[]);
    osmEntries[1] = structuredClone(osmEntries[0]);
    expect(() => registry.restore(resignEnvelope(osmDuplicate))).toThrow(
      'TYPED_PROJECTION_INVALID',
    );

    const wikidataEnvelope = registry.project('wikidata-entity/v1', WIKIDATA_ENTITY_RAW);
    const entityDuplicate = structuredClone(wikidataEnvelope) as typeof wikidataEnvelope;
    const entityEntries = (((entityDuplicate.data as JsonRecord).data as JsonRecord)
      .entityEntries as JsonRecord[]);
    entityEntries[1] = structuredClone(entityEntries[0]);
    expect(() => registry.restore(resignEnvelope(entityDuplicate))).toThrow(
      'TYPED_PROJECTION_INVALID',
    );

    const claimOutOfOrder = structuredClone(wikidataEnvelope) as typeof wikidataEnvelope;
    const claims = ((((claimOutOfOrder.data as JsonRecord).data as JsonRecord)
      .entityEntries as JsonRecord[])[0].claimEntries as JsonRecord[]);
    [claims[0], claims[1]] = [claims[1], claims[0]];
    expect(() => registry.restore(resignEnvelope(claimOutOfOrder))).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
  });

  it('retains only the SearX fields current consumers use and accepts the unchanged callback shape', () => {
    const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
    const restored = registry.restore(registry.project('searxng-search/v1', SEARX_RAW)) as RawToolResult;
    expect((restored.data.results as JsonRecord[])[0]).toEqual({
      url: URL_2048,
      title: 't'.repeat(2000),
    });
    expect(searxngSearchTool.durableReplayResult).toBeTypeOf('function');
    const currentReplay = searxngSearchTool.durableReplayResult!({
      data: { results: [{ url: 'https://directory.example/path', title: 'Directory' }] },
      costCents: 0,
    });
    expect(currentReplay).toEqual({
      data: { results: [{ url: 'https://directory.example/' }] },
      costCents: 0,
    });
    expect(registry.restore(registry.project('searxng-search/v1', currentReplay)))
      .toEqual(currentReplay);
  });

  it('restores the exact Wikidata subset consumed by parseCompanyFacts', () => {
    const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
    const restored = registry.restore(
      registry.project('wikidata-entity/v1', WIKIDATA_ENTITY_RAW),
    ) as RawToolResult;
    const before = parseCompanyFacts('Q1', FIRST_WIKIDATA_ENTITY, {});
    const after = parseCompanyFacts('Q1', (restored.data.entities as JsonRecord).Q1, {});
    expect(after).toEqual(before);
  });

  it('does not add runtime callbacks or declarations to the other nine current Tools', () => {
    const currentTools = [
      wikidataTool, osmOverpassTool, wikidataEntityTool, gleifFetchTool,
      companiesHouseSearchTool, inpiRneSearchTool, googlePatentsSearchTool,
      tradeFairAlgoliaTool, mapYourShowFetchTool,
    ];
    for (const tool of currentTools) expect(tool.durableReplayResult, tool.id).toBeUndefined();
  });

  it('preserves minimal branch outputs without inventing absent optional fields', () => {
    const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
    const cases: readonly [string, RawToolResult, RawToolResult?][] = [
      ['osm-overpass/v1', {
        data: {
          places: [{
            osmId: 'node/1', name: 'Factory', latitude: 50, longitude: 8,
            tags: { 'contact:website': 'https://factory.example/' },
          }],
        },
        costCents: 0,
        provenance: { fetchedAt: '2026-08-21', parserVersion: 'osm/1' },
      }],
      ['gleif-fetch/v1', { data: { parent: null }, costCents: 0 }],
      ['wikidata-entity/v1', {
        data: { search: [{ qid: 'Q1', label: 'Factory' }] }, costCents: 0,
      }],
      ['wikidata-entity/v1', {
        data: {
          entities: {
            Q1: { labels: {}, claims: { P1128: [quantitySnak('+1')] } },
          },
        },
        costCents: 0,
      }, {
        data: {
          entities: {
            Q1: { claims: { P1128: [quantitySnak('+1')] } },
          },
        },
        costCents: 0,
      }],
      ['mapyourshow-fetch/v1', {
        data: { hits: [{ fields: {} }, {}] }, costCents: 0,
      }],
    ];
    for (const [schema, raw, expected = raw] of cases) {
      const restored = registry.restore(registry.project(schema as never, raw));
      expect(restored, schema).toEqual(jsonRoundTrip(expected));
    }
  });

  it('rejects the all-field-max trade-fair cartesian fixture at the aggregate gate', () => {
    const maximumExhibitor = structuredClone(
      (TRADE_FAIR_RAW.data.exhibitors as JsonRecord[])[0],
    );
    const raw = cloneRaw(TRADE_FAIR_RAW);
    raw.data.exhibitors = Array.from(
      { length: 2000 }, () => structuredClone(maximumExhibitor),
    );
    const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
    expect(() => registry.project('tradefair-algolia/v1', raw)).toThrow(
      'TYPED_PROJECTION_TOO_LARGE',
    );
  });
});

const APP_DATABASE_URL = process.env.APP_DATABASE_URL?.trim();
const liveDatabaseIt = APP_DATABASE_URL ? it : it.skip;

function postgresExecutor(database: PrismaClient): PostgresJsonbByteExecutor {
  return {
    $queryRaw<T>(strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<T> {
      return database.$queryRaw<T>(strings, ...values);
    },
  };
}

describe('catalog result projection PostgreSQL JSONB byte gate', () => {
  let database: PrismaClient | undefined;

  beforeAll(async () => {
    if (!APP_DATABASE_URL) return;
    database = new PrismaClient({ datasources: { db: { url: APP_DATABASE_URL } } });
    await database.$connect();
  });

  afterAll(async () => {
    await database?.$disconnect();
  });

  liveDatabaseIt('keeps every representative legal boundary envelope below 128 KiB', async () => {
    if (!database) throw new Error('APP_DATABASE_URL did not produce a database connection');
    const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
    for (const fixture of REPRESENTATIVE_LEGAL_BOUNDARY_FIXTURES) {
      const envelope = registry.project(
        getCatalogResultProjectionSchema(fixture.toolId), fixture.raw,
      );
      const byteLength = await registry.assertPostgresJsonbEnvelopeByteLimit(
        postgresExecutor(database), envelope,
      );
      expect(byteLength, fixture.toolId).toBeLessThanOrEqual(128 * 1024);
    }
  });
});
