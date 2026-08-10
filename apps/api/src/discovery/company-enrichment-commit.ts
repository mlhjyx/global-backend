import { Prisma } from '@prisma/client';
import type { EnrichmentResult } from './provider-contract';
import { loadCompanyForSuppressionSafeWrite } from './company-suppression-gate';

export interface CompanyEnrichmentHit {
  key: string;
  result: EnrichmentResult;
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
  },
): Promise<boolean> {
  const current = await loadCompanyForSuppressionSafeWrite(tx, args.workspaceId, args.companyId);
  if (!current) return false;

  const merged: Record<string, unknown> = { ...current.attributes };
  for (const hit of args.hits) {
    merged[hit.key] = args.signalTimestamp
      ? { ...hit.result.attributes, _ts: args.signalTimestamp.toISOString() }
      : hit.result.attributes;
  }
  const updated = await tx.canonicalCompany.updateMany({
    where: { id: current.id, status: { not: 'SUPPRESSED' } },
    data: {
      attributes: merged as Prisma.InputJsonValue,
      ...(args.status ? { status: args.status } : {}),
      version: { increment: 1 },
    },
  });
  if (updated.count !== 1) return false;

  for (const hit of args.hits) {
    for (const [field, value] of Object.entries(hit.result.attributes)) {
      if (value == null) continue;
      await tx.fieldEvidence.create({
        data: {
          workspaceId: args.workspaceId,
          entityType: 'company',
          entityId: current.id,
          field: `${hit.key}.${field}`,
          value: value as Prisma.InputJsonValue,
          providerKey: hit.key,
          confidence: hit.result.confidence,
          license: 'public',
          allowedActions: ['display', 'match'] as Prisma.InputJsonValue,
          ...(hit.result.provenance ? { fetchedAt: new Date(hit.result.provenance.fetchedAt) } : {}),
        },
      });
    }
  }
  return true;
}
