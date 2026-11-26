import { Prisma } from '@prisma/client';
import { sanitizeCanonicalCompanyAttributes } from '../discovery/canonical-company-attributes';
import type { ErasureCounts } from './deletion.types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function scrubCanonicalCompanyAttributes(
  attributes: unknown,
): Record<string, unknown> {
  const governed = sanitizeCanonicalCompanyAttributes(attributes);
  const { contact_email: _removedContactEmail, ...safeAttributes } = governed;
  return safeAttributes;
}

/**
 * Company-subject DSR erasure helper (executed inside `eraseSubject`'s
 * `withWorkspace` transaction under the `canonical_company FOR UPDATE` lock):
 * 1. Scrubs `canonical_company.attributes` (strip `contact_email` + apply
 *    `sanitizeCanonicalCompanyAttributes`) while setting `status = 'SUPPRESSED'`.
 * 2. Purges `lead_outreach_draft` rows belonging to leads of the suppressed
 *    company via the narrow `SECURITY DEFINER` RPC (keeping `app_user`'s
 *    append-only `INSERT, SELECT` table grant intact).
 * 3. Deletes any legacy `dataClass = 'red'` `field_evidence` rows on `company`.
 */
export async function eraseCompanyPiiArtifactsInTransaction(
  tx: Prisma.TransactionClient,
  args: {
    workspaceId: string;
    deletionRequestId: string;
    companyIds: readonly string[];
  },
): Promise<void> {
  if (args.companyIds.length === 0) return;
  const companyIds = [...args.companyIds];

  const companies = await tx.canonicalCompany.findMany({
    where: { id: { in: companyIds } },
    select: { id: true, attributes: true },
  });
  for (const company of companies) {
    const safeAttributes = scrubCanonicalCompanyAttributes(company.attributes);
    await tx.canonicalCompany.updateMany({
      where: { id: company.id },
      data: {
        status: 'SUPPRESSED',
        attributes: safeAttributes as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    });
  }
  if (companies.length === 0) {
    await tx.canonicalCompany.updateMany({
      where: { id: { in: companyIds } },
      data: { status: 'SUPPRESSED' },
    });
  }

  await tx.$queryRaw<Array<{ deleted: number }>>(Prisma.sql`
    SELECT public.purge_workspace_company_outreach_drafts_v1(
      ${args.workspaceId}::uuid,
      ${companyIds}::uuid[],
      ${args.deletionRequestId}::uuid
    ) AS deleted
  `);

  await tx.fieldEvidence.deleteMany({
    where: {
      entityType: 'company',
      entityId: { in: companyIds },
      dataClass: 'red',
    },
  });
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

export function parsePersistedErasureStats(stats: unknown): {
  counts: ErasureCounts | null;
  erasedContactRefs?: string[];
} {
  if (stats === null || typeof stats !== 'object' || Array.isArray(stats)) {
    return { counts: null };
  }
  const row = stats as Record<string, unknown>;
  const hasCounts =
    typeof row.contactsErased === 'number' &&
    typeof row.contactPointsErased === 'number' &&
    typeof row.fieldEvidenceErased === 'number' &&
    typeof row.signalsRevoked === 'number' &&
    typeof row.companiesSuppressed === 'number' &&
    typeof row.leadsRescoreRequested === 'number';
  const counts: ErasureCounts | null = hasCounts
    ? {
        contactsErased: nonNegativeInt(row.contactsErased),
        contactPointsErased: nonNegativeInt(row.contactPointsErased),
        fieldEvidenceErased: nonNegativeInt(row.fieldEvidenceErased),
        signalsRevoked: nonNegativeInt(row.signalsRevoked),
        companiesSuppressed: nonNegativeInt(row.companiesSuppressed),
        leadsRescoreRequested: nonNegativeInt(row.leadsRescoreRequested),
        ...(typeof row.patentCacheErased === 'number'
          ? { patentCacheErased: nonNegativeInt(row.patentCacheErased) }
          : {}),
      }
    : null;
  const erasedContactRefs = Array.isArray(row.erasedContactRefs)
    ? [
        ...new Set(
          row.erasedContactRefs.filter(
            (id): id is string => typeof id === 'string' && UUID_RE.test(id),
          ),
        ),
      ].sort()
    : undefined;
  return {
    counts,
    ...(erasedContactRefs !== undefined ? { erasedContactRefs } : {}),
  };
}
