import { createHash } from "node:crypto";
import {
  copyBundleToLegacyStrings,
  finalizeDesignBriefV2,
  siteDirectionMap,
  validateDesignBriefV2AgainstCatalog,
  type AssetRefV1_1,
  type CopyBundleSetV1,
  type DesignBriefV2,
  type DesignCatalogV2,
  type SiteSpecV1_1,
} from "@global/contracts";
import type { PublishableClaimSnapshot } from "../publishable-claim-snapshot";
import {
  COMPONENT_ASSEMBLY_ADAPTERS,
  buildControlledComponentProps,
  type BuildAdapterPropsInput,
} from "./component-assembly-adapters";
import {
  deriveCopySlotDefinitions,
  type QualifiedComponentTemplateRepository,
} from "./copy-slot-derivation";
import {
  validateControlledAssembly,
  type AssemblyFinding,
} from "./controlled-assembly-validator";

export const CONTROLLED_ASSEMBLY_TASK_IDS = [
  "site_builder.assemble",
  "site_builder.assembly_fix:1",
  "site_builder.assembly_fix:2",
  "site_builder.assembly_fix:3",
] as const;
export type ControlledAssemblyTaskId =
  (typeof CONTROLLED_ASSEMBLY_TASK_IDS)[number];

export interface AssemblySectionSelection {
  pageKey: string;
  sectionId: string;
  copySlotKeys: string[];
  assetReferenceIds: string[];
  claimIds: string[];
  itemIndexes: number[];
}

export interface AssemblySelection {
  sections: AssemblySectionSelection[];
}

export interface AssemblySelectionGenerator {
  generate(input: {
    taskId: ControlledAssemblyTaskId;
    brief: DesignBriefV2;
    allowedCopySlotKeys: readonly string[];
    allowedAssetReferenceIds: readonly string[];
    allowedClaimIds: readonly string[];
    previousCandidateDigest?: string;
    findings: readonly AssemblyFinding[];
  }): Promise<unknown>;
}

export interface ControlledAssemblyResult {
  spec: SiteSpecV1_1;
  designBrief: DesignBriefV2;
  attempts: Array<{
    taskId: ControlledAssemblyTaskId | "same-family-safe-fallback";
    findings: AssemblyFinding[];
  }>;
  fallbackUsed: boolean;
}

export class ControlledAssemblyError extends Error {
  constructor(
    readonly code: "CONTROLLED_ASSEMBLY_INVALID",
    message: string,
    readonly attempts: ControlledAssemblyResult["attempts"],
  ) {
    super(`${code}: ${message}`);
    this.name = "ControlledAssemblyError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function parseSelection(
  value: unknown,
  bounds: {
    pageSections: ReadonlyMap<string, ReadonlySet<string>>;
    itemBounds: ReadonlyMap<
      string,
      { minimum: number; maximum: number; available: number }
    >;
    copyKeys: ReadonlySet<string>;
    assetIds: ReadonlySet<string>;
    claimIds: ReadonlySet<string>;
  },
): AssemblySelection {
  if (
    !record(value) ||
    Object.keys(value).some((key) => key !== "sections") ||
    !Array.isArray(value.sections)
  ) {
    throw new Error("CONTROLLED_ASSEMBLY_MODEL_OUTPUT_INVALID");
  }
  const sections = value.sections.map((candidate) => {
    if (
      !record(candidate) ||
      Object.keys(candidate).some(
        (key) =>
          ![
            "pageKey",
            "sectionId",
            "copySlotKeys",
            "assetReferenceIds",
            "claimIds",
            "itemIndexes",
          ].includes(key),
      ) ||
      typeof candidate.pageKey !== "string" ||
      typeof candidate.sectionId !== "string" ||
      !stringArray(candidate.copySlotKeys) ||
      !stringArray(candidate.assetReferenceIds) ||
      !stringArray(candidate.claimIds) ||
      !Array.isArray(candidate.itemIndexes) ||
      candidate.itemIndexes.some(
        (index) => !Number.isSafeInteger(index) || index < 0 || index > 127,
      ) ||
      new Set(candidate.itemIndexes).size !== candidate.itemIndexes.length ||
      !bounds.pageSections.get(candidate.pageKey)?.has(candidate.sectionId) ||
      candidate.copySlotKeys.some(
        (key) =>
          !key.startsWith(`${candidate.pageKey}.${candidate.sectionId}.`),
      ) ||
      (() => {
        const itemBounds = bounds.itemBounds.get(
          `${candidate.pageKey}\0${candidate.sectionId}`,
        );
        return (
          candidate.itemIndexes.length > 0 &&
          (!itemBounds ||
            candidate.itemIndexes.length < itemBounds.minimum ||
            candidate.itemIndexes.length > itemBounds.maximum ||
            candidate.itemIndexes.some(
              (index) => index >= itemBounds.available,
            ))
        );
      })() ||
      candidate.copySlotKeys.some((key) => !bounds.copyKeys.has(key)) ||
      candidate.assetReferenceIds.some((id) => !bounds.assetIds.has(id)) ||
      candidate.claimIds.some((id) => !bounds.claimIds.has(id))
    ) {
      throw new Error("CONTROLLED_ASSEMBLY_MODEL_OUTPUT_INVALID");
    }
    return {
      pageKey: candidate.pageKey,
      sectionId: candidate.sectionId,
      copySlotKeys: [...new Set(candidate.copySlotKeys)],
      assetReferenceIds: [...new Set(candidate.assetReferenceIds)],
      claimIds: [...new Set(candidate.claimIds)],
      itemIndexes: [...new Set(candidate.itemIndexes as number[])].sort(
        (left, right) => left - right,
      ),
    };
  });
  if (
    new Set(
      sections.map((section) => `${section.pageKey}\0${section.sectionId}`),
    ).size !== sections.length
  ) {
    throw new Error("CONTROLLED_ASSEMBLY_MODEL_OUTPUT_INVALID");
  }
  return { sections };
}

function selectedTemplateItems(
  template: Record<string, unknown>,
  indexes: readonly number[],
): Record<string, unknown> {
  if (indexes.length === 0) return template;
  const clone = structuredClone(template);
  const dynamic = Object.entries(clone).find(([, value]) =>
    Array.isArray(value),
  );
  if (!dynamic) throw new Error("CONTROLLED_ASSEMBLY_ITEM_SELECTION_INVALID");
  const [key, values] = dynamic as [string, unknown[]];
  if (indexes.some((index) => index >= values.length)) {
    throw new Error("CONTROLLED_ASSEMBLY_ITEM_SELECTION_INVALID");
  }
  clone[key] = indexes.map((index) => values[index]);
  return clone;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function deterministicSelection(input: {
  brief: DesignBriefV2;
  catalog: DesignCatalogV2;
  copyKeys: readonly string[];
  assetIds: readonly string[];
  claimIds: readonly string[];
}): AssemblySelection {
  const family = validateDesignBriefV2AgainstCatalog(
    input.catalog,
    input.brief,
  );
  return {
    sections: Object.entries(input.brief.blueprintIds).flatMap(
      ([pageKey, blueprintId]) => {
        const blueprint = family.blueprints[pageKey]!.find(
          (candidate) => candidate.id === blueprintId,
        )!;
        return blueprint.sections.map((section) => ({
          pageKey,
          sectionId: section.id,
          copySlotKeys: input.copyKeys.filter((key) =>
            key.startsWith(`${pageKey}.${section.id}.`),
          ),
          assetReferenceIds: [...input.assetIds],
          claimIds: section.requiresEvidence ? [...input.claimIds] : [],
          itemIndexes: [],
        }));
      },
    ),
  };
}

function copyBundles(
  set: CopyBundleSetV1,
): Record<string, Record<string, string>> {
  return Object.fromEntries(
    Object.entries(set.bundles).map(([locale, bundle]) => [
      locale,
      copyBundleToLegacyStrings(bundle),
    ]),
  );
}

function assetRoleMap(input: {
  brief: DesignBriefV2;
  catalog: DesignCatalogV2;
  assets: Readonly<Record<string, AssetRefV1_1>>;
}): ReadonlyMap<string, ReadonlySet<string>> {
  const pack = input.catalog.demoVisualPacks.find(
    (candidate) =>
      candidate.id === input.brief.assetStrategy.demoVisualPackId &&
      candidate.version === input.brief.assetStrategy.demoVisualPackVersion,
  );
  return new Map(
    Object.entries(input.assets).map(([referenceId, asset]) => {
      const roles = new Set<string>();
      if (asset.source === "catalog") {
        const catalogAsset = pack?.assets.find(
          (candidate) => candidate.id === asset.catalogAssetId,
        );
        if (catalogAsset) roles.add(catalogAsset.role);
      } else {
        if (asset.kind === "logo") roles.add("logo");
        if (asset.kind === "product_image") roles.add("generic-product");
        if (asset.kind === "factory_image") {
          roles.add("hero");
          roles.add("generic-process");
        }
        if (asset.kind === "cert") roles.add("evidence");
      }
      return [referenceId, roles] as const;
    }),
  );
}

function buildSpec(input: {
  brief: DesignBriefV2;
  catalog: DesignCatalogV2;
  copyBundleSet: CopyBundleSetV1;
  templates: QualifiedComponentTemplateRepository;
  selection: AssemblySelection;
  assets: Record<string, AssetRefV1_1>;
  assetUrls: Readonly<Record<string, string>>;
  siteName: string;
  claimSnapshot: PublishableClaimSnapshot;
}): SiteSpecV1_1 {
  const family = validateDesignBriefV2AgainstCatalog(
    input.catalog,
    input.brief,
  );
  const preset = input.catalog.stylePresets.find(
    (candidate) =>
      candidate.id === input.brief.stylePresetId &&
      candidate.version === input.brief.stylePresetVersion,
  )!;
  const locales = Object.keys(input.copyBundleSet.bundles);
  const selected = new Map(
    input.selection.sections.map((section) => [
      `${section.pageKey}\0${section.sectionId}`,
      section,
    ]),
  );
  const pageIds = Object.keys(input.brief.blueprintIds);
  const assetIds = Object.keys(input.assets);
  const rolesByAsset = assetRoleMap(input);
  const pages = Object.entries(input.brief.blueprintIds)
    .sort(([left], [right]) =>
      left === "home" ? -1 : right === "home" ? 1 : left.localeCompare(right),
    )
    .map(([pageKey, blueprintId]) => {
      const blueprint = family.blueprints[pageKey]!.find(
        (candidate) => candidate.id === blueprintId,
      )!;
      return {
        id: pageKey,
        path: pageKey === "home" ? "/" : `/${pageKey}`,
        seo: {
          titleKey: `seo.${pageKey}.title`,
          descriptionKey: `seo.${pageKey}.description`,
        },
        puck: {
          root: { props: {} },
          content: blueprint.sections.map((section) => {
            const choice = selected.get(`${pageKey}\0${section.id}`);
            const eligibleReferences =
              section.assetRoles.length === 0
                ? assetIds
                : assetIds.filter((assetId) =>
                    section.assetRoles.some((role) =>
                      rolesByAsset.get(assetId)?.has(role),
                    ),
                  );
            const references = choice?.assetReferenceIds.length
              ? choice.assetReferenceIds.filter((assetId) =>
                  eligibleReferences.includes(assetId),
                )
              : eligibleReferences;
            const adapterInput: BuildAdapterPropsInput = {
              pageKey,
              section,
              serverTemplate: selectedTemplateItems(
                input.templates.get(section.componentType),
                choice?.itemIndexes ?? [],
              ),
              pageIds,
              assetReferenceIds: references,
              assetUrls: input.assetUrls,
            };
            return {
              type: section.componentType,
              props: buildControlledComponentProps(adapterInput),
            };
          }),
        },
      };
    });
  return {
    specVersion: "1.1.0",
    componentLibraryVersion: input.brief.componentLibraryVersion,
    rendererVersion: input.brief.rendererVersion,
    site: {
      defaultLocale: input.copyBundleSet.sourceLocale,
      locales,
      archetype: input.brief.archetype,
      familyId: input.brief.familyId,
      dirByLocale: siteDirectionMap(locales),
      theme: { preset: preset.rendererPresetId },
      nav: pages.map((page) => ({
        labelKey: `nav.${page.id}`,
        pageId: page.id,
      })),
      seoGlobal: { siteName: input.siteName },
    },
    pages,
    assets: structuredClone(input.assets),
    copyBundles: copyBundles(input.copyBundleSet),
    copyBundleSet: structuredClone(input.copyBundleSet),
  };
}

function safeBrief(
  brief: DesignBriefV2,
  catalog: DesignCatalogV2,
): DesignBriefV2 {
  const family = validateDesignBriefV2AgainstCatalog(catalog, brief);
  const { digest: _digest, ...draft } = brief;
  const componentVariantSelections = Object.fromEntries(
    Object.entries(family.safeFallbackBlueprintIds).flatMap(
      ([pageKey, blueprintId]) =>
        family.blueprints[pageKey]!.find(
          (candidate) => candidate.id === blueprintId,
        )!.sections.map((section) => [section.componentType, section.variant]),
    ),
  );
  return finalizeDesignBriefV2({
    ...draft,
    blueprintIds: structuredClone(family.safeFallbackBlueprintIds),
    componentVariantSelections,
  });
}

function mustNotFallback(error: unknown): boolean {
  const name =
    error && typeof error === "object" && "name" in error
      ? String(error.name)
      : "";
  const code =
    record(error) && typeof error.code === "string" ? error.code : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    [
      "TASK_CANCELLED",
      "BUILD_CANCELLED",
      "BUDGET_KILL_SWITCH",
      "TASK_SETTLEMENT_UNKNOWN",
      "MODEL_LEDGER_SETTLEMENT_UNKNOWN",
    ].some((marker) => code === marker || message.includes(marker)) ||
    [
      "PaidCallDeniedError",
      "PaidOperationUnknownError",
      "CancellationError",
      "CancelledFailure",
    ].includes(name)
  );
}

export class ControlledAssemblyService {
  constructor(private readonly generator: AssemblySelectionGenerator) {}

  async assemble(input: {
    brief: DesignBriefV2;
    catalog: DesignCatalogV2;
    copyBundleSet: CopyBundleSetV1;
    templates: QualifiedComponentTemplateRepository;
    assets: Record<string, AssetRefV1_1>;
    assetUrls: Readonly<Record<string, string>>;
    claimSnapshot: PublishableClaimSnapshot;
    siteName: string;
  }): Promise<ControlledAssemblyResult> {
    const family = validateDesignBriefV2AgainstCatalog(
      input.catalog,
      input.brief,
    );
    const copySlots = deriveCopySlotDefinitions({
      brief: input.brief,
      catalog: input.catalog,
      templates: input.templates,
    });
    const copySlotKeys = copySlots.map((slot) => slot.key);
    const pageSections = new Map(
      Object.entries(input.brief.blueprintIds).map(([pageKey, blueprintId]) => [
        pageKey,
        new Set(
          family.blueprints[pageKey]!.find(
            (candidate) => candidate.id === blueprintId,
          )!.sections.map((section) => section.id),
        ),
      ]),
    );
    const bounds = {
      pageSections,
      itemBounds: new Map(
        Object.entries(input.brief.blueprintIds).flatMap(
          ([pageKey, blueprintId]) =>
            family.blueprints[pageKey]!.find(
              (candidate) => candidate.id === blueprintId,
            )!.sections.map((section) => {
              const adapter =
                COMPONENT_ASSEMBLY_ADAPTERS[
                  section.componentType as keyof typeof COMPONENT_ASSEMBLY_ADAPTERS
                ];
              const template = input.templates.get(section.componentType);
              const available =
                Object.values(template).find((value) => Array.isArray(value))
                  ?.length ?? 0;
              return [
                `${pageKey}\0${section.id}`,
                {
                  minimum:
                    available === 0
                      ? 0
                      : Math.min(adapter?.minItems ?? 0, available),
                  maximum: Math.min(adapter?.maxItems ?? 0, available),
                  available,
                },
              ] as const;
            }),
        ),
      ),
      copyKeys: new Set(copySlotKeys),
      assetIds: new Set(Object.keys(input.assets)),
      claimIds: new Set(input.claimSnapshot.items.map((item) => item.claimId)),
    };
    const attempts: ControlledAssemblyResult["attempts"] = [];
    let previousCandidateDigest: string | undefined;
    let findings: AssemblyFinding[] = [];
    for (const taskId of CONTROLLED_ASSEMBLY_TASK_IDS) {
      let selection: AssemblySelection;
      try {
        selection = parseSelection(
          await this.generator.generate({
            taskId,
            brief: input.brief,
            allowedCopySlotKeys: copySlotKeys,
            allowedAssetReferenceIds: Object.keys(input.assets),
            allowedClaimIds: [...bounds.claimIds],
            previousCandidateDigest,
            findings,
          }),
          bounds,
        );
      } catch (error) {
        if (mustNotFallback(error)) throw error;
        selection = deterministicSelection({
          brief: input.brief,
          catalog: input.catalog,
          copyKeys: copySlotKeys,
          assetIds: Object.keys(input.assets),
          claimIds: [...bounds.claimIds],
        });
      }
      const spec = buildSpec({ ...input, selection });
      findings = validateControlledAssembly({
        spec,
        brief: input.brief,
        catalog: input.catalog,
        claimSnapshot: input.claimSnapshot,
        copySlots,
      });
      attempts.push({ taskId, findings });
      if (findings.length === 0) {
        return {
          spec,
          designBrief: input.brief,
          attempts,
          fallbackUsed: false,
        };
      }
      previousCandidateDigest = digest(spec);
    }

    const designBrief = safeBrief(input.brief, input.catalog);
    const selection = deterministicSelection({
      brief: designBrief,
      catalog: input.catalog,
      copyKeys: copySlotKeys,
      assetIds: Object.keys(input.assets),
      claimIds: [...bounds.claimIds],
    });
    const spec = buildSpec({ ...input, brief: designBrief, selection });
    findings = validateControlledAssembly({
      spec,
      brief: designBrief,
      catalog: input.catalog,
      claimSnapshot: input.claimSnapshot,
      copySlots,
    });
    attempts.push({ taskId: "same-family-safe-fallback", findings });
    if (findings.length > 0) {
      throw new ControlledAssemblyError(
        "CONTROLLED_ASSEMBLY_INVALID",
        `three repair attempts and same-family safe fallback failed: ${findings
          .map(
            (finding) => `${finding.layer}/${finding.code}:${finding.message}`,
          )
          .join("; ")}`,
        attempts,
      );
    }
    return { spec, designBrief, attempts, fallbackUsed: true };
  }
}
