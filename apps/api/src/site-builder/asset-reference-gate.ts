import { Prisma } from '@prisma/client';
import {
  AssetReferenceScanError,
  siteSpecPotentialAssetIds,
} from './asset-reference';

type AssetReferenceTx = Pick<Prisma.TransactionClient, '$queryRaw'>;

export interface LockedReferenceAsset {
  id: string;
  kind: string;
  processingStatus: string;
  contentHash: string | null;
}

export class AssetReferenceGateError extends Error {
  constructor(
    readonly assetIds: string[],
    message = 'one or more asset references are not live and ready',
  ) {
    super(message);
    this.name = 'AssetReferenceGateError';
  }
}

function sortedUnique(assetIds: readonly string[]): string[] {
  return [...new Set(assetIds.map((assetId) => assetId.toLowerCase()))].sort();
}

/**
 * Shared database gate for every reference writer. Row locks are acquired in stable UUID order,
 * then live/readiness is revalidated in the same transaction. DELETE locks the same row, so a
 * writer and deletion can never both commit a dangling reference.
 */
export async function lockLiveAssetsForReference(
  tx: AssetReferenceTx,
  input: {
    workspaceId: string;
    siteId: string;
    assetIds: readonly string[];
  },
): Promise<LockedReferenceAsset[]> {
  const assetIds = sortedUnique(input.assetIds);
  if (assetIds.length === 0) return [];
  const rows = await tx.$queryRaw<LockedReferenceAsset[]>(Prisma.sql`
    SELECT id, kind, processing_status AS "processingStatus", content_hash AS "contentHash"
    FROM asset
    WHERE workspace_id = ${input.workspaceId}::uuid
      AND site_id = ${input.siteId}::uuid
      AND id IN (${Prisma.join(assetIds.map((assetId) => Prisma.sql`${assetId}::uuid`))})
      AND deleted_at IS NULL
      AND processing_status = 'ready'
      AND content_hash IS NOT NULL
    ORDER BY id
    FOR UPDATE
  `);
  const found = new Set(rows.map((row) => row.id));
  const missing = assetIds.filter((assetId) => !found.has(assetId));
  if (missing.length > 0) throw new AssetReferenceGateError(missing);
  return rows;
}

/** DELETE takes the same per-Asset row lock before scanning and tombstoning. */
export async function lockAssetForDeletion(
  tx: AssetReferenceTx,
  input: { workspaceId: string; assetId: string },
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM asset
    WHERE workspace_id = ${input.workspaceId}::uuid
      AND id = ${input.assetId}::uuid
      AND deleted_at IS NULL
    FOR UPDATE
  `);
  return rows.length === 1;
}

/** Reconciliation locks historical tombstones too; it never makes them live again. */
export async function lockAssetForCleanupReconciliation(
  tx: AssetReferenceTx,
  input: { workspaceId: string; assetId: string },
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM asset
    WHERE workspace_id = ${input.workspaceId}::uuid
      AND id = ${input.assetId}::uuid
    FOR UPDATE
  `);
  return rows.length === 1;
}

/** Pointer activation is the authoritative SiteSpec write gate in the current schema. */
export async function lockSiteSpecAssetsForActivation(
  tx: AssetReferenceTx,
  input: { workspaceId: string; siteId: string; spec: unknown },
): Promise<LockedReferenceAsset[]> {
  const { manifestIds, manifestRefs, propAssetIds, undeclaredAssetRefs } =
    siteSpecPotentialAssetIds(input.spec);
  if (undeclaredAssetRefs.length > 0) {
    throw new AssetReferenceScanError(
      `SiteSpec props reference assets missing from the manifest: ${undeclaredAssetRefs.join(',')}`,
    );
  }
  const manifest = new Set(manifestIds);
  const undeclaredAssets = propAssetIds.filter(
    (assetId) => !manifest.has(assetId),
  );
  if (undeclaredAssets.length > 0) {
    throw new AssetReferenceScanError(
      `SiteSpec props reference Asset ids missing from the manifest: ${undeclaredAssets.join(',')}`,
    );
  }
  const candidates = sortedUnique(manifestIds);
  if (candidates.length === 0) return [];
  const rows = await tx.$queryRaw<
    Array<LockedReferenceAsset & { siteId: string; deletedAt: Date | null }>
  >(Prisma.sql`
    SELECT id,
           site_id AS "siteId",
           kind,
           processing_status AS "processingStatus",
           content_hash AS "contentHash",
           deleted_at AS "deletedAt"
    FROM asset
    WHERE workspace_id = ${input.workspaceId}::uuid
      AND id IN (${Prisma.join(candidates.map((assetId) => Prisma.sql`${assetId}::uuid`))})
    ORDER BY id
    FOR UPDATE
  `);
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const manifestId of manifestIds) {
    const row = byId.get(manifestId);
    if (
      !row ||
      row.siteId !== input.siteId ||
      row.deletedAt ||
      row.processingStatus !== 'ready' ||
      !row.contentHash ||
      row.kind !== manifestRefs[manifestId]?.kind ||
      row.contentHash !== manifestRefs[manifestId]?.hash
    ) {
      throw new AssetReferenceGateError([manifestId]);
    }
  }
  return manifestIds.map((id) => byId.get(id)!);
}
