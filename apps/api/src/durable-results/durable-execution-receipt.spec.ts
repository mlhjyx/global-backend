import { describe, expect, it } from 'vitest';
import {
  parseDurableExecutionReceipt,
  type DurableExecutionReceipt,
} from './durable-execution-receipt';

const UUID_A = '42c863b9-7c7e-4d28-8678-60ef9a20219b';
const UUID_B = '5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0';
const UUID_C = '1b3d6096-b924-4bc8-bb4f-8436efb37b07';
const DIGEST = 'a'.repeat(64);

function receipt(
  overrides: Partial<DurableExecutionReceipt> = {},
): DurableExecutionReceipt {
  return {
    schemaVersion: 'durable-execution-receipt/v1',
    scopeKey: 'e03abddd-1307-47cb-a731-7e7a786615a0',
    authorityId: UUID_A,
    accountId: UUID_B,
    operationId: UUID_C,
    operationKey: 'workspace:model:taxonomy.normalize:request-1',
    resultStrategy: 'typed_projection',
    resultSchema: 'taxonomy-code/v1',
    resultDigest: DIGEST,
    artifactId: null,
    usage: {
      currency: 'USD',
      unit: 'microusd',
      callCount: 1,
      inputTokens: 12,
      outputTokens: 3,
      chargedMicrousd: '25',
      upperBoundMicrousd: '100',
    },
    costBasis: 'estimated_upper_bound',
    ...overrides,
  };
}

describe('DurableExecutionReceipt', () => {
  it('parses a closed typed-projection receipt and freezes the result', () => {
    const parsed = parseDurableExecutionReceipt(receipt());

    expect(parsed).toMatchObject({
      resultStrategy: 'typed_projection',
      resultSchema: 'taxonomy-code/v1',
      artifactId: null,
      costBasis: 'estimated_upper_bound',
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.usage)).toBe(true);
  });

  it('requires artifact receipts to carry the exact artifact ID only for artifact strategy', () => {
    expect(() =>
      parseDurableExecutionReceipt(receipt({ artifactId: UUID_A })),
    ).toThrow('DURABLE_EXECUTION_RECEIPT_INVALID');

    expect(() =>
      parseDurableExecutionReceipt(
        receipt({
          resultStrategy: 'artifact_reference',
          resultSchema: 'http-get/v1',
          artifactId: null,
        }),
      ),
    ).toThrow('DURABLE_EXECUTION_RECEIPT_INVALID');

    expect(
      parseDurableExecutionReceipt(
        receipt({
          resultStrategy: 'artifact_reference',
          resultSchema: 'http-get/v1',
          artifactId: 'artifact:tenant-a/http-get/sha256-aaaa',
        }),
      ).artifactId,
    ).toBe('artifact:tenant-a/http-get/sha256-aaaa');
  });

  it.each([
    'body',
    'data',
    'prompt',
    'reasoning',
    'rawResponse',
    'responseBody',
    'credential',
    'compactToken',
    'email',
  ])('rejects forbidden payload field %s', (field) => {
    expect(() =>
      parseDurableExecutionReceipt({ ...receipt(), [field]: 'forbidden' }),
    ).toThrow('DURABLE_EXECUTION_RECEIPT_INVALID');
  });

  it('rejects unknown receipt and usage fields', () => {
    expect(() =>
      parseDurableExecutionReceipt({ ...receipt(), unknown: true }),
    ).toThrow('DURABLE_EXECUTION_RECEIPT_INVALID');
    expect(() =>
      parseDurableExecutionReceipt({
        ...receipt(),
        usage: { ...receipt().usage, rawRows: 1 },
      }),
    ).toThrow('DURABLE_EXECUTION_RECEIPT_INVALID');
  });

  it('keeps BigQuery cost facts bounded and decimal-string based', () => {
    const parsed = parseDurableExecutionReceipt(
      receipt({
        resultSchema: 'google-patents-search/v1',
        costBasis: 'provider_reported',
        usage: {
          currency: 'USD',
          unit: 'microusd',
          callCount: 1,
          bytesProcessed: '123456',
          bytesBilled: '1048576',
          maximumBytesBilled: '214748364800',
          chargedMicrousd: '0',
        },
      }),
    );

    expect(parsed.usage.bytesProcessed).toBe('123456');
    expect(() =>
      parseDurableExecutionReceipt(
        receipt({
          usage: {
            currency: 'USD',
            unit: 'microusd',
            bytesProcessed: '1.5',
          },
        }),
      ),
    ).toThrow('DURABLE_EXECUTION_RECEIPT_INVALID');
  });

  it.each([
    [
      'not_incurred',
      receipt({
        costBasis: 'not_incurred',
        usage: {
          currency: 'USD',
          unit: 'microusd',
          callCount: 0,
          chargedMicrousd: '0',
          upperBoundMicrousd: '0',
        },
      }),
    ],
    [
      'provider_reported',
      receipt({
        costBasis: 'provider_reported',
        usage: {
          currency: 'USD',
          unit: 'microusd',
          callCount: 1,
          chargedMicrousd: '42',
        },
      }),
    ],
    [
      'token_pricing',
      receipt({
        costBasis: 'token_pricing',
        usage: {
          currency: 'USD',
          unit: 'microusd',
          callCount: 1,
          inputTokens: 10,
          outputTokens: 4,
          chargedMicrousd: '14',
          upperBoundMicrousd: '20',
        },
      }),
    ],
  ])('accepts internally consistent %s cost facts', (_name, candidate) => {
    expect(parseDurableExecutionReceipt(candidate).costBasis).toBe(candidate.costBasis);
  });

  it.each([
    [
      'not_incurred cannot claim a wire call or charge',
      receipt({
        costBasis: 'not_incurred',
        usage: {
          currency: 'USD',
          unit: 'microusd',
          callCount: 1,
          chargedMicrousd: '1',
          upperBoundMicrousd: '1',
        },
      }),
    ],
    [
      'charged microusd cannot exceed the upper bound',
      receipt({
        usage: {
          currency: 'USD',
          unit: 'microusd',
          callCount: 1,
          chargedMicrousd: '101',
          upperBoundMicrousd: '100',
        },
      }),
    ],
    [
      'bytes billed cannot exceed maximumBytesBilled',
      receipt({
        resultSchema: 'google-patents-search/v1',
        usage: {
          currency: 'USD',
          unit: 'microusd',
          callCount: 1,
          bytesProcessed: '214748364801',
          bytesBilled: '214748364801',
          maximumBytesBilled: '214748364800',
          chargedMicrousd: '0',
          upperBoundMicrousd: '0',
        },
      }),
    ],
    [
      'token pricing requires token facts',
      receipt({
        costBasis: 'token_pricing',
        usage: {
          currency: 'USD',
          unit: 'microusd',
          callCount: 1,
          chargedMicrousd: '10',
          upperBoundMicrousd: '10',
        },
      }),
    ],
    [
      'provider reported cost requires a charged amount',
      receipt({
        costBasis: 'provider_reported',
        usage: {
          currency: 'USD',
          unit: 'microusd',
          callCount: 1,
        },
      }),
    ],
    [
      'estimated upper bound requires an upper bound amount',
      receipt({
        costBasis: 'estimated_upper_bound',
        usage: {
          currency: 'USD',
          unit: 'microusd',
          callCount: 1,
          chargedMicrousd: '0',
        },
      }),
    ],
    [
      'estimated upper bound requires a wire call',
      receipt({
        costBasis: 'estimated_upper_bound',
        usage: {
          currency: 'USD',
          unit: 'microusd',
          callCount: 0,
          chargedMicrousd: '0',
          upperBoundMicrousd: '0',
        },
      }),
    ],
    [
      'google patents receipts require maximumBytesBilled',
      receipt({
        resultSchema: 'google-patents-search/v1',
        costBasis: 'estimated_upper_bound',
        usage: {
          currency: 'USD',
          unit: 'microusd',
          callCount: 1,
          chargedMicrousd: '0',
          upperBoundMicrousd: '0',
        },
      }),
    ],
    [
      'google patents provider-reported byte receipts require observed bytes',
      receipt({
        resultSchema: 'google-patents-search/v1',
        costBasis: 'provider_reported',
        usage: {
          currency: 'USD',
          unit: 'microusd',
          callCount: 1,
          chargedMicrousd: '0',
          maximumBytesBilled: '214748364800',
        },
      }),
    ],
  ])('rejects contradictory usage/cost facts: %s', (_name, candidate) => {
    expect(() => parseDurableExecutionReceipt(candidate)).toThrow(
      'DURABLE_EXECUTION_RECEIPT_INVALID',
    );
  });
});
