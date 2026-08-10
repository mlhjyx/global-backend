import type { Prisma } from '@prisma/client';
import { companyMatchesSuppression } from './suppression-value';

/**
 * Final company-level suppression gate for any model/provider/network processing.
 *
 * Candidate queries intentionally keep their cheap status predicate, but legacy rows and a
 * suppression committed after candidate loading can leave that derived status stale. This gate
 * therefore rereads both the company and the append-only source of truth immediately before the
 * external action. A canonical raw match repairs the derived status in the same tenant transaction.
 */
export async function companyMayUseExternalProcessing(
  tx: Prisma.TransactionClient,
  companyId: string,
): Promise<boolean> {
  const company = await tx.canonicalCompany.findUnique({
    where: { id: companyId },
    select: { id: true, name: true, domain: true, status: true },
  });
  if (!company || company.status === 'SUPPRESSED') return false;

  const suppressions = await tx.suppressionRecord.findMany({
    where: { type: { in: ['domain', 'company_name'] } },
    select: { type: true, value: true },
  });
  if (!companyMatchesSuppression(suppressions, company)) return true;

  await tx.canonicalCompany.updateMany({
    where: { id: company.id, status: { not: 'SUPPRESSED' } },
    data: { status: 'SUPPRESSED', version: { increment: 1 } },
  });
  return false;
}
