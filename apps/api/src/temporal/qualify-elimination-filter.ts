import type { Prisma } from '@prisma/client';

interface JobEliminationRow {
  canonicalCompanyId: string;
  stage: string;
  verdictQuick: string | null;
  verdictDeep: string | null;
  lastErrorCode: string | null;
  createdAt?: Date;
}

interface JudgmentEliminationRow {
  canonicalCompanyId: string;
  verdict: string;
  createdAt?: Date;
}

/**
 * Identifies companies explicitly eliminated for this ICP (prefiltered_out, quick_scan=mismatch,
 * deep=mismatch, gate-blocked skipped, or latest JudgmentRecord=NOT_FIT) so `scoreCandidates`
 * never resurrects them into `needs_review` Leads when no Lead row exists.
 */
export async function loadEliminatedCompanyIdsForIcp(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  icpId: string,
  companyIds: readonly string[],
): Promise<Set<string>> {
  const eliminated = new Set<string>();
  if (companyIds.length === 0) return eliminated;
  const targetIds = new Set(companyIds);

  const jobRepo = tx.discoveryCompanyJob as
    | { findMany?: (input: unknown) => Promise<JobEliminationRow[]> }
    | undefined;
  if (typeof jobRepo?.findMany === 'function') {
    const jobs = await jobRepo.findMany({
      where: {
        workspaceId,
        canonicalCompanyId: { in: [...targetIds] },
        run: { icpId },
      },
      orderBy: [{ createdAt: 'desc' }],
      select: {
        canonicalCompanyId: true,
        stage: true,
        verdictQuick: true,
        verdictDeep: true,
        lastErrorCode: true,
        createdAt: true,
      },
    });
    const latestJob = new Map<string, JobEliminationRow>();
    for (const row of jobs) {
      if (!targetIds.has(row.canonicalCompanyId)) continue;
      const prev = latestJob.get(row.canonicalCompanyId);
      if (!prev || (row.createdAt?.getTime() ?? 0) > (prev.createdAt?.getTime() ?? 0)) {
        latestJob.set(row.canonicalCompanyId, row);
      }
    }
    for (const [companyId, job] of latestJob) {
      if (
        job.stage === 'prefiltered_out' ||
        job.verdictQuick === 'mismatch' ||
        job.verdictDeep === 'mismatch' ||
        (job.stage === 'skipped' && Boolean(job.lastErrorCode))
      ) {
        eliminated.add(companyId);
      }
    }
  }

  const judgmentRepo = tx.judgmentRecord as
    | { findMany?: (input: unknown) => Promise<JudgmentEliminationRow[]> }
    | undefined;
  if (typeof judgmentRepo?.findMany === 'function') {
    const records = await judgmentRepo.findMany({
      where: {
        workspaceId,
        icpId,
        canonicalCompanyId: { in: [...targetIds] },
      },
      orderBy: [{ createdAt: 'desc' }],
      select: {
        canonicalCompanyId: true,
        verdict: true,
        createdAt: true,
      },
    });
    const latestJudgment = new Map<string, JudgmentEliminationRow>();
    for (const row of records) {
      if (!targetIds.has(row.canonicalCompanyId)) continue;
      const prev = latestJudgment.get(row.canonicalCompanyId);
      if (!prev || (row.createdAt?.getTime() ?? 0) > (prev.createdAt?.getTime() ?? 0)) {
        latestJudgment.set(row.canonicalCompanyId, row);
      }
    }
    for (const [companyId, record] of latestJudgment) {
      if (record.verdict === 'NOT_FIT') {
        eliminated.add(companyId);
      }
    }
  }

  return eliminated;
}
