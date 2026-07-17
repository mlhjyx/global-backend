import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { lockAssetForCleanupReconciliation } from '../site-builder/asset-reference-gate';
import type { SiteSpecAssetReferenceScanner } from '../site-builder/site-spec-asset-reference-scanner';
import { assetCleanupPayload, matchesAssetCleanupPayload, parseAssetCleanupCommand } from './asset-cleanup.contract';

export type ParkedCleanupClassification =
  'eligible' | 'referenced' | 'busy' | 'inconsistent' | 'missing' | 'already_reconciled';

export interface ParkedCleanupReconcileResult {
  scanned: number;
  nextCursor: string | null;
  applied: boolean;
  legacyUnboundRemaining: number;
  counts: Record<ParkedCleanupClassification, number>;
  items: Array<{
    eventId: string;
    classification: ParkedCleanupClassification;
    usageCount?: number;
  }>;
}

type ReconcileOwnerTx = Pick<Prisma.TransactionClient, '$queryRaw' | 'outboxEvent' | 'asset'>;
type ReconcileOwnerDb = Pick<PrismaClient, 'outboxEvent' | 'asset'> & {
  $transaction<T>(
    fn: (tx: ReconcileOwnerTx) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function emptyCounts(): Record<ParkedCleanupClassification, number> {
  return {
    eligible: 0,
    referenced: 0,
    busy: 0,
    inconsistent: 0,
    missing: 0,
    already_reconciled: 0,
  };
}

function isLegacyCanonicalPayload(value: unknown): value is {
  assetId: string;
  siteId: string;
  objectKey: string;
  objectClass: 'canonical';
  reason: 'asset_deleted';
  blockedUntil: 'site_spec_asset_reference_scanner';
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return (
    payload.objectClass === 'canonical' &&
    payload.reason === 'asset_deleted' &&
    payload.blockedUntil === 'site_spec_asset_reference_scanner' &&
    typeof payload.assetId === 'string' &&
    typeof payload.siteId === 'string' &&
    typeof payload.objectKey === 'string'
  );
}

/**
 * Dry-run by default. ownerDb only enumerates cross-tenant candidates; every classification and
 * mutation is performed through app_user RLS in a workspace transaction.
 */
export async function reconcileParkedCanonicalCleanups(
  deps: {
    ownerDb: ReconcileOwnerDb;
    prisma: PrismaService;
    scanner: SiteSpecAssetReferenceScanner;
  },
  input: { apply?: boolean; limit?: number; afterId?: bigint } = {},
): Promise<ParkedCleanupReconcileResult> {
  return deps.ownerDb.$transaction(
    async (ownerTx) => {
      const lock = await ownerTx.$queryRaw<Array<{ locked: boolean }>>(Prisma.sql`
      SELECT pg_try_advisory_xact_lock(
        hashtextextended('site-builder-mf0b-cleanup-reconcile', 0)
      ) AS locked
    `);
      if (!lock[0]?.locked) {
        throw new Error('canonical cleanup reconciliation is already running');
      }
      return reconcileParkedCanonicalCleanupsLocked({ ...deps, ownerDb: ownerTx }, input);
    },
    { maxWait: 5_000, timeout: 10 * 60_000 },
  );
}

async function reconcileParkedCanonicalCleanupsLocked(
  deps: {
    ownerDb: Pick<ReconcileOwnerTx, 'outboxEvent' | 'asset'>;
    prisma: PrismaService;
    scanner: SiteSpecAssetReferenceScanner;
  },
  input: { apply?: boolean; limit?: number; afterId?: bigint },
): Promise<ParkedCleanupReconcileResult> {
  const apply = input.apply === true;
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const events = await deps.ownerDb.outboxEvent.findMany({
    where: {
      eventType: 'AssetObjectCleanupRequested',
      schemaVersion: 1,
      parkedAt: { not: null },
      ...(input.afterId ? { id: { gt: input.afterId } } : {}),
    },
    orderBy: { id: 'asc' },
    take: limit,
    select: {
      id: true,
      eventId: true,
      workspaceId: true,
      aggregateId: true,
      payload: true,
    },
  });
  const counts = emptyCounts();
  const items: ParkedCleanupReconcileResult['items'] = [];

  for (const event of events) {
    const payload = event.payload;
    let classification: ParkedCleanupClassification = 'inconsistent';
    let usageCount: number | undefined;
    if (
      isLegacyCanonicalPayload(payload) &&
      payload.assetId === event.aggregateId &&
      UUID_RE.test(event.aggregateId) &&
      UUID_RE.test(event.workspaceId) &&
      UUID_RE.test(payload.siteId)
    ) {
      try {
        const outcome = await deps.prisma.withWorkspace(event.workspaceId, async (tx) => {
          if (
            !(await lockAssetForCleanupReconciliation(tx, {
              workspaceId: event.workspaceId,
              assetId: event.aggregateId,
            }))
          ) {
            return { classification: 'missing' as const };
          }
          const [asset, existingSuccessors, variants] = await Promise.all([
            tx.asset.findUnique({ where: { id: event.aggregateId } }),
            tx.outboxEvent.findMany({
              where: {
                causationId: event.eventId,
                eventType: 'AssetObjectCleanupRequested',
                schemaVersion: 2,
              },
              orderBy: { eventId: 'asc' },
              take: 2,
              select: {
                eventId: true,
                workspaceId: true,
                aggregateType: true,
                aggregateId: true,
                payload: true,
              },
            }),
            tx.assetVariant.findMany({
              where: { assetId: event.aggregateId },
              orderBy: { id: 'asc' },
              select: {
                id: true,
                objectKey: true,
                contentHash: true,
                recipeHash: true,
                sourceVariantId: true,
                status: true,
              },
            }),
          ]);
          if (!asset) return { classification: 'missing' as const };
          if (existingSuccessors.length > 0) {
            if (existingSuccessors.length !== 1) {
              return { classification: 'inconsistent' as const };
            }
            const existingSuccessor = existingSuccessors[0];
            let successorValid = false;
            try {
              const successorPayload = existingSuccessor.payload as Record<string, unknown>;
              const successor = parseAssetCleanupCommand({
                eventId: existingSuccessor.eventId,
                workspaceId: existingSuccessor.workspaceId,
                assetId: existingSuccessor.aggregateId,
                siteId: successorPayload.siteId,
                objectClass: successorPayload.objectClass,
                reason: successorPayload.reason,
                canonical: successorPayload.canonical,
                variants: successorPayload.variants,
              });
              successorValid =
                existingSuccessor.workspaceId === event.workspaceId &&
                existingSuccessor.aggregateType === 'Asset' &&
                existingSuccessor.aggregateId === event.aggregateId &&
                successor.objectClass === 'canonical' &&
                matchesAssetCleanupPayload(existingSuccessor.payload, successor) &&
                asset.cleanupEventId === existingSuccessor.eventId;
            } catch {
              // Keep the fail-closed default for malformed or mismatched successors.
            }
            return {
              classification: successorValid ? ('already_reconciled' as const) : ('inconsistent' as const),
            };
          }
          if (asset.cleanupCompletedAt) {
            return { classification: 'already_reconciled' as const };
          }
          if (asset.cleanupEventId && asset.cleanupEventId !== event.eventId) {
            return { classification: 'inconsistent' as const };
          }
          if (
            !asset.deletedAt ||
            asset.processingStatus !== 'deleted' ||
            asset.siteId !== payload.siteId ||
            asset.objectKey !== payload.objectKey ||
            !asset.contentHash
          ) {
            return { classification: 'inconsistent' as const };
          }
          if (variants.some((variant) => variant.status === 'processing')) {
            return { classification: 'busy' as const };
          }
          if (variants.some((variant) => !['ready', 'failed'].includes(variant.status))) {
            return { classification: 'inconsistent' as const };
          }
          const usages = await deps.scanner.scan(tx, {
            siteId: asset.siteId,
            assetId: asset.id,
          });
          if (usages.length > 0) {
            return {
              classification: 'referenced' as const,
              usageCount: usages.length,
            };
          }
          if (!apply) return { classification: 'eligible' as const };

          const eventId = randomUUID();
          const command = parseAssetCleanupCommand({
            eventId,
            workspaceId: event.workspaceId,
            siteId: asset.siteId,
            assetId: asset.id,
            objectClass: 'canonical',
            reason: 'asset_deleted',
            canonical: {
              objectKey: asset.objectKey,
              contentHash: asset.contentHash,
            },
            variants: variants.map((variant) => ({
              ...variant,
              status: variant.status as 'ready' | 'failed',
            })),
          });
          await tx.outboxEvent.create({
            data: {
              eventId,
              workspaceId: event.workspaceId,
              eventType: 'AssetObjectCleanupRequested',
              schemaVersion: 2,
              aggregateType: 'Asset',
              aggregateId: asset.id,
              causationId: event.eventId,
              privacyClassification: 'INTERNAL',
              payload: assetCleanupPayload(command) as Prisma.InputJsonValue,
            },
          });
          const bound = await tx.asset.updateMany({
            where: {
              id: asset.id,
              deletedAt: { not: null },
              cleanupCompletedAt: null,
              OR: [{ cleanupEventId: null }, { cleanupEventId: event.eventId }],
            },
            data: { cleanupEventId: eventId, cleanupLegacyUnbound: false },
          });
          if (bound.count !== 1) throw new Error('legacy canonical cleanup ownership changed');
          return { classification: 'eligible' as const };
        });
        classification = outcome.classification;
        usageCount = 'usageCount' in outcome ? outcome.usageCount : undefined;
      } catch {
        // A poison legacy row must be loud in the report but must not pin the stable cursor forever.
        classification = 'inconsistent';
      }
    }
    counts[classification] += 1;
    items.push({
      eventId: event.eventId,
      classification,
      ...(usageCount ? { usageCount } : {}),
    });
  }

  return {
    scanned: events.length,
    nextCursor: events.length === limit ? String(events.at(-1)!.id) : null,
    applied: apply,
    legacyUnboundRemaining: await deps.ownerDb.asset.count({
      where: { cleanupLegacyUnbound: true },
    }),
    counts,
    items,
  };
}
