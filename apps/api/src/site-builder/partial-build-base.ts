import type { Prisma } from "@prisma/client";
import {
  SITE_SPEC_V1_1_VERSION,
  validateSiteSpecV1_1,
  type DesignBriefV2,
  type SiteSpecV1_1,
} from "@global/contracts";
import type { BuildScopeInput } from "./refurbish-launcher";
import {
  RELEASE_MANIFEST_V2_SCHEMA_VERSION,
  releaseSpecDigest,
  validateReleaseManifest,
  type ReleaseManifestV2,
} from "./release-artifact";

export class PartialBuildRequiresV2BaseError extends Error {
  readonly code = "PARTIAL_BUILD_REQUIRES_V2_BASE";

  constructor(message: string) {
    super(`PARTIAL_BUILD_REQUIRES_V2_BASE: ${message}`);
    this.name = "PartialBuildRequiresV2BaseError";
  }
}

export function isPartialBuild(scope: BuildScopeInput | undefined): boolean {
  return (
    scope?.scope === "page" ||
    scope?.scope === "section" ||
    Boolean(scope?.options?.pages)
  );
}

export function assertPartialBuildContract(
  scope: BuildScopeInput | undefined,
): void {
  if (!isPartialBuild(scope)) return;
  if (!scope?.baseVersionId) {
    throw new PartialBuildRequiresV2BaseError(
      "partial build has no frozen baseVersionId",
    );
  }
  if (scope.options?.stylePreset || scope.options?.locales) {
    throw new PartialBuildRequiresV2BaseError(
      "partial builds cannot change stylePreset or locales",
    );
  }
}

type PartialBaseTx = Pick<Prisma.TransactionClient, "siteVersion">;

export interface PartialBuildBase {
  spec: SiteSpecV1_1;
  manifest: ReleaseManifestV2;
  designBrief: DesignBriefV2;
  claimSnapshotId: string;
  taskAttemptIds: Record<string, string>;
}

export async function loadPartialBuildBase(
  tx: PartialBaseTx,
  input: {
    siteId: string;
    baseVersionId: string;
  },
): Promise<PartialBuildBase> {
  const version = await tx.siteVersion.findFirst({
    where: {
      id: input.baseVersionId,
      siteId: input.siteId,
      buildStatus: "succeeded",
    },
    select: {
      spec: true,
      specVersion: true,
      release: { select: { status: true, manifest: true } },
      copyBundles: {
        select: {
          locale: true,
          claimSnapshotId: true,
          taskAttemptId: true,
          bundleDigest: true,
        },
        orderBy: { locale: "asc" },
      },
    },
  });
  if (
    !version ||
    version.specVersion !== SITE_SPEC_V1_1_VERSION ||
    version.release?.status !== "ready" ||
    !version.release.manifest
  ) {
    throw new PartialBuildRequiresV2BaseError(
      "base is not a ready SiteSpec 1.1 Release",
    );
  }
  let manifest;
  let spec;
  try {
    manifest = validateReleaseManifest(version.release.manifest);
    spec = validateSiteSpecV1_1(version.spec);
  } catch {
    throw new PartialBuildRequiresV2BaseError(
      "base manifest or SiteSpec is invalid",
    );
  }
  if (
    manifest.schemaVersion !== RELEASE_MANIFEST_V2_SCHEMA_VERSION ||
    manifest.siteVersionId !== input.baseVersionId ||
    manifest.siteId !== input.siteId ||
    manifest.specDigest !== releaseSpecDigest(spec) ||
    manifest.designBrief.componentLibraryVersion !==
      spec.componentLibraryVersion ||
    manifest.designBrief.rendererVersion !== spec.rendererVersion ||
    manifest.designBrief.familyId !== spec.site.familyId ||
    manifest.designBrief.archetype !== spec.site.archetype
  ) {
    throw new PartialBuildRequiresV2BaseError(
      "base Release v2 identity does not match its SiteSpec",
    );
  }
  const snapshotIds = new Set(
    version.copyBundles.map((bundle) => bundle.claimSnapshotId),
  );
  const persistedLocales = version.copyBundles
    .map((bundle) => bundle.locale)
    .sort();
  const expectedLocales = [...spec.site.locales].sort();
  if (
    !spec.copyBundleSet ||
    version.copyBundles.length !== spec.site.locales.length ||
    snapshotIds.size !== 1 ||
    JSON.stringify(persistedLocales) !== JSON.stringify(expectedLocales) ||
    version.copyBundles.some((bundle) => {
      const document = spec.copyBundleSet!.bundles[bundle.locale];
      return (
        !document ||
        document.claimSnapshot.id !== bundle.claimSnapshotId ||
        document.digest !== bundle.bundleDigest
      );
    })
  ) {
    throw new PartialBuildRequiresV2BaseError(
      "base has no complete immutable copy/snapshot set",
    );
  }
  return {
    spec,
    manifest,
    designBrief: manifest.designBrief,
    claimSnapshotId: [...snapshotIds][0]!,
    taskAttemptIds: Object.fromEntries(
      version.copyBundles.map((bundle) => [
        bundle.locale,
        bundle.taskAttemptId,
      ]),
    ),
  };
}
