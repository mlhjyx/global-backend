import { types } from 'node:util';
import type { ModelResult } from '../model-gateway/types';
import type { TypedProjectionSchema } from './durable-result-strategy';
import { TypedProjectionRegistry } from './typed-projection.registry';
import type { TypedProjectionDefinition } from './typed-projection.types';
type JsonSchema = Readonly<Record<string, unknown>>;
type UnknownRecord = Record<string, unknown>;
export const MODEL_RESULT_TASK_IDS = Object.freeze([
  'company_understanding.extract_claims', 'company_understanding.extract_profile',
  'company_understanding.extract_offerings', 'icp.design', 'discovery.query_plan',
  'taxonomy.normalize', 'discovery.qualify_fit', 'discovery.extract_company',
  'discovery.extract_list', 'contact.find_decision_makers'] as const);
export type ModelResultTaskId = (typeof MODEL_RESULT_TASK_IDS)[number];
export const MODEL_RESULT_PROJECTION_SCHEMAS = Object.freeze({
  'company_understanding.extract_claims': 'understanding-claims/v1',
  'company_understanding.extract_profile': 'understanding-profile/v1',
  'company_understanding.extract_offerings': 'understanding-offerings/v1',
  'icp.design': 'icp-design/v1', 'discovery.query_plan': 'icp-query-plan/v1',
  'taxonomy.normalize': 'taxonomy-code/v1', 'discovery.qualify_fit': 'fit-judgment/v1',
  'discovery.extract_company': 'discovery-extract-company/v1',
  'discovery.extract_list': 'discovery-extract-list/v1', 'contact.find_decision_makers': 'contact-decision-makers/v1',
} satisfies Readonly<Record<ModelResultTaskId, TypedProjectionSchema>>);
const MODEL_RESULT_KEYS = ['data', 'provider', 'model', 'reportedModel', 'modelResolutionSource', 'usage', 'callCount'] as const;
const ICP_ATTRIBUTE_KEYS = [
  'industry', 'sub_industry', 'region', 'country', 'employee_count', 'revenue',
  'certifications', 'keywords', 'tech', 'business_model', 'end_markets', 'product',
  'trade_side'] as const;
const QUERY_FILTER_KEYS = [
  'industry', 'sub_industry', 'country', 'region', 'source_hint', 'area_name',
  'hs_code', 'cpv', 'buyer_country', 'product', 'product_code', 'trade_side',
  'establishment_type', 'iso_country', 'since_days'] as const;
const OFFERING_ATTRIBUTE_KEYS = ['moq', 'lead_time', 'materials', 'params', 'certifications'] as const;
function projectionInvalid(): never {
  throw new Error('MODEL_RESULT_PROJECTION_INVALID');
}
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
    if (error instanceof Error && error.message === 'MODEL_RESULT_PROJECTION_INVALID') throw error;
    projectionInvalid();
  }
}
function denseArray(value: unknown): unknown[] {
  try {
    if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      projectionInvalid();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol')) projectionInvalid();
    for (const key of keys as string[]) {
      if (key === 'length') continue;
      const descriptor = descriptors[key];
      if (!/^(0|[1-9][0-9]*)$/.test(key) || !descriptor?.enumerable || !('value' in descriptor)) {
        projectionInvalid();
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(descriptors, String(index))) projectionInvalid();
    }
    if (keys.length !== value.length + 1) projectionInvalid();
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === 'MODEL_RESULT_PROJECTION_INVALID') throw error;
    projectionInvalid();
  }
}
function field(record: UnknownRecord, name: string): unknown {
  return Object.getOwnPropertyDescriptor(record, name)?.value;
}
function hasField(record: UnknownRecord, name: string): boolean {
  return Object.hasOwn(record, name);
}
function readModelResult(
  raw: unknown,
  allowedDataKeys: readonly string[],
  requiredDataKeys: readonly string[],
): { readonly data: UnknownRecord; readonly provider: unknown; readonly model: unknown } {
  const result = ownDataRecord(raw, MODEL_RESULT_KEYS, ['data', 'provider', 'model']);
  return {
    data: ownDataRecord(field(result, 'data'), allowedDataKeys, requiredDataKeys),
    provider: field(result, 'provider'),
    model: field(result, 'model'),
  };
}
function projectStringArray(value: unknown): unknown[] {
  return denseArray(value).map((entry) => entry);
}
function projectFactValue(value: unknown): unknown {
  if (
    value === null || typeof value === 'string' || typeof value === 'number' ||
    typeof value === 'boolean'
  ) return value;
  if (Array.isArray(value)) {
    return denseArray(value).map((entry) => {
      if (
        typeof entry !== 'string' && typeof entry !== 'number' &&
        typeof entry !== 'boolean' && entry !== null
      ) projectionInvalid();
      return entry;
    });
  }
  projectionInvalid();
}
function projectFactEntries(value: unknown, allowedKeys: readonly string[]): unknown[] {
  const record = ownDataRecord(value, allowedKeys, []);
  return Object.keys(record).sort().map((key) => ({
    key,
    value: projectFactValue(field(record, key)),
  }));
}
function restoreFactValue(value: unknown): unknown {
  return Array.isArray(value) ? value.map((entry) => entry) : value;
}
function restoreFactEntries(value: unknown): UnknownRecord {
  const restored: UnknownRecord = {};
  for (const entry of value as readonly { key: string; value: unknown }[]) {
    Object.defineProperty(restored, entry.key, {
      configurable: true,
      enumerable: true,
      value: restoreFactValue(entry.value),
      writable: true,
    });
  }
  return restored;
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
function optionalObjectSchema(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[] = [],
): JsonSchema {
  return { type: 'object', additionalProperties: false, required, properties };
}
const FACT_SCALAR_SCHEMA: JsonSchema = { oneOf: [
  stringSchema(2000), numberSchema(-1_000_000_000_000_000, 1_000_000_000_000_000),
  { type: 'boolean' }, { type: 'null' },
] };
const FACT_VALUE_SCHEMA: JsonSchema = {
  oneOf: [
    ...FACT_SCALAR_SCHEMA.oneOf as JsonSchema[],
    arraySchema(32, FACT_SCALAR_SCHEMA),
  ],
};
const RULE_SCALAR_SCHEMA: JsonSchema = { oneOf: [
  stringSchema(1000), numberSchema(-1_000_000_000_000_000, 1_000_000_000_000_000),
  { type: 'boolean' }, { type: 'null' },
] };
const RULE_VALUE_SCHEMA: JsonSchema = {
  oneOf: [
    ...RULE_SCALAR_SCHEMA.oneOf as JsonSchema[],
    arraySchema(32, RULE_SCALAR_SCHEMA),
  ],
};
const factEntriesSchema = (keys: readonly string[], value: JsonSchema): JsonSchema => arraySchema(
  32, objectSchema({ key: stringSchema(120, { enum: [...keys] }), value }, ['key', 'value']),
);
function modelResultSchema(data: JsonSchema): JsonSchema {
  return objectSchema({
    data,
    provider: stringSchema(120),
    model: stringSchema(120),
  }, ['data', 'provider', 'model']);
}
function restoreModelResult(
  projected: { readonly provider: string; readonly model: string },
  data: unknown,
): ModelResult<unknown> {
  return { data, provider: projected.provider, model: projected.model };
}
const claimsDefinition: TypedProjectionDefinition<unknown, unknown> = {
  schema: 'understanding-claims/v1',
  jsonSchema: modelResultSchema(objectSchema({
    claims: arraySchema(64, objectSchema({
      type: stringSchema(80),
      statement: stringSchema(4000),
      evidence: stringSchema(2000),
      confidence: numberSchema(0, 1),
    }, ['type', 'statement', 'confidence'])),
  }, ['claims'])),
  project(raw) {
    const result = readModelResult(raw, ['claims'], ['claims']);
    return {
      data: {
        claims: denseArray(field(result.data, 'claims')).map((claim) => {
          const source = ownDataRecord(
            claim, ['type', 'statement', 'evidence', 'confidence'],
            ['type', 'statement', 'confidence'],
          );
          return {
            type: field(source, 'type'),
            statement: field(source, 'statement'),
            ...(hasField(source, 'evidence') ? { evidence: field(source, 'evidence') } : {}),
            confidence: field(source, 'confidence'),
          };
        }),
      },
      provider: result.provider,
      model: result.model,
    };
  },
  restore(projected) {
    const result = projected as {
      data: { claims: readonly UnknownRecord[] }; provider: string; model: string;
    };
    return restoreModelResult(result, {
      claims: result.data.claims.map((claim) => ({
        type: claim.type,
        statement: claim.statement,
        ...(hasField(claim, 'evidence') ? { evidence: claim.evidence } : {}),
        confidence: claim.confidence,
      })),
    });
  },
};
const profileDefinition: TypedProjectionDefinition<unknown, unknown> = {
  schema: 'understanding-profile/v1',
  jsonSchema: modelResultSchema(objectSchema({
    industry: stringSchema(500),
    summary: stringSchema(8000),
  }, ['industry', 'summary'])),
  project(raw) {
    const result = readModelResult(raw, ['industry', 'summary'], ['industry', 'summary']);
    return {
      data: { industry: field(result.data, 'industry'), summary: field(result.data, 'summary') },
      provider: result.provider,
      model: result.model,
    };
  },
  restore(projected) {
    const result = projected as {
      data: { industry: string; summary: string }; provider: string; model: string;
    };
    return restoreModelResult(result, {
      industry: result.data.industry,
      summary: result.data.summary,
    });
  },
};
const offeringSchema = objectSchema({
  name: stringSchema(500),
  description: stringSchema(4000),
  factEntries: factEntriesSchema(OFFERING_ATTRIBUTE_KEYS, RULE_VALUE_SCHEMA),
  evidence: stringSchema(2000),
  confidence: numberSchema(0, 1),
}, ['name', 'confidence']);
const offeringsDefinition: TypedProjectionDefinition<unknown, unknown> = {
  schema: 'understanding-offerings/v1',
  jsonSchema: modelResultSchema(objectSchema({
    offerings: arraySchema(128, offeringSchema),
  }, ['offerings'])),
  project(raw) {
    const result = readModelResult(raw, ['offerings'], ['offerings']);
    return {
      data: {
        offerings: denseArray(field(result.data, 'offerings')).map((offering) => {
          const source = ownDataRecord(
            offering, ['name', 'description', 'attributes', 'evidence', 'confidence'],
            ['name', 'confidence'],
          );
          return {
            name: field(source, 'name'),
            ...(hasField(source, 'description') ? { description: field(source, 'description') } : {}),
            ...(hasField(source, 'attributes')
              ? { factEntries: projectFactEntries(field(source, 'attributes'), OFFERING_ATTRIBUTE_KEYS) }
              : {}),
            ...(hasField(source, 'evidence') ? { evidence: field(source, 'evidence') } : {}),
            confidence: field(source, 'confidence'),
          };
        }),
      },
      provider: result.provider,
      model: result.model,
    };
  },
  restore(projected) {
    const result = projected as {
      data: { offerings: readonly UnknownRecord[] }; provider: string; model: string;
    };
    return restoreModelResult(result, {
      offerings: result.data.offerings.map((offering) => ({
        name: offering.name,
        ...(hasField(offering, 'description') ? { description: offering.description } : {}),
        ...(hasField(offering, 'factEntries')
          ? { attributes: restoreFactEntries(offering.factEntries) }
          : {}),
        ...(hasField(offering, 'evidence') ? { evidence: offering.evidence } : {}),
        confidence: offering.confidence,
      })),
    });
  },
};
const icpDesignDataSchema = objectSchema({
  name: stringSchema(200),
  companyAttributeEntries: factEntriesSchema(ICP_ATTRIBUTE_KEYS, FACT_VALUE_SCHEMA),
  painPoints: arraySchema(8, stringSchema(2000)),
  triggerSignals: arraySchema(8, stringSchema(2000)),
  exclusions: arraySchema(8, stringSchema(2000)),
  valueProps: arraySchema(8, stringSchema(2000)),
  targetMarkets: arraySchema(8, stringSchema(300)),
  personas: arraySchema(8, objectSchema({
    title: stringSchema(200),
    goals: arraySchema(4, stringSchema(500)),
    painPoints: arraySchema(4, stringSchema(500)),
  }, ['title', 'goals', 'painPoints'])),
  buyingCommittee: arraySchema(32, objectSchema({
    role: stringSchema(80),
    title: stringSchema(200),
    concerns: arraySchema(4, stringSchema(500)),
  }, ['role', 'title', 'concerns'])),
  qualificationRules: arraySchema(64, objectSchema({
    kind: stringSchema(20, { enum: ['MUST_HAVE', 'NICE_TO_HAVE', 'EXCLUSION'] }),
    field: stringSchema(200),
    operator: stringSchema(80, {
      enum: ['eq', 'neq', 'in', 'not_in', 'contains', 'not_contains', 'gte', 'lte', 'matches'],
    }),
    value: RULE_VALUE_SCHEMA,
    weight: numberSchema(0, 100),
    rationale: stringSchema(2000),
  }, ['kind', 'field', 'operator', 'value'])),
}, [
  'name', 'companyAttributeEntries', 'painPoints', 'triggerSignals', 'exclusions',
  'valueProps', 'targetMarkets', 'personas', 'buyingCommittee', 'qualificationRules',
]);
const icpDesignDefinition: TypedProjectionDefinition<unknown, unknown> = {
  schema: 'icp-design/v1',
  jsonSchema: modelResultSchema(icpDesignDataSchema),
  project(raw) {
    const dataKeys = [
      'name', 'company_attributes', 'pain_points', 'trigger_signals', 'exclusions',
      'value_props', 'target_markets', 'personas', 'buying_committee',
      'qualification_rules',
    ];
    const result = readModelResult(raw, dataKeys, dataKeys);
    return {
      data: {
        name: field(result.data, 'name'),
        companyAttributeEntries: projectFactEntries(
          field(result.data, 'company_attributes'), ICP_ATTRIBUTE_KEYS,
        ),
        painPoints: projectStringArray(field(result.data, 'pain_points')),
        triggerSignals: projectStringArray(field(result.data, 'trigger_signals')),
        exclusions: projectStringArray(field(result.data, 'exclusions')),
        valueProps: projectStringArray(field(result.data, 'value_props')),
        targetMarkets: projectStringArray(field(result.data, 'target_markets')),
        personas: denseArray(field(result.data, 'personas')).map((persona) => {
          const source = ownDataRecord(persona, ['title', 'goals', 'pain_points'], [
            'title', 'goals', 'pain_points',
          ]);
          return {
            title: field(source, 'title'),
            goals: projectStringArray(field(source, 'goals')),
            painPoints: projectStringArray(field(source, 'pain_points')),
          };
        }),
        buyingCommittee: denseArray(field(result.data, 'buying_committee')).map((buyer) => {
          const source = ownDataRecord(buyer, ['role', 'title', 'concerns'], [
            'role', 'title', 'concerns',
          ]);
          return {
            role: field(source, 'role'),
            title: field(source, 'title'),
            concerns: projectStringArray(field(source, 'concerns')),
          };
        }),
        qualificationRules: denseArray(field(result.data, 'qualification_rules')).map((rule) => {
          const source = ownDataRecord(
            rule, ['kind', 'field', 'operator', 'value', 'weight', 'rationale'],
            ['kind', 'field', 'operator', 'value'],
          );
          return {
            kind: field(source, 'kind'),
            field: field(source, 'field'),
            operator: field(source, 'operator'),
            value: projectFactValue(field(source, 'value')),
            ...(hasField(source, 'weight') ? { weight: field(source, 'weight') } : {}),
            ...(hasField(source, 'rationale') ? { rationale: field(source, 'rationale') } : {}),
          };
        }),
      },
      provider: result.provider,
      model: result.model,
    };
  },
  restore(projected) {
    const result = projected as {
      data: UnknownRecord & {
        companyAttributeEntries: unknown; painPoints: readonly string[];
        triggerSignals: readonly string[]; exclusions: readonly string[];
        valueProps: readonly string[]; targetMarkets: readonly string[];
        personas: readonly UnknownRecord[]; buyingCommittee: readonly UnknownRecord[];
        qualificationRules: readonly UnknownRecord[];
      };
      provider: string; model: string;
    };
    return restoreModelResult(result, {
      name: result.data.name,
      company_attributes: restoreFactEntries(result.data.companyAttributeEntries),
      pain_points: [...result.data.painPoints],
      trigger_signals: [...result.data.triggerSignals],
      exclusions: [...result.data.exclusions],
      value_props: [...result.data.valueProps],
      target_markets: [...result.data.targetMarkets],
      personas: result.data.personas.map((persona) => ({
        title: persona.title,
        goals: [...persona.goals as string[]],
        pain_points: [...persona.painPoints as string[]],
      })),
      buying_committee: result.data.buyingCommittee.map((buyer) => ({
        role: buyer.role,
        title: buyer.title,
        concerns: [...buyer.concerns as string[]],
      })),
      qualification_rules: result.data.qualificationRules.map((rule) => ({
        kind: rule.kind,
        field: rule.field,
        operator: rule.operator,
        value: restoreFactValue(rule.value),
        ...(hasField(rule, 'weight') ? { weight: rule.weight } : {}),
        ...(hasField(rule, 'rationale') ? { rationale: rule.rationale } : {}),
      })),
    });
  },
};
const queryPlanDefinition: TypedProjectionDefinition<unknown, unknown> = {
  schema: 'icp-query-plan/v1',
  jsonSchema: modelResultSchema(objectSchema({
    queries: arraySchema(64, objectSchema({
      sourceClass: stringSchema(80, {
        enum: [
          'trade_data', 'b2b_company_person', 'company_registry',
          'public_intelligence', 'industry_data',
        ],
      }),
      filterEntries: factEntriesSchema(QUERY_FILTER_KEYS, RULE_VALUE_SCHEMA),
      keywords: arraySchema(32, stringSchema(200)),
      rationale: stringSchema(4000),
      priority: numberSchema(1, 10_000, true),
    }, ['sourceClass', 'filterEntries', 'keywords', 'rationale', 'priority'])),
    estimatedVolume: numberSchema(0, 1_000_000_000, true),
  }, ['queries', 'estimatedVolume'])),
  project(raw) {
    const result = readModelResult(raw, ['queries', 'estimated_volume'], [
      'queries', 'estimated_volume',
    ]);
    return {
      data: {
        queries: denseArray(field(result.data, 'queries')).map((query) => {
          const source = ownDataRecord(
            query, ['source_class', 'filters', 'keywords', 'rationale', 'priority'],
            ['source_class', 'filters', 'keywords', 'rationale', 'priority'],
          );
          return {
            sourceClass: field(source, 'source_class'),
            filterEntries: projectFactEntries(field(source, 'filters'), QUERY_FILTER_KEYS),
            keywords: projectStringArray(field(source, 'keywords')),
            rationale: field(source, 'rationale'),
            priority: field(source, 'priority'),
          };
        }),
        estimatedVolume: field(result.data, 'estimated_volume'),
      },
      provider: result.provider,
      model: result.model,
    };
  },
  restore(projected) {
    const result = projected as {
      data: { queries: readonly UnknownRecord[]; estimatedVolume: number };
      provider: string; model: string;
    };
    return restoreModelResult(result, {
      queries: result.data.queries.map((query) => ({
        source_class: query.sourceClass,
        filters: restoreFactEntries(query.filterEntries),
        keywords: [...query.keywords as string[]],
        rationale: query.rationale,
        priority: query.priority,
      })),
      estimated_volume: result.data.estimatedVolume,
    });
  },
};
const taxonomyDefinition: TypedProjectionDefinition<unknown, unknown> = {
  schema: 'taxonomy-code/v1',
  jsonSchema: modelResultSchema(objectSchema({
    code: { type: ['string', 'null'], maxLength: 80 },
  }, ['code'])),
  project(raw) {
    const result = readModelResult(raw, ['code'], ['code']);
    return {
      data: { code: field(result.data, 'code') },
      provider: result.provider,
      model: result.model,
    };
  },
  restore(projected) {
    const result = projected as {
      data: { code: string | null }; provider: string; model: string;
    };
    return restoreModelResult(result, { code: result.data.code });
  },
};
const fitDefinition: TypedProjectionDefinition<unknown, unknown> = {
  schema: 'fit-judgment/v1',
  jsonSchema: modelResultSchema(objectSchema({
    verdict: stringSchema(8, { enum: ['match', 'weak', 'mismatch'] }),
    materialGate: stringSchema(1000),
    roleGate: stringSchema(1000),
    processGate: stringSchema(1000),
    businessModelGate: stringSchema(1000),
    reasons: arraySchema(16, stringSchema(1000)),
  }, ['verdict', 'materialGate', 'roleGate', 'processGate', 'businessModelGate', 'reasons'])),
  project(raw) {
    const dataKeys = [
      'verdict', 'material_gate', 'role_gate', 'process_gate',
      'business_model_gate', 'reasons',
    ];
    const result = readModelResult(raw, dataKeys, dataKeys);
    return {
      data: {
        verdict: field(result.data, 'verdict'),
        materialGate: field(result.data, 'material_gate'),
        roleGate: field(result.data, 'role_gate'),
        processGate: field(result.data, 'process_gate'),
        businessModelGate: field(result.data, 'business_model_gate'),
        reasons: projectStringArray(field(result.data, 'reasons')),
      },
      provider: result.provider,
      model: result.model,
    };
  },
  restore(projected) {
    const result = projected as {
      data: UnknownRecord & { reasons: readonly string[] }; provider: string; model: string;
    };
    return restoreModelResult(result, {
      verdict: result.data.verdict,
      material_gate: result.data.materialGate,
      role_gate: result.data.roleGate,
      process_gate: result.data.processGate,
      business_model_gate: result.data.businessModelGate,
      reasons: [...result.data.reasons],
    });
  },
};
const companyDataProperties: Readonly<Record<string, JsonSchema>> = {
  isCompanySite: { type: 'boolean' },
  name: stringSchema(500),
  country: stringSchema(300),
  industry: stringSchema(300),
  employeeCount: { type: ['integer', 'null'], minimum: 0, maximum: 1_000_000_000 },
  products: arraySchema(32, stringSchema(500)),
  keywords: arraySchema(32, stringSchema(300)),
  evidence: stringSchema(2000),
  confidence: numberSchema(0, 1),
};
const companyDefinition: TypedProjectionDefinition<unknown, unknown> = {
  schema: 'discovery-extract-company/v1',
  jsonSchema: modelResultSchema(optionalObjectSchema(companyDataProperties, ['isCompanySite'])),
  project(raw) {
    const rawKeys = [
      'is_company_site', 'name', 'country', 'industry', 'employee_count',
      'products', 'keywords', 'evidence', 'confidence',
    ];
    const result = readModelResult(raw, rawKeys, ['is_company_site']);
    return {
      data: {
        isCompanySite: field(result.data, 'is_company_site'),
        ...(hasField(result.data, 'name') ? { name: field(result.data, 'name') } : {}),
        ...(hasField(result.data, 'country') ? { country: field(result.data, 'country') } : {}),
        ...(hasField(result.data, 'industry') ? { industry: field(result.data, 'industry') } : {}),
        ...(hasField(result.data, 'employee_count')
          ? { employeeCount: field(result.data, 'employee_count') }
          : {}),
        ...(hasField(result.data, 'products')
          ? { products: projectStringArray(field(result.data, 'products')) }
          : {}),
        ...(hasField(result.data, 'keywords')
          ? { keywords: projectStringArray(field(result.data, 'keywords')) }
          : {}),
        ...(hasField(result.data, 'evidence') ? { evidence: field(result.data, 'evidence') } : {}),
        ...(hasField(result.data, 'confidence')
          ? { confidence: field(result.data, 'confidence') }
          : {}),
      },
      provider: result.provider,
      model: result.model,
    };
  },
  restore(projected) {
    const result = projected as {
      data: UnknownRecord; provider: string; model: string;
    };
    return restoreModelResult(result, {
      is_company_site: result.data.isCompanySite,
      ...(hasField(result.data, 'name') ? { name: result.data.name } : {}),
      ...(hasField(result.data, 'country') ? { country: result.data.country } : {}),
      ...(hasField(result.data, 'industry') ? { industry: result.data.industry } : {}),
      ...(hasField(result.data, 'employeeCount')
        ? { employee_count: result.data.employeeCount }
        : {}),
      ...(hasField(result.data, 'products')
        ? { products: [...result.data.products as string[]] }
        : {}),
      ...(hasField(result.data, 'keywords')
        ? { keywords: [...result.data.keywords as string[]] }
        : {}),
      ...(hasField(result.data, 'evidence') ? { evidence: result.data.evidence } : {}),
      ...(hasField(result.data, 'confidence') ? { confidence: result.data.confidence } : {}),
    });
  },
};
const listDefinition: TypedProjectionDefinition<unknown, unknown> = {
  schema: 'discovery-extract-list/v1',
  jsonSchema: modelResultSchema(optionalObjectSchema({
    isDirectory: { type: 'boolean' },
    listKind: stringSchema(80, {
      enum: ['association_members', 'trade_fair_exhibitors', 'industry_directory', 'other'],
    }),
    companies: arraySchema(128, objectSchema({
      name: stringSchema(500),
      website: stringSchema(2048),
      location: stringSchema(500),
      detailUrl: stringSchema(2048),
    }, ['name'])),
    hasNextPage: { type: 'boolean' },
  }, ['isDirectory', 'companies'])),
  project(raw) {
    const result = readModelResult(
      raw, ['is_directory', 'list_kind', 'companies', 'has_next_page'],
      ['is_directory', 'companies'],
    );
    return {
      data: {
        isDirectory: field(result.data, 'is_directory'),
        ...(hasField(result.data, 'list_kind') ? { listKind: field(result.data, 'list_kind') } : {}),
        companies: denseArray(field(result.data, 'companies')).map((company) => {
          const source = ownDataRecord(
            company, ['name', 'website', 'location', 'detail_url'], ['name'],
          );
          return {
            name: field(source, 'name'),
            ...(hasField(source, 'website') ? { website: field(source, 'website') } : {}),
            ...(hasField(source, 'location') ? { location: field(source, 'location') } : {}),
            ...(hasField(source, 'detail_url') ? { detailUrl: field(source, 'detail_url') } : {}),
          };
        }),
        ...(hasField(result.data, 'has_next_page')
          ? { hasNextPage: field(result.data, 'has_next_page') }
          : {}),
      },
      provider: result.provider,
      model: result.model,
    };
  },
  restore(projected) {
    const result = projected as {
      data: UnknownRecord & { companies: readonly UnknownRecord[] };
      provider: string; model: string;
    };
    return restoreModelResult(result, {
      is_directory: result.data.isDirectory,
      ...(hasField(result.data, 'listKind') ? { list_kind: result.data.listKind } : {}),
      companies: result.data.companies.map((company) => ({
        name: company.name,
        ...(hasField(company, 'website') ? { website: company.website } : {}),
        ...(hasField(company, 'location') ? { location: company.location } : {}),
        ...(hasField(company, 'detailUrl') ? { detail_url: company.detailUrl } : {}),
      })),
      ...(hasField(result.data, 'hasNextPage')
        ? { has_next_page: result.data.hasNextPage }
        : {}),
    });
  },
};
const peopleDefinition: TypedProjectionDefinition<unknown, unknown> = {
  schema: 'contact-decision-makers/v1',
  jsonSchema: modelResultSchema(objectSchema({
    people: arraySchema(64, optionalObjectSchema({
      fullName: stringSchema(500),
      title: stringSchema(500),
      email: stringSchema(320),
      phone: stringSchema(80),
      department: stringSchema(80),
      seniority: stringSchema(80),
      buyingRole: stringSchema(80),
      isTargetRole: { type: 'boolean' },
      evidence: stringSchema(2000),
    }, ['fullName'])),
  }, ['people'])),
  project(raw) {
    const result = readModelResult(raw, ['people'], ['people']);
    return {
      data: {
        people: denseArray(field(result.data, 'people')).map((person) => {
          const source = ownDataRecord(
            person,
            [
              'full_name', 'title', 'email', 'phone', 'department', 'seniority',
              'buying_role', 'is_target_role', 'evidence',
            ],
            ['full_name'],
          );
          return {
            fullName: field(source, 'full_name'),
            ...(hasField(source, 'title') ? { title: field(source, 'title') } : {}),
            ...(hasField(source, 'email') ? { email: field(source, 'email') } : {}),
            ...(hasField(source, 'phone') ? { phone: field(source, 'phone') } : {}),
            ...(hasField(source, 'department') ? { department: field(source, 'department') } : {}),
            ...(hasField(source, 'seniority') ? { seniority: field(source, 'seniority') } : {}),
            ...(hasField(source, 'buying_role') ? { buyingRole: field(source, 'buying_role') } : {}),
            ...(hasField(source, 'is_target_role')
              ? { isTargetRole: field(source, 'is_target_role') }
              : {}),
            ...(hasField(source, 'evidence') ? { evidence: field(source, 'evidence') } : {}),
          };
        }),
      },
      provider: result.provider,
      model: result.model,
    };
  },
  restore(projected) {
    const result = projected as {
      data: { people: readonly UnknownRecord[] }; provider: string; model: string;
    };
    return restoreModelResult(result, {
      people: result.data.people.map((person) => ({
        full_name: person.fullName,
        ...(hasField(person, 'title') ? { title: person.title } : {}),
        ...(hasField(person, 'email') ? { email: person.email } : {}),
        ...(hasField(person, 'phone') ? { phone: person.phone } : {}),
        ...(hasField(person, 'department') ? { department: person.department } : {}),
        ...(hasField(person, 'seniority') ? { seniority: person.seniority } : {}),
        ...(hasField(person, 'buyingRole') ? { buying_role: person.buyingRole } : {}),
        ...(hasField(person, 'isTargetRole') ? { is_target_role: person.isTargetRole } : {}),
        ...(hasField(person, 'evidence') ? { evidence: person.evidence } : {}),
      })),
    });
  },
};
export const MODEL_RESULT_PROJECTION_DEFINITIONS = Object.freeze([
  claimsDefinition,
  profileDefinition,
  offeringsDefinition,
  icpDesignDefinition,
  queryPlanDefinition,
  taxonomyDefinition,
  fitDefinition,
  companyDefinition,
  listDefinition,
  peopleDefinition,
] as const);
export function getModelResultProjectionSchema(taskId: string): TypedProjectionSchema {
  if (!Object.hasOwn(MODEL_RESULT_PROJECTION_SCHEMAS, taskId)) {
    throw new Error('MODEL_RESULT_PROJECTION_TASK_UNKNOWN');
  }
  return MODEL_RESULT_PROJECTION_SCHEMAS[taskId as ModelResultTaskId];
}
export function registerModelResultProjections(
  registry: TypedProjectionRegistry,
): TypedProjectionRegistry {
  for (const definition of MODEL_RESULT_PROJECTION_DEFINITIONS) registry.register(definition);
  return registry;
}
