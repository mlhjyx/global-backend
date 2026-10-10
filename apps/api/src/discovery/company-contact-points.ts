import type { Prisma } from '@prisma/client';
import type { CompanyContactPaths } from './providers/website-profile.provider';
import { lockWorkspaceSuppressionPolicy } from './suppression-policy-lock';
import {
  canonicalizeSuppressionValue,
  canonicalizeSuppressionValues,
  companyMatchesSuppression,
} from './suppression-value';
import {
  COMPANY_CONTACT_LINK_KINDS,
  isCompanyContactPointValue,
  type CompanyContactPointKind,
} from './website-profile/contact-paths';

/** data_provider kill switch of the BI-14 contact paths; seeded DISABLED. */
export const COMPANY_CONTACT_PROVIDER_KEY = 'company_contact' as const;
/** Rules version of the automatic points; a new version re-reads profiled companies. */
export const COMPANY_CONTACT_PARSER_VERSION = 'company_contact/v1' as const;
/**
 * Bookkeeping key in the website_profile namespace (next to `_ts`, never field
 * evidence): the rules version the contact paths were last read with.
 */
export const COMPANY_CONTACT_PARSER_MARKER = '_contact_parser' as const;
const REMOVED_FROM_SITE = 'REMOVED_FROM_SITE';

export type CompanyContactSourceKind = 'homepage' | 'contact_page';

export interface CompanyContactObservedPoint {
  readonly kind: CompanyContactPointKind;
  readonly value: string;
  readonly sourceKind: CompanyContactSourceKind;
}

/** What one successful profile saw: its points, and every kind it looked at. */
export interface CompanyContactObservation {
  readonly points: readonly CompanyContactObservedPoint[];
  readonly checkedKinds: readonly CompanyContactPointKind[];
}

/**
 * The provider's contact paths as points. Links come from the homepage, so all link
 * kinds count as looked at; the form only when the contact page could be read (or
 * when the homepage links no contact page at all).
 */
export function companyContactObservation(paths: CompanyContactPaths): CompanyContactObservation {
  const candidates: ReadonlyArray<[CompanyContactPointKind, string | null, CompanyContactSourceKind]> = [
    ['contact_page', paths.contactPage, 'homepage'],
    ['impressum_page', paths.impressumPage, 'homepage'],
    ['supplier_page', paths.supplierPage, 'homepage'],
    ['linkedin_company_page', paths.linkedinCompanyPage, 'homepage'],
    ['x_company_account', paths.xCompanyAccount, 'homepage'],
    ['contact_form', paths.contactForm, 'contact_page'],
  ];
  return {
    points: candidates.flatMap(([kind, value, sourceKind]) => (value ? [{ kind, value, sourceKind }] : [])),
    checkedKinds: [
      ...COMPANY_CONTACT_LINK_KINDS,
      ...(paths.contactFormChecked ? (['contact_form'] as const) : []),
    ],
  };
}

function pointKey(kind: string, value: string): string {
  return `${kind}\n${value}`;
}

/** Whether a suppressed domain covers the link's host or one of its parent domains. Fails closed. */
function hostSuppressed(value: string, suppressedDomains: ReadonlySet<string>): boolean {
  if (suppressedDomains.size === 0) return false;
  const host = canonicalizeSuppressionValue('domain', new URL(value).hostname);
  if (!host) return true;
  const labels = host.split('.');
  for (let index = 0; index < labels.length - 1; index += 1) {
    if (suppressedDomains.has(labels.slice(index).join('.'))) return true;
  }
  return false;
}

/**
 * Store one company's observed contact paths (BI-14), inside the website-profile
 * commit transaction. Linearized with suppression and DSR erasure: the workspace
 * policy lock first, then the company row FOR SHARE (erasure takes it FOR UPDATE),
 * then the suppression facts. A missing, SUPPRESSED or suppression-covered company
 * gets nothing written. Every point is checked again against the finder's rules
 * and the suppressed hosts. Automatic points (company_contact, never changed by a
 * person) are refreshed when seen and marked INVALID / REMOVED_FROM_SITE when a kind
 * that was looked at no longer has them; a point a person set or changed is never
 * modified here. The automatic path only ever writes UNVERIFIED.
 */
export async function persistCompanyContactPoints(
  tx: Prisma.TransactionClient,
  args: {
    workspaceId: string;
    companyId: string;
    observation: CompanyContactObservation;
    seenAt: Date;
  },
): Promise<{ written: number; removed: number } | null> {
  await lockWorkspaceSuppressionPolicy(tx, args.workspaceId);
  const [company] = await tx.$queryRaw<{ status: string; name: string; domain: string | null }[]>`
    SELECT status, name, domain FROM canonical_company WHERE id = ${args.companyId}::uuid FOR SHARE`;
  if (!company || company.status === 'SUPPRESSED' || !company.domain) return null;
  const suppressions = await tx.suppressionRecord.findMany({
    where: { type: { in: ['domain', 'company_name'] } },
    select: { type: true, value: true },
  });
  if (companyMatchesSuppression(suppressions, company)) return null;
  const suppressedDomains = canonicalizeSuppressionValues(
    'domain',
    suppressions.filter((row) => row.type === 'domain').map((row) => row.value),
  );

  const observed = new Map<string, CompanyContactObservedPoint>();
  for (const point of args.observation.points) {
    if (!isCompanyContactPointValue(point.kind, point.value, company.domain)) continue;
    if (hostSuppressed(point.value, suppressedDomains)) continue;
    observed.set(pointKey(point.kind, point.value), point);
  }

  const existing = await tx.companyContactPoint.findMany({
    where: { companyId: args.companyId },
    select: {
      id: true,
      kind: true,
      value: true,
      status: true,
      statusReason: true,
      providerKey: true,
      updatedBy: true,
    },
  });
  const existingByKey = new Map(existing.map((row) => [pointKey(row.kind, row.value), row]));
  const automatic = (row: (typeof existing)[number]) =>
    row.providerKey === COMPANY_CONTACT_PROVIDER_KEY && row.updatedBy === null;

  const created = [...observed.entries()].filter(([key]) => !existingByKey.has(key));
  if (created.length > 0) {
    await tx.companyContactPoint.createMany({
      data: created.map(([, point]) => ({
        workspaceId: args.workspaceId,
        companyId: args.companyId,
        kind: point.kind,
        value: point.value,
        status: 'UNVERIFIED',
        dataClass: 'green',
        sourceKind: point.sourceKind,
        providerKey: COMPANY_CONTACT_PROVIDER_KEY,
        parserVersion: COMPANY_CONTACT_PARSER_VERSION,
        firstSeenAt: args.seenAt,
        lastSeenAt: args.seenAt,
      })),
      skipDuplicates: true,
    });
  }

  for (const [key, point] of observed) {
    const row = existingByKey.get(key);
    if (!row || !automatic(row)) continue;
    const revive = row.status === 'INVALID' && row.statusReason === REMOVED_FROM_SITE;
    // The where clause repeats what was read, so a concurrent change by a person wins.
    await tx.companyContactPoint.updateMany({
      where: {
        id: row.id,
        providerKey: COMPANY_CONTACT_PROVIDER_KEY,
        updatedBy: null,
        status: row.status,
        statusReason: row.statusReason,
      },
      data: {
        lastSeenAt: args.seenAt,
        sourceKind: point.sourceKind,
        parserVersion: COMPANY_CONTACT_PARSER_VERSION,
        ...(revive ? { status: 'UNVERIFIED', statusReason: null } : {}),
      },
    });
  }

  const checkedKinds = new Set<string>(args.observation.checkedKinds);
  const removedIds = existing
    .filter(
      (row) =>
        automatic(row) &&
        checkedKinds.has(row.kind) &&
        row.status !== 'INVALID' &&
        !observed.has(pointKey(row.kind, row.value)),
    )
    .map((row) => row.id);
  let removed = 0;
  if (removedIds.length > 0) {
    const result = await tx.companyContactPoint.updateMany({
      where: {
        id: { in: removedIds },
        providerKey: COMPANY_CONTACT_PROVIDER_KEY,
        updatedBy: null,
        status: { not: 'INVALID' },
      },
      data: { status: 'INVALID', statusReason: REMOVED_FROM_SITE },
    });
    removed = result.count;
  }
  return { written: observed.size, removed };
}
