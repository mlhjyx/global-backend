import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  MODEL_RESULT_PROJECTION_DEFINITIONS,
} from './model-result-projections';
import type { TypedProjectionSchema } from './durable-result-strategy';

type JsonRecord = Record<string, unknown>;
type NumericBounds = Readonly<{
  maxLength?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
}>;

const COMMON_MODEL_METADATA_BOUNDS: Readonly<Record<string, NumericBounds>> = {
  reportedModel: { maxLength: 120 },
  modelResolutionSource: { maxLength: 40 },
  'usage.inputTokens': { minimum: 0, maximum: 1_000_000_000 },
  'usage.outputTokens': { minimum: 0, maximum: 1_000_000_000 },
  'usage.costUsd': { minimum: 0, maximum: 1_000_000_000 },
  'usage.gatewaySettlements': { maxItems: 16 },
  'usage.gatewaySettlements[].oneOf[0].status': { maxLength: 16 },
  'usage.gatewaySettlements[].oneOf[0].requestId': { maxLength: 120 },
  'usage.gatewaySettlements[].oneOf[0].resolverId': { maxLength: 120 },
  'usage.gatewaySettlements[].oneOf[0].alias': { maxLength: 120 },
  'usage.gatewaySettlements[].oneOf[0].protocol': { maxLength: 40 },
  'usage.gatewaySettlements[].oneOf[0].channelId': { minimum: 0, maximum: 1_000_000_000 },
  'usage.gatewaySettlements[].oneOf[0].basis': { maxLength: 40 },
  'usage.gatewaySettlements[].oneOf[0].quota': { minimum: 0, maximum: 1_000_000_000 },
  'usage.gatewaySettlements[].oneOf[0].costMicrousd': { minimum: 0, maximum: 1_000_000_000_000_000 },
  'usage.gatewaySettlements[].oneOf[0].inputTokens': { minimum: 0, maximum: 1_000_000_000 },
  'usage.gatewaySettlements[].oneOf[0].outputTokens': { minimum: 0, maximum: 1_000_000_000 },
  'usage.gatewaySettlements[].oneOf[1].status': { maxLength: 16 },
  'usage.gatewaySettlements[].oneOf[1].requestId.oneOf[0]': { maxLength: 120 },
  'usage.gatewaySettlements[].oneOf[1].resolverId': { maxLength: 120 },
  'usage.gatewaySettlements[].oneOf[1].reason': { maxLength: 40 },
  callCount: { minimum: 0, maximum: 100 },
};

const EXPECTED_BOUNDS: Readonly<Partial<Record<
  TypedProjectionSchema,
  Readonly<Record<string, NumericBounds>>
>>> = {
  'understanding-claims/v1': {
    'data.claims': { maxItems: 64 },
    'data.claims[].type': { maxLength: 80 },
    'data.claims[].statement': { maxLength: 4000 },
    'data.claims[].evidence': { maxLength: 2000 },
    'data.claims[].confidence': { minimum: 0, maximum: 1 },
    provider: { maxLength: 120 },
    model: { maxLength: 120 },
    ...COMMON_MODEL_METADATA_BOUNDS,
  },
  'understanding-profile/v1': {
    'data.industry': { maxLength: 500 },
    'data.summary': { maxLength: 8000 },
    provider: { maxLength: 120 },
    model: { maxLength: 120 },
    ...COMMON_MODEL_METADATA_BOUNDS,
  },
  'understanding-offerings/v1': {
    'data.offerings': { maxItems: 128 },
    'data.offerings[].name': { maxLength: 500 },
    'data.offerings[].description': { maxLength: 4000 },
    'data.offerings[].factEntries': { maxItems: 32 },
    'data.offerings[].factEntries[].key': { maxLength: 120 },
    'data.offerings[].factEntries[].value.oneOf[0]': { maxLength: 1000 },
    'data.offerings[].factEntries[].value.oneOf[1]': {
      minimum: -1_000_000_000_000_000, maximum: 1_000_000_000_000_000,
    },
    'data.offerings[].factEntries[].value.oneOf[4]': { maxItems: 32 },
    'data.offerings[].factEntries[].value.oneOf[4][].oneOf[0]': { maxLength: 1000 },
    'data.offerings[].factEntries[].value.oneOf[4][].oneOf[1]': {
      minimum: -1_000_000_000_000_000, maximum: 1_000_000_000_000_000,
    },
    'data.offerings[].evidence': { maxLength: 2000 },
    'data.offerings[].confidence': { minimum: 0, maximum: 1 },
    provider: { maxLength: 120 },
    model: { maxLength: 120 },
    ...COMMON_MODEL_METADATA_BOUNDS,
  },
  'icp-design/v1': {
    'data.name': { maxLength: 200 },
    'data.companyAttributeEntries': { maxItems: 32 },
    'data.companyAttributeEntries[].key': { maxLength: 120 },
    'data.companyAttributeEntries[].value.oneOf[0]': { maxLength: 2000 },
    'data.companyAttributeEntries[].value.oneOf[1]': {
      minimum: -1_000_000_000_000_000, maximum: 1_000_000_000_000_000,
    },
    'data.companyAttributeEntries[].value.oneOf[4]': { maxItems: 32 },
    'data.companyAttributeEntries[].value.oneOf[4][].oneOf[0]': { maxLength: 2000 },
    'data.companyAttributeEntries[].value.oneOf[4][].oneOf[1]': {
      minimum: -1_000_000_000_000_000, maximum: 1_000_000_000_000_000,
    },
    'data.painPoints': { maxItems: 8 },
    'data.painPoints[]': { maxLength: 2000 },
    'data.triggerSignals': { maxItems: 8 },
    'data.triggerSignals[]': { maxLength: 2000 },
    'data.exclusions': { maxItems: 8 },
    'data.exclusions[]': { maxLength: 2000 },
    'data.valueProps': { maxItems: 8 },
    'data.valueProps[]': { maxLength: 2000 },
    'data.targetMarkets': { maxItems: 8 },
    'data.targetMarkets[]': { maxLength: 300 },
    'data.personas': { maxItems: 8 },
    'data.personas[].title': { maxLength: 200 },
    'data.personas[].goals': { maxItems: 4 },
    'data.personas[].goals[]': { maxLength: 500 },
    'data.personas[].painPoints': { maxItems: 4 },
    'data.personas[].painPoints[]': { maxLength: 500 },
    'data.buyingCommittee': { maxItems: 32 },
    'data.buyingCommittee[].role': { maxLength: 80 },
    'data.buyingCommittee[].title': { maxLength: 200 },
    'data.buyingCommittee[].concerns': { maxItems: 4 },
    'data.buyingCommittee[].concerns[]': { maxLength: 500 },
    'data.qualificationRules': { maxItems: 64 },
    'data.qualificationRules[].kind': { maxLength: 20 },
    'data.qualificationRules[].field': { maxLength: 200 },
    'data.qualificationRules[].operator': { maxLength: 80 },
    'data.qualificationRules[].value.oneOf[0]': { maxLength: 1000 },
    'data.qualificationRules[].value.oneOf[1]': {
      minimum: -1_000_000_000_000_000, maximum: 1_000_000_000_000_000,
    },
    'data.qualificationRules[].value.oneOf[4]': { maxItems: 32 },
    'data.qualificationRules[].value.oneOf[4][].oneOf[0]': { maxLength: 1000 },
    'data.qualificationRules[].value.oneOf[4][].oneOf[1]': {
      minimum: -1_000_000_000_000_000, maximum: 1_000_000_000_000_000,
    },
    'data.qualificationRules[].weight': { minimum: 0, maximum: 100 },
    'data.qualificationRules[].rationale': { maxLength: 2000 },
    provider: { maxLength: 120 },
    model: { maxLength: 120 },
    ...COMMON_MODEL_METADATA_BOUNDS,
  },
  'icp-query-plan/v1': {
    'data.queries': { maxItems: 64 },
    'data.queries[].sourceClass': { maxLength: 80 },
    'data.queries[].filterEntries': { maxItems: 32 },
    'data.queries[].filterEntries[].key': { maxLength: 120 },
    'data.queries[].filterEntries[].value.oneOf[0]': { maxLength: 1000 },
    'data.queries[].filterEntries[].value.oneOf[1]': {
      minimum: -1_000_000_000_000_000, maximum: 1_000_000_000_000_000,
    },
    'data.queries[].filterEntries[].value.oneOf[4]': { maxItems: 32 },
    'data.queries[].filterEntries[].value.oneOf[4][].oneOf[0]': { maxLength: 1000 },
    'data.queries[].filterEntries[].value.oneOf[4][].oneOf[1]': {
      minimum: -1_000_000_000_000_000, maximum: 1_000_000_000_000_000,
    },
    'data.queries[].keywords': { maxItems: 32 },
    'data.queries[].keywords[]': { maxLength: 200 },
    'data.queries[].rationale': { maxLength: 4000 },
    'data.queries[].priority': { minimum: 1, maximum: 10_000 },
    'data.estimatedVolume': { minimum: 0, maximum: 1_000_000_000 },
    provider: { maxLength: 120 },
    model: { maxLength: 120 },
    ...COMMON_MODEL_METADATA_BOUNDS,
  },
  'taxonomy-code/v1': {
    'data.code': { maxLength: 80 },
    provider: { maxLength: 120 },
    model: { maxLength: 120 },
    ...COMMON_MODEL_METADATA_BOUNDS,
  },
  'fit-judgment/v1': {
    'data.verdict': { maxLength: 8 },
    'data.materialGate': { maxLength: 1000 },
    'data.roleGate': { maxLength: 1000 },
    'data.processGate': { maxLength: 1000 },
    'data.businessModelGate': { maxLength: 1000 },
    'data.reasons': { maxItems: 16 },
    'data.reasons[]': { maxLength: 1000 },
    provider: { maxLength: 120 },
    model: { maxLength: 120 },
    ...COMMON_MODEL_METADATA_BOUNDS,
  },
  'discovery-extract-company/v1': {
    'data.name': { maxLength: 500 },
    'data.country': { maxLength: 300 },
    'data.industry': { maxLength: 300 },
    'data.employeeCount': { minimum: 0, maximum: 1_000_000_000 },
    'data.products': { maxItems: 32 },
    'data.products[]': { maxLength: 500 },
    'data.keywords': { maxItems: 32 },
    'data.keywords[]': { maxLength: 300 },
    'data.evidence': { maxLength: 2000 },
    'data.confidence': { minimum: 0, maximum: 1 },
    provider: { maxLength: 120 },
    model: { maxLength: 120 },
    ...COMMON_MODEL_METADATA_BOUNDS,
  },
  'discovery-extract-list/v1': {
    'data.listKind': { maxLength: 80 },
    'data.companies': { maxItems: 128 },
    'data.companies[].name': { maxLength: 500 },
    'data.companies[].website': { maxLength: 2048 },
    'data.companies[].location': { maxLength: 500 },
    'data.companies[].detailUrl': { maxLength: 2048 },
    provider: { maxLength: 120 },
    model: { maxLength: 120 },
    ...COMMON_MODEL_METADATA_BOUNDS,
  },
  'contact-decision-makers/v1': {
    'data.people': { maxItems: 25 },
    'data.people[].fullName': { maxLength: 500 },
    'data.people[].title': { maxLength: 500 },
    'data.people[].email': { maxLength: 320 },
    'data.people[].phone': { maxLength: 80 },
    'data.people[].department': { maxLength: 80 },
    'data.people[].seniority': { maxLength: 80 },
    'data.people[].buyingRole': { maxLength: 80 },
    'data.people[].evidence': { maxLength: 2000 },
    provider: { maxLength: 120 },
    model: { maxLength: 120 },
    ...COMMON_MODEL_METADATA_BOUNDS,
  },
};

function collectBounds(
  node: JsonRecord,
  path = '',
  result: Record<string, NumericBounds> = {},
): Record<string, NumericBounds> {
  const bounds: Record<string, number> = {};
  for (const key of ['maxLength', 'maxItems', 'minimum', 'maximum']) {
    if (typeof node[key] === 'number') bounds[key] = node[key] as number;
  }
  if (Object.keys(bounds).length > 0) result[path] = bounds;
  if (node.properties && typeof node.properties === 'object') {
    for (const [key, child] of Object.entries(node.properties as JsonRecord)) {
      collectBounds(child as JsonRecord, path ? `${path}.${key}` : key, result);
    }
  }
  if (node.items && typeof node.items === 'object') {
    collectBounds(node.items as JsonRecord, `${path}[]`, result);
  }
  for (const combination of ['oneOf', 'anyOf', 'allOf']) {
    if (!Array.isArray(node[combination])) continue;
    (node[combination] as JsonRecord[]).forEach((branch, index) => {
      collectBounds(branch, `${path}.${combination}[${index}]`, result);
    });
  }
  return result;
}

function definition(schema: TypedProjectionSchema): JsonRecord {
  const found = MODEL_RESULT_PROJECTION_DEFINITIONS.find((entry) => entry.schema === schema);
  if (!found) throw new Error(`missing definition ${schema}`);
  return found.jsonSchema as JsonRecord;
}

function schemaNode(schema: TypedProjectionSchema, path: string): JsonRecord {
  let node = definition(schema);
  const tokens = path.match(/oneOf\[\d+\]|anyOf\[\d+\]|allOf\[\d+\]|\[\]|[^.[\]]+/g) ?? [];
  for (const token of tokens) {
    if (token === '[]') {
      node = node.items as JsonRecord;
      continue;
    }
    const combination = token.match(/^(oneOf|anyOf|allOf)\[(\d+)\]$/);
    if (combination) {
      node = (node[combination[1]] as JsonRecord[])[Number(combination[2])];
      continue;
    }
    node = (node.properties as JsonRecord)[token] as JsonRecord;
  }
  return node;
}

function validates(schema: TypedProjectionSchema, path: string, value: unknown): boolean {
  return new Ajv({ strict: false }).compile(schemaNode(schema, path))(value) as boolean;
}

describe('model result projection exact literal bound lock', () => {
  it.each(MODEL_RESULT_PROJECTION_DEFINITIONS)(
    '$schema matches every independently enumerated maxLength/maxItems/minimum/maximum',
    ({ schema, jsonSchema }) => {
      expect(collectBounds(jsonSchema as JsonRecord)).toEqual(EXPECTED_BOUNDS[schema]);
    },
  );

  it.each(MODEL_RESULT_PROJECTION_DEFINITIONS)(
    '$schema accepts provider/model length 120 and rejects 121',
    ({ schema }) => {
      for (const path of ['provider', 'model']) {
        expect(validates(schema, path, 'x'.repeat(120)), path).toBe(true);
        expect(validates(schema, path, 'x'.repeat(121)), path).toBe(false);
      }
    },
  );

  it.each([
    ['fit-judgment/v1', 'data.verdict', 'mismatch', 'x'.repeat(9)],
    ['icp-design/v1', 'data.qualificationRules[].kind', 'MUST_HAVE', 'x'.repeat(21)],
    ['understanding-claims/v1', 'data.claims[].type', 'x'.repeat(80), 'x'.repeat(81)],
    ['taxonomy-code/v1', 'data.code', 'x'.repeat(80), 'x'.repeat(81)],
    ['icp-design/v1', 'data.name', 'x'.repeat(200), 'x'.repeat(201)],
    ['discovery-extract-company/v1', 'data.country', 'x'.repeat(300), 'x'.repeat(301)],
    ['contact-decision-makers/v1', 'data.people[].email', 'x'.repeat(320), 'x'.repeat(321)],
    ['understanding-profile/v1', 'data.industry', 'x'.repeat(500), 'x'.repeat(501)],
    ['fit-judgment/v1', 'data.materialGate', 'x'.repeat(1000), 'x'.repeat(1001)],
    ['understanding-claims/v1', 'data.claims[].evidence', 'x'.repeat(2000), 'x'.repeat(2001)],
    ['discovery-extract-list/v1', 'data.companies[].website', 'x'.repeat(2048), 'x'.repeat(2049)],
    ['understanding-claims/v1', 'data.claims[].statement', 'x'.repeat(4000), 'x'.repeat(4001)],
    ['understanding-profile/v1', 'data.summary', 'x'.repeat(8000), 'x'.repeat(8001)],
  ] as const)(
    '%s %s accepts its exact legal string boundary and rejects max + 1',
    (schema, path, legal, over) => {
      expect(validates(schema, path, legal)).toBe(true);
      expect(validates(schema, path, over)).toBe(false);
    },
  );

  it.each([
    ['icp-design/v1', 'data.personas[].goals', 'goal', 4],
    ['icp-design/v1', 'data.personas[].painPoints', 'pain', 4],
    ['icp-design/v1', 'data.buyingCommittee[].concerns', 'concern', 4],
    ['icp-design/v1', 'data.painPoints', 'pain', 8],
    ['fit-judgment/v1', 'data.reasons', 'reason', 16],
    ['icp-design/v1', 'data.companyAttributeEntries[].value.oneOf[4]', 'value', 32],
  ] as const)(
    '%s %s accepts exact scalar-list count %i and rejects count + 1',
    (schema, path, item, maximum) => {
      expect(validates(schema, path, Array.from({ length: maximum }, () => item))).toBe(true);
      expect(validates(schema, path, Array.from({ length: maximum + 1 }, () => item))).toBe(false);
    },
  );

  it('locks the fact-entry structural max at 32 while restore separately enforces unique sorted keys', () => {
    const path = 'data.offerings[].factEntries';
    const entry = { key: 'moq', value: '100' };
    expect(validates(
      'understanding-offerings/v1', path, Array.from({ length: 32 }, () => entry),
    )).toBe(true);
    expect(validates(
      'understanding-offerings/v1', path, Array.from({ length: 33 }, () => entry),
    )).toBe(false);
  });

  it.each([
    ['understanding-claims/v1', 'data.claims', { type: 'capability', statement: 's', confidence: 1 }, 64],
    ['icp-design/v1', 'data.qualificationRules', {
      kind: 'MUST_HAVE', field: 'industry', operator: 'eq', value: 'pump',
    }, 64],
    ['icp-query-plan/v1', 'data.queries', {
      sourceClass: 'public_intelligence', filterEntries: [], keywords: [], rationale: 'r', priority: 1,
    }, 64],
    ['contact-decision-makers/v1', 'data.people', { fullName: 'Ada' }, 25],
    ['understanding-offerings/v1', 'data.offerings', { name: 'Pump', confidence: 1 }, 128],
    ['discovery-extract-list/v1', 'data.companies', { name: 'Acme' }, 128],
  ] as const)(
    '%s %s accepts exact object-array count %i and rejects count + 1',
    (schema, path, item, maximum) => {
      expect(validates(schema, path, Array.from({ length: maximum }, () => item))).toBe(true);
      expect(validates(schema, path, Array.from({ length: maximum + 1 }, () => item))).toBe(false);
    },
  );

  it.each([
    ['icp-design/v1', 'data.companyAttributeEntries[].value.oneOf[1]', -1_000_000_000_000_000, 1_000_000_000_000_000, 1],
    ['understanding-claims/v1', 'data.claims[].confidence', 0, 1, 0.01],
    ['icp-design/v1', 'data.qualificationRules[].weight', 0, 100, 1],
    ['icp-query-plan/v1', 'data.queries[].priority', 1, 10_000, 1],
    ['icp-query-plan/v1', 'data.estimatedVolume', 0, 1_000_000_000, 1],
    ['discovery-extract-company/v1', 'data.employeeCount', 0, 1_000_000_000, 1],
  ] as const)(
    '%s %s accepts exact numeric endpoints and rejects both sides',
    (schema, path, minimum, maximum, delta) => {
      expect(validates(schema, path, minimum)).toBe(true);
      expect(validates(schema, path, maximum)).toBe(true);
      expect(validates(schema, path, minimum - delta)).toBe(false);
      expect(validates(schema, path, maximum + delta)).toBe(false);
    },
  );

  it.each([
    ['icp-query-plan/v1', 'data.queries[].priority'],
    ['icp-query-plan/v1', 'data.estimatedVolume'],
    ['discovery-extract-company/v1', 'data.employeeCount'],
  ] as const)('%s %s rejects a fractional value at its integer boundary', (schema, path) => {
    expect(validates(schema, path, 1.5)).toBe(false);
  });
});
