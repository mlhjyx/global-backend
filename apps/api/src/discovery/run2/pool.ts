import type { Prisma } from '@prisma/client';
import { readBuyerScenarioFromPlan } from '../buyer-procurement-scenarios';

/** Reads the current scenario and candidate pool inside the caller's workspace transaction. */
export async function loadQuickScanPool(
  tx: Prisma.TransactionClient,
  args: { planId?: string; icpId: string; runId: string; afterProcurementSearch?: true },
  limit: number,
) {
  const plan = args.planId
    ? await tx.discoveryQueryPlan.findFirst({
        where: { id: args.planId, icpId: args.icpId },
        select: { queries: true },
      })
    : null;
  const scenario = readBuyerScenarioFromPlan(plan?.queries);
  const requiresProcurementSearch = scenario === 'factory_direct' || scenario === 'equipment_integration';
  if (requiresProcurementSearch && !args.afterProcurementSearch) {
    return { rules: [], poolSize: 0, companies: [], requiresProcurementSearch };
  }
  const rules = await tx.qualificationRule.findMany({
    where: { icpId: args.icpId },
    select: { id: true, kind: true, field: true, operator: true, value: true, weight: true },
  });
  const where = {
    status: { not: 'SUPPRESSED' as const },
    NOT: { leads: { some: { icpId: args.icpId, fitVerdict: { not: null } } } },
    // For the pilot, judge the current run's admitted search results rather than seed from the generic pool.
    ...(requiresProcurementSearch ? {
      materializationOutcomes: { some: { runId: args.runId, outcome: 'CANONICALIZED' } },
    } : {}),
  };
  const poolSize = await tx.canonicalCompany.count({ where });
  const companies = await tx.canonicalCompany.findMany({
    where,
    orderBy: [{ lastSeenAt: { sort: 'desc' as const, nulls: 'last' as const } }, { createdAt: 'desc' as const }],
    take: limit,
    select: {
      id: true,
      name: true,
      domain: true,
      country: true,
      industry: true,
      employeeCount: true,
      revenueUsd: true,
      attributes: true,
    },
  });
  return { rules, poolSize, companies, requiresProcurementSearch };
}
