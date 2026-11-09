import { describe, expect, it } from 'vitest';
import { parseDiscoveryCompanyResultLineage } from '../discovery/company-discovery-lineage';
import type { ProviderCompanyRecord } from '../discovery/provider-contract';
import {
  parseDurableExecutionReceipt,
  parseDurableExecutionReceiptFacts,
} from '../durable-results/durable-execution-receipt';
import {
  REGISTRY_QUERY_PRODUCER_ID,
  REGISTRY_QUERY_RESULT_SCHEMA,
  buildRegistryLocalQueryReceipt,
  buildRegistryQueryLineage,
  canonicalJson,
  deterministicUuid,
  registryQueryDigest,
} from './local-query-receipt';

const AUTHORITY = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';

const record = (overrides: Partial<ProviderCompanyRecord> = {}): ProviderCompanyRecord => ({
  externalId: 'fr_siren:529990001',
  name: 'POMPES MARTIN SAS',
  country: 'FR',
  identifier: { scheme: 'fr_siren', value: '529990001' },
  license: 'Licence-Ouverte-2.0',
  attributes: { registry: { scheme: 'fr_siren', nace: '28.13' } },
  ...overrides,
});

function receiptFor(records: ProviderCompanyRecord[], queryDigest = 'a'.repeat(64)) {
  return buildRegistryLocalQueryReceipt({
    workspaceId: AUTHORITY,
    authorityId: AUTHORITY,
    accountId: ACCOUNT,
    runId: RUN,
    queryDigest,
    records,
  });
}

describe('canonicalJson / registryQueryDigest', () => {
  it('is key-order insensitive and distinguishes content', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }),
    );
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });

  it('derives the query digest from filters/keywords/limit only', () => {
    const base = { filters: { country: 'FR', nace_prefix: ['28'] }, keywords: ['pump'], limit: 25 };
    expect(registryQueryDigest(base)).toBe(
      registryQueryDigest({ ...base, filters: { nace_prefix: ['28'], country: 'FR' } }),
    );
    expect(registryQueryDigest(base)).not.toBe(registryQueryDigest({ ...base, limit: 50 }));
    expect(registryQueryDigest(base)).not.toBe(
      registryQueryDigest({ ...base, keywords: ['valve'] }),
    );
  });
});

describe('deterministicUuid', () => {
  it('is a stable RFC-4122 v5-shaped UUID', () => {
    const hex = 'f'.repeat(64);
    const first = deterministicUuid(hex);
    expect(first).toBe(deterministicUuid(hex));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(first).not.toBe(deterministicUuid('e'.repeat(64)));
  });
});

describe('buildRegistryLocalQueryReceipt', () => {
  it('produces a durable receipt that passes the strict parser, with zero cost', () => {
    const receipt = receiptFor([record()]);
    const parsed = parseDurableExecutionReceipt(receipt);
    expect(parsed).toMatchObject({
      schemaVersion: 'durable-execution-receipt/v1',
      resultStrategy: 'typed_projection',
      resultSchema: REGISTRY_QUERY_RESULT_SCHEMA,
      artifactId: null,
      costBasis: 'not_incurred',
      status: 'SETTLED',
      authorityId: AUTHORITY,
      accountId: ACCOUNT,
    });
    expect(parsed.operationKey.startsWith('registry.query:')).toBe(true);
    const facts = parseDurableExecutionReceiptFacts(
      { usage: receipt.usage, costBasis: receipt.costBasis },
      receipt.resultSchema,
    );
    expect(facts.usage.callCount).toBe(0);
    expect(facts.usage.chargedMicrousd).toBe('0');
  });

  it('derives a deterministic operation identity and a record-sensitive result digest', () => {
    const first = receiptFor([record(), record({ externalId: 'fr_siren:529990002' })]);
    const second = receiptFor([record(), record({ externalId: 'fr_siren:529990002' })]);
    expect(second.operationId).toBe(first.operationId);
    expect(second.resultDigest).toBe(first.resultDigest);
    const changed = receiptFor([record({ name: 'POMPES MARTIN SAS RENOMMEE' })]);
    expect(changed.resultDigest).not.toBe(first.resultDigest);
    // 属性键序不影响 digest。
    const reordered = receiptFor([
      record({ attributes: { registry: { nace: '28.13', scheme: 'fr_siren' } } }),
    ]);
    expect(reordered.resultDigest).toBe(receiptFor([record()]).resultDigest);
  });
});

describe('buildRegistryQueryLineage', () => {
  it('covers every record with the single local receipt and parses under the closed validator', () => {
    const records = [record(), record({ externalId: 'fr_siren:529990002' })];
    const receipt = receiptFor(records);
    const lineage = buildRegistryQueryLineage(receipt, records.length);
    const parsed = parseDiscoveryCompanyResultLineage(lineage, 'registry_frame');
    expect(parsed.recordCount).toBe(2);
    expect(parsed.attemptReceipts).toEqual([]);
    expect(parsed.receiptCoverage).toHaveLength(1);
    expect(parsed.receiptCoverage[0]).toMatchObject({
      producerId: REGISTRY_QUERY_PRODUCER_ID,
      recordIndexes: [0, 1],
    });
    expect(parsed.receiptCoverage[0]!.receipt.operationId).toBe(receipt.operationId);
  });

  it('represents empty results as a valid empty lineage', () => {
    const parsed = parseDiscoveryCompanyResultLineage(
      buildRegistryQueryLineage(receiptFor([]), 0),
      'registry_frame',
    );
    expect(parsed.recordCount).toBe(0);
    expect(parsed.receiptCoverage).toEqual([]);
  });
});
