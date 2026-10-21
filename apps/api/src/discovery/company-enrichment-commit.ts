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

/** `_name` keys (never `_ts`) with code-token values; bookkeeping, not facts. */
const MARKER_KEY = /^_[a-z][a-z0-9_]{0,40}$/u;
const MARKER_VALUE = /^[a-z0-9][a-z0-9_./-]{0,63}$/u;

function validNamespaceMarkers(markers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  if (markers === undefined) return {};
  const entries = Object.entries(markers);
  if (
    entries.length > 4 ||
    entries.some(([key, value]) => key === '_ts' || !MARKER_KEY.test(key) || typeof value !== 'string' || !MARKER_VALUE.test(value))
  ) {
    throw new Error('COMPANY_ENRICHMENT_NAMESPACE_MARKER_INVALID');
  }
  return Object.fromEntries(entries);
}

/** One hit's namespace and field evidence after governance, or undefined when nothing survives. */
function governHit(
  hit: CompanyEnrichmentHit,
  signalTimestamp: Date | undefined,
  markers: Readonly<Record<string, string>>,
): { namespace: unknown; evidence: Record<string, unknown> } | undefined {
  const evidence = Object.fromEntries(
    Object.entries(hit.result.attributes).flatMap(([field, value]) => {
      if (value == null) return [];
      const governed = sanitizeStoredCompanyFieldEvidence(`${hit.key}.${field}`, value);
      return governed === undefined ? [] : [[field, governed]];
    }),
  );
  if (Object.keys(evidence).length === 0) return undefined;
  const candidate = {
    ...evidence,
    ...(signalTimestamp ? { _ts: signalTimestamp.toISOString() } : {}),
    ...markers,
  };
  const namespace = sanitizeCanonicalCompanyAttributes({ [hit.key]: candidate })[hit.key];
  return namespace === undefined ? undefined : { namespace, evidence };
}

/**
 * Whether committing this hit would store anything. A caller that binds receipts to a hit's
 * write asks first, so a hit that governance empties is handled as a miss, not as a write that
 * silently does nothing.
 */
export function enrichmentHitSurvivesGovernance(hit: CompanyEnrichmentHit, signalTimestamp?: Date): boolean {
  return governHit(hit, signalTimestamp, {}) !== undefined;
}

/**
 * Final transaction boundary for forward/backlog enrichment and signal activities.
 * It intentionally accepts no pre-wire attributes snapshot. `namespaceMarkers`
 * are stored in each committed namespace next to `_ts`, never as field evidence.
 */
export async function commitCompanyEnrichmentResults(
  tx: Prisma.TransactionClient,
  args: {
    workspaceId: string;
    companyId: string;
    hits: readonly CompanyEnrichmentHit[];
    status?: 'ENRICHED';
    signalTimestamp?: Date;
    namespaceMarkers?: Readonly<Record<string, string>>;
  },
): Promise<boolean> {
  const markers = validNamespaceMarkers(args.namespaceMarkers);
  const current = await loadCompanyForSuppressionSafeWrite(tx, args.workspaceId, args.companyId);
  if (!current) return false;

  const merged: Record<string, unknown> = { ...current.attributes };
  const governedHits: CompanyEnrichmentHit[] = [];
  for (const hit of args.hits) {
    const governed = governHit(hit, args.signalTimestamp, markers);
    if (governed === undefined) continue;
    merged[hit.key] = governed.namespace;
    governedHits.push({
      ...hit,
      result: {
        ...hit.result,
        attributes: governed.evidence,
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
