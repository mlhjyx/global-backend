import { Prisma } from '@prisma/client';
import type { CompanyContactPaths } from './providers/website-profile.provider';
import { loadCompanyForSuppressionSafeWrite } from './company-suppression-gate';
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
/**
 * Bookkeeping keys in the website_profile namespace (W5-f): when the contact paths were last
 * tried (every outcome: read, empty, robots-blocked, dead site, timeout, unreplayable, denied
 * subject), and the attempt before the current run's (see nextContactPathAttempt).
 */
export const CONTACT_PATH_ATTEMPT_MARKER = '_contact_attempt_at' as const;
export const CONTACT_PATH_PREVIOUS_ATTEMPT_MARKER = '_contact_attempt_prev' as const;
/** A company whose contact paths were tried rests this long before the backfill tries it again. */
export const CONTACT_PATH_RETRY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
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
 * The provider's contact paths as points. Links come from the homepage, so the link
 * kinds count as looked at only when the homepage text was complete (not cut at the
 * fetch cap); the form only when the contact page could be read, or when a complete
 * homepage links no contact page at all.
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
      ...(paths.linksChecked ? COMPANY_CONTACT_LINK_KINDS : []),
      ...(paths.contactFormChecked ? (['contact_form'] as const) : []),
    ],
  };
}

function pointKey(kind: string, value: string): string {
  return `${kind}\n${value}`;
}

/** Whether a suppressed domain covers the link's host or one of its parent domains. Fails closed. */
export function contactPointHostSuppressed(value: string, suppressedDomains: ReadonlySet<string>): boolean {
  if (suppressedDomains.size === 0) return false;
  let hostname: string;
  try {
    hostname = new URL(value).hostname;
  } catch {
    return true;
  }
  const host = canonicalizeSuppressionValue('domain', hostname);
  if (!host) return true;
  const labels = host.split('.');
  for (let index = 0; index < labels.length - 1; index += 1) {
    if (suppressedDomains.has(labels.slice(index).join('.'))) return true;
  }
  return false;
}

/**
 * Suppression is not a status: it is applied when the points are read (scoring, read models)
 * and by deletion when the company subject is erased. A company covered by a suppression
 * (its domain or name) has no reachable point; otherwise every point on a suppressed host
 * (or a parent domain of one) is left out.
 */
export function reachableCompanyContactPoints<T extends { readonly value: string }>(
  points: readonly T[],
  suppressions: ReadonlyArray<{ type: string; value: string }>,
  company: { name: string; domain: string | null },
): T[] {
  if (points.length === 0) return [];
  if (companyMatchesSuppression(suppressions, company)) return [];
  const suppressedDomains = canonicalizeSuppressionValues(
    'domain',
    suppressions.filter((row) => row.type === 'domain').map((row) => row.value),
  );
  return points.filter((point) => !contactPointHostSuppressed(point.value, suppressedDomains));
}

/** The company columns the website profile reads for one candidate. */
export interface ContactPathBackfillCandidate {
  readonly id: string;
  readonly name: string;
  readonly domain: string | null;
  readonly country: string | null;
  readonly attributes: unknown;
}

/** A company's contact-path attempt watermark (ISO timestamps; anything else reads as absent). */
export interface ContactPathAttempt {
  readonly at: string | null;
  readonly previous: string | null;
}

function isoTimestamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

/** The attempt watermark stored in `attributes.website_profile`. */
export function contactPathAttempt(attributes: unknown): ContactPathAttempt {
  const namespace =
    attributes !== null && typeof attributes === 'object' && !Array.isArray(attributes)
      ? (attributes as Record<string, unknown>).website_profile
      : undefined;
  const profile =
    namespace !== null && typeof namespace === 'object' && !Array.isArray(namespace)
      ? (namespace as Record<string, unknown>)
      : {};
  return {
    at: isoTimestamp(profile[CONTACT_PATH_ATTEMPT_MARKER]),
    previous: isoTimestamp(profile[CONTACT_PATH_PREVIOUS_ATTEMPT_MARKER]),
  };
}

/**
 * Attempts at or after this instant are cooling for a run created at `runSince`. The cooldown counts
 * from the run's creation, not from each activity's clock, so a run's candidate list is the same
 * for every one of its profile activities.
 */
export function contactPathRetryCutoff(runSince: Date): Date {
  return new Date(runSince.getTime() - CONTACT_PATH_RETRY_COOLDOWN_MS);
}

/**
 * Whether the backfill should leave this company alone now: it was tried within the cooldown, or
 * since the run began (by this run's earlier activity or a concurrent run). Read again just before
 * profiling a backfill company, so two runs that listed the same companies do not both fetch them.
 */
export function contactPathAttemptCooling(attempt: ContactPathAttempt, runSince: Date): boolean {
  return attempt.at !== null && Date.parse(attempt.at) >= contactPathRetryCutoff(runSince).getTime();
}

/**
 * The watermark after an attempt at `at` by a run created at `runSince`. `previous` keeps the last
 * attempt from before the run began: the candidate list orders a company the run already tried by
 * that value, so it stays where it was and continuation indexes still point at the same companies.
 * A company tried again since the run began (a retried activity, a concurrent run) keeps its
 * earlier `previous`.
 */
export function nextContactPathAttempt(
  prior: ContactPathAttempt,
  at: Date,
  runSince: Date,
): { at: string; previous: string | null } {
  const triedSinceRunBegan = prior.at !== null && Date.parse(prior.at) >= runSince.getTime();
  return { at: at.toISOString(), previous: triedSinceRunBegan ? prior.previous : prior.at };
}

/**
 * Record a contact-path attempt in the website_profile namespace (bookkeeping next to `_ts`, never
 * field evidence). Written under the suppression policy lock through the suppression-safe loader:
 * a suppressed company, or one a suppression covers, gets nothing. The rest of the attributes,
 * including the facts a profile commit wrote earlier in the same transaction, is kept as stored.
 */
export async function recordContactPathAttempt(
  tx: Prisma.TransactionClient,
  args: { workspaceId: string; companyId: string; attempt: { at: string; previous: string | null } },
): Promise<boolean> {
  const current = await loadCompanyForSuppressionSafeWrite(tx, args.workspaceId, args.companyId);
  if (!current) return false;
  const stored = current.attributes.website_profile;
  const {
    [CONTACT_PATH_ATTEMPT_MARKER]: _previousAt,
    [CONTACT_PATH_PREVIOUS_ATTEMPT_MARKER]: _previousPrevious,
    ...profile
  } = stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const updated = await tx.canonicalCompany.updateMany({
    where: { id: current.id, status: { not: 'SUPPRESSED' } },
    data: {
      attributes: {
        ...current.attributes,
        website_profile: {
          ...profile,
          [CONTACT_PATH_ATTEMPT_MARKER]: args.attempt.at,
          ...(args.attempt.previous ? { [CONTACT_PATH_PREVIOUS_ATTEMPT_MARKER]: args.attempt.previous } : {}),
        },
      } as Prisma.InputJsonValue,
      version: { increment: 1 },
    },
  });
  return updated.count === 1;
}

/**
 * Backfill of the contact paths (scoring rules v3): while the switch is on, a run whose own
 * companies leave part of the website-profile quota unused reads the workspace companies whose
 * contact paths were never read under the current rules, so a switched-on workspace does not have
 * to wait for a new run to find each company again.
 *
 * Attempt watermark (W5-f): every attempt is stamped (`_contact_attempt_at`), whatever came of it,
 * and a company tried within CONTACT_PATH_RETRY_COOLDOWN_MS before the run was created is left
 * out. Never-tried companies come first, then the longest-untried, then the oldest — so companies
 * that keep failing (robots-blocked, empty page, dead site, timeout, denied subject) rest a week
 * and then queue behind every company never tried, instead of holding the front of the list and
 * starving new companies.
 *
 * The list must be the same for every profile activity of one run (continuation is by index): a
 * company tried since the run was created stays in it, ordered by the attempt it had before the
 * run (`_contact_attempt_prev`), and the profile loop skips it on its re-read. A company a
 * concurrent run tries mid-run can still enter the list and shift later indexes by one; the cost is
 * one company missed this round or skipped on its re-read, never a second fetch.
 */
export async function contactPathBackfillCandidates(
  tx: Prisma.TransactionClient,
  args: { workspaceId: string; runSince: Date; excludeCompanyIds: readonly string[]; limit: number },
): Promise<ContactPathBackfillCandidate[]> {
  if (args.limit <= 0) return [];
  const since = args.runSince.toISOString();
  const cutoff = contactPathRetryCutoff(args.runSince).toISOString();
  const excluded = args.excludeCompanyIds.length
    ? Prisma.sql`AND id NOT IN (${Prisma.join(args.excludeCompanyIds.map((id) => Prisma.sql`${id}::uuid`))})`
    : Prisma.empty;
  // ISO-8601 timestamps written by toISOString() compare as text in time order; a missing stamp is ''.
  return tx.$queryRaw<ContactPathBackfillCandidate[]>`
    SELECT id, name, domain, country, attributes
    FROM canonical_company
    WHERE workspace_id = ${args.workspaceId}::uuid
      AND status <> 'SUPPRESSED'
      AND domain IS NOT NULL
      ${excluded}
      AND (
        COALESCE(attributes #>> '{website_profile,_contact_attempt_at}', '') >= ${since}
        OR (
          COALESCE(attributes #>> '{website_profile,_contact_parser}', '') <> ${COMPANY_CONTACT_PARSER_VERSION}
          AND COALESCE(attributes #>> '{website_profile,_contact_attempt_at}', '') < ${cutoff}
        )
      )
    ORDER BY
      CASE
        WHEN COALESCE(attributes #>> '{website_profile,_contact_attempt_at}', '') >= ${since}
          THEN attributes #>> '{website_profile,_contact_attempt_prev}'
        ELSE attributes #>> '{website_profile,_contact_attempt_at}'
      END ASC NULLS FIRST,
      created_at ASC,
      id ASC
    LIMIT ${args.limit}`;
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
    if (contactPointHostSuppressed(point.value, suppressedDomains)) continue;
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
    // The where clause repeats what was read, so a concurrent change by a person wins, and only an
    // observation at least as new as the stored one updates the row: last_seen_at never goes back.
    await tx.companyContactPoint.updateMany({
      where: {
        id: row.id,
        providerKey: COMPANY_CONTACT_PROVIDER_KEY,
        updatedBy: null,
        status: row.status,
        statusReason: row.statusReason,
        lastSeenAt: { lte: args.seenAt },
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
    // Only points last seen before this observation: an older observation that commits after a
    // newer one never removes what the newer one saw.
    const result = await tx.companyContactPoint.updateMany({
      where: {
        id: { in: removedIds },
        providerKey: COMPANY_CONTACT_PROVIDER_KEY,
        updatedBy: null,
        status: { not: 'INVALID' },
        lastSeenAt: { lt: args.seenAt },
      },
      data: { status: 'INVALID', statusReason: REMOVED_FROM_SITE },
    });
    removed = result.count;
  }
  return { written: observed.size, removed };
}
