import { Prisma } from '@prisma/client';
import type { EnrichmentResult } from './provider-contract';
import { loadCompanyForSuppressionSafeWrite } from './company-suppression-gate';
import {
  sanitizeCanonicalCompanyAttributes,
  sanitizeStoredCompanyFieldEvidence,
} from './canonical-company-attributes';

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
  const governedHits: CompanyEnrichmentHit[] = [];
  for (const hit of args.hits) {
    const governedEvidence = Object.fromEntries(
      Object.entries(hit.result.attributes).flatMap(([field, value]) => {
        if (value == null) return [];
        const governed = sanitizeStoredCompanyFieldEvidence(`${hit.key}.${field}`, value);
        return governed === undefined ? [] : [[field, governed]];
      }),
    );
    if (Object.keys(governedEvidence).length === 0) continue;
    const candidate = args.signalTimestamp
      ? { ...governedEvidence, _ts: args.signalTimestamp.toISOString() }
      : governedEvidence;
    const governed = sanitizeCanonicalCompanyAttributes({
      [hit.key]: candidate,
    })[hit.key];
    if (governed === undefined) continue;
    merged[hit.key] = governed;
    governedHits.push({
      ...hit,
      result: {
        ...hit.result,
        attributes: governedEvidence as Record<string, unknown>,
      },
    });
  }
  if (governedHits.length === 0) return false;
  const updated = await tx.canonicalCompany.updateMany({
    where: { id: current.id, status: { not: 'SUPPRESSED' } },
    data: {
      attributes: merged as Prisma.InputJsonValue,
      ...(args.status ? { status: args.status } : {}),
      version: { increment: 1 },
    },
  });
  if (updated.count !== 1) return false;

  for (const hit of governedHits) {
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
