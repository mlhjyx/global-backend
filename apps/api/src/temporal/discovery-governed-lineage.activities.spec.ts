import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const activitySource = readFileSync(new URL('./discovery.activities.ts', import.meta.url), 'utf8');

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
    const prior = await attestQueryLineageV1(transaction, lookup);
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
    if (partitions.status === 'APPLIED') await appendQueryLineageV1(transaction, command);
    if (partitions.status === 'REPLAYED') await attestQueryLineageV1(transaction, lookup);
  });
}`;

function assertActivityContract(source: string): void {
  const body = executeQueryBody(source);
  for (const symbol of [
    'buildDiscoveryQueryLineageLookup', 'attestQueryLineageV1',
    'buildDiscoveryQueryProviderPlan', 'finalizeDiscoveryQueryLineageCommand',
    'applyPartitionedDomainAckConsumerTransactions', 'appendQueryLineageV1',
  ]) expect(source).toContain(symbol);
  expectOrdered(body, [
    'parseExecutionBudgetBinding', 'buildDiscoveryQueryLineageLookup',
    'attestQueryLineageV1', "status === 'REPLAYED'", 'attestAuthorized',
    'taxonomy', 'routeCompanyDiscovery',
  ]);
  expect(body).toMatch(/status\s*===\s*['"]NOT_FOUND['"][\s\S]{0,500}attestAuthorized/u);
  expect(body).toMatch(/mode\s*===\s*['"]governed['"][\s\S]{0,500}(?:Qtx|QTX|qtx)/u);
  expect(body).toMatch(/else[\s\S]{0,300}(?:Legacy|legacy)/u);
  expect(body).toMatch(/companyAcknowledgements[\s\S]{0,300}auxiliaryAcknowledgements/u);
  expect(body).toMatch(/finalizeDiscoveryQueryLineageCommand[\s\S]{0,500}companyFacts/u);
  expect(body).toMatch(/status\s*===\s*['"]APPLIED['"][\s\S]{0,300}appendQueryLineageV1/u);
  expect(body).toMatch(/status\s*===\s*['"]REPLAYED['"][\s\S]{0,300}attestQueryLineageV1/u);
  expect(body).toContain('DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD');
}

describe('executeQuery governed query-lineage activity contract', () => {
  it('accepts the locked reference orchestration', () => assertActivityContract(reference));

  it('attests immutable lookup identity before budget, taxonomy, routing, or provider work', () => {
    const body = executeQueryBody(activitySource);
    expectOrdered(body, [
      'parseExecutionBudgetBinding', 'buildDiscoveryQueryLineageLookup',
      'attestQueryLineageV1', "status === 'REPLAYED'", 'attestAuthorized',
      'taxonomy', 'routeCompanyDiscovery',
    ]);
    expect(body).toMatch(/status\s*===\s*['"]REPLAYED['"][\s\S]{0,350}return/u);
  });

  it('uses QTX only when every selected provider is lineage-capable and propagates controls', () => {
    const body = executeQueryBody(activitySource);
    expect(body).toContain('buildDiscoveryQueryProviderPlan');
    expect(body).toMatch(/mode\s*===\s*['"]governed['"][\s\S]{0,500}(?:Qtx|QTX|qtx)/u);
    expect(body).toMatch(/mode\s*===\s*['"]legacy['"][\s\S]{0,500}(?:Legacy|legacy)/u);
    expect(body).toMatch(/isExecutionControlError[\s\S]{0,120}throw/u);
  });

  it('partitions ACK facts and commits lineage by APPLIED or REPLAYED state', () => {
    assertActivityContract(activitySource);
  });

  it('passes the exact index resolutions, raw receipts, zero-company, and auxiliary facts to finalization', () => {
    const body = executeQueryBody(activitySource);
    for (const field of [
      'resolutions', 'rawReceipts', 'queryReceipt', 'auxiliaryOperationIds',
      'companyFacts', 'auxiliaryFacts',
    ]) expect(body).toContain(field);
    expect(body).toMatch(/records\.length\s*===\s*0[\s\S]{0,600}(?:direct|auxiliary|zero)/iu);
    expect(body).toMatch(/recordIndex[\s\S]{0,400}(?:WRITE|EXISTING|REUSE_BATCH)/u);
  });

  it('holds historical lineage, never retries UNKNOWN, and keeps stats/usage inside the append transaction', () => {
    const body = executeQueryBody(activitySource);
    expect(body).toContain('DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD');
    expect(body).toMatch(/UNKNOWN[\s\S]{0,300}(?:throw|HOLD)/u);
    expect(body).not.toMatch(/UNKNOWN[\s\S]{0,500}discoverCompanies/u);
    expect(body).toMatch(/applyPartitionedDomainAckConsumerTransactions[\s\S]*discoveryRun\.update/u);
    expect(body).toMatch(/applyPartitionedDomainAckConsumerTransactions[\s\S]*usageLedger\.create/u);
  });

  it('keeps the frozen Temporal executeQuery command and result surface', () => {
    expect(activitySource).toContain('async executeQuery(args: DiscoveryActivityInput & {');
    expect(activitySource).toContain('}): Promise<DiscoveryQueryExecutionResult>');
    expect(activitySource).not.toContain('executeGovernedQuery');
  });
});
