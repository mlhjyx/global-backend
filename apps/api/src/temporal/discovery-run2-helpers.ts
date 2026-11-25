import type { Prisma } from '@prisma/client';

type Run2JobReader = {
  discoveryCompanyJob?: {
    findMany(args: {
      where: Record<string, unknown>;
      select: { canonicalCompanyId: true };
    }): Promise<Array<{ canonicalCompanyId: string }>>;
  };
};

/**
 * Merges Run 2.0 `discovery_company_job` judged company IDs into a run's
 * company ID set so pool-first runs without `raw_source_record` rows still
 * trigger scoring on failure and watch registration on completion.
 */
export async function mergeRun2JudgedCompanyIds(
  tx: Prisma.TransactionClient,
  runId: string,
  initialCompanyIds: readonly string[],
  options: { deepMatchOnly?: boolean } = {},
): Promise<string[]> {
  const merged = new Set(initialCompanyIds);
  const reader = (tx as unknown as Run2JobReader).discoveryCompanyJob;
  if (typeof reader?.findMany === 'function') {
    const jobs = await reader.findMany({
      where: options.deepMatchOnly
        ? { runId, verdictDeep: 'match' }
        : { runId, OR: [{ verdictQuick: { not: null } }, { verdictDeep: { not: null } }] },
      select: { canonicalCompanyId: true },
    });
    for (const job of jobs) merged.add(job.canonicalCompanyId);
  }
  return [...merged];
}
