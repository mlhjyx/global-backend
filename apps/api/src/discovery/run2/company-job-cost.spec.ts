import { describe, expect, it, vi } from 'vitest';
import type { DurableExecutionReceipt } from '../../durable-results/durable-execution-receipt';
import {
  flattenSignalReceipts,
  microusdToCostCentsCeil,
  recordCompanyJobCostCents,
  sumReceiptMicrousd,
} from './company-job-cost';

function fakeReceipt(operationId: string, chargedMicrousd?: string): DurableExecutionReceipt {
  return {
    schemaVersion: 'durable-execution-receipt/v1',
    scopeKey: 'ws-1',
    authorityId: 'auth-1',
    accountId: 'acc-1',
    operationId,
    operationKey: `op:${operationId}`,
    resultStrategy: 'typed_projection',
    resultSchema: 'fit-judgment/v1',
    resultDigest: 'a'.repeat(64),
    artifactId: null,
    usage: {
      currency: 'USD',
      unit: 'microusd',
      ...(chargedMicrousd !== undefined ? { chargedMicrousd } : {}),
    },
    costBasis: 'token_pricing',
    status: 'SETTLED',
  };
}

describe('discovery_company_job cost writeback helpers', () => {
  it('deduplicates receipts by operationId and sums chargedMicrousd', () => {
    const total = sumReceiptMicrousd([
      fakeReceipt('op-1', '1200'),
      fakeReceipt('op-1', '1200'),
      fakeReceipt('op-2', '9500'),
      fakeReceipt('op-3', undefined),
      null,
      undefined,
    ]);
    expect(total).toBe(10_700n);
  });

  it('rounds positive microusd up to integer cents and preserves zero', () => {
    expect(microusdToCostCentsCeil(0n)).toBe(0);
    expect(microusdToCostCentsCeil(1n)).toBe(1);
    expect(microusdToCostCentsCeil(10_000n)).toBe(1);
    expect(microusdToCostCentsCeil(10_001n)).toBe(2);
  });

  it('increments discoveryCompanyJob.costCents when positive spend exists', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const cents = await recordCompanyJobCostCents(
      { discoveryCompanyJob: { updateMany } },
      { workspaceId: 'ws-1', runId: 'run-1', companyId: 'co-1' },
      12_500n,
    );
    expect(cents).toBe(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1', runId: 'run-1', canonicalCompanyId: 'co-1' },
      data: { costCents: { increment: 2 } },
    });
  });

  it('flattens nested signal receipts map', () => {
    const r1 = fakeReceipt('op-s1', '5000');
    const r2 = fakeReceipt('op-s2', '6000');
    const map = new Map([
      ['digital_footprint', new Map([['op-s1', { receipt: r1 }]])],
      ['structured_harvest', new Map([['op-s2', { receipt: r2 }]])],
    ]);
    expect(sumReceiptMicrousd(flattenSignalReceipts(map))).toBe(11_000n);
  });
});
