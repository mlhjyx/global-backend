import { afterEach, describe, expect, it } from 'vitest';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';
import { legacyDiscoveryQueryAcknowledgements } from './discovery-query-governed-execution';

function sampleReceipt(operationId: string): DurableExecutionReceipt {
  return {
    schemaVersion: 'durable-execution-receipt/v1',
    operationId,
    operationKey: `local:${operationId}`,
    authorityId: '00000000-0000-4000-8000-000000000001',
    accountId: '00000000-0000-4000-8000-000000000002',
    scopeKey: '10000000-0000-4000-8000-000000000001',
    resultStrategy: 'typed_projection',
    resultSchema: 'channel-catalog-query/v1',
    resultDigest: 'a'.repeat(64),
    artifactId: null,
    usage: { inputTokens: 0, outputTokens: 0, estimatedMicrousd: 0, actualMicrousd: 0 },
    costBasis: 'not_incurred',
  };
}

describe('legacyDiscoveryQueryAcknowledgements bypass guard', () => {
  const originalMode = process.env.LEGACY_EXECUTION_BUDGET_MODE;

  afterEach(() => {
    if (originalMode === undefined) delete process.env.LEGACY_EXECUTION_BUDGET_MODE;
    else process.env.LEGACY_EXECUTION_BUDGET_MODE = originalMode;
  });

  const settled = [
    {
      status: 'fulfilled' as const,
      value: {
        key: 'channel_catalog',
        r: { records: [], costCents: 0 },
        durableReceipts: [
          {
            producerId: 'channel_catalog.query',
            receipt: sampleReceipt('20000000-0000-4000-8000-000000000001'),
          },
        ],
      },
    },
    {
      status: 'fulfilled' as const,
      value: {
        key: 'registry_frame',
        r: { records: [], costCents: 0 },
        durableReceipts: [
          {
            producerId: 'registry.query',
            receipt: sampleReceipt('20000000-0000-4000-8000-000000000002'),
          },
        ],
      },
    },
  ];

  it('omits synthetic local_query receipts under LEGACY_EXECUTION_BUDGET_MODE=bypass', () => {
    process.env.LEGACY_EXECUTION_BUDGET_MODE = 'bypass';
    expect(legacyDiscoveryQueryAcknowledgements(settled, 'run-1', 'q-1')).toEqual([]);
  });

  it('preserves receipts verbatim when bypass mode is off', () => {
    process.env.LEGACY_EXECUTION_BUDGET_MODE = 'enforce';
    const acks = legacyDiscoveryQueryAcknowledgements(settled, 'run-1', 'q-1');
    expect(acks).toHaveLength(2);
    expect(acks[0]?.producerId).toBe('channel_catalog.query');
    expect(acks[0]?.domainAckKey).toBe('run-1:q-1:channel_catalog:20000000-0000-4000-8000-000000000001');
    expect(acks[1]?.producerId).toBe('registry.query');
  });
});
