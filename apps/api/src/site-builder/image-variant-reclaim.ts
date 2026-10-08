import { Prisma } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import { readPublishedVariantKeys } from './media-foundation';
import type { StorageService } from './storage.service';

// One frozen asset cleanup plan holds at most 128 objects (asset-cleanup.contract.ts); the
// reservation budgets keep every asset inside it, so reclaiming never needs more.
const MAX_RECLAIM_OBJECTS = 128;
const RECLAIM_CONCURRENCY = 8;
// The transaction may run 30 s from BEGIN, the wait for the asset lock included. Storage work
// stops 20 s after BEGIN so the lock still covers every deletion and the row deletes after it.
const RECLAIM_TRANSACTION = { maxWait: 10_000, timeout: 30_000 } as const;
const RECLAIM_STORAGE_DEADLINE_MS = 20_000;
const MIN_STORAGE_WINDOW_MS = 5_000;
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

export type ImageVariantReclaimSkipReason = 'build_in_progress' | 'manifest_unreadable' | 'lock_contended';

export type ImageVariantReclaimResult =
  | { status: 'reclaimed'; rows: number; objects: number }
  | { status: 'skipped'; reason: ImageVariantReclaimSkipReason };

export interface VariantProvenanceRow {
  recipeHash: string;
  objectKey: string;
  metadata: Prisma.JsonValue | null;
}

interface LedgerRow extends VariantProvenanceRow {
  id: string;
  status: string;
  sourceVariantId: string | null;
}

function jsonRecord(value: Prisma.JsonValue | null | undefined): Record<string, Prisma.JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : {};
}

/** Every attempt-object key a variant row records, from its history and its reservation. */
export function attemptKeysFromMetadata(metadata: Record<string, Prisma.JsonValue>): string[] {
  const keys = Array.isArray(metadata.attemptKeys)
    ? metadata.attemptKeys.filter((value): value is string => typeof value === 'string')
    : [];
  const reservation = jsonRecord(metadata.reservation ?? null);
  if (typeof reservation.attemptKey === 'string') keys.push(reservation.attemptKey);
  return [...new Set(keys)];
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
  const keys = attemptKeysFromMetadata(jsonRecord(row.metadata));
  const prefix = `ws/${job.workspaceId}/${job.siteId}/variant-attempts/${job.assetId}/`;
  const suffix = `/${row.recipeHash}.${ext}`;
  for (const key of keys) {
    const token = key.startsWith(prefix) && key.endsWith(suffix) ? key.slice(prefix.length, -suffix.length) : '';
    if (!ATTEMPT_TOKEN.test(token)) {
      throw new Error(`image variant attempt provenance conflicts for ${row.recipeHash}`);
    }
  }
  return keys;
}

/** Locks the asset row the producer is working from and returns its published manifest. */
async function lockAsset(tx: Prisma.TransactionClient, job: ImageVariantReclaimJob): Promise<Prisma.JsonValue | null> {
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
  return locked[0].derivedKeys;
}

/**
 * Variant ids that a version of the site may still materialize. A page or section build merges
 * the active version's assets into its spec and reads every one of them by id, and a succeeded
 * version can become active again on rollback, so a row such a version references must outlive
 * the manifest that once published it. A failed version is never built from again.
 */
async function referencedVariantIds(tx: Prisma.TransactionClient, job: ImageVariantReclaimJob): Promise<Set<string>> {
  const rows = await tx.$queryRaw<Array<{ variantId: string }>>(Prisma.sql`
    SELECT DISTINCT lower(ref.value ->> 'variantId') AS "variantId"
    FROM site_version AS version
    CROSS JOIN LATERAL jsonb_each(
      CASE WHEN jsonb_typeof(version.spec -> 'assets') = 'object' THEN version.spec -> 'assets' ELSE '{}'::jsonb END
    ) AS ref
    WHERE version.site_id = ${job.siteId}::uuid
      AND version.build_status <> 'failed'
      AND ref.value ->> 'source' = 'tenant'
      AND lower(ref.value ->> 'assetId') = lower(${job.assetId})
      AND ref.value ->> 'variantId' IS NOT NULL
  `);
  return new Set(rows.map((row) => row.variantId));
}

/** Terminal rows that are neither published nor about to be produced again. */
function unpublishedTerminalRows(
  rows: readonly LedgerRow[],
  published: ReadonlySet<string>,
  planned: ReadonlySet<string>,
): LedgerRow[] {
  return rows.filter(
    (row) =>
      (row.status === 'ready' || row.status === 'failed') &&
      !published.has(row.objectKey) &&
      !planned.has(row.recipeHash),
  );
}

/** Candidates nothing keeps, children first; a kept row keeps its source row, transitively. */
function supersededRows(
  rows: readonly LedgerRow[],
  candidateRows: readonly LedgerRow[],
  referenced: ReadonlySet<string>,
): LedgerRow[] {
  const candidates = new Map(
    candidateRows.filter((row) => !referenced.has(row.id.toLowerCase())).map((row) => [row.id, row]),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!candidates.has(row.id) && row.sourceVariantId && candidates.delete(row.sourceVariantId)) changed = true;
    }
  }
  const ordered: LedgerRow[] = [];
  while (candidates.size > 0) {
    const sources = new Set([...candidates.values()].flatMap((row) => (row.sourceVariantId ? [row.sourceVariantId] : [])));
    const leaves = [...candidates.values()].filter((row) => !sources.has(row.id));
    if (leaves.length === 0) throw new Error('image variant source graph contains a cycle');
    for (const leaf of leaves) {
      ordered.push(leaf);
      candidates.delete(leaf.id);
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
    // Settle the whole batch first: a rejection must not end the transaction, and with it the
    // asset lock, while sibling deletes are still in flight.
    const deleted = await Promise.allSettled(batch.map((key) => storage.delete(key, signal)));
    const failure = deleted.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
    const heads = await Promise.all(batch.map((key) => storage.head(key, signal)));
    const survivor = batch.find((_key, index) => heads[index]);
    if (survivor) throw new Error(`image variant reclamation could not delete ${survivor}`);
  }
}

async function reclaimLocked(
  tx: Prisma.TransactionClient,
  deps: ImageVariantReclaimDeps,
  job: ImageVariantReclaimJob,
  planned: ReadonlySet<string>,
  startedAt: number,
  signal: AbortSignal | undefined,
): Promise<ImageVariantReclaimResult> {
  const derivedKeys = await lockAsset(tx, job);
  const building = await tx.siteVersion.findFirst({
    where: { siteId: job.siteId, buildStatus: 'building' },
    select: { id: true },
  });
  if (building) return { status: 'skipped', reason: 'build_in_progress' };
  const published = readPublishedVariantKeys(derivedKeys, job.sourceHash);
  if (published.status === 'invalid') return { status: 'skipped', reason: 'manifest_unreadable' };
  const rows = await tx.assetVariant.findMany({
    where: { assetId: job.assetId },
    select: { id: true, recipeHash: true, objectKey: true, status: true, metadata: true, sourceVariantId: true },
  });
  const candidates = unpublishedTerminalRows(
    rows,
    published.status === 'present' ? published.keys : new Set<string>(),
    planned,
  );
  if (candidates.length === 0) return { status: 'reclaimed', rows: 0, objects: 0 };
  const superseded = supersededRows(rows, candidates, await referencedVariantIds(tx, job));
  const objects = [...new Set(superseded.flatMap((row) => [row.objectKey, ...variantAttemptKeys(job, row)]))];
  if (objects.length > MAX_RECLAIM_OBJECTS) {
    throw new Error(`image variant reclamation exceeds ${MAX_RECLAIM_OBJECTS} objects`);
  }
  if (superseded.length === 0) return { status: 'reclaimed', rows: 0, objects: 0 };
  const window = startedAt + RECLAIM_STORAGE_DEADLINE_MS - Date.now();
  if (window < MIN_STORAGE_WINDOW_MS) return { status: 'skipped', reason: 'lock_contended' };
  await deleteObjects(
    deps.storage,
    objects,
    AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(window)]),
  );
  let removed = 0;
  for (const row of superseded) {
    const deleted = await tx.assetVariant.deleteMany({
      where: { id: row.id, assetId: job.assetId, status: row.status },
    });
    removed += deleted.count;
  }
  return { status: 'reclaimed', rows: removed, objects: objects.length };
}

/**
 * Removes the variant rows and objects an asset has superseded: terminal rows that its published
 * derivedKeys manifest does not reference, that no site version names, and that the current
 * plans will not reuse. Without this, every pipeline-version change (each sharp/libvips upgrade)
 * leaves a full set behind until the reservation and cleanup budgets refuse the asset.
 *
 * Everything runs in one transaction under the asset row lock that reservation, promotion,
 * finalization and asset deletion also take, so no producer can publish or re-promote a row
 * while it is reclaimed. Builds pick only published rows; a build already in flight may still
 * hold a row chosen under an older manifest, so reclamation waits until the site has no building
 * version. The only moment a build holds rows outside site_version is between choosing them and
 * creating its building version; image processing runs before that step in the same run, and a
 * site has one active build run at a time. Objects go first and must be gone before their rows
 * are deleted, so a failure never leaves an object without the row that asset deletion would
 * clean it up through.
 */
export async function reclaimSupersededImageVariants(
  deps: ImageVariantReclaimDeps,
  job: ImageVariantReclaimJob,
  planned: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<ImageVariantReclaimResult> {
  return deps.prisma.withWorkspace(
    job.workspaceId,
    (tx) => reclaimLocked(tx, deps, job, planned, Date.now(), signal),
    RECLAIM_TRANSACTION,
  );
}
