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

function publishedManifest(sourceHash: string, keys: string[]) {
  return {
    schemaVersion: "1.0",
    pipelineVersion: "sharp-test-m1c.1",
    sourceHash,
    variants: {
      card: {
        webp: keys.map((key, index) => ({
          key,
          width: 320 * (index + 1),
          height: 240 * (index + 1),
          bytes: 1_000 + index,
        })),
      },
    },
  };
}

async function tenantEntries(rows: unknown[]) {
  const manifest = await buildControlledAssetManifest(
    { asset: { findMany: vi.fn(async () => rows) } } as unknown as Pick<
      Prisma.TransactionClient,
      "asset"
    >,
    {
      siteId: "site-1",
      brief: golden.designBrief,
      catalog: STATIC_DESIGN_CATALOG_V2,
    },
  );
  return Object.values(manifest).filter((asset) => asset.source === "tenant");
}

beforeAll(async () => {
  golden = (
    await buildM1ebGoldenFixtures(
      new URL("../../../../", import.meta.url).pathname,
      { ids: ["natural-origin-rich"] },
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
        derivedKeys: publishedManifest("b".repeat(64), ["tenant/factory.webp"]),
        variants: [
          {
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            contentHash: "c".repeat(64),
            mime: "image/webp",
            objectKey: "tenant/factory.webp",
          },
        ],
      },
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        kind: "product_image",
        contentHash: "not-a-sha",
        derivedKeys: null,
        variants: [],
      },
      {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        kind: "cert",
        contentHash: "d".repeat(64),
        derivedKeys: publishedManifest("d".repeat(64), ["tenant/cert.pdf"]),
        variants: [
          {
            id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            contentHash: "e".repeat(64),
            mime: "application/pdf",
            objectKey: "tenant/cert.pdf",
          },
        ],
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
    expect(
      Object.keys(manifest).some((key) => key.includes("dddddddd-dddd")),
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

  it("uses only the variant the asset's derived manifest publishes", async () => {
    const sourceHash = "b".repeat(64);
    const superseded = {
      id: "11111111-1111-4111-8111-111111111111",
      contentHash: "d".repeat(64),
      mime: "image/webp",
      objectKey: "tenant/superseded.webp",
    };
    const current = {
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      contentHash: "c".repeat(64),
      mime: "image/webp",
      objectKey: "tenant/current.webp",
    };

    await expect(
      tenantEntries([
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          kind: "factory_image",
          contentHash: sourceHash,
          derivedKeys: publishedManifest(sourceHash, [current.objectKey]),
          // The query orders by role then id, so the superseded row sorts first.
          variants: [superseded, current],
        },
      ]),
    ).resolves.toEqual([
      expect.objectContaining({
        variantId: current.id,
        variantHash: current.contentHash,
      }),
    ]);
  });

  it.each([
    ["no", null],
    ["an unreadable", { schemaVersion: "1.0" }],
    ["another source's", publishedManifest("f".repeat(64), ["tenant/current.webp"])],
  ] as const)(
    "offers no tenant variant for an asset with %s derived manifest",
    async (_label, derivedKeys) => {
      await expect(
        tenantEntries([
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            kind: "factory_image",
            contentHash: "b".repeat(64),
            derivedKeys,
            variants: [
              {
                id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
                contentHash: "c".repeat(64),
                mime: "image/webp",
                objectKey: "tenant/current.webp",
              },
            ],
          },
        ]),
      ).resolves.toEqual([]);
    },
  );

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
