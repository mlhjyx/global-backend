import { describe, expect, it } from 'vitest';
import {
  parseDurableExecutionReceipt,
  type DurableExecutionReceipt,
} from './durable-execution-receipt';

const UUIDS = Object.freeze({
  authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
  accountId: '486eb66b-67d3-46c3-a358-637b3650038d',
  operationId: '9efb3b8d-b32d-472e-a594-679b5f43bf41',
  artifactId: '892b2e0e-990a-4c66-89d9-2ce467a0da4d',
});

const typedReceipt = Object.freeze({
  schemaVersion: 'durable-execution-receipt/v1',
  scopeKey: 'workspace:8baedc78-9082-4b95-b888-4b18eb326d13',
  authorityId: UUIDS.authorityId,
  accountId: UUIDS.accountId,
  operationId: UUIDS.operationId,
  operationKey: 'model:icp.design:request:2c52d430',
  resultStrategy: 'typed_projection',
  resultSchema: 'icp-design/v1',
  resultDigest: 'a'.repeat(64),
  artifactId: null,
  usage: Object.freeze({
    currency: 'USD',
    unit: 'microusd',
    callCount: 1,
    inputTokens: 120,
    outputTokens: 45,
    chargedMicrousd: '3141',
    upperBoundMicrousd: '5000',
  }),
  costBasis: 'token_pricing',
  status: 'SETTLED',
}) satisfies DurableExecutionReceipt;

describe('durable execution receipt contract', () => {
  it('parses a closed immutable typed receipt with accounting-only token counts', () => {
    const parsed = parseDurableExecutionReceipt(typedReceipt);
    expect(parsed).toEqual(typedReceipt);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.usage)).toBe(true);
  });

  it('requires artifactId exactly for artifact_reference receipts', () => {
    expect(parseDurableExecutionReceipt({
      ...typedReceipt,
      resultStrategy: 'artifact_reference',
      resultSchema: 'http-get/v1',
      artifactId: UUIDS.artifactId,
      usage: {
        currency: 'USD', unit: 'microusd', callCount: 1,
        bytesProcessed: '2048', bytesBilled: '4096',
        maximumBytesBilled: '214748364800', chargedMicrousd: '0',
        upperBoundMicrousd: '0',
      },
      costBasis: 'provider_reported',
    })).toMatchObject({ artifactId: UUIDS.artifactId });
    expect(() => parseDurableExecutionReceipt({
      ...typedReceipt,
      resultStrategy: 'artifact_reference',
      resultSchema: 'http-get/v1',
    })).toThrow('DURABLE_EXECUTION_RECEIPT_INVALID');
    expect(() => parseDurableExecutionReceipt({
      ...typedReceipt,
      artifactId: UUIDS.artifactId,
    })).toThrow('DURABLE_EXECUTION_RECEIPT_INVALID');
  });

  it.each([
    'body', 'prompt', 'reasoning', 'rawResponse', 'response', 'responseBody',
    'token', 'email', 'credential', 'credentials',
  ])('rejects forbidden payload field %s at every receipt boundary', (field) => {
    expect(() => parseDurableExecutionReceipt({ ...typedReceipt, [field]: 'secret' }))
      .toThrow('DURABLE_EXECUTION_RECEIPT_INVALID');
    expect(() => parseDurableExecutionReceipt({
      ...typedReceipt,
      usage: { ...typedReceipt.usage, [field]: 'secret' },
    })).toThrow('DURABLE_EXECUTION_RECEIPT_INVALID');
  });

  it('rejects unknown fields, invalid status, non-canonical amounts and impossible usage', () => {
    for (const candidate of [
      { ...typedReceipt, extra: true },
      { ...typedReceipt, status: 'RESULT_UNKNOWN' },
      { ...typedReceipt, usage: { ...typedReceipt.usage, chargedMicrousd: '03' } },
      { ...typedReceipt, usage: { ...typedReceipt.usage, chargedMicrousd: '5001' } },
      { ...typedReceipt, usage: { ...typedReceipt.usage, inputTokens: -1 } },
      { ...typedReceipt, resultDigest: 'A'.repeat(64) },
    ]) {
      expect(() => parseDurableExecutionReceipt(candidate))
        .toThrow('DURABLE_EXECUTION_RECEIPT_INVALID');
    }
  });
});

