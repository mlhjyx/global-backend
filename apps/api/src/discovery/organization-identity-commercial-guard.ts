import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

const TERMINAL_LEAD_STATUSES = ['QUALIFIED', 'CONTACTED', 'CONVERTED'] as const;

export class OrganizationIdentityCommercialFactsImmutableError extends ConflictException {
  readonly code = 'COMMERCIAL_FACTS_IMMUTABLE';

  constructor() {
    super({
      error: {
        code: 'COMMERCIAL_FACTS_IMMUTABLE',
        message: 'identity change is blocked because commercial facts were already created or delivered',
      },
    });
  }
}

export class OrganizationIdentityMergeProjectionUnsettledError extends ConflictException {
  readonly code = 'IDENTITY_MERGE_PROJECTION_UNSETTLED';

  constructor() {
    super({
      error: {
        code: 'IDENTITY_MERGE_PROJECTION_UNSETTLED',
        message: 'identity mapping cannot be split until its merge replay and conflict resolution are complete',
      },
    });
  }
}

export type SettledMergeProjection = {
  mergeDecision: {
    replay: { status: string } | null;
    conflict: { status: string } | null;
  };
};

export function assertMergeProjectionSettled(mapping: SettledMergeProjection): void {
  if (
    mapping.mergeDecision.replay?.status !== 'SUCCEEDED' ||
    mapping.mergeDecision.conflict?.status !== 'RESOLVED'
  ) {
    throw new OrganizationIdentityMergeProjectionUnsettledError();
  }
}

/**
 * Merge/split may only change an identity graph before it owns irreversible
 * commercial facts. Callers hold the workspace identity lock, so the complete
 * root/alias group and its business facts are one stable snapshot.
 */
export async function assertOrganizationIdentityCommercialFactsMutable(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  companyIds: readonly string[],
): Promise<void> {
  const seedIds = [...new Set(companyIds)];
  const mappings = await tx.organizationCanonicalMapping.findMany({
    where: {
      workspaceId,
      status: 'ACTIVE',
      OR: [{ sourceCompanyId: { in: seedIds } }, { canonicalCompanyId: { in: seedIds } }],
    },
    select: { sourceCompanyId: true, canonicalCompanyId: true },
  });
  const ids = [
    ...new Set([
      ...seedIds,
      ...mappings.flatMap((mapping) => [mapping.sourceCompanyId, mapping.canonicalCompanyId]),
    ]),
  ];
  const leads = await tx.lead.findMany({
    where: { workspaceId, canonicalCompanyId: { in: ids } },
    select: { id: true, icpId: true, canonicalCompanyId: true, status: true },
  });
  const terminal = leads.some((lead) => TERMINAL_LEAD_STATUSES.includes(lead.status as never));
  const delivered = leads.length
    ? await tx.outboxEvent.count({
        where: {
          workspaceId,
          eventType: 'LeadQualified',
          aggregateId: { in: leads.map((lead) => lead.id) },
        },
      })
    : 0;
  const icpOwners = new Map<string, Set<string>>();
  for (const lead of leads) {
    const owners = icpOwners.get(lead.icpId) ?? new Set<string>();
    owners.add(lead.canonicalCompanyId);
    icpOwners.set(lead.icpId, owners);
  }
  const duplicateIcp = [...icpOwners.values()].some((owners) => owners.size > 1);
  if (terminal || delivered > 0 || duplicateIcp) {
    throw new OrganizationIdentityCommercialFactsImmutableError();
  }
}
