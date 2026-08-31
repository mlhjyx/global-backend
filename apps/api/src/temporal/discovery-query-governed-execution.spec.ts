import { describe, expect, it, vi } from 'vitest';
import type { CompanyDiscoveryAdapter } from '../discovery/provider-contract';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';
import { DISCOVERY_COMPANY_RESULT_LINEAGE_V1 } from '../discovery/company-discovery-lineage';
import {
  buildDiscoveryQueryLineageLookup,
  projectDiscoveryQueryLineageAttestKey,
} from '../discovery/discovery-query-governed-lineage';
import { discoveryQueryKey } from '../discovery/discovery-query-receipt';
import { discoveryCompanyDomainAckIdentity } from '../discovery/discovery-company-domain-ack';
import { DomainAckService, InMemoryDomainAckRepository } from '../durable-results/domain-ack';
import {
  buildGovernedDiscoveryQueryExecutionPlan,
  commitGovernedDiscoveryQueryExecution,
} from './discovery-query-governed-execution';

const partitionMock = vi.hoisted(() => vi.fn());
vi.mock('../durable-results/domain-ack-consumer-bindings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../durable-results/domain-ack-consumer-bindings')>()),
  applyPartitionedDomainAckConsumerTransactions: partitionMock,
}));

const IDS = Object.freeze({
  workspace: '10000000-0000-4000-8000-000000000001',
  authority: '20000000-0000-4000-8000-000000000001',
  account: '30000000-0000-4000-8000-000000000001',
  companyOperation: '40000000-0000-4000-8000-000000000001',
  auxiliaryOperation: '40000000-0000-4000-8000-000000000002',
});

function receipt(
  operationId: string,
  schema: string,
): DurableExecutionReceipt {
  return Object.freeze({
    schemaVersion: 'durable-execution-receipt/v1',
    scopeKey: IDS.workspace,
    authorityId: IDS.authority,
    accountId: IDS.account,
    operationId,
    operationKey: `operation:${operationId}`,
    resultStrategy: 'typed_projection',
    resultSchema: schema,
    resultDigest: 'a'.repeat(64),
    artifactId: null,
    usage: Object.freeze({
      currency: 'USD',
      unit: 'microusd',
      callCount: 1,
      upperBoundMicrousd: '0',
    }),
    costBasis: 'estimated_upper_bound',
    status: 'SETTLED',
  });
}

function adapter(
  key: string,
  capable: boolean,
): CompanyDiscoveryAdapter {
  return {
    key,
    classes: ['public_intelligence'],
    ...(capable
      ? { companyResultLineage: DISCOVERY_COMPANY_RESULT_LINEAGE_V1 }
      : {}),
    discoverCompanies: async () => ({ records: [], costCents: 0 }),
  } as CompanyDiscoveryAdapter;
}

function settled(value: Record<string, unknown>) {
  return Object.freeze({ status: 'fulfilled' as const, value });
}

describe('governed Discovery execution plan', () => {
  it('keeps missing receipt identity and mixed capability entirely legacy', () => {
    expect(buildGovernedDiscoveryQueryExecutionPlan({
      lineageEnabled: false,
      adapters: [],
      settled: [],
    })).toEqual({ mode: 'legacy' });
    expect(buildGovernedDiscoveryQueryExecutionPlan({
      lineageEnabled: true,
      adapters: [adapter('public_web', true), adapter('wikidata', false)],
      settled: [],
    })).toEqual({ mode: 'legacy' });
  });

  it('maps ordinary capable-provider rejection to one stable control failure', () => {
    expect(() => buildGovernedDiscoveryQueryExecutionPlan({
      lineageEnabled: true,
      adapters: [adapter('public_web', true)],
      settled: [{ status: 'rejected', reason: new Error('provider unavailable') }],
    })).toThrow('DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH');
  });

  it('rejects missing lineage and record-count drift', () => {
    for (const result of [
      { records: [], costCents: 0 },
      {
        records: [{ externalId: 'one', name: 'One GmbH' }],
        costCents: 0,
        lineage: {
          schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
          recordCount: 0,
          attemptReceipts: [],
          receiptCoverage: [],
        },
      },
    ]) {
      expect(() => buildGovernedDiscoveryQueryExecutionPlan({
        lineageEnabled: true,
        adapters: [adapter('public_web', true)],
        settled: [settled({ key: 'public_web', r: result, durableReceipts: [] })] as never,
      })).toThrow('DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH');
    }
  });

  it('partitions company callbacks from exact auxiliary operation ids', () => {
    const company = receipt(
      IDS.companyOperation,
      'discovery-extract-company/v1',
    );
    const auxiliary = receipt(IDS.auxiliaryOperation, 'searxng-search/v1');
    const plan = buildGovernedDiscoveryQueryExecutionPlan({
      lineageEnabled: true,
      adapters: [adapter('public_web', true)],
      settled: [settled({
        key: 'public_web',
        r: {
          records: [],
          costCents: 0,
          lineage: {
            schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
            recordCount: 0,
            attemptReceipts: [{ producerId: 'discovery.extract_company', receipt: company }],
            receiptCoverage: [],
          },
        },
        durableReceipts: [
          { producerId: 'discovery.extract_company', receipt: company },
          { producerId: 'searxng.search', receipt: auxiliary },
        ],
      })] as never,
    });
    expect(plan).toMatchObject({
      mode: 'governed',
      auxiliaryReceipts: [{
        producerId: 'searxng.search',
        receipt: { operationId: IDS.auxiliaryOperation },
      }],
    });
    expect(Object.isFrozen(plan)).toBe(true);
  });
});

function zeroCommitFixture() {
  const runId = '50000000-0000-4000-8000-000000000001';
  const planId = '60000000-0000-4000-8000-000000000001';
  const request = 'b'.repeat(64);
  const query = Object.freeze({
    source_class: 'public_intelligence',
    filters: Object.freeze({}),
    keywords: Object.freeze([]) as unknown as string[],
    priority: 1,
  });
  const queryKey = discoveryQueryKey({ runId, planId, queryOrdinal: 0, query });
  const lookup = buildDiscoveryQueryLineageLookup({
    workspaceId: IDS.workspace,
    runId,
    planId,
    queryKey,
    queryOrdinal: 0,
    query,
    binding: {
      authorityId: IDS.authority,
      replay: false,
      scopeKey: IDS.workspace,
      accountKey: `discovery.run:discovery_run:request:${request}:${request}`,
      purpose: 'discovery.run',
      subjectType: 'discovery_run',
      subjectId: `request:${request}`,
      requestSha256: request,
    },
  });
  const plan = buildGovernedDiscoveryQueryExecutionPlan({
    lineageEnabled: true,
    adapters: [],
    settled: [],
  });
  if (plan.mode !== 'governed') throw new Error('expected governed zero plan');
  return { runId, planId, queryKey, lookup, plan };
}

describe('governed Discovery execution commit', () => {
  it('materializes one WRITE plus one REUSE_BATCH index and records usage', async () => {
    const fixture = zeroCommitFixture();
    const companyReceipt = receipt(
      IDS.companyOperation,
      'discovery-extract-company/v1',
    );
    const record = {
      externalId: 'qtx.example',
      name: 'QTX Pumps GmbH',
      provenance: {
        sourceUrl: 'https://qtx.example/company',
        fetchedAt: '2026-08-30T12:00:00.000Z',
        contentHash: 'c'.repeat(64),
        parserVersion: 'public-web/v1',
      },
    };
    const settledValue = settled({
      key: 'public_web',
      r: {
        records: [record, record],
        costCents: 3,
        lineage: {
          schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
          recordCount: 2,
          attemptReceipts: [],
          receiptCoverage: [{
            producerId: 'discovery.extract_company',
            receipt: companyReceipt,
            recordIndexes: [0, 1],
          }],
        },
      },
      durableReceipts: [{
        producerId: 'discovery.extract_company',
        receipt: companyReceipt,
      }],
    });
    const plan = buildGovernedDiscoveryQueryExecutionPlan({
      lineageEnabled: true,
      adapters: [adapter('public_web', true)],
      settled: [settledValue] as never,
    });
    if (plan.mode !== 'governed') throw new Error('expected governed plan');
    const identity = discoveryCompanyDomainAckIdentity({
      runId: fixture.runId,
      providerKey: 'public_web',
      operationId: companyReceipt.operationId,
      resultDigest: companyReceipt.resultDigest,
    });
    const ackResult = await new DomainAckService(
      new InMemoryDomainAckRepository(),
    ).applyWithAck({
      receipt: companyReceipt,
      consumer: 'PublicWebDiscoveryProvider.mineDomain',
      domainAggregateType: 'RawSourceRecord',
      ...identity,
    }, async () => undefined);
    const usage = vi.fn(async () => ({}));
    const update = vi.fn(async () => ({}));
    const writer = vi.fn();
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(async (statement: { strings: readonly string[]; values: readonly unknown[] }) => {
        const sql = statement.strings.join('?');
        if (sql.includes('write_raw_source_record_v2')) {
          writer();
          const command = JSON.parse(String(statement.values[0]));
          return [{ raw_record_id: '70000000-0000-4000-8000-000000000001',
            payload_hash: 'f'.repeat(64), payload_bytes: 32,
            ingest_status: command.ingestStatus, inserted: true }];
        }
        if (sql.includes('append_discovery_query_lineage_v2')) return [{
          status: 'APPLIED', attempt_count: 1, item_count: 2,
          query_key: fixture.queryKey,
        }];
        if (sql.includes('FROM discovery_run')) return [{
          id: fixture.runId, plan_id: fixture.planId, stats: {},
        }];
        throw new Error(`unexpected SQL: ${sql}`);
      }),
      rawSourceRecord: { findMany: vi.fn(async () => []) },
      discoveryRun: { update },
      usageLedger: { create: usage },
    };
    partitionMock.mockImplementationOnce(async (input) => ({
      status: 'APPLIED',
      companyFacts: [{ producerId: 'discovery.extract_company',
        operationId: companyReceipt.operationId, status: 'APPLIED', ack: ackResult.ack }],
      auxiliaryFacts: [],
      value: await input.apply(input.transaction, [{
        producerId: 'discovery.extract_company', operationId: companyReceipt.operationId,
        status: 'APPLIED', ack: ackResult.ack,
      }], []),
    }));
    await expect(commitGovernedDiscoveryQueryExecution({
      prisma: { withWorkspace: async (_workspaceId, callback) => callback(tx) } as never,
      workspaceId: IDS.workspace, runId: fixture.runId, planId: fixture.planId,
      queryKey: fixture.queryKey, sourceClass: 'public_intelligence',
      settled: [settledValue] as never,
      sourcePolicies: [{ id: '71000000-0000-4000-8000-000000000001',
        domain: 'qtx.example', retentionDays: 30, reviewStatus: 'APPROVED',
        allowedPurpose: ['discovery'], updatedAt: new Date('2026-08-30T00:00:00Z') }],
      lookup: fixture.lookup, plan,
      budgetAuthorization: { accountId: IDS.account, authorityId: IDS.authority,
        authorizedCapMicrousd: 0n, generation: 1 },
      budgetTruncated: false,
    })).resolves.toMatchObject({
      rawCount: 0,
      rejectedCount: 1,
      duplicateCount: 1,
      costCents: 3,
    });
    expect(writer).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
    expect(usage).toHaveBeenCalledOnce();

    const failingTx = {
      ...tx,
      rawSourceRecord: {
        findMany: vi.fn(async () => {
          throw new Error('RAW_SOURCE_INDEXED_RESOLUTION_INVALID');
        }),
      },
    };
    partitionMock.mockImplementationOnce(async (input) => ({
      status: 'APPLIED', companyFacts: [], auxiliaryFacts: [],
      value: await input.apply(input.transaction, [{
        producerId: 'discovery.extract_company', operationId: companyReceipt.operationId,
        status: 'APPLIED', ack: ackResult.ack,
      }], []),
    }));
    await expect(commitGovernedDiscoveryQueryExecution({
      prisma: { withWorkspace: async (_workspaceId, callback) => callback(failingTx) } as never,
      workspaceId: IDS.workspace, runId: fixture.runId, planId: fixture.planId,
      queryKey: fixture.queryKey, sourceClass: 'public_intelligence',
      settled: [settledValue] as never,
      sourcePolicies: [{ id: '71000000-0000-4000-8000-000000000001',
        domain: 'qtx.example', retentionDays: 30, reviewStatus: 'APPROVED',
        allowedPurpose: ['discovery'], updatedAt: new Date('2026-08-30T00:00:00Z') }],
      lookup: fixture.lookup, plan,
      budgetAuthorization: { accountId: IDS.account, authorityId: IDS.authority,
        authorizedCapMicrousd: 0n, generation: 1 },
      budgetTruncated: false,
    })).rejects.toThrow('DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH');
  });

  it('atomically appends and updates the compatibility stats for a fresh zero result', async () => {
    const fixture = zeroCommitFixture();
    const update = vi.fn(async () => ({}));
    const usage = vi.fn(async () => ({}));
    const queryRaw = vi.fn(async (statement: { strings: readonly string[] }) => {
      const sql = statement.strings.join('?');
      if (sql.includes('append_discovery_query_lineage_v2')) return [{
        status: 'APPLIED', attempt_count: 0, item_count: 0, query_key: fixture.queryKey,
      }];
      if (sql.includes('FROM discovery_run')) return [{
        id: fixture.runId, plan_id: fixture.planId, stats: {},
      }];
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const tx = {
      $queryRaw: queryRaw,
      $executeRaw: vi.fn(),
      rawSourceRecord: { findMany: vi.fn() },
      discoveryRun: { update },
      usageLedger: { create: usage },
    };
    partitionMock.mockImplementationOnce(async (input) => ({
      status: 'APPLIED', companyFacts: [], auxiliaryFacts: [],
      value: await input.apply(input.transaction, [], []),
    }));
    await expect(commitGovernedDiscoveryQueryExecution({
      prisma: { withWorkspace: async (_workspaceId, callback) => callback(tx) } as never,
      workspaceId: IDS.workspace,
      runId: fixture.runId,
      planId: fixture.planId,
      queryKey: fixture.queryKey,
      sourceClass: 'public_intelligence',
      settled: [],
      sourcePolicies: [],
      lookup: fixture.lookup,
      plan: fixture.plan,
      budgetAuthorization: {
        accountId: IDS.account,
        authorityId: IDS.authority,
        authorizedCapMicrousd: 0n,
        generation: 1,
      },
      budgetTruncated: true,
    })).resolves.toMatchObject({
      rawCount: 0,
      budgetTruncated: true,
      queryReceipt: { providers: [] },
    });
    expect(update).toHaveBeenCalledOnce();
    expect(usage).not.toHaveBeenCalled();
  });

  it('uses identity-only v2 attest on partition replay with zero writes', async () => {
    const fixture = zeroCommitFixture();
    const update = vi.fn();
    const attestKey = projectDiscoveryQueryLineageAttestKey(fixture.lookup);
    const queryRaw = vi.fn(async (statement: { strings: readonly string[] }) => {
      expect(statement.strings.join('?')).toContain('attest_discovery_query_lineage_v2');
      return [{
        status: 'REPLAYED',
        query_receipt: {
          schemaVersion: 'discovery-query-receipt/v1', queryKey: fixture.queryKey,
          queryOrdinal: 0, sourceClass: 'public_intelligence', providers: [],
          accepted: 0, quarantined: 0, rejected: 0, governanceDenied: 0,
          duplicate: 0, usageQuantity: 0, costCents: 0,
        },
        budget_truncated: false,
        attempt_count: 0,
        item_count: 0,
        replay: true,
      }];
    });
    const tx = { $queryRaw: queryRaw, discoveryRun: { update } };
    partitionMock.mockImplementationOnce(async (input) => ({
      status: 'REPLAYED', companyFacts: [], auxiliaryFacts: [],
      value: await input.readback(input.transaction, [], []),
    }));
    await expect(commitGovernedDiscoveryQueryExecution({
      prisma: { withWorkspace: async (_workspaceId, callback) => callback(tx) } as never,
      workspaceId: IDS.workspace,
      runId: fixture.runId,
      planId: fixture.planId,
      queryKey: fixture.queryKey,
      sourceClass: 'public_intelligence',
      settled: [],
      sourcePolicies: [],
      lookup: fixture.lookup,
      plan: fixture.plan,
      budgetAuthorization: {
        accountId: IDS.account, authorityId: IDS.authority,
        authorizedCapMicrousd: 0n, generation: 1,
      },
      budgetTruncated: true,
    })).resolves.toMatchObject({ budgetTruncated: false });
    expect(attestKey).not.toHaveProperty('sourceClass');
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'run binding drift',
      updateError: null,
      expected: 'DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD',
    },
    {
      label: 'unknown stats write failure',
      updateError: new Error('database unavailable'),
      expected: 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_UNAVAILABLE',
    },
    {
      label: 'proxied secret-bearing error',
      updateError: new Proxy(new Error('secret@example.test'), {}),
      expected: 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_UNAVAILABLE',
    },
    {
      label: 'error subclass',
      updateError: new (class HostileError extends Error {})('private payload'),
      expected: 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_UNAVAILABLE',
    },
    {
      label: 'message accessor',
      updateError: (() => {
        const error = new Error();
        Object.defineProperty(error, 'message', {
          enumerable: false,
          get: () => { throw new Error('message trap'); },
        });
        return error;
      })(),
      expected: 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_UNAVAILABLE',
    },
  ])('maps $label to a stable control error', async ({ updateError, expected }) => {
    const fixture = zeroCommitFixture();
    const tx = {
      $queryRaw: vi.fn(async (statement: { strings: readonly string[] }) => {
        const sql = statement.strings.join('?');
        if (sql.includes('append_discovery_query_lineage_v2')) return [{
          status: 'APPLIED', attempt_count: 0, item_count: 0, query_key: fixture.queryKey,
        }];
        if (sql.includes('FROM discovery_run')) return updateError
          ? [{ id: fixture.runId, plan_id: fixture.planId, stats: {} }]
          : [];
        throw new Error('unexpected SQL');
      }),
      $executeRaw: vi.fn(),
      rawSourceRecord: { findMany: vi.fn() },
      discoveryRun: {
        update: vi.fn(async () => {
          if (updateError) throw updateError;
          return {};
        }),
      },
      usageLedger: { create: vi.fn() },
    };
    partitionMock.mockImplementationOnce(async (input) => ({
      status: 'APPLIED', companyFacts: [], auxiliaryFacts: [],
      value: await input.apply(input.transaction, [], []),
    }));
    await expect(commitGovernedDiscoveryQueryExecution({
      prisma: { withWorkspace: async (_workspaceId, callback) => callback(tx) } as never,
      workspaceId: IDS.workspace, runId: fixture.runId, planId: fixture.planId,
      queryKey: fixture.queryKey, sourceClass: 'public_intelligence', settled: [],
      sourcePolicies: [], lookup: fixture.lookup, plan: fixture.plan,
      budgetAuthorization: { accountId: IDS.account, authorityId: IDS.authority,
        authorizedCapMicrousd: 0n, generation: 1 },
      budgetTruncated: false,
    })).rejects.toThrow(expected);
  });

  it.each([
    { status: 'NOT_FOUND', budget: null, replay: false,
      expected: 'DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD' },
    { status: 'REPLAYED', budget: null, replay: true,
      expected: 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_UNAVAILABLE' },
  ])('holds an incomplete partition readback: $status/$budget', async (row) => {
    const fixture = zeroCommitFixture();
    const tx = { $queryRaw: vi.fn(async () => [{
      status: row.status,
      query_receipt: row.status === 'NOT_FOUND' ? null : {
        schemaVersion: 'discovery-query-receipt/v1', queryKey: fixture.queryKey,
        queryOrdinal: 0, sourceClass: 'public_intelligence', providers: [],
        accepted: 0, quarantined: 0, rejected: 0, governanceDenied: 0,
        duplicate: 0, usageQuantity: 0, costCents: 0,
      },
      budget_truncated: row.budget,
      attempt_count: 0,
      item_count: 0,
      replay: row.replay,
    }]) };
    partitionMock.mockImplementationOnce(async (input) => ({
      status: 'REPLAYED', companyFacts: [], auxiliaryFacts: [],
      value: await input.readback(input.transaction, [], []),
    }));
    await expect(commitGovernedDiscoveryQueryExecution({
      prisma: { withWorkspace: async (_workspaceId, callback) => callback(tx) } as never,
      workspaceId: IDS.workspace, runId: fixture.runId, planId: fixture.planId,
      queryKey: fixture.queryKey, sourceClass: 'public_intelligence', settled: [],
      sourcePolicies: [], lookup: fixture.lookup, plan: fixture.plan,
      budgetAuthorization: { accountId: IDS.account, authorityId: IDS.authority,
        authorizedCapMicrousd: 0n, generation: 1 },
      budgetTruncated: false,
    })).rejects.toThrow(row.expected);
  });
});
