import { createHash } from "node:crypto";
import {
  DESIGN_BRIEF_V2_SCHEMA_VERSION,
  demoVisualPackV2Digest,
  designStylePresetV2Digest,
  designTemplateFamilyV2Digest,
  finalizeDesignBriefV2,
  type AssetRefV1_1,
  type DesignBriefV2,
  type SiteSpecComponentType,
  type SiteSpecV1_1,
} from "@global/contracts";
import {
  CopyBundleService,
  neutralCopySlotContent,
} from "../copy-bundle.service";
import type { PublishableClaimSnapshot } from "../publishable-claim-snapshot";
import { controlledAssetUrls } from "../controlled-asset-materializer";
import {
  ControlledAssemblyService,
  type AssemblySelectionGenerator,
} from "../assembly/controlled-assembly.service";
import { deriveCopySlotDefinitions } from "../assembly/copy-slot-derivation";
import { loadQualifiedComponentTemplates } from "../assembly/qualified-component-templates";
import { M1_E_A_COMPONENT_LIBRARY_VERSION } from "./design-brief-producer";
import { STATIC_DESIGN_CATALOG_V2 } from "./catalog";

export const M1_E_B_GOLDEN_RENDERER_VERSION = "site-renderer@m1-e-b/1.0.0";

export interface M1ebGoldenFixture {
  id: string;
  mode: "sparse" | "rich";
  designBrief: DesignBriefV2;
  spec: SiteSpecV1_1;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function selectedBlueprints(
  family: (typeof STATIC_DESIGN_CATALOG_V2.families)[number],
  mode: M1ebGoldenFixture["mode"],
): Record<string, string> {
  if (mode === "sparse") {
    return structuredClone(family.safeFallbackBlueprintIds);
  }
  const pageKeys = Object.keys(family.blueprints).sort();
  const combinations: Record<string, string>[] = [];
  const visit = (index: number, selected: Record<string, string>): void => {
    if (index === pageKeys.length) {
      combinations.push(selected);
      return;
    }
    const pageKey = pageKeys[index]!;
    for (const blueprint of family.blueprints[pageKey]!) {
      visit(index + 1, { ...selected, [pageKey]: blueprint.id });
    }
  };
  visit(0, {});
  const compatible = combinations.filter((selected) => {
    const variants = new Map<string, string>();
    for (const [pageKey, blueprintId] of Object.entries(selected)) {
      const blueprint = family.blueprints[pageKey]!.find(
        (candidate) => candidate.id === blueprintId,
      )!;
      for (const section of blueprint.sections) {
        const previous = variants.get(section.componentType);
        if (previous && previous !== section.variant) return false;
        variants.set(section.componentType, section.variant);
      }
    }
    return true;
  });
  const ranked = compatible.sort((left, right) => {
    const leftDifferences = pageKeys.filter(
      (pageKey) => left[pageKey] !== family.safeFallbackBlueprintIds[pageKey],
    ).length;
    const rightDifferences = pageKeys.filter(
      (pageKey) => right[pageKey] !== family.safeFallbackBlueprintIds[pageKey],
    ).length;
    return (
      rightDifferences - leftDifferences ||
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
  });
  if (!ranked[0]) {
    throw new Error(
      `M1_E_B_GOLDEN_BLUEPRINT_COMBINATION_INVALID: ${family.id}`,
    );
  }
  return ranked[0];
}

function fixtureBrief(
  family: (typeof STATIC_DESIGN_CATALOG_V2.families)[number],
  id: string,
  mode: M1ebGoldenFixture["mode"],
): DesignBriefV2 {
  const blueprintIds = selectedBlueprints(family, mode);
  const sections = Object.entries(blueprintIds).flatMap(
    ([pageKey, blueprintId]) =>
      family.blueprints[pageKey]!.find(
        (blueprint) => blueprint.id === blueprintId,
      )!.sections,
  );
  const componentVariantSelections = Object.fromEntries(
    sections.map((section) => [section.componentType, section.variant]),
  ) as Partial<Record<SiteSpecComponentType, string>>;
  const presetId =
    family.stylePresetIds[mode === "sparse" ? 0 : 1] ??
    family.stylePresetIds[0]!;
  const preset = STATIC_DESIGN_CATALOG_V2.stylePresets.find(
    (candidate) => candidate.id === presetId,
  )!;
  const pack = STATIC_DESIGN_CATALOG_V2.demoVisualPacks.find(
    (candidate) => candidate.id === family.demoVisualPackIds[0],
  )!;
  return finalizeDesignBriefV2({
    schemaVersion: DESIGN_BRIEF_V2_SCHEMA_VERSION,
    catalogVersion: STATIC_DESIGN_CATALOG_V2.catalogVersion,
    catalogDigest: STATIC_DESIGN_CATALOG_V2.digest,
    familyId: family.id,
    familyVersion: family.version,
    familyDigest: designTemplateFamilyV2Digest(family),
    stylePresetId: preset.id,
    stylePresetVersion: preset.version,
    stylePresetDigest: designStylePresetV2Digest(preset),
    blueprintIds,
    componentVariantSelections,
    assetStrategy: {
      availableRoles: [
        ...new Set(pack.assets.map((asset) => asset.role)),
      ].sort(),
      demoVisualPackId: pack.id,
      demoVisualPackVersion: pack.version,
      demoVisualPackDigest: demoVisualPackV2Digest(pack),
      allowGeneratedImages: false,
      allowVideo: false,
    },
    contentBudgets: structuredClone(family.contentBudgets),
    localePolicy: ["en"],
    motionIntensity: family.motionPolicy.intensity,
    variationSeed: sha256(`m1-e-b-golden:${id}`),
    archetype: family.compatibleArchetypes[0]!,
    componentLibraryVersion: M1_E_A_COMPONENT_LIBRARY_VERSION,
    rendererVersion: M1_E_B_GOLDEN_RENDERER_VERSION,
    reasons: [`Golden ${mode} fixture for ${family.id}`],
    warnings:
      mode === "sparse"
        ? [
            "No tenant Claims or assets; neutral copy and fixed demo visuals only.",
          ]
        : [],
  });
}

function fixtureSnapshot(id: string): PublishableClaimSnapshot {
  return {
    schemaVersion: "site-builder-publishable-claim-snapshot/v1",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    siteId: "22222222-2222-4222-8222-222222222222",
    companyProfileId: "33333333-3333-4333-8333-333333333333",
    buildRunId: "44444444-4444-4444-8444-444444444444",
    capturedAt: "2026-07-24T00:00:00.000Z",
    digest: sha256(`m1-e-b-golden-snapshot:${id}`),
    items: [],
  };
}

export async function buildM1ebGoldenFixtures(
  repositoryRoot = process.cwd(),
): Promise<M1ebGoldenFixture[]> {
  const templates = loadQualifiedComponentTemplates(repositoryRoot);
  const generator: AssemblySelectionGenerator = {
    generate: async () => ({ sections: [] }),
  };
  const output: M1ebGoldenFixture[] = [];
  for (const family of STATIC_DESIGN_CATALOG_V2.families) {
    for (const id of family.goldenFixtureIds) {
      const mode = id.endsWith("-sparse") ? "sparse" : "rich";
      const designBrief = fixtureBrief(family, id, mode);
      const slots = deriveCopySlotDefinitions({
        brief: designBrief,
        catalog: STATIC_DESIGN_CATALOG_V2,
        templates,
      });
      const snapshot = fixtureSnapshot(id);
      const copyBundleSet = (
        await new CopyBundleService({
          generateSlot: async ({ slot, locale }) => ({
            content: neutralCopySlotContent(slot.key, locale),
            claimRefs: [],
          }),
        }).generate({
          locales: ["en"],
          sourceLocale: "en",
          snapshotId: `snapshot-${sha256(id).slice(0, 16)}`,
          snapshot,
          slots,
          approvedOutboundDomains: [],
        })
      ).set;
      const pack = STATIC_DESIGN_CATALOG_V2.demoVisualPacks.find(
        (candidate) =>
          candidate.id === designBrief.assetStrategy.demoVisualPackId,
      )!;
      const assets: Record<string, AssetRefV1_1> = Object.fromEntries(
        pack.assets.map((asset) => [
          `catalog-${asset.id}`,
          {
            source: "catalog",
            packId: pack.id,
            packVersion: pack.version,
            catalogAssetId: asset.id,
            sha256: asset.sha256,
            mimeType: asset.mimeType,
          },
        ]),
      );
      const assembled = await new ControlledAssemblyService(generator).assemble(
        {
          brief: designBrief,
          catalog: STATIC_DESIGN_CATALOG_V2,
          copyBundleSet,
          templates,
          assets,
          assetUrls: controlledAssetUrls(assets),
          claimSnapshot: snapshot,
          siteName: `${family.id} ${mode}`,
        },
      );
      output.push({
        id,
        mode,
        designBrief: assembled.designBrief,
        spec: assembled.spec,
      });
    }
  }
  return output.sort((left, right) => left.id.localeCompare(right.id));
}
