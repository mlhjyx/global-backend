import type { Prisma } from "@prisma/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import { STATIC_DESIGN_CATALOG_V2 } from "./design/catalog";
import { buildM1ebGoldenFixtures } from "./design/m1eb-golden";
import {
  buildControlledAssetManifest,
  createTenantVariantReader,
} from "./controlled-build-assets";

let golden: Awaited<ReturnType<typeof buildM1ebGoldenFixtures>>[number];

beforeAll(async () => {
  golden = (
    await buildM1ebGoldenFixtures(
      new URL("../../../../", import.meta.url).pathname,
    )
  )[0]!;
});

describe("M1-e-B controlled runtime assets", () => {
  it("combines the fixed approved pack with only ready, hash-bound tenant variants", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "factory_image",
        contentHash: "b".repeat(64),
        variants: [
          {
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            contentHash: "c".repeat(64),
            mime: "image/webp",
          },
        ],
      },
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        kind: "product_image",
        contentHash: "not-a-sha",
        variants: [],
      },
    ]);
    const manifest = await buildControlledAssetManifest(
      { asset: { findMany } } as unknown as Pick<
        Prisma.TransactionClient,
        "asset"
      >,
      {
        siteId: "site-1",
        brief: golden.designBrief,
        catalog: STATIC_DESIGN_CATALOG_V2,
      },
    );
    const pack = STATIC_DESIGN_CATALOG_V2.demoVisualPacks.find(
      ({ id }) => id === golden.designBrief.assetStrategy.demoVisualPackId,
    )!;
    expect(
      Object.values(manifest).filter((asset) => asset.source === "catalog"),
    ).toHaveLength(pack.assets.length);
    expect(
      manifest["tenant-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-cccccccccccc"],
    ).toEqual({
      source: "tenant",
      assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "factory_image",
      contentHash: "b".repeat(64),
      variantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      variantHash: "c".repeat(64),
      mimeType: "image/webp",
    });
    expect(
      Object.keys(manifest).some((key) => key.includes("cccccccc-cccc")),
    ).toBe(false);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          siteId: "site-1",
          processingStatus: "ready",
        }),
      }),
    );
  });

  it("reads a tenant variant only through tenant-scoped DB lookup and bounded storage", async () => {
    const findFirst = vi.fn(async () => ({
      id: "variant-1",
      assetId: "asset-1",
      contentHash: "c".repeat(64),
      mime: "image/webp",
      objectKey: "tenant/variant.webp",
      sizeBytes: 123,
      asset: { kind: "factory_image", contentHash: "b".repeat(64) },
    }));
    const withWorkspace = vi.fn(async (_workspaceId, execute) =>
      execute({ assetVariant: { findFirst } }),
    );
    const getBufferBounded = vi.fn(async () => Buffer.from("variant"));
    const reader = createTenantVariantReader({
      prisma: { withWorkspace } as unknown as PrismaService,
      storage: { getBufferBounded },
    });
    await expect(
      reader.readReadyVariant({
        workspaceId: "workspace-1",
        siteId: "site-1",
        assetId: "asset-1",
        variantId: "variant-1",
      }),
    ).resolves.toMatchObject({
      assetId: "asset-1",
      variantId: "variant-1",
      variantHash: "c".repeat(64),
      mimeType: "image/webp",
    });
    expect(withWorkspace).toHaveBeenCalledWith(
      "workspace-1",
      expect.any(Function),
    );
    expect(getBufferBounded).toHaveBeenCalledWith(
      "tenant/variant.webp",
      123,
      undefined,
    );
  });
});
