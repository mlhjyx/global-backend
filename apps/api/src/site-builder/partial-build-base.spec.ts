import type { Prisma } from "@prisma/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  RELEASE_MANIFEST_V2_SCHEMA_VERSION,
  releaseArtifactDigest,
  releaseSpecDigest,
  type ReleaseManifestV2,
} from "./release-artifact";
import { buildM1ebGoldenFixtures } from "./design/m1eb-golden";
import {
  assertPartialBuildContract,
  loadPartialBuildBase,
  PartialBuildRequiresV2BaseError,
} from "./partial-build-base";

let golden: Awaited<ReturnType<typeof buildM1ebGoldenFixtures>>[number];

beforeAll(async () => {
  golden = (
    await buildM1ebGoldenFixtures(
      new URL("../../../../", import.meta.url).pathname,
    )
  )[0]!;
});

function manifest(): ReleaseManifestV2 {
  const common = {
    releaseId: "50000000-0000-4000-8000-000000000001",
    workspaceId: "10000000-0000-4000-8000-000000000001",
    siteId: "20000000-0000-4000-8000-000000000001",
    siteVersionId: "40000000-0000-4000-8000-000000000001",
    buildRunId: "30000000-0000-4000-8000-000000000001",
    producerToken: "60000000-0000-4000-8000-000000000001",
  };
  const files = [
    {
      path: "index.html",
      objectKey: `sites/${common.siteId}/releases/${common.releaseId}/attempts/${common.producerToken}/files/index.html`,
      size: 12,
      sha256: "a".repeat(64),
      contentType: "text/html; charset=utf-8",
    },
  ];
  return {
    schemaVersion: RELEASE_MANIFEST_V2_SCHEMA_VERSION,
    ...common,
    artifactPrefix: `sites/${common.siteId}/releases/${common.releaseId}`,
    artifactDigest: releaseArtifactDigest(files),
    specVersion: "1.1.0",
    specDigest: releaseSpecDigest(golden.spec),
    buildIdentity: golden.spec.rendererVersion,
    createdAt: "2026-07-24T00:00:00.000Z",
    componentTypes: [
      ...new Set(
        golden.spec.pages.flatMap((page) =>
          page.puck.content.map((block) => block.type),
        ),
      ),
    ].sort(),
    files,
    componentLibraryVersion: golden.spec.componentLibraryVersion,
    rendererVersion: golden.spec.rendererVersion,
    designBrief: golden.designBrief,
    designBriefDigest: golden.designBrief.digest,
  };
}

function transaction(overrides: Record<string, unknown> = {}) {
  const bundle = golden.spec.copyBundleSet!.bundles.en!;
  return {
    siteVersion: {
      findFirst: vi.fn(async () => ({
        spec: structuredClone(golden.spec),
        specVersion: "1.1.0",
        release: { status: "ready", manifest: manifest() },
        copyBundles: [
          {
            locale: "en",
            claimSnapshotId: bundle.claimSnapshot.id,
            taskAttemptId: "attempt-copy-en",
            bundleDigest: bundle.digest,
          },
        ],
        ...overrides,
      })),
    },
  } as unknown as Pick<Prisma.TransactionClient, "siteVersion">;
}

describe("M1-e-B partial build base", () => {
  it("requires immutable scope fields before activity execution", () => {
    expect(() =>
      assertPartialBuildContract({ scope: "page", targetId: "home" }),
    ).toThrow(PartialBuildRequiresV2BaseError);
    expect(() =>
      assertPartialBuildContract({
        scope: "page",
        targetId: "home",
        baseVersionId: "version-1",
        options: { locales: ["de-DE"] },
      }),
    ).toThrow("partial builds cannot change stylePreset or locales");
  });

  it("loads the ready v2 Release and reuses its Brief, snapshot, and task IDs", async () => {
    const base = await loadPartialBuildBase(transaction(), {
      siteId: manifest().siteId,
      baseVersionId: manifest().siteVersionId,
    });
    expect(base.designBrief).toEqual(golden.designBrief);
    expect(base.spec).toEqual(golden.spec);
    expect(base.claimSnapshotId).toBe(
      golden.spec.copyBundleSet!.bundles.en!.claimSnapshot.id,
    );
    expect(base.taskAttemptIds).toEqual({ en: "attempt-copy-en" });
  });

  it.each([
    ["v1 base", { specVersion: "1.0.0" }],
    [
      "manifest/spec digest drift",
      {
        release: {
          status: "ready",
          manifest: () => ({ ...manifest(), specDigest: "f".repeat(64) }),
        },
      },
    ],
    ["incomplete locale rows", { copyBundles: [] }],
  ])("rejects %s with the stable v2-base error", async (_label, override) => {
    const normalized =
      "release" in override &&
      typeof override.release === "object" &&
      override.release !== null &&
      "manifest" in override.release &&
      typeof override.release.manifest === "function"
        ? {
            ...override,
            release: {
              status: "ready",
              manifest: override.release.manifest(),
            },
          }
        : override;
    await expect(
      loadPartialBuildBase(transaction(normalized), {
        siteId: manifest().siteId,
        baseVersionId: manifest().siteVersionId,
      }),
    ).rejects.toMatchObject({ code: "PARTIAL_BUILD_REQUIRES_V2_BASE" });
  });
});
