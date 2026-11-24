import type { DurableExecutionReceipt } from '../../durable-results/durable-execution-receipt';

const MICROUSD_PER_CENT = 10_000n;

/**
 * Sums unique receipt charges (`usage.chargedMicrousd`) deduplicated by `operationId`
 * so repeated acknowledgements of the same operation never double-count job cost.
 */
export function sumReceiptMicrousd(
  receipts: Iterable<DurableExecutionReceipt | undefined | null>,
): bigint {
  const seen = new Set<string>();
  let total = 0n;
  for (const receipt of receipts) {
    if (!receipt || seen.has(receipt.operationId)) continue;
    seen.add(receipt.operationId);
    const raw = receipt.usage?.chargedMicrousd;
    if (typeof raw !== 'string' || !/^\d+$/u.test(raw)) continue;
    total += BigInt(raw);
  }
  return total;
}

/**
 * Converts microusd to integer cents (ceil, minimum 1 cent for any positive spend)
 * for `discovery_company_job.cost_cents`.
 */
export function microusdToCostCentsCeil(microusd: bigint): number {
  if (microusd <= 0n) return 0;
  const cents = (microusd + MICROUSD_PER_CENT - 1n) / MICROUSD_PER_CENT;
  return Number(cents > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : cents);
}

interface CompanyJobCostTx {
  discoveryCompanyJob?: {
    updateMany?: (args: {
      where: { workspaceId: string; runId: string; canonicalCompanyId: string };
      data: { costCents: { increment: number } };
    }) => Promise<unknown>;
  };
}

/**
 * Atomically increments `discovery_company_job.cost_cents` inside an existing
 * workspace-scoped transaction. Safe no-op when spend is 0 or in unit tests
 * that stub only domain tables.
 */
export async function recordCompanyJobCostCents(
  tx: CompanyJobCostTx,
  target: { workspaceId: string; runId: string; companyId: string },
  microusd: bigint,
): Promise<number> {
  const cents = microusdToCostCentsCeil(microusd);
  if (cents <= 0 || typeof tx.discoveryCompanyJob?.updateMany !== 'function') return 0;
  await tx.discoveryCompanyJob.updateMany({
    where: {
      workspaceId: target.workspaceId,
      runId: target.runId,
      canonicalCompanyId: target.companyId,
    },
    data: { costCents: { increment: cents } },
  });
  return cents;
}

/** Extracts all DurableExecutionReceipts from the nested signal-stage receipt map. */
export function flattenSignalReceipts(
  receipts: ReadonlyMap<string, ReadonlyMap<string, { receipt: DurableExecutionReceipt }>>,
): DurableExecutionReceipt[] {
  const out: DurableExecutionReceipt[] = [];
  for (const group of receipts.values()) {
    for (const entry of group.values()) out.push(entry.receipt);
  }
  return out;
}
