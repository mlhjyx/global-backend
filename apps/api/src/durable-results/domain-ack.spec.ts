import { describe, expect, it, vi } from 'vitest';
import type { DurableExecutionReceipt } from './durable-execution-receipt';
import {
  DomainAckService,
  InMemoryDomainAckRepository,
} from './domain-ack';

const UUID_A = '42c863b9-7c7e-4d28-8678-60ef9a20219b';
const UUID_B = '5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0';
const UUID_C = '1b3d6096-b924-4bc8-bb4f-8436efb37b07';

function receipt(
  overrides: Partial<DurableExecutionReceipt> = {},
): DurableExecutionReceipt {
  return {
    schemaVersion: 'durable-execution-receipt/v1',
    scopeKey: 'workspace-1',
    authorityId: UUID_A,
    accountId: UUID_B,
    operationId: UUID_C,
    operationKey: 'workspace:model:taxonomy.normalize:request-1',
    resultStrategy: 'typed_projection',
    resultSchema: 'taxonomy-code/v1',
    resultDigest: 'a'.repeat(64),
    artifactId: null,
    usage: {
      currency: 'USD',
      unit: 'microusd',
      callCount: 1,
      chargedMicrousd: '0',
      upperBoundMicrousd: '0',
    },
    costBasis: 'estimated_upper_bound',
    ...overrides,
  };
}

describe('DomainAckService', () => {
  it('applies once and replays the same ack without running the consumer twice', async () => {
    const service = new DomainAckService(new InMemoryDomainAckRepository());
    const apply = vi.fn(async () => ({ code: 'CPV-123' }));
    const input = {
      receipt: receipt(),
      consumer: 'TaxonomyResolver',
      domainAggregateType: 'TermAlias',
      domainAckKey: 'taxonomy:cpv:pump',
    } as const;

    await expect(service.applyWithAck(input, apply)).resolves.toMatchObject({
      status: 'APPLIED',
      value: { code: 'CPV-123' },
      ack: {
        consumer: 'TaxonomyResolver',
        domainAggregateType: 'TermAlias',
        domainAckKey: 'taxonomy:cpv:pump',
        resultDigest: 'a'.repeat(64),
      },
    });
    await expect(service.applyWithAck(input, apply)).resolves.toMatchObject({
      status: 'REPLAYED',
      value: undefined,
      ack: {
        operationId: UUID_C,
        domainAckKey: 'taxonomy:cpv:pump',
      },
    });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('throws a stable conflict when the same receipt is acked against a different domain key', async () => {
    const service = new DomainAckService(new InMemoryDomainAckRepository());
    const apply = vi.fn(async () => undefined);
    const base = {
      receipt: receipt(),
      consumer: 'TaxonomyResolver',
      domainAggregateType: 'TermAlias',
    } as const;

    await service.applyWithAck({ ...base, domainAckKey: 'taxonomy:cpv:pump' }, apply);

    await expect(
      service.applyWithAck({ ...base, domainAckKey: 'taxonomy:cpv:valve' }, apply),
    ).rejects.toMatchObject({ code: 'DOMAIN_ACK_CONFLICT' });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('rejects PII-like ACK keys and never stores receipt payload fields', async () => {
    const repository = new InMemoryDomainAckRepository();
    const service = new DomainAckService(repository);
    await expect(
      service.applyWithAck({
        receipt: receipt(),
        consumer: 'ContactDecisionMaker',
        domainAggregateType: 'Contact',
        domainAckKey: 'person:ada@example.test',
      }, async () => undefined),
    ).rejects.toThrow('DOMAIN_ACK_INVALID');
    expect(repository.snapshot()).toEqual([]);
  });
});
