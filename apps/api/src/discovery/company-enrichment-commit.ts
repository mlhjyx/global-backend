import { Prisma } from '@prisma/client';
import type { EnrichmentResult } from './provider-contract';
import {
  loadCompanyForSuppressionSafeWrite,
  loadMaterializableCompanyState,
} from './company-suppression-gate';
import {
  lockWorkspaceOrganizationIdentity,
  loadOrganizationIdentitySnapshot,
  organizationMayUseExternalProcessing,
  resolveOrganizationRoot,
} from './organization-identity-root';
import { lockWorkspaceSuppressionPolicy } from './suppression-policy-lock';
import { bindOrganizationEnrichmentIdentifiers } from './organization-identity-enrichment';
import { normalizeDomain } from './identity';

export interface CompanyEnrichmentHit {
  key: string;
  result: EnrichmentResult;
  /** Sanitized enrichment Raw that directly supports this hit. */
  rawRecordId?: string;
  license?: string;
  /** Evidence authorization; defaults to ordinary display + match semantics. */
  allowedActions?: readonly ('display' | 'match')[];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Final transaction boundary for forward/backlog enrichment and signal activities.
 * It intentionally accepts no pre-wire attributes snapshot.
 */
export async function commitCompanyEnrichmentResults(
  tx: Prisma.TransactionClient,
  args: {
    workspaceId: string;
    companyId: string;
    hits: readonly CompanyEnrichmentHit[];
    status?: 'ENRICHED';
    signalTimestamp?: Date;
    expectedIdentitySnapshot: string;
  },
): Promise<boolean> {
  // Global order: suppression policy -> identity graph -> canonical rows ->
  // identifier keys. Merge/split/resolver use the same identity lock, so a
  // target cannot become an alias between the external call and this commit.
  await lockWorkspaceSuppressionPolicy(tx, args.workspaceId);
  await lockWorkspaceOrganizationIdentity(tx, args.workspaceId);
  const identity = await resolveOrganizationRoot(tx, args.workspaceId, args.companyId);
  await tx.$queryRaw`SELECT id FROM canonical_company WHERE workspace_id = ${args.workspaceId}::uuid AND id IN (${Prisma.join(identity.relatedCompanyIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`;
  const currentSnapshot = await loadOrganizationIdentitySnapshot(
    tx,
    args.workspaceId,
    identity.rootCompanyId,
  );
  if (currentSnapshot.fingerprint !== args.expectedIdentitySnapshot) return false;
  if (!(await organizationMayUseExternalProcessing(tx, args.workspaceId, identity.rootCompanyId))) return false;
  const current = await loadCompanyForSuppressionSafeWrite(tx, args.workspaceId, identity.rootCompanyId);
  if (!current) return false;

  const claimedDomains = [
    ...new Set(
      args.hits.flatMap((hit) =>
        (hit.result.identifiers ?? [])
          .filter((identifier) => identifier.scheme.toLocaleLowerCase('en-US') === 'domain')
          .map((identifier) => normalizeDomain(identifier.value))
          .filter((value): value is string => !!value),
      ),
    ),
  ];
  const promotedDomain = current.domain == null && claimedDomains.length === 1 ? claimedDomains[0] : null;
  if (promotedDomain) {
    const materializable = await loadMaterializableCompanyState(
      tx,
      args.workspaceId,
      current.dedupeKey,
      { name: current.name, domain: promotedDomain },
    );
    if (!materializable.allowed) return false;
  }

  const identityBinding = await bindOrganizationEnrichmentIdentifiers(tx, {
    workspaceId: args.workspaceId,
    companyId: current.id,
    claims: args.hits
      .filter((hit) => (hit.result.identifiers?.length ?? 0) > 0)
      .map((hit) => ({
        providerKey: hit.key,
        confidence: hit.result.confidence,
        identifiers: hit.result.identifiers ?? [],
        provenance: hit.result.provenance,
      })),
  });
  if (identityBinding.kind === 'conflict') return false;

  const merged: Record<string, unknown> = { ...current.attributes };
  for (const hit of args.hits) {
    const currentNamespace = recordValue(merged[hit.key]);
    const nextNamespace = { ...currentNamespace, ...hit.result.attributes };
    merged[hit.key] = args.signalTimestamp
      ? { ...nextNamespace, _ts: args.signalTimestamp.toISOString() }
      : nextNamespace;
  }
  const updated = await tx.canonicalCompany.updateMany({
    where: {
      id: current.id,
      status: { not: 'SUPPRESSED' },
      ...(promotedDomain ? { domain: null } : {}),
    },
    data: {
      attributes: merged as Prisma.InputJsonValue,
      ...(promotedDomain ? { domain: promotedDomain } : {}),
      ...(args.status ? { status: args.status } : {}),
      version: { increment: 1 },
    },
  });
  if (updated.count !== 1) return false;

  if (promotedDomain) {
    const domainEvidence = await tx.fieldEvidence.findFirst({
      where: {
        workspaceId: args.workspaceId,
        entityType: 'company',
        entityId: current.id,
        field: 'domain',
        providerKey: args.hits.find((hit) =>
          hit.result.identifiers?.some(
            (identifier) =>
              identifier.scheme.toLocaleLowerCase('en-US') === 'domain' &&
              normalizeDomain(identifier.value) === promotedDomain,
          ),
        )?.key,
        value: { equals: promotedDomain },
      },
      select: { id: true },
    });
    if (!domainEvidence) {
      const source = args.hits.find((hit) =>
        hit.result.identifiers?.some(
          (identifier) =>
            identifier.scheme.toLocaleLowerCase('en-US') === 'domain' &&
            normalizeDomain(identifier.value) === promotedDomain,
        ),
      );
      if (source) {
        await tx.fieldEvidence.create({
          data: {
            workspaceId: args.workspaceId,
            entityType: 'company',
            entityId: current.id,
            field: 'domain',
            value: promotedDomain,
            providerKey: source.key,
            confidence: source.result.confidence,
            license: 'public',
            allowedActions: ['display', 'match'] as Prisma.InputJsonValue,
            ...(source.result.provenance
              ? { fetchedAt: new Date(source.result.provenance.fetchedAt) }
              : {}),
          },
        });
      }
    }
  }

  for (const hit of args.hits) {
    for (const [field, value] of Object.entries(hit.result.attributes)) {
      if (value == null) continue;
      if (hit.rawRecordId) {
        const existingEvidence = await tx.fieldEvidence.findFirst({
          where: {
            workspaceId: args.workspaceId,
            entityType: 'company',
            entityId: current.id,
            field: `${hit.key}.${field}`,
            rawRecordId: hit.rawRecordId,
          },
          select: { id: true },
        });
        if (existingEvidence) continue;
      }
      await tx.fieldEvidence.create({
        data: {
          workspaceId: args.workspaceId,
          entityType: 'company',
          entityId: current.id,
          field: `${hit.key}.${field}`,
          value: value as Prisma.InputJsonValue,
          providerKey: hit.key,
          ...(hit.rawRecordId ? { rawRecordId: hit.rawRecordId } : {}),
          confidence: hit.result.confidence,
          license: hit.license ?? 'public',
          allowedActions: (hit.allowedActions ?? ['display', 'match']) as Prisma.InputJsonValue,
          dataClass: 'green',
          ...(hit.result.provenance ? { fetchedAt: new Date(hit.result.provenance.fetchedAt) } : {}),
        },
      });
    }
  }
  return true;
}
