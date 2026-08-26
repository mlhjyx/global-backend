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
    sanitizeAttributes?: (
      attributes: Record<string, unknown>,
    ) => Record<string, unknown>;
  },
) {
  if (options?.policyLock) assertWorkspaceSuppressionPolicyLock(options.policyLock, workspaceId);
  else await lockWorkspaceSuppressionPolicy(tx, workspaceId);
  const prior = await tx.canonicalCompany.findUnique({
    where: { workspaceId_dedupeKey: { workspaceId, dedupeKey } },
    select: { id: true, name: true, domain: true, dedupeKey: true, attributes: true, status: true },
  });
  const suppressions =
    options?.knownSuppressions ??
    (await tx.suppressionRecord.findMany({
      where: { type: { in: ['domain', 'company_name'] } },
      select: { type: true, value: true },
    }));
  const sourceSuppressed = companyMatchesSuppression(suppressions, sourceCompany);
  const canonicalSuppressed = prior ? companyMatchesSuppression(suppressions, prior) : false;
  const blocked = prior?.status === 'SUPPRESSED' || sourceSuppressed || canonicalSuppressed;
  if (prior && blocked)
    await repairSuppressedCompany(tx, prior, options?.sanitizeAttributes);
  return { allowed: !blocked, prior } as const;
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
    select: { id: true, name: true, domain: true, status: true, attributes: true },
  });
  if (!company) return false;
  if (company.status === 'SUPPRESSED') {
    await repairSuppressedCompany(tx, company);
    return false;
  }

  const suppressions = await tx.suppressionRecord.findMany({
    where: { type: { in: ['domain', 'company_name'] } },
    select: { type: true, value: true },
  });
  if (!companyMatchesSuppression(suppressions, company)) return true;

  await repairSuppressedCompany(tx, company);
  return false;
}

/**
 * Commit-side state for provider/model results. The caller must merge only its owned namespaces
 * into the returned current attributes and write in the same transaction. This closes the window
 * between the last physical wire and database commit without holding a transaction across I/O.
 */
export async function loadCompanyForSuppressionSafeWrite(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  companyId: string,
): Promise<{ id: string; attributes: Record<string, unknown> } | null> {
  await lockWorkspaceSuppressionPolicy(tx, workspaceId);
  const company = await tx.canonicalCompany.findUnique({
    where: { id: companyId },
    select: { id: true, name: true, domain: true, status: true, attributes: true },
  });
  if (!company) return null;

  const suppressions = await tx.suppressionRecord.findMany({
    where: { type: { in: ['domain', 'company_name', 'email'] } },
    select: { type: true, value: true },
  });
  if (company.status === 'SUPPRESSED' || companyMatchesSuppression(suppressions, company)) {
    await repairSuppressedCompany(tx, company);
    return null;
  }

  const attributes = jsonObject(company.attributes);
  const mailbox = canonicalizeSuppressionValue(
    'email',
    typeof attributes.contact_email === 'string' ? attributes.contact_email : '',
  );
  const mailboxDomain = mailbox ? canonicalizeSuppressionValue('domain', mailbox.split('@')[1]) : null;
  const suppressedEmails = canonicalizeSuppressionValues(
    'email',
    suppressions.filter((row) => row.type === 'email').map((row) => row.value),
  );
  const suppressedDomains = canonicalizeSuppressionValues(
    'domain',
    suppressions.filter((row) => row.type === 'domain').map((row) => row.value),
  );
  const mailboxSuppressed =
    !!mailbox && (suppressedEmails.has(mailbox) || (!!mailboxDomain && suppressedDomains.has(mailboxDomain)));
  if (!mailboxSuppressed) return { id: company.id, attributes };
  const { contact_email: _removedMailbox, ...safeAttributes } = attributes;
  return { id: company.id, attributes: safeAttributes };
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
          attributes: true,
        },
      },
    },
  });
  if (!contact) return false;
  if (contact.company.status === 'SUPPRESSED') {
    await repairSuppressedCompany(tx, contact.company);
    return false;
  }

  const suppressions = await tx.suppressionRecord.findMany({
    where: { type: { in: ['domain', 'company_name', 'email', 'contact_key'] } },
    select: { type: true, value: true },
  });
  if (companyMatchesSuppression(suppressions, contact.company)) {
    await repairSuppressedCompany(tx, contact.company);
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

async function repairSuppressedCompany(
  tx: Prisma.TransactionClient,
  company: { id: string; status: string; attributes?: unknown },
  sanitizeAttributes?: (
    attributes: Record<string, unknown>,
  ) => Record<string, unknown>,
): Promise<void> {
  const attributes = jsonObject(company.attributes);
  const sanitized = sanitizeAttributes ? sanitizeAttributes(attributes) : attributes;
  const { contact_email: _removedContactEmail, ...safeAttributes } = sanitized;
  const attributesChanged = JSON.stringify(safeAttributes) !== JSON.stringify(attributes);

  if (company.status !== 'SUPPRESSED') {
    const repaired = await tx.canonicalCompany.updateMany({
      where: { id: company.id, status: { not: 'SUPPRESSED' } },
      data: {
        status: 'SUPPRESSED',
        ...(attributesChanged
          ? { attributes: safeAttributes as Prisma.InputJsonValue }
          : {}),
        version: { increment: 1 },
      },
    });
    if (repaired.count > 0 || !attributesChanged) return;
  } else if (!attributesChanged) {
    return;
  }

  // A concurrent derived-status repair may win the conditional update. Re-read the current
  // JSON before scrubbing so an old snapshot cannot restore unrelated attributes.
  const current = await tx.canonicalCompany.findUnique({
    where: { id: company.id },
    select: { attributes: true },
  });
  const currentAttributes = jsonObject(current?.attributes);
  const currentSanitized = sanitizeAttributes
    ? sanitizeAttributes(currentAttributes)
    : currentAttributes;
  const { contact_email: _currentMailbox, ...currentSafeAttributes } = currentSanitized;
  if (
    JSON.stringify(currentSafeAttributes) === JSON.stringify(currentAttributes)
  )
    return;
  await tx.canonicalCompany.updateMany({
    where: { id: company.id },
    data: { attributes: currentSafeAttributes as Prisma.InputJsonValue, version: { increment: 1 } },
  });
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
