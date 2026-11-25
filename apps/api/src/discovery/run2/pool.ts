import type { Prisma } from '@prisma/client';
import { readBuyerScenarioFromPlan } from '../buyer-procurement-scenarios';

/** Only unjudged or explicitly provisional rows may be changed by a quick pass. */
export function revisableProvisionalLeadWhere(): Prisma.LeadWhereInput {
  return { OR: [
    { status: 'DISCOVERED', OR: [
      { fitVerdict: null },
      { fitReasons: { path: ['source'], equals: 'quick_scan' } },
    ] },
    // Normal scoring moves quick placeholders to REVIEW without replacing their fit markers.
    { status: 'REVIEW', queue: 'needs_review', AND: [
      { fitReasons: { path: ['source'], equals: 'quick_scan' } },
      { fitReasons: { path: ['tier'], equals: 'quick' } },
    ] },
  ] };
}

/** Rejects any revisable provisional quick-scan lead when deterministic prefiltering eliminates the company. */
export async function rejectProvisionalLeadOnPrefilter(
  tx: Prisma.TransactionClient,
  args: { workspaceId: string; icpId: string; companyId: string; verdict: string },
): Promise<void> {
  const leadRepo = tx.lead as { updateMany?: (input: unknown) => Promise<unknown> } | undefined;
  if (typeof leadRepo?.updateMany !== 'function') return;
  await leadRepo.updateMany({
    where: {
      workspaceId: args.workspaceId,
      icpId: args.icpId,
      canonicalCompanyId: args.companyId,
      ...revisableProvisionalLeadWhere(),
    },
    data: {
      fitVerdict: 'mismatch',
      fitReasons: { source: 'prefilter', verdict: args.verdict },
      queue: 'rejected',
      status: 'REJECTED',
      version: { increment: 1 },
    },
  });
}

async function loadPriorRejectedPoolCompanyIds(
  tx: Prisma.TransactionClient,
  icpId: string,
): Promise<string[]> {
  const jobRepo = tx.discoveryCompanyJob as
    | { findMany?: (input: unknown) => Promise<Array<{
        canonicalCompanyId: string;
        stage: string;
        verdictQuick: string | null;
        verdictDeep: string | null;
        createdAt?: Date;
      }>> }
    | undefined;
  if (typeof jobRepo?.findMany !== 'function') return [];
  const rows = await jobRepo.findMany({
    where: { run: { icpId } },
    orderBy: [{ createdAt: 'desc' }],
    take: 5_000,
    select: {
      canonicalCompanyId: true,
      stage: true,
      verdictQuick: true,
      verdictDeep: true,
      createdAt: true,
    },
  });
  const latestByCompany = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const prev = latestByCompany.get(row.canonicalCompanyId);
    if (!prev || (row.createdAt?.getTime() ?? 0) > (prev.createdAt?.getTime() ?? 0)) {
      latestByCompany.set(row.canonicalCompanyId, row);
    }
  }
  const excluded: string[] = [];
  for (const [companyId, job] of latestByCompany) {
    if (
      job.stage === 'prefiltered_out' ||
      job.verdictQuick === 'mismatch' ||
      job.verdictDeep === 'mismatch'
    ) {
      excluded.push(companyId);
    }
  }
  return excluded;
}

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
  const priorRejectedIds = await loadPriorRejectedPoolCompanyIds(tx, args.icpId);
  const where: Prisma.CanonicalCompanyWhereInput = {
    status: { not: 'SUPPRESSED' as const },
    ...(priorRejectedIds.length > 0 ? { id: { notIn: priorRejectedIds } } : {}),
    OR: [
      { NOT: { leads: { some: { icpId: args.icpId, OR: [
        { fitVerdict: { not: null } }, { status: { not: 'DISCOVERED' } },
      ] } } } },
      { leads: { some: { icpId: args.icpId, ...revisableProvisionalLeadWhere() } } },
    ],
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
