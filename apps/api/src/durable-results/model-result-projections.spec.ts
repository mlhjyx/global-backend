import { PrismaClient } from '@prisma/client';
import Ajv from 'ajv';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTask } from '../ai-tasks/task-registry';
import type { PostgresJsonbByteExecutor } from './typed-projection.types';
import { TypedProjectionRegistry } from './typed-projection.registry';
import {
  MODEL_RESULT_PROJECTION_DEFINITIONS,
  MODEL_RESULT_PROJECTION_SCHEMAS,
  MODEL_RESULT_TASK_IDS,
  getModelResultProjectionSchema,
  registerModelResultProjections,
} from './model-result-projections';

type JsonRecord = Record<string, unknown>;

interface RawModelResult {
  data: JsonRecord;
  provider: string;
  model: string;
  reportedModel?: string;
  modelResolutionSource?: string;
  usage?: JsonRecord;
  callCount?: number;
}

interface InvalidFixture {
  readonly name: string;
  readonly raw: RawModelResult & JsonRecord;
  readonly prewire: boolean;
}

interface ProjectionFixture {
  readonly taskId: string;
  readonly schema: string;
  readonly raw: RawModelResult;
  readonly restored: RawModelResult;
  readonly invalid: readonly InvalidFixture[];
}

const PROVIDER = 'p'.repeat(120);
const MODEL = 'm'.repeat(120);
const KNOWN_MODEL_METADATA = {
  reportedModel: 'upstream-model',
  modelResolutionSource: 'upstream_response',
  usage: { inputTokens: 8, outputTokens: 5, costUsd: 0.001 },
  callCount: 1,
};

function rawResult(data: JsonRecord): RawModelResult {
  return {
    data,
    provider: PROVIDER,
    model: MODEL,
    ...KNOWN_MODEL_METADATA,
  };
}

function restoredResult(data: JsonRecord): RawModelResult {
  return { data, provider: PROVIDER, model: MODEL };
}

function cloneRaw(raw: RawModelResult): RawModelResult & JsonRecord {
  return structuredClone(raw) as RawModelResult & JsonRecord;
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

function invalid(
  name: string,
  source: RawModelResult,
  mutate: (copy: RawModelResult & JsonRecord) => void,
  prewire = true,
): InvalidFixture {
  const copy = cloneRaw(source);
  mutate(copy);
  return { name, raw: copy, prewire };
}

const icpDesignData: JsonRecord = {
  name: 'n'.repeat(200),
  company_attributes: {
    industry: 'i'.repeat(2000),
    sub_industry: 'precision pumps',
    region: 'Europe',
    country: 'Germany',
    employee_count: '51-200',
    revenue: 50_000_000,
    certifications: ['ISO 9001'],
    keywords: ['pump'],
    tech: ['CNC'],
    business_model: 'manufacturer',
    end_markets: ['chemical'],
    product: 'industrial pump',
    trade_side: 'importer',
  },
  pain_points: ['p'.repeat(2000), ...Array.from({ length: 7 }, () => 'pain')],
  trigger_signals: ['t'.repeat(2000), ...Array.from({ length: 7 }, () => 'trigger')],
  exclusions: ['e'.repeat(2000), ...Array.from({ length: 7 }, () => 'exclude')],
  value_props: ['v'.repeat(2000), ...Array.from({ length: 7 }, () => 'value')],
  target_markets: ['m'.repeat(300), ...Array.from({ length: 7 }, () => 'market')],
  personas: Array.from({ length: 8 }, (_, index) => ({
    title: index === 0 ? 't'.repeat(200) : `title-${index}`,
    goals: [index === 0 ? 'g'.repeat(500) : 'goal', 'goal'],
    pain_points: [index === 0 ? 'p'.repeat(500) : 'pain', 'pain'],
  })),
  buying_committee: Array.from({ length: 32 }, (_, index) => ({
    role: index === 0 ? 'r'.repeat(80) : 'decision_maker',
    title: index === 0 ? 't'.repeat(200) : `buyer-${index}`,
    concerns: [index === 0 ? 'c'.repeat(500) : 'concern'],
  })),
  qualification_rules: Array.from({ length: 64 }, (_, index) => ({
    kind: index % 3 === 0 ? 'MUST_HAVE' : index % 3 === 1 ? 'NICE_TO_HAVE' : 'EXCLUSION',
    field: index === 0 ? 'f'.repeat(200) : 'industry',
    operator: 'contains',
    value: index === 0 ? 'v'.repeat(1000) : 'pump',
    weight: index === 0 ? 100 : 1,
    rationale: index === 0 ? 'r'.repeat(2000) : 'reason',
  })),
};
const icpDesignRaw = rawResult(icpDesignData);

const queryFilterValues: JsonRecord = {
  industry: 'i'.repeat(1000),
  sub_industry: 'pumps',
  country: 'Germany',
  region: 'Europe',
  source_hint: 'public_web',
  area_name: 'Baden-Wurttemberg',
  hs_code: '8413',
  cpv: '42120000',
  buyer_country: 'DEU',
  product: 'pump',
  product_code: 'ABC',
  trade_side: 'importer',
  establishment_type: 'Manufacturer',
  iso_country: 'US',
  since_days: 30,
};
const icpQueryPlanData: JsonRecord = {
  queries: Array.from({ length: 64 }, (_, index) => ({
    source_class: 'public_intelligence',
    filters: index === 0 ? queryFilterValues : { industry: 'pump' },
    keywords: index === 0
      ? ['k'.repeat(200), ...Array.from({ length: 31 }, () => 'pump')]
      : ['pump'],
    rationale: index === 0 ? 'r'.repeat(4000) : 'reason',
    priority: index + 1,
  })),
  estimated_volume: 1_000_000_000,
};
const icpQueryPlanRaw = rawResult(icpQueryPlanData);

const understandingClaimsData: JsonRecord = {
  claims: Array.from({ length: 64 }, (_, index) => ({
    type: index === 0 ? 't'.repeat(80) : 'capability',
    statement: index === 0 ? 's'.repeat(4000) : 'makes pumps',
    evidence: index === 0 ? 'e'.repeat(2000) : 'source excerpt',
    confidence: index === 0 ? 1 : 0.75,
  })),
};
const understandingClaimsRaw = rawResult(understandingClaimsData);

const understandingProfileData: JsonRecord = {
  industry: 'i'.repeat(500),
  summary: 's'.repeat(8000),
};
const understandingProfileRaw = rawResult(understandingProfileData);

const understandingOfferingsData: JsonRecord = {
  offerings: Array.from({ length: 128 }, (_, index) => ({
    name: index === 0 ? 'n'.repeat(500) : `offering-${index}`,
    description: index === 0 ? 'd'.repeat(4000) : 'description',
    attributes: index === 0
      ? {
          moq: '100',
          lead_time: '4 weeks',
          materials: ['steel', 'bronze'],
          params: 'DN 50',
          certifications: ['ISO 9001'],
        }
      : { materials: ['steel'] },
    evidence: index === 0 ? 'e'.repeat(2000) : 'source excerpt',
    confidence: index === 0 ? 1 : 0.75,
  })),
};
const understandingOfferingsRaw = rawResult(understandingOfferingsData);

const taxonomyCodeData: JsonRecord = { code: 'c'.repeat(80) };
const taxonomyCodeRaw = rawResult(taxonomyCodeData);

const fitJudgmentData: JsonRecord = {
  verdict: 'match',
  material_gate: 'm'.repeat(1000),
  role_gate: 'r'.repeat(1000),
  process_gate: 'p'.repeat(1000),
  business_model_gate: 'b'.repeat(1000),
  reasons: ['x'.repeat(1000), ...Array.from({ length: 15 }, () => 'reason')],
};
const fitJudgmentRaw = rawResult(fitJudgmentData);

const discoveryExtractCompanyData: JsonRecord = {
  is_company_site: true,
  name: 'n'.repeat(500),
  country: 'c'.repeat(300),
  industry: 'i'.repeat(300),
  employee_count: 1_000_000_000,
  products: ['p'.repeat(500), ...Array.from({ length: 31 }, () => 'pump')],
  keywords: ['k'.repeat(300), ...Array.from({ length: 31 }, () => 'precision')],
  evidence: 'e'.repeat(2000),
  confidence: 1,
};
const discoveryExtractCompanyRaw = rawResult(discoveryExtractCompanyData);

const discoveryExtractListData: JsonRecord = {
  is_directory: true,
  list_kind: 'association_members',
  companies: Array.from({ length: 128 }, (_, index) => ({
    name: index === 0 ? 'n'.repeat(500) : `company-${index}`,
    website: index === 0 ? `https://example.test/${'w'.repeat(2027)}` : 'https://example.test',
    location: index === 0 ? 'l'.repeat(500) : 'Berlin',
    detail_url: index === 0 ? `https://example.test/${'d'.repeat(2027)}` : 'https://example.test/detail',
  })),
  has_next_page: true,
};
const discoveryExtractListRaw = rawResult(discoveryExtractListData);

const contactDecisionMakersData: JsonRecord = {
  people: Array.from({ length: 64 }, (_, index) => ({
    full_name: index === 0 ? 'n'.repeat(500) : `Person ${index}`,
    title: index === 0 ? 't'.repeat(500) : 'Managing Director',
    email: index === 0 ? `${'e'.repeat(308)}@example.com` : `person${index}@example.com`,
    phone: index === 0 ? '1'.repeat(80) : '+49 30 1234',
    department: index === 0 ? 'd'.repeat(80) : 'management',
    seniority: index === 0 ? 's'.repeat(80) : 'c_level',
    buying_role: index === 0 ? 'b'.repeat(80) : 'decision_maker',
    is_target_role: index % 2 === 0,
    evidence: index === 0 ? 'e'.repeat(2000) : 'source excerpt',
  })),
};
const contactDecisionMakersRaw = rawResult(contactDecisionMakersData);

const REPRESENTATIVE_LEGAL_BOUNDARY_FIXTURES: readonly ProjectionFixture[] = [
  {
    taskId: 'icp.design', schema: 'icp-design/v1', raw: icpDesignRaw,
    restored: restoredResult(icpDesignData),
    invalid: [
      invalid('name maxLength + 1', icpDesignRaw, (copy) => { copy.data.name = 'n'.repeat(201); }),
      invalid('rule value maxLength + 1', icpDesignRaw, (copy) => {
        ((copy.data.qualification_rules as JsonRecord[])[0]).value = 'v'.repeat(1001);
      }),
      invalid('rules maxItems + 1', icpDesignRaw, (copy) => {
        (copy.data.qualification_rules as unknown[]).push((copy.data.qualification_rules as unknown[])[0]);
      }),
      invalid('unknown ModelResult root', icpDesignRaw, (copy) => { copy.unexpected = true; }, false),
      invalid('unknown nested rule field', icpDesignRaw, (copy) => {
        ((copy.data.qualification_rules as JsonRecord[])[0]).unexpected = true;
      }),
      invalid('non-canonical rule number', icpDesignRaw, (copy) => {
        ((copy.data.qualification_rules as JsonRecord[])[0]).weight = -0;
      }),
    ],
  },
  {
    taskId: 'discovery.query_plan', schema: 'icp-query-plan/v1', raw: icpQueryPlanRaw,
    restored: restoredResult(icpQueryPlanData),
    invalid: [
      invalid('rationale maxLength + 1', icpQueryPlanRaw, (copy) => {
        ((copy.data.queries as JsonRecord[])[0]).rationale = 'r'.repeat(4001);
      }),
      invalid('queries maxItems + 1', icpQueryPlanRaw, (copy) => {
        (copy.data.queries as unknown[]).push((copy.data.queries as unknown[])[0]);
      }),
      invalid('unknown ModelResult root', icpQueryPlanRaw, (copy) => { copy.unexpected = true; }, false),
      invalid('unknown nested filter', icpQueryPlanRaw, (copy) => {
        (((copy.data.queries as JsonRecord[])[0]).filters as JsonRecord).unbounded_filter = 'x';
      }),
      invalid('non-canonical priority number', icpQueryPlanRaw, (copy) => {
        ((copy.data.queries as JsonRecord[])[0]).priority = -0;
      }),
    ],
  },
  {
    taskId: 'company_understanding.extract_claims', schema: 'understanding-claims/v1', raw: understandingClaimsRaw,
    restored: restoredResult(understandingClaimsData),
    invalid: [
      invalid('statement maxLength + 1', understandingClaimsRaw, (copy) => {
        ((copy.data.claims as JsonRecord[])[0]).statement = 's'.repeat(4001);
      }),
      invalid('claims maxItems + 1', understandingClaimsRaw, (copy) => {
        (copy.data.claims as unknown[]).push((copy.data.claims as unknown[])[0]);
      }),
      invalid('unknown ModelResult root', understandingClaimsRaw, (copy) => { copy.unexpected = true; }, false),
      invalid('unknown nested claim field', understandingClaimsRaw, (copy) => {
        ((copy.data.claims as JsonRecord[])[0]).rawPage = 'forbidden';
      }),
      invalid('non-canonical confidence number', understandingClaimsRaw, (copy) => {
        ((copy.data.claims as JsonRecord[])[0]).confidence = -0;
      }),
    ],
  },
  {
    taskId: 'company_understanding.extract_profile', schema: 'understanding-profile/v1', raw: understandingProfileRaw,
    restored: restoredResult(understandingProfileData),
    invalid: [
      invalid('summary maxLength + 1', understandingProfileRaw, (copy) => { copy.data.summary = 's'.repeat(8001); }),
      invalid('unknown ModelResult root', understandingProfileRaw, (copy) => { copy.unexpected = true; }, false),
      invalid('unknown profile field', understandingProfileRaw, (copy) => { copy.data.attributes = {}; }),
      invalid('non-canonical profile value', understandingProfileRaw, (copy) => { copy.data.industry = Number.NaN; }),
    ],
  },
  {
    taskId: 'company_understanding.extract_offerings', schema: 'understanding-offerings/v1', raw: understandingOfferingsRaw,
    restored: restoredResult(understandingOfferingsData),
    invalid: [
      invalid('offering name maxLength + 1', understandingOfferingsRaw, (copy) => {
        ((copy.data.offerings as JsonRecord[])[0]).name = 'n'.repeat(501);
      }),
      invalid('offering fact value maxLength + 1', understandingOfferingsRaw, (copy) => {
        (((copy.data.offerings as JsonRecord[])[0]).attributes as JsonRecord).params = 'p'.repeat(1001);
      }),
      invalid('offerings maxItems + 1', understandingOfferingsRaw, (copy) => {
        (copy.data.offerings as unknown[]).push((copy.data.offerings as unknown[])[0]);
      }),
      invalid('unknown ModelResult root', understandingOfferingsRaw, (copy) => { copy.unexpected = true; }, false),
      invalid('unknown open attribute', understandingOfferingsRaw, (copy) => {
        (((copy.data.offerings as JsonRecord[])[0]).attributes as JsonRecord).raw_response = 'forbidden';
      }),
      invalid('non-canonical confidence number', understandingOfferingsRaw, (copy) => {
        ((copy.data.offerings as JsonRecord[])[0]).confidence = -0;
      }),
    ],
  },
  {
    taskId: 'taxonomy.normalize', schema: 'taxonomy-code/v1', raw: taxonomyCodeRaw,
    restored: restoredResult(taxonomyCodeData),
    invalid: [
      invalid('code maxLength + 1', taxonomyCodeRaw, (copy) => { copy.data.code = 'c'.repeat(81); }),
      invalid('unknown ModelResult root', taxonomyCodeRaw, (copy) => { copy.unexpected = true; }, false),
      invalid('unknown taxonomy field', taxonomyCodeRaw, (copy) => { copy.data.catalog = []; }),
      invalid('non-canonical code value', taxonomyCodeRaw, (copy) => { copy.data.code = Number.NaN; }),
    ],
  },
  {
    taskId: 'discovery.qualify_fit', schema: 'fit-judgment/v1', raw: fitJudgmentRaw,
    restored: restoredResult(fitJudgmentData),
    invalid: [
      invalid('gate maxLength + 1', fitJudgmentRaw, (copy) => { copy.data.material_gate = 'm'.repeat(1001); }),
      invalid('reasons maxItems + 1', fitJudgmentRaw, (copy) => {
        (copy.data.reasons as unknown[]).push('reason');
      }),
      invalid('unknown ModelResult root', fitJudgmentRaw, (copy) => { copy.unexpected = true; }, false),
      invalid('unknown fit field', fitJudgmentRaw, (copy) => { copy.data.fullIcp = {}; }),
      invalid('non-canonical verdict value', fitJudgmentRaw, (copy) => { copy.data.verdict = -0; }),
    ],
  },
  {
    taskId: 'discovery.extract_company', schema: 'discovery-extract-company/v1', raw: discoveryExtractCompanyRaw,
    restored: restoredResult(discoveryExtractCompanyData),
    invalid: [
      invalid('company name maxLength + 1', discoveryExtractCompanyRaw, (copy) => { copy.data.name = 'n'.repeat(501); }),
      invalid('products maxItems + 1', discoveryExtractCompanyRaw, (copy) => {
        (copy.data.products as unknown[]).push('pump');
      }),
      invalid('unknown ModelResult root', discoveryExtractCompanyRaw, (copy) => { copy.unexpected = true; }, false),
      invalid('unknown company field', discoveryExtractCompanyRaw, (copy) => { copy.data.rawPage = 'forbidden'; }),
      invalid('non-canonical confidence number', discoveryExtractCompanyRaw, (copy) => { copy.data.confidence = -0; }),
    ],
  },
  {
    taskId: 'discovery.extract_list', schema: 'discovery-extract-list/v1', raw: discoveryExtractListRaw,
    restored: restoredResult(discoveryExtractListData),
    invalid: [
      invalid('website maxLength + 1', discoveryExtractListRaw, (copy) => {
        ((copy.data.companies as JsonRecord[])[0]).website = `https://example.test/${'w'.repeat(2028)}`;
      }),
      invalid('companies maxItems + 1', discoveryExtractListRaw, (copy) => {
        (copy.data.companies as unknown[]).push((copy.data.companies as unknown[])[0]);
      }),
      invalid('unknown ModelResult root', discoveryExtractListRaw, (copy) => { copy.unexpected = true; }, false),
      invalid('unknown listed-company field', discoveryExtractListRaw, (copy) => {
        ((copy.data.companies as JsonRecord[])[0]).attributes = {};
      }),
      invalid('non-canonical directory flag', discoveryExtractListRaw, (copy) => { copy.data.is_directory = -0; }),
    ],
  },
  {
    taskId: 'contact.find_decision_makers', schema: 'contact-decision-makers/v1', raw: contactDecisionMakersRaw,
    restored: restoredResult(contactDecisionMakersData),
    invalid: [
      invalid('person name maxLength + 1', contactDecisionMakersRaw, (copy) => {
        ((copy.data.people as JsonRecord[])[0]).full_name = 'n'.repeat(501);
      }),
      invalid('people maxItems + 1', contactDecisionMakersRaw, (copy) => {
        (copy.data.people as unknown[]).push((copy.data.people as unknown[])[0]);
      }),
      invalid('unknown ModelResult root', contactDecisionMakersRaw, (copy) => { copy.unexpected = true; }, false),
      invalid('unknown person field', contactDecisionMakersRaw, (copy) => {
        ((copy.data.people as JsonRecord[])[0]).cookie = 'forbidden';
      }),
      invalid('non-canonical target-role flag', contactDecisionMakersRaw, (copy) => {
        ((copy.data.people as JsonRecord[])[0]).is_target_role = -0;
      }),
    ],
  },
];

function schemaTypes(schema: JsonRecord): readonly string[] {
  const type = schema.type;
  return typeof type === 'string' ? [type] : Array.isArray(type) ? type as string[] : [];
}

function expectRecursivelyClosedAndBounded(schema: unknown, propertyNames?: string[]): void {
  expect(schema).toBeTruthy();
  expect(typeof schema).toBe('object');
  expect(Array.isArray(schema)).toBe(false);
  const node = schema as JsonRecord;
  for (const combination of ['oneOf', 'anyOf', 'allOf']) {
    const branches = node[combination];
    if (Array.isArray(branches)) {
      expect(branches.length).toBeGreaterThan(0);
      for (const branch of branches) expectRecursivelyClosedAndBounded(branch, propertyNames);
    }
  }
  const types = schemaTypes(node);
  if (types.includes('object')) {
    expect(node.additionalProperties).toBe(false);
    expect(node.properties).toBeTruthy();
    for (const [name, child] of Object.entries(node.properties as JsonRecord)) {
      propertyNames?.push(name);
      if (name === 'key') {
        expect(Array.isArray((child as JsonRecord).enum)).toBe(true);
        expect(((child as JsonRecord).enum as unknown[]).length).toBeGreaterThan(0);
      }
      expectRecursivelyClosedAndBounded(child, propertyNames);
    }
  }
  if (types.includes('array')) {
    expect(Number.isSafeInteger(node.maxItems)).toBe(true);
    expectRecursivelyClosedAndBounded(node.items, propertyNames);
  }
  if (types.includes('string')) expect(Number.isSafeInteger(node.maxLength)).toBe(true);
  if (types.includes('number') || types.includes('integer')) {
    expect(typeof node.minimum).toBe('number');
    expect(typeof node.maximum).toBe('number');
  }
}

describe('non-Site-Builder model result projection registry', () => {
  it('locks the exact ten task IDs and their exact schema IDs', () => {
    expect(MODEL_RESULT_TASK_IDS).toEqual([
      'company_understanding.extract_claims',
      'company_understanding.extract_profile',
      'company_understanding.extract_offerings',
      'icp.design',
      'discovery.query_plan',
      'taxonomy.normalize',
      'discovery.qualify_fit',
      'discovery.extract_company',
      'discovery.extract_list',
      'contact.find_decision_makers',
    ]);
    expect(MODEL_RESULT_PROJECTION_SCHEMAS).toEqual({
      'company_understanding.extract_claims': 'understanding-claims/v1',
      'company_understanding.extract_profile': 'understanding-profile/v1',
      'company_understanding.extract_offerings': 'understanding-offerings/v1',
      'icp.design': 'icp-design/v1',
      'discovery.query_plan': 'icp-query-plan/v1',
      'taxonomy.normalize': 'taxonomy-code/v1',
      'discovery.qualify_fit': 'fit-judgment/v1',
      'discovery.extract_company': 'discovery-extract-company/v1',
      'discovery.extract_list': 'discovery-extract-list/v1',
      'contact.find_decision_makers': 'contact-decision-makers/v1',
    });
    expect(MODEL_RESULT_PROJECTION_DEFINITIONS.map((definition) => definition.schema)).toEqual([
      'understanding-claims/v1',
      'understanding-profile/v1',
      'understanding-offerings/v1',
      'icp-design/v1',
      'icp-query-plan/v1',
      'taxonomy-code/v1',
      'fit-judgment/v1',
      'discovery-extract-company/v1',
      'discovery-extract-list/v1',
      'contact-decision-makers/v1',
    ]);
  });

  it('fails closed for an unknown task, a missing registration, and duplicate bootstrap', () => {
    expect(() => getModelResultProjectionSchema('site_builder.brand_profile')).toThrow(
      'MODEL_RESULT_PROJECTION_TASK_UNKNOWN',
    );
    expect(() => new TypedProjectionRegistry().project('icp-design/v1', icpDesignRaw)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
    const registry = new TypedProjectionRegistry();
    registerModelResultProjections(registry);
    expect(() => registerModelResultProjections(registry)).toThrow(
      'DURABLE_RESULT_SCHEMA_DUPLICATE',
    );
  });

  it('registers only closed, bounded, ASCII-camelCase, non-sensitive projection schemas', () => {
    expect(MODEL_RESULT_PROJECTION_DEFINITIONS).toHaveLength(10);
    for (const definition of MODEL_RESULT_PROJECTION_DEFINITIONS) {
      const names: string[] = [];
      expectRecursivelyClosedAndBounded(definition.jsonSchema, names);
      for (const name of names) {
        expect(name).toMatch(/^[a-z][A-Za-z0-9]*$/);
        expect(name).not.toMatch(/prompt|reasoning|raw|response|body|pageBody|credential|token|secret|cookie/i);
      }
    }
  });

  it.each(REPRESENTATIVE_LEGAL_BOUNDARY_FIXTURES)('$taskId projects/restores its representative legal boundary fixture below 120 KiB', (fixture) => {
    const registry = new TypedProjectionRegistry();
    registerModelResultProjections(registry);
    registry.freeze();

    const envelope = registry.project(getModelResultProjectionSchema(fixture.taskId), fixture.raw);

    expect(envelope.schema).toBe(fixture.schema);
    expect(Buffer.byteLength(JSON.stringify(envelope), 'utf8')).toBeLessThanOrEqual(120 * 1024);
    expect(registry.restore(envelope)).toEqual(fixture.restored);
    expect(JSON.stringify(envelope.data)).not.toContain('rawPage');
    expect(JSON.stringify(envelope.data)).not.toContain('inputTokens');
  });

  it.each(REPRESENTATIVE_LEGAL_BOUNDARY_FIXTURES)('$taskId rejects each over-bound, open, forbidden, or non-canonical mutation', (fixture) => {
    const registry = new TypedProjectionRegistry();
    registerModelResultProjections(registry);
    for (const mutation of fixture.invalid) {
      expect(
        () => registry.project(getModelResultProjectionSchema(fixture.taskId), mutation.raw),
        mutation.name,
      ).toThrow('TYPED_PROJECTION_INVALID');
    }
  });

  it.each(REPRESENTATIVE_LEGAL_BOUNDARY_FIXTURES)('$taskId refuses prompt, reasoning, raw response, and credential fields', (fixture) => {
    const registry = new TypedProjectionRegistry();
    registerModelResultProjections(registry);
    const validate = new Ajv({ allErrors: true, strict: false }).compile(
      getTask(fixture.taskId)!.outputSchema,
    );
    for (const fieldName of ['prompt', 'reasoning', 'rawResponse', 'credentials']) {
      const copy = cloneRaw(fixture.raw);
      copy.data[fieldName] = 'forbidden';
      expect(() => registry.project(getModelResultProjectionSchema(fixture.taskId), copy)).toThrow(
        'TYPED_PROJECTION_INVALID',
      );
      expect(validate(copy.data), fieldName).toBe(false);
    }
  });

  it.each([
    {
      taskId: 'company_understanding.extract_claims',
      raw: { data: { claims: [{ type: 'capability', statement: 'makes pumps', confidence: 1 }] }, provider: 'p', model: 'm' },
    },
    {
      taskId: 'company_understanding.extract_offerings',
      raw: { data: { offerings: [{ name: 'Pump', confidence: 1 }] }, provider: 'p', model: 'm' },
    },
    {
      taskId: 'icp.design',
      raw: {
        data: {
          name: 'ICP', company_attributes: {}, pain_points: [], trigger_signals: [],
          exclusions: [], value_props: [], target_markets: [], personas: [],
          buying_committee: [], qualification_rules: [{
            kind: 'MUST_HAVE', field: 'industry', operator: 'eq', value: 'pump',
          }],
        },
        provider: 'p', model: 'm',
      },
    },
    {
      taskId: 'discovery.extract_company',
      raw: { data: { is_company_site: false }, provider: 'p', model: 'm' },
    },
    {
      taskId: 'discovery.extract_list',
      raw: { data: { is_directory: false, companies: [{ name: 'Acme' }] }, provider: 'p', model: 'm' },
    },
    {
      taskId: 'contact.find_decision_makers',
      raw: { data: { people: [{ full_name: 'Ada Lovelace' }] }, provider: 'p', model: 'm' },
    },
  ])('$taskId preserves the minimal current domain shape without adding optional fields', ({ taskId, raw }) => {
    const registry = new TypedProjectionRegistry();
    registerModelResultProjections(registry);
    const envelope = registry.project(getModelResultProjectionSchema(taskId), raw);

    expect(registry.restore(envelope)).toEqual(raw);
  });

  it('rejects unsupported object-valued and nested object-valued fact entries', () => {
    const registry = new TypedProjectionRegistry();
    registerModelResultProjections(registry);
    const objectValue = cloneRaw(understandingOfferingsRaw);
    ((objectValue.data.offerings as JsonRecord[])[0].attributes as JsonRecord).params = {
      unrestricted: true,
    };
    const nestedArrayValue = cloneRaw(understandingOfferingsRaw);
    ((nestedArrayValue.data.offerings as JsonRecord[])[0].attributes as JsonRecord).materials = [
      { unrestricted: true },
    ];

    expect(() => registry.project('understanding-offerings/v1', objectValue)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
    expect(() => registry.project('understanding-offerings/v1', nestedArrayValue)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
  });

  it('sorts bounded offering facts deterministically before persistence', () => {
    const registry = new TypedProjectionRegistry();
    registerModelResultProjections(registry);
    const envelope = registry.project('understanding-offerings/v1', understandingOfferingsRaw);
    const first = (envelope.data as {
      data: { offerings: { factEntries: { key: string }[] }[] };
    }).data.offerings[0];

    expect(first.factEntries.map((entry) => entry.key)).toEqual([
      'certifications', 'lead_time', 'materials', 'moq', 'params',
    ]);
  });

  it('rejects the all-leaf-max cartesian claim fixture as aggregate oversize at the 120 KiB gate', () => {
    const raw = {
      data: {
        claims: Array.from({ length: 64 }, () => ({
          type: 't'.repeat(80),
          statement: 's'.repeat(4000),
          evidence: 'e'.repeat(2000),
          confidence: 1,
        })),
      },
      provider: 'p',
      model: 'm',
    };
    const validate = new Ajv({ strict: false }).compile(
      getTask('company_understanding.extract_claims')!.outputSchema,
    );
    const registry = new TypedProjectionRegistry();
    registerModelResultProjections(registry);

    expect(validate(raw.data)).toBe(true);
    expect(() => registry.project('understanding-claims/v1', raw)).toThrow(
      'TYPED_PROJECTION_TOO_LARGE',
    );
  });

  it.each([
    {
      schema: 'icp-design/v1' as const,
      raw: icpDesignRaw,
      entries: (data: JsonRecord) => ((data.data as JsonRecord).companyAttributeEntries as JsonRecord[]),
    },
    {
      schema: 'icp-query-plan/v1' as const,
      raw: icpQueryPlanRaw,
      entries: (data: JsonRecord) => ((((data.data as JsonRecord).queries as JsonRecord[])[0])
        .filterEntries as JsonRecord[]),
    },
    {
      schema: 'understanding-offerings/v1' as const,
      raw: understandingOfferingsRaw,
      entries: (data: JsonRecord) => ((((data.data as JsonRecord).offerings as JsonRecord[])[0])
        .factEntries as JsonRecord[]),
    },
  ])('$schema rejects digest-valid duplicate and out-of-order fact entries', ({ schema, raw, entries }) => {
    const registry = new TypedProjectionRegistry();
    registerModelResultProjections(registry);
    const projected = registry.project(schema, raw);
    const duplicate = structuredClone(projected) as typeof projected;
    const duplicateEntries = entries(duplicate.data as JsonRecord);
    duplicateEntries[1] = structuredClone(duplicateEntries[0]);
    const outOfOrder = structuredClone(projected) as typeof projected;
    const outOfOrderEntries = entries(outOfOrder.data as JsonRecord);
    [outOfOrderEntries[0], outOfOrderEntries[1]] = [outOfOrderEntries[1], outOfOrderEntries[0]];

    expect(() => registry.restore(resignEnvelope(duplicate))).toThrow('TYPED_PROJECTION_INVALID');
    expect(() => registry.restore(resignEnvelope(outOfOrder))).toThrow('TYPED_PROJECTION_INVALID');
  });
});

describe('provider-facing model task schemas are pre-wire closed and no wider than projections', () => {
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });

  it.each(REPRESENTATIVE_LEGAL_BOUNDARY_FIXTURES)('$taskId accepts the representative legal boundary fixture and rejects every data mutation', (fixture) => {
    const contract = getTask(fixture.taskId);
    expect(contract).toBeTruthy();
    expectRecursivelyClosedAndBounded(contract!.outputSchema);
    const validate = ajv.compile(contract!.outputSchema);
    expect(validate(fixture.raw.data), JSON.stringify(validate.errors)).toBe(true);
    for (const mutation of fixture.invalid.filter(
      (entry) => entry.prewire && !entry.name.includes('non-canonical'),
    )) {
      expect(validate(mutation.raw.data), mutation.name).toBe(false);
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

describe('model result projection PostgreSQL JSONB byte gate', () => {
  let database: PrismaClient | undefined;

  beforeAll(async () => {
    if (!APP_DATABASE_URL) return;
    database = new PrismaClient({ datasources: { db: { url: APP_DATABASE_URL } } });
    await database.$connect();
  });

  afterAll(async () => {
    await database?.$disconnect();
  });

  liveDatabaseIt('keeps all ten representative legal boundary envelopes below the real 128 KiB JSONB text limit', async () => {
    if (!database) throw new Error('APP_DATABASE_URL did not produce a database connection');
    const registry = new TypedProjectionRegistry();
    registerModelResultProjections(registry);
    for (const fixture of REPRESENTATIVE_LEGAL_BOUNDARY_FIXTURES) {
      const envelope = registry.project(getModelResultProjectionSchema(fixture.taskId), fixture.raw);
      const postgresBytes = await registry.assertPostgresJsonbEnvelopeByteLimit(
        postgresExecutor(database), envelope,
      );
      expect(postgresBytes, fixture.taskId).toBeLessThanOrEqual(128 * 1024);
    }
  });
});
