import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { authorityProfileForProvider } from './organization-identity-authority';
import { normalizeAuthorityIdentifiers } from './organization-identity-v2';
import { lockWorkspaceOrganizationIdentity, resolveOrganizationRoot } from './organization-identity-root';
import type { OrganizationIdentityRecord } from './organization-identity-resolver';

const MUTABLE_CANDIDATE_STATUSES = ['DISCOVERED', 'ENRICHING', 'REVIEW'] as const;
const TERMINAL_COMMERCIAL_STATUSES = ['QUALIFIED', 'CONTACTED', 'CONVERTED'] as const;
export const NPPES_LIFECYCLE_RESOLVER_VERSION = 'nppes-lifecycle-v1';

type NppesLifecycleRaw = {
  id: string;
  providerKey: string;
  sourceUrl?: string | null;
  fetchedAt?: Date | null;
  contentHash?: string | null;
  parserVersion?: string | null;
};

type NppesLifecycleResult =
  | { kind: 'not_applicable' }
  | { kind: 'unmatched' }
  | {
      kind: 'deactivated';
      companyId: string;
      suppressedLeads: number;
      requiresManualFollowup: boolean;
    };

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactDeactivation(record: OrganizationIdentityRecord): boolean {
  const nppes = object(record.attributes)?.nppes;
  const fact = object(nppes);
  return String(fact?.status ?? '').toUpperCase() === 'D' && fact?.observation_scope === 'exact_npi';
}

function normalizedNpi(record: OrganizationIdentityRecord): string {
  const inputs = [...(record.identifiers ?? []), ...(record.identifier ? [record.identifier] : [])]
    .filter((identifier) => identifier.scheme === 'us_npi');
  const normalized = normalizeAuthorityIdentifiers(authorityProfileForProvider('nppes'), inputs);
  if (normalized.length !== 1 || normalized[0]?.scheme !== 'us_npi') {
    throw new Error('NPPES_DEACTIVATION_NPI_REQUIRED');
  }
  return normalized[0].normalizedValue;
}

function lifecycleInputHash(rawRecordId: string, npi: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ rawRecordId, npi, status: 'D', resolverVersion: NPPES_LIFECYCLE_RESOLVER_VERSION }))
    .digest('hex');
}

/**
 * Apply an exact NPPES lifecycle observation without deleting any historical
 * object. Caller owns the surrounding transaction (Raw was committed earlier).
 * The workspace identity lock serializes this with fit writes and Lead handoff.
 */
export async function commitNppesLifecycleFact(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    raw: NppesLifecycleRaw;
    record: OrganizationIdentityRecord;
    now?: Date;
  },
): Promise<NppesLifecycleResult> {
  if (input.raw.providerKey !== 'nppes' || !exactDeactivation(input.record)) {
    return { kind: 'not_applicable' };
  }
  const npi = normalizedNpi(input.record);
  await lockWorkspaceOrganizationIdentity(tx, input.workspaceId);
  const identifierWhere = {
    workspaceId: input.workspaceId,
    scheme: 'us_npi',
    jurisdiction: 'US',
    normalizedValue: npi,
  };
  const identifier = await tx.organizationIdentifier.findFirst({
    where: { ...identifierWhere, status: 'ACTIVE' },
  });
  // An authoritative D response for an NPI we never admitted is still retained
  // in Raw, but must not synthesize a new company or candidate.
  if (!identifier) return { kind: 'unmatched' };

  const identity = await resolveOrganizationRoot(tx, input.workspaceId, identifier.companyId);
  // Match the global suppression -> identity -> company-row lock order used by
  // Lead handoff. Deterministic row order prevents alias groups from deadlocking
  // and ensures a concurrent accept cannot slip between lifecycle inspection
  // and the suppression write.
  await tx.$queryRaw(
    Prisma.sql`SELECT id::text
      FROM canonical_company
      WHERE workspace_id = ${input.workspaceId}::uuid
        AND id IN (${Prisma.join([...identity.relatedCompanyIds].sort().map((id) => Prisma.sql`${id}::uuid`))})
      ORDER BY id
      FOR UPDATE`,
  );
  const leads = await tx.lead.findMany({
    where: {
      workspaceId: input.workspaceId,
      canonicalCompanyId: { in: identity.relatedCompanyIds },
    },
    select: { id: true, status: true },
  });
  const terminal = leads.some((lead) => TERMINAL_COMMERCIAL_STATUSES.includes(lead.status as never));
  const deliveredEvents = leads.length
    ? await tx.outboxEvent.findMany({
        where: {
          workspaceId: input.workspaceId,
          eventType: 'LeadQualified',
          aggregateId: { in: leads.map((lead) => lead.id) },
        },
        select: { aggregateId: true },
      })
    : [];
  const deliveredLeadIds = new Set(deliveredEvents.map((event) => event.aggregateId));
  const protectedLeadIds = leads
    .filter((lead) => TERMINAL_COMMERCIAL_STATUSES.includes(lead.status as never) || deliveredLeadIds.has(lead.id))
    .map((lead) => lead.id);
  const requiresManualFollowup = terminal || deliveredLeadIds.size > 0;

  const now = input.now ?? new Date();
  await tx.identityLink.upsert({
    where: {
      workspaceId_canonicalType_canonicalId_rawRecordId: {
        workspaceId: input.workspaceId,
        canonicalType: 'company',
        canonicalId: identity.rootCompanyId,
        rawRecordId: input.raw.id,
      },
    },
    update: {
      status: 'ACTIVE',
      matchRule: 'nppes_lifecycle_deactivated',
      confidence: 1,
      resolverVersion: NPPES_LIFECYCLE_RESOLVER_VERSION,
      inputHash: lifecycleInputHash(input.raw.id, npi),
    },
    create: {
      workspaceId: input.workspaceId,
      canonicalType: 'company',
      canonicalId: identity.rootCompanyId,
      rawRecordId: input.raw.id,
      status: 'ACTIVE',
      matchRule: 'nppes_lifecycle_deactivated',
      confidence: 1,
      resolverVersion: NPPES_LIFECYCLE_RESOLVER_VERSION,
      inputHash: lifecycleInputHash(input.raw.id, npi),
    },
  });

  await tx.fieldEvidence.upsert({
    where: {
      workspaceId_entityType_entityId_field_rawRecordId: {
        workspaceId: input.workspaceId,
        entityType: 'company',
        entityId: identity.rootCompanyId,
        field: 'nppes.status',
        rawRecordId: input.raw.id,
      },
    },
    update: {
      value: 'D',
      providerKey: 'nppes',
      confidence: 1,
      license: 'US-GOV-PUBLIC-DOMAIN',
      allowedActions: ['display', 'match'] as Prisma.InputJsonValue,
      fetchedAt: input.raw.fetchedAt ?? now,
    },
    create: {
      workspaceId: input.workspaceId,
      entityType: 'company',
      entityId: identity.rootCompanyId,
      field: 'nppes.status',
      value: 'D',
      providerKey: 'nppes',
      rawRecordId: input.raw.id,
      confidence: 1,
      license: 'US-GOV-PUBLIC-DOMAIN',
      allowedActions: ['display', 'match'] as Prisma.InputJsonValue,
      dataClass: 'green',
      fetchedAt: input.raw.fetchedAt ?? now,
    },
  });
  await tx.canonicalCompany.updateMany({
    where: { id: { in: identity.relatedCompanyIds }, status: { not: 'SUPPRESSED' } },
    data: { status: 'SUPPRESSED', version: { increment: 1 } },
  });
  const suppressed = await tx.lead.updateMany({
    where: {
      workspaceId: input.workspaceId,
      canonicalCompanyId: { in: identity.relatedCompanyIds },
      status: { in: [...MUTABLE_CANDIDATE_STATUSES] },
      ...(protectedLeadIds.length ? { id: { notIn: protectedLeadIds } } : {}),
    },
    data: {
      status: 'SUPPRESSED',
      queue: 'suppressed',
      version: { increment: 1 },
    },
  });
  return {
    kind: 'deactivated',
    companyId: identity.rootCompanyId,
    suppressedLeads: suppressed.count,
    requiresManualFollowup,
  };
}
