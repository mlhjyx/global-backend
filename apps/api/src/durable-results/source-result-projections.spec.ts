import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { map510k, mapRegistration } from '../adapters/openfda-api';
import {
  openFdaSearchTool,
  samgovSearchTool,
  tedSearchTool,
} from '../tools/source-tools';
import { smtpRcptProbeTool } from '../tools/builtin-tools';
import type { PostgresJsonbByteExecutor } from './typed-projection.types';
import { TypedProjectionRegistry } from './typed-projection.registry';
import {
  SOURCE_RESULT_PROJECTION_DEFINITIONS,
  SOURCE_RESULT_PROJECTION_SCHEMAS,
  SOURCE_RESULT_TOOL_IDS,
  getSourceResultProjectionSchema,
  registerSourceResultProjections,
} from './source-result-projections';

type JsonRecord = Record<string, unknown>;

interface RawToolResult {
  data: JsonRecord;
  costCents: number;
  degraded?: boolean;
}

interface ProjectionFixture {
  readonly toolId: string;
  readonly schema: string;
  readonly raw: RawToolResult;
}

const URL_2048 = `https://x/${'u'.repeat(2038)}`;

function cloneRaw(raw: RawToolResult): RawToolResult & JsonRecord {
  return structuredClone(raw) as RawToolResult & JsonRecord;
}

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

function deviceFacts(): JsonRecord {
  return {
    deviceName: 'v'.repeat(1000),
    deviceClass: '2',
    medicalSpecialtyDescription: 'Cardiovascular',
    regulationNumber: '870.0000',
  };
}

const TED_RAW: RawToolResult = {
  data: {
    awards: Array.from({ length: 32 }, (_, index) => ({
      publicationNumber: index === 0 ? 'p'.repeat(500) : `award-${index}`,
      publicationDate: index === 0 ? 'd'.repeat(500) : '2026-08-20+02:00',
      noticeType: index === 0 ? 'n'.repeat(500) : 'can-standard',
      formType: index === 0 ? 'f'.repeat(500) : 'award',
      cpvCodes: index === 0
        ? ['c'.repeat(500), ...Array.from({ length: 63 }, () => '42120000')]
        : ['42122430'],
      buyerNames: index === 0
        ? ['b'.repeat(500), ...Array.from({ length: 63 }, () => 'Buyer')]
        : ['Buyer GmbH'],
      buyerCountries: index === 0
        ? ['D'.repeat(500), ...Array.from({ length: 63 }, () => 'DEU')]
        : ['DEU'],
      winners: Array.from({ length: index === 0 ? 32 : 1 }, (_, winnerIndex) => ({
        name: index === 0 && winnerIndex === 0 ? 'w'.repeat(500) : `Winner ${winnerIndex}`,
        country: index === 0 && winnerIndex === 0 ? 'C'.repeat(500) : 'DEU',
        identifier: index === 0 && winnerIndex === 0 ? 'i'.repeat(500) : `DE-${winnerIndex}`,
        internetAddress: index === 0 && winnerIndex === 0 ? URL_2048 : 'https://winner.example/',
        city: index === 0 && winnerIndex === 0 ? 'x'.repeat(500) : 'Berlin',
      })),
    })),
    notices: Array.from({ length: 32 }, (_, index) => ({
      publicationNumber: index === 0 ? 'p'.repeat(500) : `notice-${index}`,
      publicationDate: index === 0 ? 'd'.repeat(500) : '2026-08-20+02:00',
      publicationDateIso: index === 0 ? 'i'.repeat(500) : '2026-08-20T00:00:00+02:00',
      noticeType: index === 0 ? 'n'.repeat(500) : 'cn-standard',
      cpvCodes: index === 0
        ? ['c'.repeat(500), ...Array.from({ length: 63 }, () => '42120000')]
        : ['42122430'],
      buyerNames: index === 0
        ? ['b'.repeat(500), ...Array.from({ length: 63 }, () => 'Buyer')]
        : ['Buyer GmbH'],
      buyerCountries: index === 0
        ? ['D'.repeat(500), ...Array.from({ length: 63 }, () => 'DEU')]
        : ['DEU'],
      deadlines: index === 0
        ? ['d'.repeat(500), ...Array.from({ length: 63 }, () => '2026-10-01')]
        : ['2026-10-01'],
    })),
  },
  costCents: 0,
  degraded: true,
};

const OPENFDA_RAW: RawToolResult = {
  data: {
    establishments: Array.from({ length: 12 }, (_, index) => ({
      registrationNumber: index === 0 ? 'r'.repeat(500) : `REG-${index}`,
      feiNumber: index === 0 ? 'f'.repeat(500) : `FEI-${index}`,
      name: index === 0 ? 'n'.repeat(500) : `Firm ${index}`,
      country: index === 0 ? 'c'.repeat(500) : 'US',
      city: index === 0 ? 'y'.repeat(500) : 'Boston',
      stateCode: index === 0 ? 's'.repeat(500) : 'MA',
      statusCode: index === 0 ? 't'.repeat(500) : '1',
      establishmentTypes: [index === 0 ? 'e'.repeat(500) : 'Manufacturer', ...Array.from({ length: 63 }, () => 'Manufacturer')],
      initialImporter: index % 2 === 0,
      productCodes: [index === 0 ? 'p'.repeat(500) : 'LLZ', ...Array.from({ length: 63 }, () => 'LLZ')],
      deviceFacts: index === 0 ? deviceFacts() : { deviceName: 'Pump' },
      deviceNames: [index === 0 ? 'd'.repeat(500) : 'Pump', ...Array.from({ length: 63 }, () => 'Pump')],
      ownerOperatorNumbers: [index === 0 ? 'o'.repeat(500) : `OO-${index}`, ...Array.from({ length: 63 }, () => 'OO')],
      createdDate: index === 0 ? 'a'.repeat(500) : '2026-08-20',
    })),
    clearances: Array.from({ length: 12 }, (_, index) => ({
      kNumber: index === 0 ? 'k'.repeat(500) : `K-${index}`,
      applicant: index === 0 ? 'a'.repeat(500) : `Applicant ${index}`,
      country: index === 0 ? 'c'.repeat(500) : 'US',
      productCode: index === 0 ? 'p'.repeat(500) : 'LLZ',
      decisionDateIso: index === 0 ? 'd'.repeat(500) : '2026-08-20',
      decisionCode: index === 0 ? 's'.repeat(500) : 'SESE',
      deviceName: index === 0 ? 'n'.repeat(500) : 'Pump',
      deviceFacts: index === 0 ? deviceFacts() : { deviceName: 'Pump' },
    })),
  },
  costCents: 0,
  degraded: true,
};

const SAM_RAW: RawToolResult = {
  data: {
    notices: Array.from({ length: 32 }, (_, index) => ({
      noticeId: index === 0 ? 'i'.repeat(500) : `N-${index}`,
      title: index === 0 ? 't'.repeat(2000) : `Industrial pump ${index}`,
      department: index === 0 ? 'd'.repeat(500) : 'DOD',
      subTier: index === 0 ? 's'.repeat(500) : 'Army',
      office: index === 0 ? 'o'.repeat(500) : 'ACC',
      postedDateIso: index === 0 ? 'p'.repeat(500) : '2026-08-20T00:00:00.000Z',
      naicsCode: index === 0 ? 'n'.repeat(500) : '333911',
      responseDeadlineIso: index === 0 ? 'r'.repeat(500) : null,
      popCountry: index === 0 ? 'c'.repeat(500) : 'USA',
      link: index === 0 ? URL_2048 : `https://sam.gov/opp/N-${index}`,
    })),
  },
  costCents: 0,
  degraded: true,
};

const SMTP_RAW: RawToolResult = {
  data: {
    reachable: false,
    mailFromCode: 250,
    codes: [250, 550, null, 450, 251, 551, 421, 521],
    egressBlocked: 'non_global_address',
  },
  costCents: 0,
  degraded: true,
};

const REPRESENTATIVE_LEGAL_BOUNDARY_FIXTURES: readonly ProjectionFixture[] = [
  { toolId: 'ted.search', schema: 'ted-search/v1', raw: TED_RAW },
  { toolId: 'openfda.search', schema: 'openfda-search/v1', raw: OPENFDA_RAW },
  { toolId: 'samgov.search', schema: 'samgov-search/v1', raw: SAM_RAW },
  { toolId: 'smtp.rcpt_probe', schema: 'smtp-probe-verdict/v1', raw: SMTP_RAW },
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
  for (const child of Array.isArray(value)
    ? value
    : Object.values(value as JsonRecord)) {
    expectSchemaDeeplyFrozen(child, seen);
  }
}

const COMMON_RESULT_BOUNDS = {
  '$.costCents.minimum': 0,
  '$.costCents.maximum': 1_000_000_000,
};

describe('closed source Tool result projections', () => {
  it('locks the exact toolId-to-schema machine map and definition order', () => {
    expect(SOURCE_RESULT_TOOL_IDS).toEqual([
      'ted.search', 'openfda.search', 'samgov.search', 'smtp.rcpt_probe',
    ]);
    expect(SOURCE_RESULT_PROJECTION_SCHEMAS).toEqual({
      'ted.search': 'ted-search/v1',
      'openfda.search': 'openfda-search/v1',
      'samgov.search': 'samgov-search/v1',
      'smtp.rcpt_probe': 'smtp-probe-verdict/v1',
    });
    expect(SOURCE_RESULT_PROJECTION_DEFINITIONS.map((definition) => definition.schema)).toEqual([
      'ted-search/v1', 'openfda-search/v1', 'samgov-search/v1',
      'smtp-probe-verdict/v1',
    ]);
    expect(Object.isFrozen(SOURCE_RESULT_TOOL_IDS)).toBe(true);
    expect(Object.isFrozen(SOURCE_RESULT_PROJECTION_SCHEMAS)).toBe(true);
    expect(Object.isFrozen(SOURCE_RESULT_PROJECTION_DEFINITIONS)).toBe(true);
  });

  it('fails closed for unknown tool IDs, missing registration, and duplicate registration', () => {
    expect(() => getSourceResultProjectionSchema('http.get')).toThrow(
      'SOURCE_RESULT_PROJECTION_TOOL_UNKNOWN',
    );
    expect(() => new TypedProjectionRegistry().project('ted-search/v1', TED_RAW)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
    const registry = new TypedProjectionRegistry();
    registerSourceResultProjections(registry);
    expect(() => registerSourceResultProjections(registry)).toThrow(
      'DURABLE_RESULT_SCHEMA_DUPLICATE',
    );
  });

  it('registers only recursively closed, bounded, ASCII-camelCase, non-sensitive schemas', () => {
    for (const definition of SOURCE_RESULT_PROJECTION_DEFINITIONS) {
      const names: string[] = [];
      expectClosedAndBounded(definition.jsonSchema, names);
      for (const name of names) {
        expect(name).toMatch(/^[a-z][A-Za-z0-9]*$/);
        expect(name).not.toMatch(
          /email|rcpt|localPart|mxHost|prompt|raw|responseBody|credential|accessToken|cookie/i,
        );
      }
    }
  });

  it('deep-freezes every exported definition and every nested JSON Schema object/array', () => {
    for (const definition of SOURCE_RESULT_PROJECTION_DEFINITIONS) {
      expect(Object.isFrozen(definition)).toBe(true);
      expectSchemaDeeplyFrozen(definition.jsonSchema);
    }
  });

  it('prevents schema/project/restore mutation without changing later registration behavior', () => {
    const definition = SOURCE_RESULT_PROJECTION_DEFINITIONS[1];
    const jsonSchema = definition.jsonSchema as JsonRecord;
    const rootProperties = jsonSchema.properties as JsonRecord;
    const dataSchema = rootProperties.data as JsonRecord;
    const dataProperties = dataSchema.properties as JsonRecord;
    const establishments = dataProperties.establishments as JsonRecord;
    const required = jsonSchema.required as unknown[];
    const originalProject = definition.project;
    const originalRestore = definition.restore;
    const originalSchema = definition.schema;
    const originalMaxItems = establishments.maxItems;
    const originalRequired = required[0];
    const outcomes: boolean[] = [];

    const attempt = (
      target: object,
      key: PropertyKey,
      replacement: unknown,
      original: unknown,
    ) => {
      const changed = Reflect.set(target, key, replacement);
      outcomes.push(changed);
      if (changed) Reflect.set(target, key, original);
    };
    attempt(definition as object, 'schema', 'ted-search/v1', originalSchema);
    attempt(definition as object, 'project', () => ({ tampered: true }), originalProject);
    attempt(definition as object, 'restore', () => ({ tampered: true }), originalRestore);
    attempt(establishments, 'maxItems', 999, originalMaxItems);
    attempt(required, '0', 'tampered', originalRequired);

    expect(outcomes).toEqual([false, false, false, false, false]);
    expect(definition.schema).toBe(originalSchema);
    expect(definition.project).toBe(originalProject);
    expect(definition.restore).toBe(originalRestore);
    expect(establishments.maxItems).toBe(originalMaxItems);
    expect(required[0]).toBe(originalRequired);

    const registry = registerSourceResultProjections(new TypedProjectionRegistry());
    expect(registry.restore(registry.project('openfda-search/v1', OPENFDA_RAW)))
      .toEqual(OPENFDA_RAW);
  });

  it.each(REPRESENTATIVE_LEGAL_BOUNDARY_FIXTURES)(
    '$toolId projects and restores its representative legal boundary below 120 KiB',
    (fixture) => {
      const registry = registerSourceResultProjections(new TypedProjectionRegistry());
      registry.freeze();
      const envelope = registry.project(
        getSourceResultProjectionSchema(fixture.toolId), fixture.raw,
      );

      expect(envelope.schema).toBe(fixture.schema);
      expect(Buffer.byteLength(JSON.stringify(envelope), 'utf8')).toBeLessThanOrEqual(120 * 1024);
      expect(registry.restore(envelope)).toEqual(fixture.raw);
      expect(JSON.stringify(envelope)).not.toMatch(
        /buyer@|x-verify-|accessToken|responseBody|cookie|prompt|rcptTo|mxHost/i,
      );
    },
  );

  it('accepts the exact cost maximum and rejects max+1, negative, and fractional costs', () => {
    const registry = registerSourceResultProjections(new TypedProjectionRegistry());
    const maximum = cloneRaw(SMTP_RAW);
    maximum.costCents = 1_000_000_000;
    expect(registry.restore(registry.project('smtp-probe-verdict/v1', maximum))).toEqual(maximum);
    for (const costCents of [1_000_000_001, -1, 0.5]) {
      const raw = cloneRaw(SMTP_RAW);
      raw.costCents = costCents;
      expect(() => registry.project('smtp-probe-verdict/v1', raw), String(costCents)).toThrow(
        'TYPED_PROJECTION_INVALID',
      );
    }
  });

  it.each([
    {
      toolId: 'ted.search',
      schema: 'ted-search/v1' as const,
      raw: {
        data: { awards: [{ cpvCodes: [], buyerNames: [], buyerCountries: [], winners: [] }] },
        costCents: 0,
      },
    },
    {
      toolId: 'openfda.search',
      schema: 'openfda-search/v1' as const,
      raw: {
        data: {
          establishments: [{
            name: 'Firm', establishmentTypes: [], initialImporter: false,
            productCodes: [], deviceNames: [], ownerOperatorNumbers: [],
          }],
        },
        costCents: 0,
      },
    },
    {
      toolId: 'samgov.search',
      schema: 'samgov-search/v1' as const,
      raw: {
        data: { notices: [{
          noticeId: '', title: '', department: '', subTier: '', office: '',
          postedDateIso: null, naicsCode: '', responseDeadlineIso: null,
        }] },
        costCents: 0,
      },
    },
    {
      toolId: 'smtp.rcpt_probe',
      schema: 'smtp-probe-verdict/v1' as const,
      raw: {
        data: { reachable: false, mailFromCode: null, codes: [] },
        costCents: 0,
      },
    },
  ])('$toolId preserves the minimal current output without inventing optional fields', ({ schema, raw }) => {
    const registry = registerSourceResultProjections(new TypedProjectionRegistry());
    expect(registry.restore(registry.project(schema, raw))).toEqual(raw);
  });

  it('rejects the all-leaf-max TED cartesian fixture at the 120 KiB aggregate gate', () => {
    const raw = cloneRaw(TED_RAW);
    const maximumAward = structuredClone((raw.data.awards as JsonRecord[])[0]);
    const maximumNotice = structuredClone((raw.data.notices as JsonRecord[])[0]);
    raw.data.awards = Array.from({ length: 32 }, () => structuredClone(maximumAward));
    raw.data.notices = Array.from({ length: 32 }, () => structuredClone(maximumNotice));
    const registry = registerSourceResultProjections(new TypedProjectionRegistry());

    expect(() => registry.project('ted-search/v1', raw)).toThrow(
      'TYPED_PROJECTION_TOO_LARGE',
    );
  });

  it('locks every TED schema bound exactly', () => {
    expect(bounds(SOURCE_RESULT_PROJECTION_DEFINITIONS[0].jsonSchema)).toEqual({
      ...COMMON_RESULT_BOUNDS,
      '$.data.awards.maxItems': 32,
      '$.data.awards[].publicationNumber.maxLength': 500,
      '$.data.awards[].publicationDate.maxLength': 500,
      '$.data.awards[].noticeType.maxLength': 500,
      '$.data.awards[].formType.maxLength': 500,
      '$.data.awards[].cpvCodes.maxItems': 64,
      '$.data.awards[].cpvCodes[].maxLength': 500,
      '$.data.awards[].buyerNames.maxItems': 64,
      '$.data.awards[].buyerNames[].maxLength': 500,
      '$.data.awards[].buyerCountries.maxItems': 64,
      '$.data.awards[].buyerCountries[].maxLength': 500,
      '$.data.awards[].winners.maxItems': 32,
      '$.data.awards[].winners[].name.maxLength': 500,
      '$.data.awards[].winners[].country.maxLength': 500,
      '$.data.awards[].winners[].identifier.maxLength': 500,
      '$.data.awards[].winners[].internetAddress.maxLength': 2048,
      '$.data.awards[].winners[].city.maxLength': 500,
      '$.data.notices.maxItems': 32,
      '$.data.notices[].publicationNumber.maxLength': 500,
      '$.data.notices[].publicationDate.maxLength': 500,
      '$.data.notices[].publicationDateIso.maxLength': 500,
      '$.data.notices[].noticeType.maxLength': 500,
      '$.data.notices[].cpvCodes.maxItems': 64,
      '$.data.notices[].cpvCodes[].maxLength': 500,
      '$.data.notices[].buyerNames.maxItems': 64,
      '$.data.notices[].buyerNames[].maxLength': 500,
      '$.data.notices[].buyerCountries.maxItems': 64,
      '$.data.notices[].buyerCountries[].maxLength': 500,
      '$.data.notices[].deadlines.maxItems': 64,
      '$.data.notices[].deadlines[].maxLength': 500,
    });
  });

  it('locks every OpenFDA schema bound exactly', () => {
    expect(bounds(SOURCE_RESULT_PROJECTION_DEFINITIONS[1].jsonSchema)).toEqual({
      ...COMMON_RESULT_BOUNDS,
      '$.data.establishments.maxItems': 12,
      '$.data.establishments[].registrationNumber.maxLength': 500,
      '$.data.establishments[].feiNumber.maxLength': 500,
      '$.data.establishments[].name.maxLength': 500,
      '$.data.establishments[].country.maxLength': 500,
      '$.data.establishments[].city.maxLength': 500,
      '$.data.establishments[].stateCode.maxLength': 500,
      '$.data.establishments[].statusCode.maxLength': 500,
      '$.data.establishments[].establishmentTypes.maxItems': 64,
      '$.data.establishments[].establishmentTypes[].maxLength': 500,
      '$.data.establishments[].productCodes.maxItems': 64,
      '$.data.establishments[].productCodes[].maxLength': 500,
      '$.data.establishments[].factEntries.maxItems': 64,
      '$.data.establishments[].factEntries[].key.maxLength': 120,
      '$.data.establishments[].factEntries[].value.maxLength': 1000,
      '$.data.establishments[].deviceNames.maxItems': 64,
      '$.data.establishments[].deviceNames[].maxLength': 500,
      '$.data.establishments[].ownerOperatorNumbers.maxItems': 64,
      '$.data.establishments[].ownerOperatorNumbers[].maxLength': 500,
      '$.data.establishments[].createdDate.maxLength': 500,
      '$.data.clearances.maxItems': 12,
      '$.data.clearances[].kNumber.maxLength': 500,
      '$.data.clearances[].applicant.maxLength': 500,
      '$.data.clearances[].country.maxLength': 500,
      '$.data.clearances[].productCode.maxLength': 500,
      '$.data.clearances[].decisionDateIso.maxLength': 500,
      '$.data.clearances[].decisionCode.maxLength': 500,
      '$.data.clearances[].deviceName.maxLength': 500,
      '$.data.clearances[].factEntries.maxItems': 64,
      '$.data.clearances[].factEntries[].key.maxLength': 120,
      '$.data.clearances[].factEntries[].value.maxLength': 1000,
    });
  });

  it('locks both OpenFDA fact-entry key schemas to the exact authoritative four-key allowlist', () => {
    const root = SOURCE_RESULT_PROJECTION_DEFINITIONS[1].jsonSchema as JsonRecord;
    const data = ((root.properties as JsonRecord).data as JsonRecord);
    const properties = data.properties as JsonRecord;
    const entryKeyEnum = (collection: 'establishments' | 'clearances') => {
      const array = properties[collection] as JsonRecord;
      const item = array.items as JsonRecord;
      const factEntries = (item.properties as JsonRecord).factEntries as JsonRecord;
      const entry = factEntries.items as JsonRecord;
      const key = (entry.properties as JsonRecord).key as JsonRecord;
      return key.enum;
    };
    const expected = [
      'deviceName', 'deviceClass', 'medicalSpecialtyDescription', 'regulationNumber',
    ];
    expect(entryKeyEnum('establishments')).toEqual(expected);
    expect(entryKeyEnum('clearances')).toEqual(expected);
    expect(Object.isFrozen(entryKeyEnum('establishments'))).toBe(true);
    expect(Object.isFrozen(entryKeyEnum('clearances'))).toBe(true);
  });

  it('locks every SAM and SMTP schema bound exactly', () => {
    expect(bounds(SOURCE_RESULT_PROJECTION_DEFINITIONS[2].jsonSchema)).toEqual({
      ...COMMON_RESULT_BOUNDS,
      '$.data.notices.maxItems': 32,
      '$.data.notices[].noticeId.maxLength': 500,
      '$.data.notices[].title.maxLength': 2000,
      '$.data.notices[].department.maxLength': 500,
      '$.data.notices[].subTier.maxLength': 500,
      '$.data.notices[].office.maxLength': 500,
      '$.data.notices[].postedDateIso.maxLength': 500,
      '$.data.notices[].naicsCode.maxLength': 500,
      '$.data.notices[].responseDeadlineIso.maxLength': 500,
      '$.data.notices[].popCountry.maxLength': 500,
      '$.data.notices[].link.maxLength': 2048,
    });
    expect(bounds(SOURCE_RESULT_PROJECTION_DEFINITIONS[3].jsonSchema)).toEqual({
      ...COMMON_RESULT_BOUNDS,
      '$.data.mailFromCode.minimum': 200,
      '$.data.mailFromCode.maximum': 599,
      '$.data.codes.maxItems': 8,
      '$.data.codes[].minimum': 200,
      '$.data.codes[].maximum': 599,
      '$.data.egressBlocked.maxLength': 120,
    });
  });

  it.each([
    ['TED awards maxItems + 1', 'ted.search', TED_RAW, (raw: RawToolResult) => {
      (raw.data.awards as unknown[]).push(structuredClone((raw.data.awards as unknown[])[0]));
    }],
    ['TED winners maxItems + 1', 'ted.search', TED_RAW, (raw: RawToolResult) => {
      const award = (raw.data.awards as JsonRecord[])[0];
      (award.winners as unknown[]).push(structuredClone((award.winners as unknown[])[0]));
    }],
    ['TED nested list maxItems + 1', 'ted.search', TED_RAW, (raw: RawToolResult) => {
      ((raw.data.awards as JsonRecord[])[0].cpvCodes as string[]).push('42120000');
    }],
    ['TED name maxLength + 1', 'ted.search', TED_RAW, (raw: RawToolResult) => {
      ((raw.data.awards as JsonRecord[])[0].winners as JsonRecord[])[0].name = 'w'.repeat(501);
    }],
    ['TED URL maxLength + 1', 'ted.search', TED_RAW, (raw: RawToolResult) => {
      ((raw.data.awards as JsonRecord[])[0].winners as JsonRecord[])[0].internetAddress = 'u'.repeat(2049);
    }],
    ['OpenFDA establishments maxItems + 1', 'openfda.search', OPENFDA_RAW, (raw: RawToolResult) => {
      (raw.data.establishments as unknown[]).push(structuredClone((raw.data.establishments as unknown[])[0]));
    }],
    ['OpenFDA nested list maxItems + 1', 'openfda.search', OPENFDA_RAW, (raw: RawToolResult) => {
      ((raw.data.establishments as JsonRecord[])[0].productCodes as string[]).push('LLZ');
    }],
    ['OpenFDA fact key maxLength + 1', 'openfda.search', OPENFDA_RAW, (raw: RawToolResult) => {
      (raw.data.establishments as JsonRecord[])[0].deviceFacts = { ['k'.repeat(121)]: 'value' };
    }],
    ['OpenFDA fact value maxLength + 1', 'openfda.search', OPENFDA_RAW, (raw: RawToolResult) => {
      (raw.data.establishments as JsonRecord[])[0].deviceFacts = { deviceName: 'v'.repeat(1001) };
    }],
    ['SAM notices maxItems + 1', 'samgov.search', SAM_RAW, (raw: RawToolResult) => {
      (raw.data.notices as unknown[]).push(structuredClone((raw.data.notices as unknown[])[0]));
    }],
    ['SAM title maxLength + 1', 'samgov.search', SAM_RAW, (raw: RawToolResult) => {
      (raw.data.notices as JsonRecord[])[0].title = 't'.repeat(2001);
    }],
    ['SAM link maxLength + 1', 'samgov.search', SAM_RAW, (raw: RawToolResult) => {
      (raw.data.notices as JsonRecord[])[0].link = 'l'.repeat(2049);
    }],
    ['SMTP codes maxItems + 1', 'smtp.rcpt_probe', SMTP_RAW, (raw: RawToolResult) => {
      (raw.data.codes as unknown[]).push(250);
    }],
    ['SMTP code below range', 'smtp.rcpt_probe', SMTP_RAW, (raw: RawToolResult) => {
      (raw.data.codes as unknown[])[0] = 199;
    }],
    ['SMTP code above range', 'smtp.rcpt_probe', SMTP_RAW, (raw: RawToolResult) => {
      raw.data.mailFromCode = 600;
    }],
    ['SMTP reason maxLength + 1', 'smtp.rcpt_probe', SMTP_RAW, (raw: RawToolResult) => {
      raw.data.egressBlocked = 'r'.repeat(121);
    }],
  ] as const)('%s is rejected', (_name, toolId, source, mutate) => {
    const raw = cloneRaw(source);
    mutate(raw);
    const registry = registerSourceResultProjections(new TypedProjectionRegistry());
    expect(() => registry.project(getSourceResultProjectionSchema(toolId), raw)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
  });

  it('rejects a single 64 KiB leaf, unknown fields, and prohibited privacy fields', () => {
    const registry = registerSourceResultProjections(new TypedProjectionRegistry());
    for (const fieldName of ['accessToken', 'responseBody', 'cookie', 'prompt', 'attributes']) {
      const raw = cloneRaw(SAM_RAW);
      raw.data[fieldName] = 'forbidden';
      expect(() => registry.project('samgov-search/v1', raw), fieldName).toThrow(
        'TYPED_PROJECTION_INVALID',
      );
    }
    const unknownNested = cloneRaw(TED_RAW);
    ((unknownNested.data.awards as JsonRecord[])[0].winners as JsonRecord[])[0].contact =
      'buyer@example.test';
    expect(() => registry.project('ted-search/v1', unknownNested)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
    const hugeLeaf = cloneRaw(SAM_RAW);
    (hugeLeaf.data.notices as JsonRecord[])[0].title = 'x'.repeat(64 * 1024);
    expect(() => registry.project('samgov-search/v1', hugeLeaf)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
    const topLevel = cloneRaw(TED_RAW);
    topLevel.responseBody = 'forbidden';
    expect(() => registry.project('ted-search/v1', topLevel)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
  });

  it('rejects Proxy, accessor, sparse, custom-prototype, and open device fact values', () => {
    const registry = registerSourceResultProjections(new TypedProjectionRegistry());
    expect(() => registry.project('ted-search/v1', new Proxy(TED_RAW, {}))).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
    const accessor = cloneRaw(TED_RAW);
    Object.defineProperty(accessor, 'data', { enumerable: true, get: () => TED_RAW.data });
    expect(() => registry.project('ted-search/v1', accessor)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
    const sparse = cloneRaw(TED_RAW);
    sparse.data.awards = new Array(1);
    expect(() => registry.project('ted-search/v1', sparse)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
    const custom = cloneRaw(TED_RAW);
    Object.setPrototypeOf((custom.data.awards as JsonRecord[])[0], { inherited: true });
    expect(() => registry.project('ted-search/v1', custom)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
    const openValue = cloneRaw(OPENFDA_RAW);
    (openValue.data.establishments as JsonRecord[])[0].deviceFacts = {
      deviceName: { unrestricted: true },
    };
    expect(() => registry.project('openfda-search/v1', openValue)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
    const forbiddenFact = cloneRaw(OPENFDA_RAW);
    (forbiddenFact.data.establishments as JsonRecord[])[0].deviceFacts = {
      accessToken: 'secret',
    };
    expect(() => registry.project('openfda-search/v1', forbiddenFact)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
  });

  it('normalizes deviceFacts to sorted entries and refuses digest-valid duplicate or out-of-order restore', () => {
    const registry = registerSourceResultProjections(new TypedProjectionRegistry());
    const raw = cloneRaw(OPENFDA_RAW);
    (raw.data.establishments as JsonRecord[])[0].deviceFacts = {
      regulationNumber: '870.0000',
      deviceName: 'Pump',
      medicalSpecialtyDescription: 'Cardiovascular',
      deviceClass: '2',
    };
    const envelope = registry.project('openfda-search/v1', raw);
    const entries = (((envelope.data as JsonRecord).data as JsonRecord)
      .establishments as JsonRecord[])[0].factEntries as JsonRecord[];
    expect(entries.map((entry) => entry.key)).toEqual([
      'deviceClass', 'deviceName', 'medicalSpecialtyDescription', 'regulationNumber',
    ]);

    const duplicate = structuredClone(envelope) as typeof envelope;
    const duplicateEntries = (((duplicate.data as JsonRecord).data as JsonRecord)
      .establishments as JsonRecord[])[0].factEntries as JsonRecord[];
    duplicateEntries[1] = structuredClone(duplicateEntries[0]);
    expect(() => registry.restore(resignEnvelope(duplicate))).toThrow(
      'TYPED_PROJECTION_INVALID',
    );

    const outOfOrder = structuredClone(envelope) as typeof envelope;
    const outOfOrderEntries = (((outOfOrder.data as JsonRecord).data as JsonRecord)
      .establishments as JsonRecord[])[0].factEntries as JsonRecord[];
    [outOfOrderEntries[0], outOfOrderEntries[1]] = [
      outOfOrderEntries[1], outOfOrderEntries[0],
    ];
    expect(() => registry.restore(resignEnvelope(outOfOrder))).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
  });

  it('keeps the OpenFDA fact-entry schema at 64 but rejects a digest-valid max+1 array', () => {
    const registry = registerSourceResultProjections(new TypedProjectionRegistry());
    const envelope = registry.project('openfda-search/v1', OPENFDA_RAW);
    const tampered = structuredClone(envelope) as typeof envelope;
    const establishment = ((((tampered.data as JsonRecord).data as JsonRecord)
      .establishments as JsonRecord[])[0]);
    establishment.factEntries = Array.from({ length: 65 }, () => ({
      key: 'deviceName', value: 'Pump',
    }));
    expect(() => registry.restore(resignEnvelope(tampered))).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
  });

  it('accepts actual adapter partial deviceFacts and omits exactly-undefined keys', () => {
    const establishment = mapRegistration({
      registration: {
        name: 'Pump Inc', registration_number: 'REG-1', fei_number: 'FEI-1',
        iso_country_code: 'US', initial_importer_flag: 'N',
      },
      establishment_type: ['Manufacturer'],
      products: [{
        product_code: 'LLZ', owner_operator_number: 'OO-1',
        openfda: { device_name: ['Pump'] },
      }],
    }, ['LLZ']);
    const clearance = map510k({
      k_number: 'K123456', applicant: 'Pump Inc', country_code: 'US',
      product_code: 'LLZ', decision_date: '20260820', decision_code: 'SESE',
      device_name: 'Pump', openfda: { device_name: ['Pump'] },
    });
    expect(establishment).not.toBeNull();
    expect(clearance).not.toBeNull();
    expect(Object.hasOwn(establishment!.deviceFacts!, 'deviceClass')).toBe(true);
    expect(establishment!.deviceFacts!.deviceClass).toBeUndefined();
    expect(Object.hasOwn(clearance!.deviceFacts!, 'regulationNumber')).toBe(true);
    expect(clearance!.deviceFacts!.regulationNumber).toBeUndefined();

    const replay = openFdaSearchTool.durableReplayResult!({
      data: { establishments: [establishment!], clearances: [clearance!] },
      costCents: 0,
    });
    const registry = registerSourceResultProjections(new TypedProjectionRegistry());
    const restored = registry.restore(
      registry.project('openfda-search/v1', replay),
    ) as RawToolResult;
    expect(restored).toEqual(jsonRoundTrip(replay));
    const restoredEstablishment = (restored.data.establishments as JsonRecord[])[0];
    const restoredClearance = (restored.data.clearances as JsonRecord[])[0];
    expect(restoredEstablishment.deviceFacts).toEqual({ deviceName: 'Pump' });
    expect(restoredClearance.deviceFacts).toEqual({ deviceName: 'Pump' });
    expect(Object.hasOwn(restoredEstablishment.deviceFacts as object, 'deviceClass')).toBe(false);
    expect(Object.hasOwn(restoredClearance.deviceFacts as object, 'regulationNumber')).toBe(false);
  });

  it.each([
    'primaryContactEmail',
    'responseBodySnippet',
    'rawResponseText',
    'apiCredentialValue',
    'systemPromptText',
  ])('rejects non-authoritative OpenFDA fact key %s in project and digest-valid restore', (key) => {
    const registry = registerSourceResultProjections(new TypedProjectionRegistry());
    const raw = cloneRaw(OPENFDA_RAW);
    (raw.data.establishments as JsonRecord[])[0].deviceFacts = {
      deviceName: 'Pump',
      [key]: 'forbidden',
    };
    expect(() => registry.project('openfda-search/v1', raw)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );

    const envelope = registry.project('openfda-search/v1', OPENFDA_RAW);
    const tampered = structuredClone(envelope) as typeof envelope;
    const entries = (((tampered.data as JsonRecord).data as JsonRecord)
      .establishments as JsonRecord[])[0].factEntries as JsonRecord[];
    entries[0].key = key;
    expect(() => registry.restore(resignEnvelope(tampered))).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
  });

  it('rejects SMTP reason text that could carry an email, domain, or free-form evidence', () => {
    const registry = registerSourceResultProjections(new TypedProjectionRegistry());
    for (const reason of [
      'buyer@acme.example', 'blocked:acme.example', 'reason with spaces',
      'non_global_address\nRCPT TO buyer@example.test',
    ]) {
      const raw = cloneRaw(SMTP_RAW);
      raw.data.egressBlocked = reason;
      expect(() => registry.project('smtp-probe-verdict/v1', raw), reason).toThrow(
        'TYPED_PROJECTION_INVALID',
      );
    }
    const envelope = registry.project('smtp-probe-verdict/v1', SMTP_RAW);
    const tampered = structuredClone(envelope) as typeof envelope;
    (((tampered.data as JsonRecord).data as JsonRecord)).egressBlocked =
      'buyer@acme.example';
    expect(() => registry.restore(resignEnvelope(tampered))).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
  });

  it('accepts current Tool callback outputs without replacing those callbacks', () => {
    const registry = registerSourceResultProjections(new TypedProjectionRegistry());
    const current = [
      [tedSearchTool, TED_RAW],
      [openFdaSearchTool, OPENFDA_RAW],
      [samgovSearchTool, SAM_RAW],
      [smtpRcptProbeTool, SMTP_RAW],
    ] as const;
    for (const [tool, result] of current) {
      expect(tool.durableReplayResult).toBeTypeOf('function');
      const replay = tool.durableReplayResult!(result as never);
      expect(replay).not.toBeNull();
      const envelope = registry.project(
        getSourceResultProjectionSchema(tool.id), replay,
      );
      expect(registry.restore(envelope)).toEqual(jsonRoundTrip(replay));
    }
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

describe('source result projection PostgreSQL JSONB byte gate', () => {
  let database: PrismaClient | undefined;

  beforeAll(async () => {
    if (!APP_DATABASE_URL) return;
    database = new PrismaClient({ datasources: { db: { url: APP_DATABASE_URL } } });
    await database.$connect();
  });

  afterAll(async () => {
    await database?.$disconnect();
  });

  liveDatabaseIt('keeps all representative legal boundary envelopes below 128 KiB', async () => {
    if (!database) throw new Error('APP_DATABASE_URL did not produce a database connection');
    const registry = registerSourceResultProjections(new TypedProjectionRegistry());
    for (const fixture of REPRESENTATIVE_LEGAL_BOUNDARY_FIXTURES) {
      const envelope = registry.project(
        getSourceResultProjectionSchema(fixture.toolId), fixture.raw,
      );
      const byteLength = await registry.assertPostgresJsonbEnvelopeByteLimit(
        postgresExecutor(database), envelope,
      );
      expect(byteLength, fixture.toolId).toBeLessThanOrEqual(128 * 1024);
    }
  });
});
