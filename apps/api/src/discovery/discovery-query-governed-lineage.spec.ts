import { types } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
  type DiscoveryCompanyResultLineageV1,
} from './company-discovery-lineage';

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
const QUERY = 'c'.repeat(64);
const RESULT = 'd'.repeat(64);

type Subject = Readonly<Record<string, unknown>>;
type BuilderModule = Readonly<{
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
      typeof module.finalizeDiscoveryQueryLineageCommand !== 'function'
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
    normalizedQuery: 'industrial pumps germany',
    binding: binding(),
    ...overrides,
  };
}

function receipt(operationId = IDS.operation, producerId = 'discovery.extract_company') {
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
      resultSchema: 'discovery-extract-company/v1',
      resultDigest: RESULT,
      artifactId: null,
      usage: Object.freeze({ currency: 'USD', unit: 'microusd', callCount: 1 }),
      costBasis: 'token_pricing',
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
      Object.freeze({ providerKey: 'public_web', lineage: lineage([], []) }),
    ]),
    callbackReceipts: Object.freeze([]),
    auxiliaryOperationIds: Object.freeze([]),
    ...overrides,
  };
}

function ackFact(operationId = IDS.operation) {
  return Object.freeze({
    producerId: 'discovery.extract_company',
    operationId,
    status: 'APPLIED',
    ack: Object.freeze({
      ackId: IDS.ack,
      operationId,
      authorityId: IDS.authority,
      accountId: IDS.account,
      consumer: 'PublicWebDiscoveryProvider.mineDomain',
      domainAggregateType: 'RawSourceRecord',
      resultSchema: 'discovery-extract-company/v1',
      resultDigest: RESULT,
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
  it('mutation-proves the closed lookup surface and hostile-reflection rejection', () => {
    const keys = ['workspaceId', 'runId', 'planId', 'queryKey', 'queryOrdinal',
      'normalizedQuery', 'binding'];
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
    ]) expect(() => module.buildDiscoveryQueryLineageLookup(changed)).toThrow(
      'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID',
    );
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
      providerResults: [{ providerKey: 'public_web', lineage: lineage([], [attempt]) }],
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
      providerResults: [{ providerKey: 'public_web', lineage: lineage([settled], []) }],
      callbackReceipts: [settled],
      auxiliaryOperationIds: ['60000000-0000-4000-8000-000000000099'],
    }));
    expect(zeroOutput).toMatchObject({ providers: ['public_web'] });
    expect((zeroOutput.attempts as unknown[])).toHaveLength(1);
    expect(zeroOutput).not.toHaveProperty('auxiliaryOperationIds');
  });

  it('accepts 0 and 128 attempts but rejects 129 before any acknowledgement action', async () => {
    const module = await load();
    const attempts = (count: number) => Array.from({ length: count }, (_, index) =>
      receipt(`60000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`));
    for (const count of [0, 128]) {
      const values = attempts(count);
      expect(() => module.buildDiscoveryQueryProviderPlan(providerInput({
        providerResults: [{ providerKey: 'public_web', lineage: lineage(values, []) }],
        callbackReceipts: values,
      }))).not.toThrow();
    }
    const values = attempts(129);
    expect(() => module.buildDiscoveryQueryProviderPlan(providerInput({
      providerResults: [{ providerKey: 'public_web', lineage: lineage(values, []) }],
      callbackReceipts: values,
    }))).toThrow('DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID');
  });

  it('finalizes every index relation and derives WRITE, EXISTING and REUSE_BATCH', async () => {
    const module = await load();
    const attempt = receipt();
    const plan = module.buildDiscoveryQueryProviderPlan(providerInput({
      providerResults: [{ providerKey: 'public_web', lineage: lineage([], [attempt, attempt, attempt]) }],
      callbackReceipts: [attempt],
    }));
    const command = module.finalizeDiscoveryQueryLineageCommand({
      lookup: module.buildDiscoveryQueryLineageLookup(lookup()),
      providerPlan: plan,
      resolutions: [
        { recordIndex: 0, kind: 'WRITE', row: { ingestStatus: 'ACCEPTED' } },
        { recordIndex: 1, kind: 'EXISTING', rawRecordId: IDS.rawA },
        { recordIndex: 2, kind: 'REUSE_BATCH', sourceRecordIndex: 0 },
      ],
      writerReceipts: [{ recordIndex: 0, id: IDS.rawA, payloadHash: RESULT,
        ingestStatus: 'ACCEPTED', inserted: true }],
      budgetAuthorization: { accountId: IDS.account, authorityId: IDS.authority,
        authorizedCapMicrousd: 999999999999n, generation: 7 },
      ackFacts: [ackFact()],
    });
    expect(command).toMatchObject({ schemaVersion: 'discovery-query-lineage-command/v1' });
    expect(command).not.toHaveProperty('authorizedCapMicrousd');
    expect((command.items as unknown[])).toHaveLength(3);
    expect((command.items as Array<Record<string, unknown>>).map((item) => item.resolutionKind))
      .toEqual(['INSERTED', 'EXISTING', 'REUSE_BATCH']);
    expect(new Set((command.items as Array<Record<string, unknown>>)
      .map((item) => item.relationKey)).size).toBe(3);
  });

  it('requires the parsed lineage operation set to equal the ACK fact set', async () => {
    const module = await load();
    const attempt = receipt();
    const base = {
      lookup: module.buildDiscoveryQueryLineageLookup(lookup()),
      providerPlan: module.buildDiscoveryQueryProviderPlan(providerInput({
        providerResults: [{ providerKey: 'public_web', lineage: lineage([attempt], []) }],
        callbackReceipts: [attempt],
      })),
      resolutions: [], writerReceipts: [],
      budgetAuthorization: { accountId: IDS.account, authorityId: IDS.authority,
        authorizedCapMicrousd: 1n, generation: 1 },
    };
    expect(() => module.finalizeDiscoveryQueryLineageCommand({ ...base, ackFacts: [] }))
      .toThrow('DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH');
    expect(() => module.finalizeDiscoveryQueryLineageCommand({
      ...base, ackFacts: [ackFact(), ackFact('60000000-0000-4000-8000-000000000099')],
    })).toThrow('DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH');
    expect(() => module.finalizeDiscoveryQueryLineageCommand({
      ...base, ackFacts: [ackFact('60000000-0000-4000-8000-000000000099')],
    })).toThrow('DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH');
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
