import type { Prisma } from '@prisma/client';
import { blindContactKey } from '../compliance/pii-crypto';
import { contactSuppressionKeys } from './identity';
import {
  canonicalizeSuppressionValue,
  canonicalizeSuppressionValues,
  companyMatchesSuppression,
} from './suppression-value';
import {
  assertWorkspaceSuppressionPolicyLock,
  lockWorkspaceSuppressionPolicy,
  type SuppressionPolicyLockReceipt,
} from './suppression-policy-lock';

/**
 * Final gate for writers that may create a canonical company from a platform
 * fact. The workspace advisory lock orders append-only suppression creation
 * before or after the whole tenant materialization transaction; the writer
 * must call this before reading or writing canonical state.
 */
export async function companyMayBeMaterialized(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  company: { name: string; domain?: string | null },
): Promise<boolean> {
  await lockWorkspaceSuppressionPolicy(tx, workspaceId);
  const suppressions = await tx.suppressionRecord.findMany({
    where: { type: { in: ['domain', 'company_name'] } },
    select: { type: true, value: true },
  });
  return !companyMatchesSuppression(suppressions, company);
}

/**
 * Signal projections need the existing canonical identity and the materialization decision from
 * the same suppression-policy critical section. Checking only the source-side name is insufficient:
 * an existing canonical row may already carry a domain that is covered by an append-only suppression
 * while its derived SUPPRESSED status is still being reconciled.
 */
export async function loadMaterializableCompanyState(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  dedupeKey: string,
  sourceCompany: { name: string; domain?: string | null },
  options?: {
    knownSuppressions?: ReadonlyArray<{ type: string; value: string }>;
    policyLock?: SuppressionPolicyLockReceipt;
  },
) {
  if (options?.policyLock) assertWorkspaceSuppressionPolicyLock(options.policyLock, workspaceId);
  else await lockWorkspaceSuppressionPolicy(tx, workspaceId);
  const prior = await tx.canonicalCompany.findUnique({
    where: { workspaceId_dedupeKey: { workspaceId, dedupeKey } },
    select: { id: true, name: true, domain: true, attributes: true, status: true },
  });
  if (prior?.status === 'SUPPRESSED') return { allowed: false, prior } as const;

  const suppressions =
    options?.knownSuppressions ??
    (await tx.suppressionRecord.findMany({
      where: { type: { in: ['domain', 'company_name'] } },
      select: { type: true, value: true },
    }));
  const sourceSuppressed = companyMatchesSuppression(suppressions, sourceCompany);
  const canonicalSuppressed = prior ? companyMatchesSuppression(suppressions, prior) : false;
  if (prior && (sourceSuppressed || canonicalSuppressed)) {
    const priorAttributes =
      prior.attributes && typeof prior.attributes === 'object' && !Array.isArray(prior.attributes)
        ? (prior.attributes as Record<string, unknown>)
        : null;
    const { contact_email: removedContactEmail, ...safeAttributes } = priorAttributes ?? {};
    await tx.canonicalCompany.updateMany({
      where: { id: prior.id, status: { not: 'SUPPRESSED' } },
      data: {
        status: 'SUPPRESSED',
        ...(removedContactEmail === undefined ? {} : { attributes: safeAttributes as Prisma.InputJsonValue }),
        version: { increment: 1 },
      },
    });
  }
  return { allowed: !sourceSuppressed && !canonicalSuppressed, prior } as const;
}

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
  workspaceId: string,
  companyId: string,
): Promise<boolean> {
  await lockWorkspaceSuppressionPolicy(tx, workspaceId);
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

/**
 * Linearization point for a physical action concerning a named contact. A suppression committed
 * before this short transaction is observed and denies the call; an authorization committed first
 * defines the action as already started. No DB transaction is held across provider/network latency.
 */
export async function contactMayUseExternalProcessing(
  tx: Prisma.TransactionClient,
  args: { workspaceId: string; contactId: string; email?: string },
): Promise<boolean> {
  await lockWorkspaceSuppressionPolicy(tx, args.workspaceId);
  const contact = await tx.canonicalContact.findUnique({
    where: { id: args.contactId },
    select: {
      fullName: true,
      company: {
        select: {
          id: true,
          name: true,
          domain: true,
          status: true,
          dedupeKey: true,
        },
      },
    },
  });
  if (!contact || contact.company.status === 'SUPPRESSED') return false;

  const suppressions = await tx.suppressionRecord.findMany({
    where: { type: { in: ['domain', 'company_name', 'email', 'contact_key'] } },
    select: { type: true, value: true },
  });
  if (companyMatchesSuppression(suppressions, contact.company)) {
    await tx.canonicalCompany.updateMany({
      where: { id: contact.company.id, status: { not: 'SUPPRESSED' } },
      data: { status: 'SUPPRESSED', version: { increment: 1 } },
    });
    return false;
  }

  const suppressedContactKeys = new Set(
    suppressions.filter((row) => row.type === 'contact_key').map((row) => row.value.toLowerCase()),
  );
  const contactKeys = contactSuppressionKeys(contact.fullName, contact.company.dedupeKey).map((value) =>
    blindContactKey(value).toLowerCase(),
  );
  if (contactKeys.some((value) => suppressedContactKeys.has(value))) return false;

  if (args.email) {
    const email = canonicalizeSuppressionValue('email', args.email);
    if (!email) return false;
    const emailDomain = canonicalizeSuppressionValue('domain', email.split('@')[1]);
    const suppressedEmails = canonicalizeSuppressionValues(
      'email',
      suppressions.filter((row) => row.type === 'email').map((row) => row.value),
    );
    const suppressedDomains = canonicalizeSuppressionValues(
      'domain',
      suppressions.filter((row) => row.type === 'domain').map((row) => row.value),
    );
    if (suppressedEmails.has(email) || (!!emailDomain && suppressedDomains.has(emailDomain))) return false;
  }
  return true;
}
