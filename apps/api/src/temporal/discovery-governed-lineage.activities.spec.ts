import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { discoveryQueryKey } from '../discovery/discovery-query-receipt';
import { createDiscoveryActivities } from './discovery.activities';

const activitySource = readFileSync(new URL('./discovery.activities.ts', import.meta.url), 'utf8');
const governedSource = readFileSync(
  new URL('./discovery-query-governed-execution.ts', import.meta.url),
  'utf8',
);

function executeQueryBody(source: string): string {
  const start = source.indexOf('async executeQuery(');
  const boundary = source.indexOf('\n    async canonicalizeRun(', start);
  const end = boundary === -1 ? source.length : boundary;
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function expectOrdered(source: string, names: readonly string[]): void {
  let cursor = -1;
  for (const name of names) {
    const next = source.indexOf(name, cursor + 1);
    expect(next, `${name} must occur after the prior control`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

const reference = `
async executeQuery(args) {
  const parsedBinding = parseExecutionBudgetBinding(args.executionBudget);
  const lookup = buildDiscoveryQueryLineageLookup({ binding: parsedBinding });
  return withWorkspace(async (transaction) => {
    const prior = await attestQueryLineageV2(transaction, lookup);
    if (prior.status === 'REPLAYED') return replayDiscoveryQueryExecution(prior);
    if (prior.status !== 'NOT_FOUND') throw new ExecutionControlError('DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD');
    if (prior.status === 'NOT_FOUND') await budgetStore.attestAuthorized();
    await taxonomy.resolveMany();
    const selectedProviders = await providers.routeCompanyDiscovery();
    const providerPlan = buildDiscoveryQueryProviderPlan({ selectedProviders });
    if (providerPlan.mode === 'governed') executeQtxProviderPlan(providerPlan);
    else executeLegacyProviderPlan(selectedProviders);
    const partitions = applyPartitionedDomainAckConsumerTransactions({ companyAcknowledgements, auxiliaryAcknowledgements });
    const command = finalizeDiscoveryQueryLineageCommand({ ackFacts: partitions.companyFacts });
    if (partitions.status === 'APPLIED') await appendQueryLineageV2(transaction, command);
    if (partitions.status === 'REPLAYED') await attestQueryLineageV2(transaction, lookup);
  });
}`;

function assertActivityContract(source: string): void {
  const body = executeQueryBody(source);
  for (const symbol of [
    'buildDiscoveryQueryLineageLookup', 'attestQueryLineageV2',
    'buildDiscoveryQueryProviderPlan', 'finalizeDiscoveryQueryLineageCommand',
    'applyPartitionedDomainAckConsumerTransactions', 'appendQueryLineageV2',
  ]) expect(source).toContain(symbol);
  expectOrdered(body, [
    'parseExecutionBudgetBinding', 'buildDiscoveryQueryLineageLookup',
    'attestQueryLineageV2', "status === 'REPLAYED'", 'attestAuthorized',
    'taxonomy', 'routeCompanyDiscovery',
  ]);
  expect(body).toMatch(/status\s*===\s*['"]NOT_FOUND['"][\s\S]{0,500}attestAuthorized/u);
  expect(body).toMatch(/mode\s*===\s*['"]governed['"][\s\S]{0,500}(?:Qtx|QTX|qtx)/u);
  expect(body).toMatch(/else[\s\S]{0,300}(?:Legacy|legacy)/u);
  expect(body).toMatch(/companyAcknowledgements[\s\S]{0,300}auxiliaryAcknowledgements/u);
  expect(body).toMatch(/finalizeDiscoveryQueryLineageCommand[\s\S]{0,500}companyFacts/u);
  expect(body).toMatch(/status\s*===\s*['"]APPLIED['"][\s\S]{0,300}appendQueryLineageV2/u);
  expect(body).toMatch(/status\s*===\s*['"]REPLAYED['"][\s\S]{0,300}attestQueryLineageV2/u);
  expect(body).toContain('DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD');
}

describe('executeQuery governed query-lineage activity contract', () => {
  it('accepts the locked reference orchestration', () => assertActivityContract(reference));

  it('attests immutable lookup identity before budget, taxonomy, routing, or provider work', () => {
    const body = executeQueryBody(activitySource);
    expectOrdered(body, [
      'parseExecutionBudgetBinding', 'buildDiscoveryQueryLineageLookup',
      'attestQueryLineageV2', "status === 'REPLAYED'", 'attestAuthorized',
      'taxonomy', 'routeCompanyDiscovery',
    ]);
    expect(body).toMatch(/status\s*===\s*['"]REPLAYED['"][\s\S]{0,350}return/u);
    expect(body).toMatch(/prior\.budgetTruncated[\s\S]{0,120}return|return[\s\S]{0,120}prior\.budgetTruncated/u);
  });

  it('uses QTX only when every selected provider is lineage-capable and propagates controls', () => {
    const body = executeQueryBody(activitySource);
    expect(body).toContain('buildGovernedDiscoveryQueryExecutionPlan');
    expect(body).toContain('commitGovernedDiscoveryQueryExecution');
    expect(governedSource).toContain('buildDiscoveryQueryProviderPlan');
    expect(governedSource).toMatch(/mode:\s*['"]legacy['"]/u);
    expect(governedSource).toMatch(/mode:\s*['"]governed['"]/u);
    expect(body).toMatch(/isExecutionControlError[\s\S]{0,120}throw/u);
  });

  it('partitions ACK facts and commits lineage by APPLIED or REPLAYED state', () => {
    for (const symbol of [
      'buildDiscoveryQueryProviderPlan',
      'applyPartitionedDomainAckConsumerTransactions',
      'finalizeDiscoveryQueryLineageCommand',
      'appendQueryLineageV2',
      'attestQueryLineageV2',
    ]) expect(governedSource).toContain(symbol);
  });

  it('passes the exact index resolutions, raw receipts, zero-company, and auxiliary facts to finalization', () => {
    const body = governedSource;
    for (const field of [
      'resolutions', 'rawReceipts', 'queryReceipt', 'auxiliaryOperationIds',
      'companyFacts', 'auxiliaryReceipts',
    ]) expect(body).toContain(field);
    expect(body).toMatch(/recordIndex[\s\S]{0,400}(?:WRITE|EXISTING|REUSE_BATCH)/u);
  });

  it('holds historical lineage, never retries UNKNOWN, and keeps stats/usage inside the append transaction', () => {
    const activityBody = executeQueryBody(activitySource);
    const body = governedSource;
    expect(body).toContain('DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD');
    expect(activityBody).toMatch(/UNKNOWN[\s\S]{0,300}(?:throw|HOLD)/u);
    expect(activityBody).not.toMatch(/UNKNOWN[\s\S]{0,500}discoverCompanies/u);
    expect(body).toMatch(/applyPartitionedDomainAckConsumerTransactions[\s\S]*discoveryRun\.update/u);
    expect(body).toMatch(/applyPartitionedDomainAckConsumerTransactions[\s\S]*usageLedger\.create/u);
  });

  it('keeps the frozen Temporal executeQuery command and result surface', () => {
    expect(activitySource).toContain('async executeQuery(args: DiscoveryActivityInput & {');
    expect(activitySource).toContain('}): Promise<DiscoveryQueryExecutionResult>');
    expect(activitySource).not.toContain('executeGovernedQuery');
  });

  it('replays the persisted truncation fact before budget or provider access', async () => {
    const workspaceId = '10000000-0000-4000-8000-000000000001';
    const runId = '20000000-0000-4000-8000-000000000001';
    const planId = '30000000-0000-4000-8000-000000000001';
    const query = Object.freeze({
      source_class: 'public_intelligence',
      filters: Object.freeze({ country: 'DE' }),
      keywords: Object.freeze(['pump']) as unknown as string[],
      priority: 1,
    });
    const queryKey = discoveryQueryKey({ runId, planId, queryOrdinal: 0, query });
    const route = vi.fn();
    const attestAuthorized = vi.fn();
    const status = vi.fn();
    const activities = createDiscoveryActivities({
      prisma: {
        withWorkspace: vi.fn(async (_workspaceId, callback) => callback({
          $queryRaw: vi.fn(async () => [{
            status: 'REPLAYED',
            query_receipt: {
              schemaVersion: 'discovery-query-receipt/v1',
              queryKey,
              queryOrdinal: 0,
              sourceClass: 'public_intelligence',
              providers: ['public_web'],
              accepted: 1,
              quarantined: 0,
              rejected: 0,
              governanceDenied: 0,
              duplicate: 0,
              usageQuantity: 1,
              costCents: 2,
            },
            budget_truncated: true,
            attempt_count: 1,
            item_count: 1,
            replay: true,
          }]),
        })),
      },
      providers: { routeCompanyDiscovery: route },
      gateway: {},
      budgetStore: { attestAuthorized, status },
    } as never);
    const requestSha256 = 'a'.repeat(64);
    await expect(activities.executeQuery({
      workspaceId,
      runId,
      planId,
      queryOrdinal: 0,
      queryReceiptMode: 'raw-governance-query-receipt/v1',
      query,
      executionContractVersion: 2,
      executionBudget: {
        authorityId: '40000000-0000-4000-8000-000000000001',
        replay: false,
        scopeKey: workspaceId,
        accountKey: `discovery.run:discovery_run:request:${requestSha256}:${requestSha256}`,
        purpose: 'discovery.run',
        subjectType: 'discovery_run',
        subjectId: `request:${requestSha256}`,
        requestSha256,
      },
    })).resolves.toMatchObject({
      rawCount: 1,
      costCents: 2,
      budgetTruncated: true,
    });
    expect(attestAuthorized).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
  });
});
