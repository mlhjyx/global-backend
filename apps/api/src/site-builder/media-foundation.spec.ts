import { describe, expect, it } from "vitest";

import {
  buildAssetVariantRecipeHash,
  projectDerivedImageManifest,
  type AssetVariantProjectionRow,
  type AssetVariantRecipe,
} from "./media-foundation";

const SOURCE_HASH = "a".repeat(64);

function recipe(
  overrides: Partial<AssetVariantRecipe> = {},
): AssetVariantRecipe {
  return {
    pipelineVersion: "sharp-v1",
    source: {
      contentHash: SOURCE_HASH,
      variantId: null,
      variantContentHash: null,
    },
    output: {
      role: "hero",
      format: "avif",
      width: 1440,
      height: 810,
      fit: "cover",
      position: "centre",
      focalPoint: { x: 0.5, y: 0.4 },
      quality: 62,
    },
    ...overrides,
  };
}

function variant(
  overrides: Partial<AssetVariantProjectionRow> = {},
): AssetVariantProjectionRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    variantType: "hero",
    mime: "image/avif",
    width: 1440,
    height: 810,
    sizeBytes: 120_000,
    objectKey: "ws/w/s/generated/hero-1440.avif",
    contentHash: "b".repeat(64),
    recipeHash: "c".repeat(64),
    pipelineVersion: "sharp-v1",
    status: "ready",
    ...overrides,
  };
}

describe("AssetVariant recipe hash", () => {
  it("is a stable SHA-256 over semantic recipe content, independent of object key order", () => {
    const canonical = recipe();
    const reordered = {
      output: {
        quality: 62,
        focalPoint: { y: 0.4, x: 0.5 },
        position: "centre",
        fit: "cover",
        height: 810,
        width: 1440,
        format: "avif" as const,
        role: "hero" as const,
      },
      source: {
        variantContentHash: null,
        variantId: null,
        contentHash: SOURCE_HASH,
      },
      pipelineVersion: "sharp-v1",
    } satisfies AssetVariantRecipe;

    expect(buildAssetVariantRecipeHash(canonical)).toMatch(/^[a-f0-9]{64}$/);
    expect(buildAssetVariantRecipeHash(reordered)).toBe(
      buildAssetVariantRecipeHash(canonical),
    );
  });

  it.each([
    ["pipeline version", recipe({ pipelineVersion: "sharp-v2" })],
    [
      "source hash",
      recipe({
        source: {
          contentHash: "d".repeat(64),
          variantId: null,
          variantContentHash: null,
        },
      }),
    ],
    [
      "source variant",
      recipe({
        source: {
          contentHash: SOURCE_HASH,
          variantId: "00000000-0000-4000-8000-000000000099",
          variantContentHash: "e".repeat(64),
        },
      }),
    ],
    ["role", recipe({ output: { ...recipe().output, role: "card" } })],
    ["format", recipe({ output: { ...recipe().output, format: "webp" } })],
    ["width", recipe({ output: { ...recipe().output, width: 960 } })],
    ["height", recipe({ output: { ...recipe().output, height: 540 } })],
    ["crop", recipe({ output: { ...recipe().output, fit: "contain" } })],
    ["position", recipe({ output: { ...recipe().output, position: "entropy" } })],
    [
      "focal point",
      recipe({
        output: { ...recipe().output, focalPoint: { x: 0.2, y: 0.8 } },
      }),
    ],
    ["quality", recipe({ output: { ...recipe().output, quality: 70 } })],
  ])("changes when %s changes", (_label, changed) => {
    expect(buildAssetVariantRecipeHash(changed)).not.toBe(
      buildAssetVariantRecipeHash(recipe()),
    );
  });
});

describe("derivedKeys compatibility projection", () => {
  it("projects ready authoritative rows into the versioned legacy manifest", () => {
    const rows: AssetVariantProjectionRow[] = [
      variant(),
      variant({
        id: "00000000-0000-4000-8000-000000000002",
        mime: "image/webp",
        objectKey: "ws/w/s/generated/hero-1440.webp",
        sizeBytes: 135_000,
        recipeHash: "d".repeat(64),
      }),
      variant({
        id: "00000000-0000-4000-8000-000000000003",
        variantType: "logo",
        mime: "image/png",
        width: 640,
        height: 320,
        objectKey: "ws/w/s/generated/logo-640.png",
        sizeBytes: 90_000,
        recipeHash: "e".repeat(64),
      }),
      variant({
        id: "00000000-0000-4000-8000-000000000004",
        variantType: "thumb",
        status: "failed",
      }),
    ];

    expect(
      projectDerivedImageManifest({
        pipelineVersion: "sharp-v1",
        sourceHash: SOURCE_HASH,
        variants: rows,
      }),
    ).toEqual({
      schemaVersion: "1.0",
      pipelineVersion: "sharp-v1",
      sourceHash: SOURCE_HASH,
      variants: {
        hero: {
          avif: {
            key: "ws/w/s/generated/hero-1440.avif",
            width: 1440,
            height: 810,
            bytes: 120_000,
          },
          webp: {
            key: "ws/w/s/generated/hero-1440.webp",
            width: 1440,
            height: 810,
            bytes: 135_000,
          },
        },
        logo: {
          fallback: {
            key: "ws/w/s/generated/logo-640.png",
            width: 640,
            height: 320,
            bytes: 90_000,
          },
        },
      },
    });
  });

  it("is deterministic, does not mutate input, and chooses one largest output per role/format", () => {
    const smaller = variant({
      id: "00000000-0000-4000-8000-000000000010",
      width: 640,
      height: 360,
      objectKey: "ws/w/s/generated/hero-640.avif",
      recipeHash: "1".repeat(64),
    });
    const larger = variant({
      id: "00000000-0000-4000-8000-000000000011",
      width: 1920,
      height: 1080,
      objectKey: "ws/w/s/generated/hero-1920.avif",
      recipeHash: "2".repeat(64),
    });
    const rows = [smaller, larger];
    const before = structuredClone(rows);

    const forward = projectDerivedImageManifest({
      pipelineVersion: "sharp-v1",
      sourceHash: SOURCE_HASH,
      variants: rows,
    });
    const reverse = projectDerivedImageManifest({
      pipelineVersion: "sharp-v1",
      sourceHash: SOURCE_HASH,
      variants: [...rows].reverse(),
    });

    expect(forward).toEqual(reverse);
    expect(forward.variants.hero?.avif?.key).toContain("hero-1920.avif");
    expect(rows).toEqual(before);
  });

  it("rejects rows from another pipeline instead of mixing generations", () => {
    expect(() =>
      projectDerivedImageManifest({
        pipelineVersion: "sharp-v1",
        sourceHash: SOURCE_HASH,
        variants: [variant({ pipelineVersion: "sharp-v2" })],
      }),
    ).toThrow(/pipeline/i);
  });
});
