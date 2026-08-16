import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { companyMayUseExternalProcessing } from './company-suppression-gate';
import type { CompanyIdentifier } from './identity';
import { lockWorkspaceSuppressionPolicy } from './suppression-policy-lock';

/**
 * Workspace-wide Identity v2 mutation lock. All resolver, enrichment and
 * merge/split paths acquire it before identifier/company locks. The coarse
 * scope is intentional for phase one: correctness beats parallel mutation of
 * one tenant's identity graph.
 */
export async function lockWorkspaceOrganizationIdentity(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${'organization-identity:' + workspaceId}, 0))::text AS locked`;
}

/** Resolve an alias in one hop. Database guards prohibit multi-level mapping chains. */
export async function resolveOrganizationRoot(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  companyId: string,
): Promise<{ rootCompanyId: string; relatedCompanyIds: string[] }> {
  const delegate = tx.organizationCanonicalMapping;
  if (!delegate) return { rootCompanyId: companyId, relatedCompanyIds: [companyId] };
  const sourceMapping = await delegate.findFirst({
    where: { workspaceId, sourceCompanyId: companyId, status: 'ACTIVE' },
    select: { canonicalCompanyId: true },
  });
  const rootCompanyId = sourceMapping?.canonicalCompanyId ?? companyId;
  const aliases = await delegate.findMany({
    where: { workspaceId, canonicalCompanyId: rootCompanyId, status: 'ACTIVE' },
    select: { sourceCompanyId: true },
  });
  return {
    rootCompanyId,
    relatedCompanyIds: [...new Set([rootCompanyId, ...aliases.map((mapping) => mapping.sourceCompanyId)])],
  };
}

/** Resolve a bounded set of company ids to direct roots without introducing N+1 queries. */
export async function resolveOrganizationRootIds(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  companyIds: readonly string[],
): Promise<string[]> {
  const ids = [...new Set(companyIds)];
  if (!ids.length || !tx.organizationCanonicalMapping) return ids;
  const mappings = await tx.organizationCanonicalMapping.findMany({
    where: { workspaceId, sourceCompanyId: { in: ids }, status: 'ACTIVE' },
    select: { sourceCompanyId: true, canonicalCompanyId: true },
  });
  const roots = new Map(mappings.map((mapping) => [mapping.sourceCompanyId, mapping.canonicalCompanyId]));
  return [...new Set(ids.map((id) => roots.get(id) ?? id))];
}

export interface OrganizationIdentityGroup {
  rootCompanyId: string;
  relatedCompanyIds: string[];
}

/** Resolve roots and all of their active aliases in two bounded mapping queries. */
export async function resolveOrganizationIdentityGroups(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  companyIds: readonly string[],
): Promise<OrganizationIdentityGroup[]> {
  const rootCompanyIds = await resolveOrganizationRootIds(tx, workspaceId, companyIds);
  if (!rootCompanyIds.length) return [];
  const delegate = tx.organizationCanonicalMapping;
  if (!delegate) {
    return rootCompanyIds.map((rootCompanyId) => ({ rootCompanyId, relatedCompanyIds: [rootCompanyId] }));
  }
  const aliases = await delegate.findMany({
    where: { workspaceId, canonicalCompanyId: { in: rootCompanyIds }, status: 'ACTIVE' },
    select: { sourceCompanyId: true, canonicalCompanyId: true },
    orderBy: { sourceCompanyId: 'asc' },
  });
  const aliasesByRoot = new Map<string, string[]>();
  for (const mapping of aliases) {
    const related = aliasesByRoot.get(mapping.canonicalCompanyId) ?? [];
    related.push(mapping.sourceCompanyId);
    aliasesByRoot.set(mapping.canonicalCompanyId, related);
  }
  return rootCompanyIds.map((rootCompanyId) => ({
    rootCompanyId,
    relatedCompanyIds: [...new Set([rootCompanyId, ...(aliasesByRoot.get(rootCompanyId) ?? [])])],
  }));
}

/** Load ACTIVE identifiers from roots and aliases, grouped by current root. */
export async function loadOrganizationActiveIdentifiersByRoot(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  companyIds: readonly string[],
): Promise<Map<string, CompanyIdentifier[]>> {
  const snapshots = await loadOrganizationIdentitySnapshots(tx, workspaceId, companyIds);
  return new Map([...snapshots.entries()].map(([root, snapshot]) => [root, snapshot.identifiers]));
}

export interface OrganizationIdentitySnapshot {
  rootCompanyId: string;
  relatedCompanyIds: string[];
  identifiers: CompanyIdentifier[];
  fingerprint: string;
}

export function organizationIdentitySnapshotFingerprint(
  value: Pick<OrganizationIdentitySnapshot, 'rootCompanyId' | 'relatedCompanyIds' | 'identifiers'>,
): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Consistent pre-wire snapshot used as an optimistic identity-graph CAS. */
export async function loadOrganizationIdentitySnapshots(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  companyIds: readonly string[],
): Promise<Map<string, OrganizationIdentitySnapshot>> {
  await lockWorkspaceOrganizationIdentity(tx, workspaceId);
  const groups = await resolveOrganizationIdentityGroups(tx, workspaceId, companyIds);
  const companyToRoot = new Map<string, string>();
  for (const group of groups) {
    for (const companyId of group.relatedCompanyIds) companyToRoot.set(companyId, group.rootCompanyId);
  }
  const rows = companyToRoot.size && tx.organizationIdentifier
    ? await tx.organizationIdentifier.findMany({
        where: {
          workspaceId,
          companyId: { in: [...companyToRoot.keys()] },
          status: 'ACTIVE',
        },
        select: { companyId: true, scheme: true, jurisdiction: true, normalizedValue: true },
      })
    : [];
  const byRoot = new Map<string, CompanyIdentifier[]>();
  for (const row of rows) {
    const root = companyToRoot.get(row.companyId);
    if (!root) continue;
    const list = byRoot.get(root) ?? [];
    const candidate = { scheme: row.scheme, jurisdiction: row.jurisdiction, value: row.normalizedValue };
    if (!list.some((item) => item.scheme === candidate.scheme && item.jurisdiction === candidate.jurisdiction && item.value === candidate.value)) {
      list.push(candidate);
      byRoot.set(root, list);
    }
  }
  const result = new Map<string, OrganizationIdentitySnapshot>();
  for (const group of groups) {
    const identifiers = (byRoot.get(group.rootCompanyId) ?? []).sort((left, right) =>
      `${left.scheme}:${left.jurisdiction ?? ''}:${left.value}`.localeCompare(
        `${right.scheme}:${right.jurisdiction ?? ''}:${right.value}`,
      ),
    );
    const relatedCompanyIds = [...group.relatedCompanyIds].sort();
    const fingerprint = organizationIdentitySnapshotFingerprint({
      rootCompanyId: group.rootCompanyId,
      relatedCompanyIds,
      identifiers,
    });
    result.set(group.rootCompanyId, {
      rootCompanyId: group.rootCompanyId,
      relatedCompanyIds,
      identifiers,
      fingerprint,
    });
  }
  return result;
}

export async function loadOrganizationIdentitySnapshot(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  companyId: string,
): Promise<OrganizationIdentitySnapshot> {
  await lockWorkspaceOrganizationIdentity(tx, workspaceId);
  const identity = await resolveOrganizationRoot(tx, workspaceId, companyId);
  const snapshots = await loadOrganizationIdentitySnapshots(tx, workspaceId, [identity.rootCompanyId]);
  const snapshot = snapshots.get(identity.rootCompanyId);
  if (!snapshot) throw new Error('organization identity snapshot not found');
  return snapshot;
}

/** Suppression and open-conflict safety applies to the whole reversible identity group. */
export async function organizationMayUseExternalProcessing(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  companyId: string,
): Promise<boolean> {
  // Network authorization must observe the same identity group as merge/split.
  // Keep the global order aligned with every mutation path.
  await lockWorkspaceSuppressionPolicy(tx, workspaceId);
  await lockWorkspaceOrganizationIdentity(tx, workspaceId);
  const identity = await resolveOrganizationRoot(tx, workspaceId, companyId);
  if (tx.organizationIdentityConflictParty) {
    const conflicts = await tx.organizationIdentityConflictParty.count({
      where: {
        workspaceId,
        companyId: { in: identity.relatedCompanyIds },
        conflict: { status: { in: ['OPEN', 'RESOLVING'] } },
      },
    });
    if (conflicts > 0) return false;
  }
  let allowed = true;
  for (const relatedCompanyId of identity.relatedCompanyIds) {
    if (!(await companyMayUseExternalProcessing(tx, workspaceId, relatedCompanyId))) allowed = false;
  }
  if (!allowed && identity.relatedCompanyIds.length > 1) {
    await tx.canonicalCompany.updateMany({
      where: { id: identity.rootCompanyId, status: { not: 'SUPPRESSED' } },
      data: { status: 'SUPPRESSED', version: { increment: 1 } },
    });
  }
  return allowed;
}
