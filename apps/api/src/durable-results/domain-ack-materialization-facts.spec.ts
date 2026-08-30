import { types } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { DurableExecutionReceipt } from './durable-execution-receipt';
import {
  DomainAckService,
  InMemoryDomainAckRepository,
  type DomainAckRecord,
} from './domain-ack';
import {
  applyDomainAckConsumerTransactions,
} from './domain-ack-consumer-bindings';

const moduleUrl = new URL('./domain-ack-consumer-bindings.ts', import.meta.url);
const OPS = Object.freeze({
  a: '10000000-0000-4000-8000-000000000001',
  b: '10000000-0000-4000-8000-000000000002',
  c: '10000000-0000-4000-8000-000000000003',
});
const AUTHORITY = '20000000-0000-4000-8000-000000000001';
const ACCOUNT = '30000000-0000-4000-8000-000000000001';

type Fact = Readonly<{
  producerId: string;
  operationId: string;
  status: 'APPLIED' | 'REPLAYED';
  ack: DomainAckRecord;
}>;

type PartitionedModule = Readonly<{
  applyPartitionedDomainAckConsumerTransactions(input: unknown): Promise<Readonly<{
    status: 'APPLIED' | 'REPLAYED';
    companyFacts: readonly Fact[];
    auxiliaryFacts: readonly Fact[];
    value: unknown;
  }>>;
}>;

async function load(): Promise<PartitionedModule> {
  const module = await import(moduleUrl.href) as Partial<PartitionedModule>;
  if (typeof module.applyPartitionedDomainAckConsumerTransactions !== 'function') {
    throw new Error('DOMAIN_ACK_PARTITIONED_MATERIALIZATION_MISSING');
  }
  return module as PartitionedModule;
}

function receipt(
  operationId: string,
  producerId: 'discovery.extract_company' | 'searxng.search' = 'discovery.extract_company',
): DurableExecutionReceipt {
  return Object.freeze({
    schemaVersion: 'durable-execution-receipt/v1',
    scopeKey: 'workspace-1',
    authorityId: AUTHORITY,
    accountId: ACCOUNT,
    operationId,
    operationKey: `${producerId}:${operationId}`,
    resultStrategy: 'typed_projection',
    resultSchema: producerId === 'discovery.extract_company'
      ? 'discovery-extract-company/v1' : 'searxng-search/v1',
    resultDigest: operationId.replaceAll('-', '').padEnd(64, 'a').slice(0, 64),
    artifactId: null,
    usage: Object.freeze({
      currency: 'USD', unit: 'microusd', callCount: 1,
      upperBoundMicrousd: '0',
    }),
    costBasis: 'estimated_upper_bound',
    status: 'SETTLED',
  });
}

function acknowledgement(
  producerId: 'discovery.extract_company' | 'searxng.search',
  operationId: string,
) {
  return Object.freeze({
    producerId,
    receipt: receipt(operationId, producerId),
    domainAckKey: `${producerId}:${operationId}`,
    domainRevision: operationId,
  });
}

async function expectedAck(value: ReturnType<typeof acknowledgement>): Promise<DomainAckRecord> {
  const service = new DomainAckService(new InMemoryDomainAckRepository());
  const result = await service.applyWithAck({
    receipt: value.receipt,
    consumer: value.producerId === 'discovery.extract_company'
      ? 'PublicWebDiscoveryProvider.mineDomain' : 'SearchDiscoveryProvider',
    domainAggregateType: value.producerId === 'discovery.extract_company'
      ? 'CanonicalCompany' : 'SearchResultEvidence',
    domainAckKey: value.domainAckKey,
    domainRevision: value.domainRevision,
  }, async () => undefined);
  return result.ack;
}

function exactRecord(value: unknown, keys: readonly string[]): boolean {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    return Object.getPrototypeOf(value) === Object.prototype &&
      ownKeys.length === keys.length && ownKeys.every((key) =>
        typeof key === 'string' && keys.includes(key) &&
        descriptors[key]?.enumerable === true && Object.hasOwn(descriptors[key]!, 'value'));
  } catch {
    return false;
  }
}

async function instrumentedTransaction(
  entries: readonly Readonly<{ operationId: string; status: 'APPLIED' | 'REPLAYED'; ack: DomainAckRecord }>[],
) {
  const byOperation = new Map(entries.map((entry) => [entry.operationId, entry]));
  const repositoryOrder: string[] = [];
  const queryRaw = vi.fn(async (query: { strings: readonly string[]; values: readonly unknown[] }) => {
    const sql = query.strings.join('?');
    if (sql.includes('lock_execution_domain_ack_authority_first_v1')) return [];
    const operationId = query.values[1] as string;
    repositoryOrder.push(operationId);
    const entry = byOperation.get(operationId);
    if (!entry) throw new Error('unexpected operation');
    return [{ status: entry.status, ack_json: entry.ack }];
  });
  return { transaction: { $queryRaw: queryRaw }, queryRaw, repositoryOrder };
}

describe('exact Domain ACK materialization facts', () => {
  it('mutation-proves descriptor-safe partition inputs before repository access', () => {
    const keys = ['transaction', 'companyAcknowledgements', 'auxiliaryAcknowledgements',
      'apply', 'readback'];
    const valid = {
      transaction: { $queryRaw: vi.fn() }, companyAcknowledgements: [],
      auxiliaryAcknowledgements: [], apply: vi.fn(), readback: vi.fn(),
    };
    expect(exactRecord(valid, keys)).toBe(true);
    expect(exactRecord({ ...valid, extra: true }, keys)).toBe(false);
    expect(exactRecord(new Proxy(valid, {}), keys)).toBe(false);
    const accessor = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessor, 'companyAcknowledgements', {
      enumerable: true, get: () => [],
    });
    expect(exactRecord(accessor, keys)).toBe(false);
    expect(exactRecord({ ...valid, [Symbol('x')]: true }, keys)).toBe(false);
  });

  it('snapshots and globally sorts company plus auxiliary operations before first repository call', async () => {
    const module = await load();
    const company = [acknowledgement('discovery.extract_company', OPS.c),
      acknowledgement('discovery.extract_company', OPS.a)];
    const auxiliary = [acknowledgement('searxng.search', OPS.b)];
    const expected = await Promise.all([...company, ...auxiliary].map(async (item) => ({
      operationId: item.receipt.operationId,
      status: 'APPLIED' as const,
      ack: await expectedAck(item),
    })));
    const database = await instrumentedTransaction(expected);
    const apply = vi.fn(async (_tx, companyFacts: readonly Fact[], auxiliaryFacts: readonly Fact[]) => {
      expect(database.repositoryOrder).toEqual([OPS.a, OPS.b, OPS.c]);
      expect(companyFacts.map((fact) => fact.operationId)).toEqual([OPS.a, OPS.c]);
      expect(auxiliaryFacts.map((fact) => fact.operationId)).toEqual([OPS.b]);
      return 'written';
    });
    const result = await module.applyPartitionedDomainAckConsumerTransactions({
      transaction: database.transaction,
      companyAcknowledgements: company,
      auxiliaryAcknowledgements: auxiliary,
      apply,
      readback: vi.fn(),
    });
    expect(result.value).toBe('written');
    expect(Object.isFrozen(result.companyFacts)).toBe(true);
    expect(Object.isFrozen(result.auxiliaryFacts)).toBe(true);
    for (const fact of [...result.companyFacts, ...result.auxiliaryFacts]) {
      expect(Object.isFrozen(fact)).toBe(true);
      expect(Object.isFrozen(fact.ack)).toBe(true);
      expect(Object.isFrozen(fact.ack.usage)).toBe(true);
      expect(Object.keys(fact).sort()).toEqual(['ack', 'operationId', 'producerId', 'status']);
    }
  });

  it('requires homogeneous company status while auxiliary status may be mixed', async () => {
    const module = await load();
    const company = [acknowledgement('discovery.extract_company', OPS.a),
      acknowledgement('discovery.extract_company', OPS.c)];
    const auxiliary = [acknowledgement('searxng.search', OPS.b)];
    const records = await Promise.all([...company, ...auxiliary].map(async (item, index) => ({
      operationId: item.receipt.operationId,
      status: (index === 2 ? 'REPLAYED' : 'APPLIED') as 'APPLIED' | 'REPLAYED',
      ack: await expectedAck(item),
    })));
    const allowed = await instrumentedTransaction(records);
    await expect(module.applyPartitionedDomainAckConsumerTransactions({
      transaction: allowed.transaction, companyAcknowledgements: company,
      auxiliaryAcknowledgements: auxiliary, apply: vi.fn(async () => 'ok'), readback: vi.fn(),
    })).resolves.toMatchObject({ status: 'APPLIED' });
    const mixedCompany = await instrumentedTransaction(records.map((entry) =>
      entry.operationId === OPS.c ? { ...entry, status: 'REPLAYED' as const } : entry));
    await expect(module.applyPartitionedDomainAckConsumerTransactions({
      transaction: mixedCompany.transaction, companyAcknowledgements: company,
      auxiliaryAcknowledgements: auxiliary, apply: vi.fn(), readback: vi.fn(),
    })).rejects.toThrow('DOMAIN_ACK_MIXED_REPLAY_STATE');
  });

  it('passes full exact ACK facts to APPLIED and REPLAYED closures in the same transaction', async () => {
    const module = await load();
    const company = [acknowledgement('discovery.extract_company', OPS.a)];
    const ack = await expectedAck(company[0]!);
    for (const status of ['APPLIED', 'REPLAYED'] as const) {
      const database = await instrumentedTransaction([{ operationId: OPS.a, status, ack }]);
      const apply = vi.fn(async (tx, facts) => ({ tx, facts }));
      const readback = vi.fn(async (tx, facts) => ({ tx, facts }));
      const result = await module.applyPartitionedDomainAckConsumerTransactions({
        transaction: database.transaction, companyAcknowledgements: company,
        auxiliaryAcknowledgements: [], apply, readback,
      });
      const callback = status === 'APPLIED' ? apply : readback;
      expect(callback).toHaveBeenCalledOnce();
      expect(callback.mock.calls[0]?.[0]).toBe(database.transaction);
      expect(callback.mock.calls[0]?.[1]?.[0]).toEqual({
        producerId: 'discovery.extract_company', operationId: OPS.a, status, ack,
      });
      expect(result.status).toBe(status);
    }
  });

  it('propagates callback failure so the outer transaction can roll back every ACK', async () => {
    const module = await load();
    const company = [acknowledgement('discovery.extract_company', OPS.a)];
    const ack = await expectedAck(company[0]!);
    const database = await instrumentedTransaction([{
      operationId: OPS.a, status: 'APPLIED', ack,
    }]);
    const failure = new Error('same transaction callback failed');
    await expect(module.applyPartitionedDomainAckConsumerTransactions({
      transaction: database.transaction, companyAcknowledgements: company,
      auxiliaryAcknowledgements: [], apply: vi.fn(async () => { throw failure; }),
      readback: vi.fn(),
    })).rejects.toBe(failure);
  });

  it('rejects hostile acknowledgement arrays and entries before the first SQL call', async () => {
    const module = await load();
    const queryRaw = vi.fn();
    const base = { transaction: { $queryRaw: queryRaw }, auxiliaryAcknowledgements: [],
      apply: vi.fn(), readback: vi.fn() };
    const item = acknowledgement('discovery.extract_company', OPS.a);
    const accessor = { ...item } as Record<string, unknown>;
    Object.defineProperty(accessor, 'receipt', { enumerable: true, get: () => item.receipt });
    for (const companyAcknowledgements of [
      new Proxy([item], {}), [{ ...item, extra: true }], [new Proxy(item, {})],
      [accessor], [{ ...item, [Symbol('x')]: true }],
    ]) {
      await expect(module.applyPartitionedDomainAckConsumerTransactions({
        ...base, companyAcknowledgements,
      })).rejects.toThrow();
      expect(queryRaw).not.toHaveBeenCalled();
    }
  });

  it('validates every raw identity and execution binding before the first SQL call', async () => {
    const module = await load();
    const valid = acknowledgement('discovery.extract_company', OPS.a);
    const second = acknowledgement('discovery.extract_company', OPS.c);
    for (const invalid of [
      { ...second, domainAckKey: 'token' },
      { ...second, domainRevision: 'bad\0revision' },
      { ...second, domainAckKey: 'decomposed-e\u0301' },
      { ...second, receipt: { ...second.receipt, scopeKey: 'workspace-2' } },
      { ...second, receipt: { ...second.receipt, accountId: OPS.b } },
      { ...second, receipt: { ...second.receipt, authorityId: OPS.b } },
    ]) {
      const queryRaw = vi.fn();
      const apply = vi.fn();
      const readback = vi.fn();
      await expect(module.applyPartitionedDomainAckConsumerTransactions({
        transaction: { $queryRaw: queryRaw },
        companyAcknowledgements: [valid, invalid],
        auxiliaryAcknowledgements: [], apply, readback,
      })).rejects.toThrow();
      expect(queryRaw).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
      expect(readback).not.toHaveBeenCalled();
    }
  });

  it('preserves the existing helper public result and callback shape', async () => {
    const transaction = { $queryRaw: vi.fn() };
    const apply = vi.fn(async (tx) => {
      expect(tx).toBe(transaction);
      return 'legacy';
    });
    await expect(applyDomainAckConsumerTransactions({
      transaction, acknowledgements: [], apply, readback: vi.fn(),
    })).resolves.toEqual({ status: 'UNRECEIPTED', acknowledgements: [], value: 'legacy' });
    expect(apply).toHaveBeenCalledOnce();
  });
});
