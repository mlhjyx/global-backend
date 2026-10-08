import { Prisma } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import { readPublishedVariantKeys } from './media-foundation';
import type { StorageService } from './storage.service';

// One frozen asset cleanup plan holds at most 128 objects (asset-cleanup.contract.ts); the
// reservation budgets keep every asset inside it, so reclaiming never needs more.
const MAX_RECLAIM_OBJECTS = 128;
const RECLAIM_CONCURRENCY = 8;
// Storage work runs inside the asset-locked transaction (30 s), so it must give up first.
const RECLAIM_STORAGE_TIMEOUT_MS = 20_000;
const VARIANT_EXTENSIONS = new Set(['avif', 'webp', 'jpg', 'png']);
const ATTEMPT_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ImageVariantReclaimDeps {
  prisma: Pick<PrismaService, 'withWorkspace'>;
  storage: Pick<StorageService, 'delete' | 'head'>;
}

export interface ImageVariantReclaimJob {
  workspaceId: string;
  siteId: string;
  assetId: string;
  sourceHash: string;
  sourceObjectKey: string;
}

export type ImageVariantReclaimResult =
  | { status: 'reclaimed'; rows: number; objects: number }
  | { status: 'skipped'; reason: 'build_in_progress' | 'manifest_unreadable' };

export interface VariantProvenanceRow {
  recipeHash: string;
  objectKey: string;
  metadata: Prisma.JsonValue | null;
}

interface LedgerRow extends VariantProvenanceRow {
  id: string;
  status: string;
  sourceVariantId: string | null;
  updatedAt: Date;
}

function jsonRecord(value: Prisma.JsonValue | null | undefined): Record<string, Prisma.JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : {};
}

/**
 * Attempt-object keys recorded on a variant row, after checking that the row's canonical key and
 * every attempt key belong to this asset and recipe. A mismatch is a provenance conflict: nothing
 * outside the asset's own variant namespace may ever be deleted on its behalf.
 */
export function variantAttemptKeys(job: ImageVariantReclaimJob, row: VariantProvenanceRow): string[] {
  const canonicalPrefix = `ws/${job.workspaceId}/${job.siteId}/variants/${job.assetId}/${row.recipeHash}.`;
  const ext = row.objectKey.startsWith(canonicalPrefix) ? row.objectKey.slice(canonicalPrefix.length) : '';
  if (!VARIANT_EXTENSIONS.has(ext)) {
    throw new Error(`image variant canonical provenance conflicts for ${row.recipeHash}`);
  }
  const metadata = jsonRecord(row.metadata);
  const keys = Array.isArray(metadata.attemptKeys)
    ? metadata.attemptKeys.filter((value): value is string => typeof value === 'string')
    : [];
  const reservation = jsonRecord(metadata.reservation);
  if (typeof reservation.attemptKey === 'string') keys.push(reservation.attemptKey);
  const prefix = `ws/${job.workspaceId}/${job.siteId}/variant-attempts/${job.assetId}/`;
  const suffix = `/${row.recipeHash}.${ext}`;
  for (const key of keys) {
    const token = key.startsWith(prefix) && key.endsWith(suffix) ? key.slice(prefix.length, -suffix.length) : '';
    if (!ATTEMPT_TOKEN.test(token)) {
      throw new Error(`image variant attempt provenance conflicts for ${row.recipeHash}`);
    }
  }
  return [...new Set(keys)];
}

/**
 * Terminal rows the asset neither publishes nor is about to produce, ordered children first.
 * A row that stays keeps its source row, transitively.
 */
function reclaimableRows(
  rows: readonly LedgerRow[],
  published: ReadonlySet<string>,
  planned: ReadonlySet<string>,
): LedgerRow[] {
  const candidates = new Map(
    rows
      .filter(
        (row) =>
          (row.status === 'ready' || row.status === 'failed') &&
          !published.has(row.objectKey) &&
          !planned.has(row.recipeHash),
      )
      .map((row) => [row.id, row]),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!candidates.has(row.id) && row.sourceVariantId && candidates.delete(row.sourceVariantId)) {
        changed = true;
      }
    }
  }
  const remaining = new Map(candidates);
  const ordered: LedgerRow[] = [];
  while (remaining.size > 0) {
    const sources = new Set([...remaining.values()].flatMap((row) => (row.sourceVariantId ? [row.sourceVariantId] : [])));
    const leaves = [...remaining.values()].filter((row) => !sources.has(row.id));
    if (leaves.length === 0) throw new Error('image variant source graph contains a cycle');
    for (const leaf of leaves) {
      ordered.push(leaf);
      remaining.delete(leaf.id);
    }
  }
  return ordered;
}

async function deleteObjects(
  storage: ImageVariantReclaimDeps['storage'],
  keys: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  for (let offset = 0; offset < keys.length; offset += RECLAIM_CONCURRENCY) {
    if (signal.aborted) {
      // The caller's cancellation (or the storage deadline) keeps its own reason.
      throw signal.reason instanceof Error ? signal.reason : new Error('image variant reclamation aborted');
    }
    const batch = keys.slice(offset, offset + RECLAIM_CONCURRENCY);
    await Promise.all(batch.map((key) => storage.delete(key, signal)));
    const heads = await Promise.all(batch.map((key) => storage.head(key, signal)));
    const survivor = batch.find((_key, index) => heads[index]);
    if (survivor) throw new Error(`image variant reclamation could not delete ${survivor}`);
  }
}

/**
 * Removes the variant rows and objects an asset has superseded: terminal rows that its published
 * derivedKeys manifest does not reference and that the current plans will not reuse. Without
 * this, every pipeline-version change (each sharp/libvips upgrade) or focal-point change leaves a
 * full set behind until the reservation and cleanup budgets refuse the asset.
 *
 * Everything runs under the asset row lock that reservation, promotion and finalization also
 * take, so no producer can publish or re-promote a row while it is reclaimed. Builds read only
 * published rows; a build already in flight may still hold a row chosen under an older manifest,
 * so reclamation waits until the site has no building version. Objects go first and must be
 * gone before their rows are deleted, so a failure never leaves an object without its row.
 */
export async function reclaimSupersededImageVariants(
  deps: ImageVariantReclaimDeps,
  job: ImageVariantReclaimJob,
  planned: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<ImageVariantReclaimResult> {
  return deps.prisma.withWorkspace(
    job.workspaceId,
    async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string; derivedKeys: Prisma.JsonValue | null }>>(Prisma.sql`
        SELECT id, derived_keys AS "derivedKeys"
        FROM asset
        WHERE id = ${job.assetId}::uuid
          AND workspace_id = ${job.workspaceId}::uuid
          AND site_id = ${job.siteId}::uuid
          AND deleted_at IS NULL
          AND processing_status = 'ready'
          AND content_hash = ${job.sourceHash}
          AND object_key = ${job.sourceObjectKey}
        FOR UPDATE
      `);
      if (locked.length !== 1) throw new Error('asset changed before image variant reclamation');
      const building = await tx.siteVersion.findFirst({
        where: { siteId: job.siteId, buildStatus: 'building' },
        select: { id: true },
      });
      if (building) return { status: 'skipped', reason: 'build_in_progress' };
      const published = readPublishedVariantKeys(locked[0].derivedKeys, job.sourceHash);
      if (published.status === 'invalid') return { status: 'skipped', reason: 'manifest_unreadable' };
      const rows = await tx.assetVariant.findMany({
        where: { assetId: job.assetId },
        select: {
          id: true,
          recipeHash: true,
          objectKey: true,
          status: true,
          metadata: true,
          sourceVariantId: true,
          updatedAt: true,
        },
      });
      const reclaimable = reclaimableRows(
        rows,
        published.status === 'present' ? published.keys : new Set<string>(),
        planned,
      );
      const objects = [
        ...new Set(reclaimable.flatMap((row) => [row.objectKey, ...variantAttemptKeys(job, row)])),
      ];
      if (objects.length > MAX_RECLAIM_OBJECTS) {
        throw new Error(`image variant reclamation exceeds ${MAX_RECLAIM_OBJECTS} objects`);
      }
      if (reclaimable.length === 0) return { status: 'reclaimed', rows: 0, objects: 0 };
      const storageSignal = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(RECLAIM_STORAGE_TIMEOUT_MS),
      ]);
      await deleteObjects(deps.storage, objects, storageSignal);
      let removed = 0;
      for (const row of reclaimable) {
        // updatedAt fences writers that touch a row without the asset lock.
        const deleted = await tx.assetVariant.deleteMany({
          where: { id: row.id, assetId: job.assetId, status: row.status, updatedAt: row.updatedAt },
        });
        removed += deleted.count;
      }
      return { status: 'reclaimed', rows: removed, objects: objects.length };
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
}
