import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
  type DiscoveryCompanyResultLineageV1,
} from './company-discovery-lineage';
import { discoveryQueryKey } from './discovery-query-receipt';

const moduleUrl = new URL('./discovery-query-governed-lineage.ts', import.meta.url);
const IDS = Object.freeze({
  workspace: '10000000-0000-4000-8000-000000000001',
  run: '20000000-0000-4000-8000-000000000001',
  plan: '30000000-0000-4000-8000-000000000001',
  authority: '40000000-0000-4000-8000-000000000001',
  account: '50000000-0000-4000-8000-000000000001',
  operation: '60000000-0000-4000-8000-000000000001',
  ack: 'a'.repeat(64),
  rawA: '70000000-0000-4000-8000-000000000001',
  rawB: '70000000-0000-4000-8000-000000000002',
});
const REQUEST = 'b'.repeat(64);
const RESULT = 'd'.repeat(64);
const NORMALIZED_QUERY = Object.freeze({
  source_class: 'public_intelligence',
  filters: Object.freeze({ country: 'DE' }),
  keywords: Object.freeze(['industrial pumps']),
  priority: 1,
});
const QUERY = discoveryQueryKey({
  runId: IDS.run,
  planId: IDS.plan,
  queryOrdinal: 0,
  query: NORMALIZED_QUERY,
});

type Subject = Readonly<Record<string, unknown>>;
type BuilderModule = Readonly<{
  DISCOVERY_QUERY_LINEAGE_CONTRACT_SHA256: string;
  DISCOVERY_QUERY_RAW_RELATION_SHA256: string;
  buildDiscoveryQueryLineageLookup(value: unknown): Subject;
  buildDiscoveryQueryProviderPlan(value: unknown): Subject;
  finalizeDiscoveryQueryLineageCommand(value: unknown): Subject;
}>;

async function load(): Promise<BuilderModule> {
  try {
    const module = await import(moduleUrl.href) as Partial<BuilderModule>;
    if (
      typeof module.buildDiscoveryQueryLineageLookup !== 'function' ||
      typeof module.buildDiscoveryQueryProviderPlan !== 'function' ||
      typeof module.finalizeDiscoveryQueryLineageCommand !== 'function' ||
      typeof module.DISCOVERY_QUERY_LINEAGE_CONTRACT_SHA256 !== 'string' ||
      typeof module.DISCOVERY_QUERY_RAW_RELATION_SHA256 !== 'string'
    ) throw new Error();
    return module as BuilderModule;
  } catch {
    throw new Error('DISCOVERY_QUERY_GOVERNED_LINEAGE_MISSING');
  }
}

function binding(overrides: Record<string, unknown> = {}) {
  const subjectId = `request:${REQUEST}`;
  return {
    authorityId: IDS.authority,
    replay: false,
    scopeKey: IDS.workspace,
    purpose: 'discovery.run',
    subjectType: 'discovery_run',
    subjectId,
    requestSha256: REQUEST,
    accountKey: `discovery.run:discovery_run:${subjectId}:${REQUEST}`,
    ...overrides,
  };
}

function lookup(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: IDS.workspace,
    runId: IDS.run,
    planId: IDS.plan,
    queryKey: QUERY,
    queryOrdinal: 0,
    query: NORMALIZED_QUERY,
    binding: binding(),
    ...overrides,
  };
}

function receipt(
  operationId = IDS.operation,
  producerId = 'discovery.extract_company',
  resultSchema = 'discovery-extract-company/v1',
) {
  return Object.freeze({
    producerId,
    receipt: Object.freeze({
      schemaVersion: 'durable-execution-receipt/v1',
      scopeKey: IDS.workspace,
      authorityId: IDS.authority,
      accountId: IDS.account,
      operationId,
      operationKey: `discovery:company:${operationId}`,
      resultStrategy: 'typed_projection',
      resultSchema,
      resultDigest: RESULT,
      artifactId: null,
      usage: Object.freeze({
        currency: 'USD', unit: 'microusd', callCount: 1,
        upperBoundMicrousd: '0',
      }),
      costBasis: 'estimated_upper_bound',
      status: 'SETTLED',
    }),
  });
}

function lineage(attempts: readonly ReturnType<typeof receipt>[], coverage = attempts) {
  return Object.freeze({
    schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
    recordCount: coverage.length,
    attemptReceipts: Object.freeze(attempts.map((attempt) => Object.freeze(attempt))),
    receiptCoverage: Object.freeze(coverage.map((attempt, index) => Object.freeze({
      ...attempt,
      recordIndexes: Object.freeze([index]),
    }))),
  }) as DiscoveryCompanyResultLineageV1;
}

function providerInput(overrides: Record<string, unknown> = {}) {
  return {
    selectedProviders: Object.freeze([
      Object.freeze({ providerKey: 'public_web', lineageSchema: DISCOVERY_COMPANY_RESULT_LINEAGE_V1 }),
    ]),
    providerResults: Object.freeze([
      Object.freeze({ providerKey: 'public_web', lineage: lineage([], []), costCents: 0 }),
    ]),
    callbackReceipts: Object.freeze([]),
    auxiliaryOperationIds: Object.freeze([]),
    ...overrides,
  };
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function ackFact(
  operationId = IDS.operation,
  overrides: Record<string, unknown> = {},
  providerKey: 'public_web' | 'directory' = 'public_web',
) {
  const contract = providerKey === 'public_web'
    ? { producerId: 'discovery.extract_company', consumer: 'PublicWebDiscoveryProvider.mineDomain',
        resultSchema: 'discovery-extract-company/v1' }
    : { producerId: 'discovery.extract_list', consumer: 'DirectoryDiscoveryProvider.extractList',
        resultSchema: 'discovery-extract-list/v1' };
  const domainAckKey = sha(`${IDS.run}:${providerKey}:${operationId}`);
  const domainRevision = sha(RESULT);
  const consumer = contract.consumer;
  const domainAggregateType = 'RawSourceRecord';
  const ackId = sha(canonical({
    operationId, consumer, domainAggregateType, domainAckKey,
    domainRevision, resultDigest: RESULT,
  }));
  return Object.freeze({
    producerId: contract.producerId,
    operationId,
    status: 'APPLIED',
    ack: Object.freeze({
      schemaVersion: 'domain-ack/v1',
      ackId,
      operationId,
      operationKey: `discovery:company:${operationId}`,
      authorityId: IDS.authority,
      accountId: IDS.account,
      scopeKey: IDS.workspace,
      consumer,
      domainAggregateType,
      domainAckKey,
      domainRevision,
      resultStrategy: 'typed_projection',
      resultSchema: contract.resultSchema,
      resultDigest: RESULT,
      artifactId: null,
      usage: Object.freeze({
        currency: 'USD', unit: 'microusd', callCount: 1,
        upperBoundMicrousd: '0',
      }),
      costBasis: 'estimated_upper_bound',
      ...overrides,
    }),
  });
}

function exactDataRecord(value: unknown, keys: readonly string[]): boolean {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) return false;
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    return ownKeys.length === keys.length && ownKeys.every((key) =>
      typeof key === 'string' && keys.includes(key) &&
      descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key]!, 'value'));
  } catch {
    return false;
  }
}

describe('pure governed Discovery Q-TX plan builders', () => {
  it('locks canonical lineage and raw-relation descriptor digests', async () => {
    const module = await load();
    expect(module.DISCOVERY_QUERY_LINEAGE_CONTRACT_SHA256).toBe(
      'c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c',
    );
    expect(module.DISCOVERY_QUERY_RAW_RELATION_SHA256).toBe(
      'dd2f4144f58de22f7415dfc11be56c4828c137e52d34e916852e64cfde38a2e1',
    );
  });
  it('mutation-proves the closed lookup surface and hostile-reflection rejection', () => {
    const keys = ['workspaceId', 'runId', 'planId', 'queryKey', 'queryOrdinal',
      'query', 'binding'];
    expect(exactDataRecord(lookup(), keys)).toBe(true);
    expect(exactDataRecord({ ...lookup(), extra: true }, keys)).toBe(false);
    expect(exactDataRecord(new Proxy(lookup(), {}), keys)).toBe(false);
    const accessor = lookup() as Record<string, unknown>;
    Object.defineProperty(accessor, 'binding', { enumerable: true, get: () => binding() });
    expect(exactDataRecord(accessor, keys)).toBe(false);
    expect(exactDataRecord({ ...lookup(), [Symbol('x')]: true }, keys)).toBe(false);
  });

  it('builds an immutable request-bound lookup before budget, provider or taxonomy work', async () => {
    const module = await load();
    const built = module.buildDiscoveryQueryLineageLookup(lookup());
    expect(built).toMatchObject({
      schemaVersion: 'discovery-query-lineage-lookup/v1',
      workspaceId: IDS.workspace,
      runId: IDS.run,
      planId: IDS.plan,
      queryKey: QUERY,
      queryOrdinal: 0,
      authorityId: IDS.authority,
      subjectId: `request:${REQUEST}`,
      requestSha256: REQUEST,
    });
    expect(built.subjectId).not.toBe(IDS.run);
    expect(Object.isFrozen(built)).toBe(true);
    for (const changed of [
      lookup({ binding: binding({ subjectId: IDS.run }) }),
      lookup({ binding: binding({ requestSha256: 'e'.repeat(64) }) }),
      lookup({ binding: binding({ accountKey: `discovery.run:discovery_run:${IDS.run}:${REQUEST}` }) }),
      lookup({ queryKey: 'e'.repeat(64) }),
    ]) expect(() => module.buildDiscoveryQueryLineageLookup(changed)).toThrow(
      'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID',
    );
  });

  it('preserves special own filter keys in the formal query hash', async () => {
    const module = await load();
    const emptyQuery = Object.freeze({ ...NORMALIZED_QUERY, filters: Object.freeze({}) });
    const hostileFilters = JSON.parse('{"__proto__":{"country":"DE"},"constructor":"data"}');
    const hostileQuery = Object.freeze({ ...NORMALIZED_QUERY, filters: hostileFilters });
    const emptyHash = discoveryQueryKey({
      runId: IDS.run, planId: IDS.plan, queryOrdinal: 0, query: emptyQuery,
    });
    const hostileHash = discoveryQueryKey({
      runId: IDS.run, planId: IDS.plan, queryOrdinal: 0, query: hostileQuery,
    });
    expect(hostileHash).not.toBe(emptyHash);
    expect(() => module.buildDiscoveryQueryLineageLookup(lookup({
      query: hostileQuery, queryKey: emptyHash,
    }))).toThrow('DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID');
    expect(module.buildDiscoveryQueryLineageLookup(lookup({
      query: hostileQuery, queryKey: hostileHash,
    }))).toMatchObject({ queryKey: hostileHash });
  });

  it('classifies all-capable versus mixed legacy providers and requires callback equality', async () => {
    const module = await load();
    expect(module.buildDiscoveryQueryProviderPlan(providerInput())).toMatchObject({
      mode: 'governed', providers: ['public_web'], attempts: [],
    });
    expect(module.buildDiscoveryQueryProviderPlan(providerInput({
      selectedProviders: [
        { providerKey: 'public_web', lineageSchema: DISCOVERY_COMPANY_RESULT_LINEAGE_V1 },
        { providerKey: 'legacy', lineageSchema: null },
      ],
    }))).toEqual(Object.freeze({ mode: 'legacy' }));
    const attempt = receipt();
    const exact = providerInput({
      providerResults: [{ providerKey: 'public_web', lineage: lineage([], [attempt]), costCents: 3 }],
      callbackReceipts: [attempt],
    });
    expect(module.buildDiscoveryQueryProviderPlan(exact)).toMatchObject({ mode: 'governed' });
    expect(() => module.buildDiscoveryQueryProviderPlan({
      ...exact, callbackReceipts: [receipt('60000000-0000-4000-8000-000000000099')],
    })).toThrow('DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH');
  });

  it('separates all three zero-company shapes and ancillary receipts', async () => {
    const module = await load();
    const zeroSelected = module.buildDiscoveryQueryProviderPlan(providerInput({
      selectedProviders: [], providerResults: [], callbackReceipts: [],
    }));
    expect(zeroSelected).toMatchObject({ mode: 'governed', providers: [], attempts: [] });
    const notInvoked = module.buildDiscoveryQueryProviderPlan(providerInput());
    expect(notInvoked).toMatchObject({ providers: ['public_web'], attempts: [] });
    const settled = receipt();
    const zeroOutput = module.buildDiscoveryQueryProviderPlan(providerInput({
      providerResults: [{ providerKey: 'public_web', lineage: lineage([settled], []), costCents: 2 }],
      callbackReceipts: [settled],
      auxiliaryOperationIds: ['60000000-0000-4000-8000-000000000099'],
    }));
    expect(zeroOutput).toMatchObject({ providers: ['public_web'] });
    expect((zeroOutput.attempts as unknown[])).toHaveLength(1);
    expect(zeroOutput).toMatchObject({
      auxiliaryOperationIds: ['60000000-0000-4000-8000-000000000099'],
    });
  });

  it('accepts 0 and 128 attempts but rejects 129 before any acknowledgement action', async () => {
    const module = await load();
    const attempts = (count: number) => Array.from({ length: count }, (_, index) =>
      receipt(`60000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`));
    for (const count of [0, 128]) {
      const values = attempts(count);
      expect(() => module.buildDiscoveryQueryProviderPlan(providerInput({
        providerResults: [{ providerKey: 'public_web', lineage: lineage(values, []), costCents: 0 }],
        callbackReceipts: values,
      }))).not.toThrow();
    }
    const values = attempts(129);
    expect(() => module.buildDiscoveryQueryProviderPlan(providerInput({
      providerResults: [{ providerKey: 'public_web', lineage: lineage(values, []), costCents: 0 }],
      callbackReceipts: values,
    }))).toThrow('DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID');
  });

  it('finalizes every index relation and derives WRITE, EXISTING and REUSE_BATCH', async () => {
    const module = await load();
    const attempt = receipt();
    const plan = module.buildDiscoveryQueryProviderPlan(providerInput({
      providerResults: [{ providerKey: 'public_web', costCents: 7, lineage: Object.freeze({
        schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
        recordCount: 3,
        attemptReceipts: Object.freeze([]),
        receiptCoverage: Object.freeze([Object.freeze({
          ...attempt,
          recordIndexes: Object.freeze([0, 1, 2]),
        })]),
      }) }],
      callbackReceipts: [attempt],
    }));
    const command = module.finalizeDiscoveryQueryLineageCommand({
      lookup: module.buildDiscoveryQueryLineageLookup(lookup()),
      providerPlan: plan,
      resolutions: [
        { providerKey: 'public_web', recordIndex: 0, kind: 'WRITE',
          row: { ingestStatus: 'ACCEPTED' } },
        { providerKey: 'public_web', recordIndex: 1, kind: 'EXISTING', rawRecordId: IDS.rawB },
        { providerKey: 'public_web', recordIndex: 2, kind: 'REUSE_BATCH', sourceRecordIndex: 0 },
      ],
      rawReceipts: [
        { providerKey: 'public_web', recordIndex: 0, rawRecordId: IDS.rawA,
          payloadHash: RESULT, ingestStatus: 'ACCEPTED', materialization: 'INSERTED' },
        { providerKey: 'public_web', recordIndex: 1, rawRecordId: IDS.rawB,
          payloadHash: RESULT, ingestStatus: 'ACCEPTED', materialization: 'EXISTING' },
      ],
      budgetAuthorization: { accountId: IDS.account, authorityId: IDS.authority,
        authorizedCapMicrousd: 999999999999n, generation: 7 },
      budgetTruncated: false,
      ackFacts: [ackFact()],
    });
    expect(command).toMatchObject({ schemaVersion: 'discovery-query-lineage-command/v2' });
    expect(command).not.toHaveProperty('authorizedCapMicrousd');
    expect(command).toMatchObject({
      queryReceipt: {
        schemaVersion: 'discovery-query-receipt/v1',
        sourceClass: 'public_intelligence',
        providers: ['public_web'],
        accepted: 1,
        duplicate: 2,
        costCents: 7,
      },
    });
    expect((command.items as unknown[])).toHaveLength(3);
    expect((command.items as Array<Record<string, unknown>>).map((item) => item.resolutionKind))
      .toEqual(['INSERTED', 'EXISTING', 'REUSE_BATCH']);
    expect(new Set((command.items as Array<Record<string, unknown>>)
      .map((item) => item.relationKey)).size).toBe(3);
    expect((command.items as Array<Record<string, unknown>>).every((item) =>
      typeof item.rawPayloadHash === 'string' && typeof item.rawIngestStatus === 'string'))
      .toBe(true);
  });

  it('keeps provider-local indexes and relation source refs independent', async () => {
    const module = await load();
    const industryQuery = Object.freeze({ ...NORMALIZED_QUERY, source_class: 'industry_data' });
    const industryLookup = lookup({
      query: industryQuery,
      queryKey: discoveryQueryKey({
        runId: IDS.run, planId: IDS.plan, queryOrdinal: 0, query: industryQuery,
      }),
    });
    const publicAttempt = receipt();
    const directoryOperation = '60000000-0000-4000-8000-000000000002';
    const directoryAttempt = receipt(
      directoryOperation, 'discovery.extract_list', 'discovery-extract-list/v1',
    );
    const providerPlan = module.buildDiscoveryQueryProviderPlan(providerInput({
      selectedProviders: [
        { providerKey: 'public_web', lineageSchema: DISCOVERY_COMPANY_RESULT_LINEAGE_V1 },
        { providerKey: 'directory', lineageSchema: DISCOVERY_COMPANY_RESULT_LINEAGE_V1 },
      ],
      providerResults: [
        { providerKey: 'public_web', lineage: lineage([], [publicAttempt]), costCents: 1 },
        { providerKey: 'directory', lineage: lineage([], [directoryAttempt]), costCents: 2 },
      ],
      callbackReceipts: [publicAttempt, directoryAttempt],
    }));
    const command = module.finalizeDiscoveryQueryLineageCommand({
      lookup: module.buildDiscoveryQueryLineageLookup(industryLookup),
      providerPlan,
      resolutions: [
        { providerKey: 'public_web', recordIndex: 0, kind: 'WRITE', row: {} },
        { providerKey: 'directory', recordIndex: 0, kind: 'WRITE', row: {} },
      ],
      rawReceipts: [
        { providerKey: 'public_web', recordIndex: 0, rawRecordId: IDS.rawA,
          payloadHash: RESULT, ingestStatus: 'ACCEPTED', materialization: 'INSERTED' },
        { providerKey: 'directory', recordIndex: 0, rawRecordId: IDS.rawB,
          payloadHash: RESULT, ingestStatus: 'ACCEPTED', materialization: 'INSERTED' },
      ],
      budgetAuthorization: { accountId: IDS.account, authorityId: IDS.authority,
        authorizedCapMicrousd: 5n, generation: 1 },
      budgetTruncated: true,
      ackFacts: [ackFact(), ackFact(directoryOperation, {}, 'directory')],
    });
    expect(command.budgetTruncated).toBe(true);
    const items = command.items as Array<Record<string, unknown>>;
    expect(items.map((item) => `${item.providerKey}:${item.recordIndex}`))
      .toEqual(['directory:0', 'public_web:0']);
    expect(new Set(items.map((item) => item.sourceRefUuid)).size).toBe(2);
  });

  it('requires the parsed lineage operation set to equal the ACK fact set', async () => {
    const module = await load();
    const attempt = receipt();
    const base = {
      lookup: module.buildDiscoveryQueryLineageLookup(lookup()),
      providerPlan: module.buildDiscoveryQueryProviderPlan(providerInput({
        providerResults: [{ providerKey: 'public_web', lineage: lineage([attempt], []), costCents: 0 }],
        callbackReceipts: [attempt],
      })),
      resolutions: [], rawReceipts: [],
      budgetAuthorization: { accountId: IDS.account, authorityId: IDS.authority,
        authorizedCapMicrousd: 1n, generation: 1 },
      budgetTruncated: false,
    };
    expect(() => module.finalizeDiscoveryQueryLineageCommand({ ...base, ackFacts: [] }))
      .toThrow('DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH');
    expect(() => module.finalizeDiscoveryQueryLineageCommand({
      ...base, ackFacts: [{ ...ackFact(), status: 'REPLAYED' }],
    })).toThrow('DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH');
    expect(() => module.finalizeDiscoveryQueryLineageCommand({
      ...base, ackFacts: [ackFact(), ackFact('60000000-0000-4000-8000-000000000099')],
    })).toThrow('DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH');
    expect(() => module.finalizeDiscoveryQueryLineageCommand({
      ...base, ackFacts: [ackFact('60000000-0000-4000-8000-000000000099')],
    })).toThrow('DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH');
  });

  it('keeps auxiliary and company operation partitions disjoint and unique', async () => {
    const module = await load();
    const attempt = receipt();
    const base = providerInput({
      providerResults: [{ providerKey: 'public_web', lineage: lineage([attempt], []), costCents: 0 }],
      callbackReceipts: [attempt],
    });
    for (const auxiliaryOperationIds of [
      [IDS.operation],
      ['60000000-0000-4000-8000-000000000099', '60000000-0000-4000-8000-000000000099'],
    ]) expect(() => module.buildDiscoveryQueryProviderPlan({
      ...base, auxiliaryOperationIds,
    })).toThrow('DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID');
  });

  it('enforces the per-operation governed graph coverage boundary', async () => {
    const module = await load();
    const attempt = receipt();
    const input = (count: number) => providerInput({
      providerResults: [{
        providerKey: 'public_web', costCents: 0,
        lineage: Object.freeze({
          schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
          recordCount: count,
          attemptReceipts: Object.freeze([]),
          receiptCoverage: Object.freeze([Object.freeze({
            ...attempt,
            recordIndexes: Object.freeze(Array.from({ length: count }, (_, index) => index)),
          })]),
        }),
      }],
      callbackReceipts: [attempt],
    });
    expect(() => module.buildDiscoveryQueryProviderPlan(input(4_095))).not.toThrow();
    expect(() => module.buildDiscoveryQueryProviderPlan(input(4_096)))
      .toThrow('DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID');
  });

  it('rejects hostile finalizer inputs before invoking reflection traps', async () => {
    const module = await load();
    const attempt = receipt();
    const providerPlan = module.buildDiscoveryQueryProviderPlan(providerInput({
      providerResults: [{ providerKey: 'public_web', lineage: lineage([], [attempt]), costCents: 0 }],
      callbackReceipts: [attempt],
    }));
    let traps = 0;
    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor: () => {
        traps += 1;
        throw new Error('DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID');
      },
    });
    expect(() => module.finalizeDiscoveryQueryLineageCommand({
      lookup: module.buildDiscoveryQueryLineageLookup(lookup()),
      providerPlan,
      resolutions: [hostile],
      rawReceipts: [],
      budgetAuthorization: { accountId: IDS.account, authorityId: IDS.authority,
        authorizedCapMicrousd: 1n, generation: 1 },
      budgetTruncated: false,
      ackFacts: [ackFact()],
    })).toThrow('DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID');
    expect(traps).toBe(0);
  });

  it('rejects hostile plan, resolution, writer and ACK reflection', async () => {
    const module = await load();
    for (const value of [
      new Proxy(providerInput(), {}),
      { ...providerInput(), extra: true },
      Object.defineProperty(providerInput(), 'providerResults', {
        enumerable: true, get: () => [],
      }),
    ]) expect(() => module.buildDiscoveryQueryProviderPlan(value)).toThrow(
      'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID',
    );
  });
});
