import type { Run2Activities } from './discovery.run2.activities';

export async function prefilterProcurementPool(
  load: Run2Activities['prefilterPool'],
  input: Parameters<Run2Activities['prefilterPool']>[0],
  planId: string,
  checkProcurementPlan: boolean,
) {
  const { requiresProcurementSearch, ...pool } = await load({
    ...input,
    ...(checkProcurementPlan ? { planId } : {}),
  });
  return { pool, requiresProcurementSearch: checkProcurementPlan && requiresProcurementSearch === true };
}

export function needsDiscoverySearch(
  quickScan: boolean, procurementSearch: boolean, candidates: number | undefined, threshold: number,
): boolean {
  return !quickScan || procurementSearch || (candidates ?? 0) < threshold;
}
