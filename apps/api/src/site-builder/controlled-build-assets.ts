import path from "node:path";
import type { Prisma } from "@prisma/client";
import {
  demoVisualPackV2Digest,
  type AssetRefV1_1,
  type DesignBriefV2,
  type DesignCatalogV2,
} from "@global/contracts";
import type { PrismaService } from "../prisma/prisma.service";
import type {
  TenantVariantBytes,
  TenantVariantReader,
} from "./controlled-asset-materializer";

const TENANT_ASSET_KINDS = new Set([
  "logo",
  "product_image",
  "factory_image",
  "cert",
]);
const RENDERABLE_IMAGE_MIMES = new Set([
  "image/avif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
]);
const MAX_CONTROLLED_VARIANT_BYTES = 64 * 1024 * 1024;

type AssetManifestTx = Pick<Prisma.TransactionClient, "asset">;

export async function buildControlledAssetManifest(
  tx: AssetManifestTx,
  input: {
    siteId: string;
    brief: DesignBriefV2;
    catalog: DesignCatalogV2;
  },
): Promise<Record<string, AssetRefV1_1>> {
  const pack = input.catalog.demoVisualPacks.find(
    (candidate) =>
      candidate.id === input.brief.assetStrategy.demoVisualPackId &&
      candidate.version === input.brief.assetStrategy.demoVisualPackVersion,
  );
  if (
    !pack ||
    pack.status !== "approved" ||
    demoVisualPackV2Digest(pack) !==
      input.brief.assetStrategy.demoVisualPackDigest
  ) {
    throw new Error("CONTROLLED_ASSET_CATALOG_INVALID");
  }
  const manifest: Record<string, AssetRefV1_1> = Object.fromEntries(
    pack.assets
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((asset) => [
        `catalog-${asset.id}`,
        {
          source: "catalog" as const,
          packId: pack.id,
          packVersion: pack.version,
          catalogAssetId: asset.id,
          sha256: asset.sha256,
          mimeType: asset.mimeType,
        },
      ]),
  );
  const assets = await tx.asset.findMany({
    where: {
      siteId: input.siteId,
      deletedAt: null,
      processingStatus: "ready",
      kind: { in: [...TENANT_ASSET_KINDS] },
    },
    orderBy: [{ kind: "asc" }, { id: "asc" }],
    select: {
      id: true,
      kind: true,
      contentHash: true,
      variants: {
        where: { status: "ready", contentHash: { not: null } },
        orderBy: [{ variantType: "asc" }, { id: "asc" }],
        select: {
          id: true,
          contentHash: true,
          mime: true,
        },
      },
    },
  });
  for (const asset of assets) {
    const variant = asset.variants.find((candidate) =>
      RENDERABLE_IMAGE_MIMES.has(candidate.mime),
    );
    if (
      !asset.contentHash ||
      !/^[a-f0-9]{64}$/.test(asset.contentHash) ||
      !variant?.contentHash ||
      !/^[a-f0-9]{64}$/.test(variant.contentHash)
    ) {
      continue;
    }
    manifest[
      `tenant-${asset.id.toLowerCase()}-${variant.contentHash.slice(0, 12)}`
    ] = {
      source: "tenant",
      assetId: asset.id,
      kind: asset.kind,
      contentHash: asset.contentHash,
      variantId: variant.id,
      variantHash: variant.contentHash,
      mimeType: variant.mime,
    };
  }
  return manifest;
}

export function createTenantVariantReader(input: {
  prisma: PrismaService;
  storage: {
    getBufferBounded(
      key: string,
      maxBytes: number,
      signal?: AbortSignal,
    ): Promise<Buffer>;
  };
  signal?: AbortSignal;
}): TenantVariantReader {
  return {
    async readReadyVariant(request): Promise<TenantVariantBytes | null> {
      const row = await input.prisma.withWorkspace(
        request.workspaceId,
        async (tx) =>
          tx.assetVariant.findFirst({
            where: {
              id: request.variantId,
              assetId: request.assetId,
              siteId: request.siteId,
              status: "ready",
              contentHash: { not: null },
              asset: {
                deletedAt: null,
                processingStatus: "ready",
              },
            },
            select: {
              id: true,
              assetId: true,
              contentHash: true,
              mime: true,
              objectKey: true,
              sizeBytes: true,
              asset: {
                select: { kind: true, contentHash: true },
              },
            },
          }),
      );
      if (!row?.contentHash || !row.asset.contentHash) return null;
      const ceiling = Math.min(
        MAX_CONTROLLED_VARIANT_BYTES,
        Math.max(1, row.sizeBytes ?? MAX_CONTROLLED_VARIANT_BYTES),
      );
      const data = await input.storage.getBufferBounded(
        row.objectKey,
        ceiling,
        input.signal,
      );
      return {
        data,
        assetId: row.assetId,
        kind: row.asset.kind,
        contentHash: row.asset.contentHash,
        variantId: row.id,
        variantHash: row.contentHash,
        mimeType: row.mime,
      };
    },
  };
}

export function resolveRepositoryRoot(cwd = process.cwd()): string {
  const normalized = path.resolve(cwd);
  if (
    path.basename(normalized) === "api" &&
    path.basename(path.dirname(normalized)) === "apps"
  ) {
    return path.resolve(normalized, "../..");
  }
  return normalized;
}
