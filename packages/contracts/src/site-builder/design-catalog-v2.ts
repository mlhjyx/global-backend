import {
  M1_E_A_COMPONENT_QUALIFICATION_ARTIFACTS,
  M1_E_A_COMPONENT_QUALIFICATIONS,
  getComponentReleaseReadiness,
} from "./component-qualification";
import {
  designSha256,
  hasOnlyKeys,
  isDesignAbstractionCode,
  isDesignAbstractionCodeArray,
  isFiniteNumber,
  isNonBlankString,
  isRecord,
  isStringArray,
} from "./design-integrity";
import { validateDesignDna, type DesignDna } from "./design-dna";
import { validateDesignRule, type DesignRule } from "./design-observation";
import {
  validateDesignSourceManifest,
  type DesignSourceManifest,
} from "./design-source";
import {
  SITE_SPEC_COMPONENT_TYPES,
  SITE_SPEC_STYLE_PRESETS,
  type SiteSpecComponentType,
  type SiteSpecStylePreset,
} from "./site-spec";

/**
 * M1-e-B's executable design catalog.  DI-0 v1 remains exported for already
 * published contracts; v2 adds the structures the controlled assembler needs.
 */
export const DESIGN_CATALOG_V2_SCHEMA_VERSION =
  "site-builder-design-catalog/v2" as const;
export const DESIGN_TEMPLATE_FAMILY_V2_SCHEMA_VERSION =
  "site-builder-template-family/v2" as const;
export const DESIGN_STYLE_PRESET_V2_SCHEMA_VERSION =
  "site-builder-design-style-preset/v2" as const;
export const DEMO_VISUAL_PACK_V2_SCHEMA_VERSION =
  "site-builder-demo-visual-pack/v2" as const;
export const DESIGN_BRIEF_V2_SCHEMA_VERSION =
  "site-builder-design-brief/v2" as const;

const SHA256 = /^[a-f0-9]{64}$/;
const MIMES = new Set([
  "image/avif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
]);

export type DesignCatalogV2Status = "draft" | "approved" | "deprecated";
export type BlueprintPageKind = "home" | "inner";

export interface ContentBudgetV2 {
  minimum: number;
  maximum: number;
}

export interface DesignStylePresetV2 {
  schemaVersion: typeof DESIGN_STYLE_PRESET_V2_SCHEMA_VERSION;
  id: string;
  version: string;
  status: DesignCatalogV2Status;
  /** The only token package a renderer may materialize for this preset. */
  rendererPresetId: SiteSpecStylePreset;
  /** Digest of the renderer-owned token package, frozen at catalog publication. */
  rendererTokenDigest: string;
  /** Resolved defaults; a brief must pin every component it uses. */
  defaultComponentVariants: Partial<Record<SiteSpecComponentType, string>>;
}

export interface DemoVisualAssetV2 {
  id: string;
  role: string;
  repositoryPath: string;
  sha256: string;
  mimeType: string;
  altTemplate: string;
  sourceManifestId: string;
}

export interface DemoVisualPackV2 {
  schemaVersion: typeof DEMO_VISUAL_PACK_V2_SCHEMA_VERSION;
  id: string;
  version: string;
  status: DesignCatalogV2Status;
  compatibleFamilyIds: string[];
  assets: DemoVisualAssetV2[];
  paletteTags: string[];
  minimumContrastRatio: number;
}

export interface BlueprintSectionV2 {
  id: string;
  role: string;
  componentType: SiteSpecComponentType;
  variant: string;
  required: boolean;
  requiresEvidence: boolean;
  assetRoles: string[];
  contentBudgetKey: string;
}

export interface PageBlueprintV2 {
  id: string;
  pageKind: BlueprintPageKind;
  sections: BlueprintSectionV2[];
  mobileReflow: string[];
}

export type DesignCompatibilityRuleV2 =
  | { code: "no_adjacent_full_bleed" }
  | { code: "max_consecutive_card_grid"; maximum: 1 | 2 | 3 }
  | { code: "max_consecutive_dark_surface"; maximum: 1 | 2 }
  | { code: "requires_evidence" }
  | { code: "requires_wide_asset_for_full_bleed" }
  | { code: "requires_minimum_product_count"; minimum: 2 | 3 | 4 };

export interface TemplateFamilyV2 {
  schemaVersion: typeof DESIGN_TEMPLATE_FAMILY_V2_SCHEMA_VERSION;
  id: string;
  version: string;
  status: DesignCatalogV2Status;
  designDnaId: string;
  compatibleArchetypes: string[];
  compatibleIndustries: string[];
  stylePresetIds: string[];
  /** Page key -> alternatives. A brief pins exactly one alternative per key. */
  blueprints: Record<string, PageBlueprintV2[]>;
  /** One deterministic fallback for every page key. */
  safeFallbackBlueprintIds: Record<string, string>;
  componentVariants: Partial<Record<SiteSpecComponentType, string[]>>;
  /** Two or three distinct hero choices, each backed by M1-e-A evidence. */
  heroOptions: Array<{ componentType: SiteSpecComponentType; variant: string }>;
  compatibilityRules: DesignCompatibilityRuleV2[];
  contentBudgets: Record<string, ContentBudgetV2>;
  assetRequirements: string[];
  demoVisualPackIds: string[];
  motionPolicy: {
    intensity: "none" | "low" | "medium";
    allowed: string[];
    forbidden: string[];
  };
  qualityBaselineId: string;
  sourceManifestIds: string[];
  /** Sparse and rich input identifiers are declared now and exercised in B6. */
  goldenFixtureIds: string[];
}

export interface DesignCatalogV2Draft {
  schemaVersion: typeof DESIGN_CATALOG_V2_SCHEMA_VERSION;
  catalogVersion: string;
  sourceManifests: DesignSourceManifest[];
  designRules: DesignRule[];
  designDnas: DesignDna[];
  stylePresets: DesignStylePresetV2[];
  demoVisualPacks: DemoVisualPackV2[];
  families: TemplateFamilyV2[];
}

export interface DesignCatalogV2 extends DesignCatalogV2Draft {
  digest: string;
}

export interface DesignBriefV2Draft {
  schemaVersion: typeof DESIGN_BRIEF_V2_SCHEMA_VERSION;
  catalogVersion: string;
  catalogDigest: string;
  familyId: string;
  familyVersion: string;
  familyDigest: string;
  stylePresetId: string;
  stylePresetVersion: string;
  stylePresetDigest: string;
  blueprintIds: Record<string, string>;
  componentVariantSelections: Partial<Record<SiteSpecComponentType, string>>;
  assetStrategy: {
    availableRoles: string[];
    demoVisualPackId?: string;
    demoVisualPackVersion?: string;
    demoVisualPackDigest?: string;
    allowGeneratedImages: false;
    allowVideo: false;
  };
  contentBudgets: Record<string, ContentBudgetV2>;
  localePolicy: string[];
  motionIntensity: "none" | "low" | "medium";
  variationSeed: string;
  archetype: string;
  componentLibraryVersion: string;
  rendererVersion: string;
  reasons: string[];
  warnings: string[];
}

export interface DesignBriefV2 extends DesignBriefV2Draft {
  digest: string;
}

export type DesignCatalogV2ContractErrorCode =
  | "DESIGN_CATALOG_V2_INVALID"
  | "DESIGN_CATALOG_V2_DIGEST_MISMATCH"
  | "DESIGN_FAMILY_V2_INVALID"
  | "DESIGN_FAMILY_V2_COMPONENT_UNQUALIFIED"
  | "DESIGN_FAMILY_V2_VARIANT_UNQUALIFIED"
  | "DESIGN_FAMILY_V2_MINIMUMS_UNMET"
  | "DESIGN_CATALOG_V2_REFERENCE_UNKNOWN"
  | "DESIGN_CATALOG_V2_APPROVAL_INVALID"
  | "DESIGN_BRIEF_V2_INVALID"
  | "DESIGN_BRIEF_V2_DIGEST_MISMATCH"
  | "DESIGN_BRIEF_V2_CATALOG_MISMATCH"
  | "DESIGN_BRIEF_V2_FAMILY_UNAVAILABLE"
  | "DESIGN_BRIEF_V2_FAMILY_MISMATCH"
  | "DESIGN_BRIEF_V2_PRESET_MISMATCH"
  | "DESIGN_BRIEF_V2_BLUEPRINT_MISMATCH"
  | "DESIGN_BRIEF_V2_VARIANT_MISMATCH"
  | "DESIGN_BRIEF_V2_VISUAL_PACK_MISMATCH"
  | "DESIGN_BRIEF_V2_BUDGET_MISMATCH"
  | "DESIGN_BRIEF_V2_MOTION_MISMATCH";

export class DesignCatalogV2ContractError extends Error {
  constructor(
    readonly code: DesignCatalogV2ContractErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "DesignCatalogV2ContractError";
  }
}

function fail(code: DesignCatalogV2ContractErrorCode, message: string): never {
  throw new DesignCatalogV2ContractError(code, message);
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function uniqueIds(values: readonly { id: string }[]): boolean {
  return unique(values.map((value) => value.id));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function isRelativeRepositoryPath(value: unknown): value is string {
  return (
    isNonBlankString(value) &&
    value.length <= 512 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").includes("..")
  );
}

function validBudget(value: unknown): value is ContentBudgetV2 {
  const budget = isRecord(value) ? value : null;
  return (
    !!budget &&
    hasOnlyKeys(budget, ["minimum", "maximum"]) &&
    isFiniteNumber(budget.minimum) &&
    isFiniteNumber(budget.maximum) &&
    budget.minimum >= 0 &&
    budget.minimum <= budget.maximum
  );
}

function validStatus(value: unknown): value is DesignCatalogV2Status {
  return ["draft", "approved", "deprecated"].includes(String(value));
}

function validComponentRecord(
  value: unknown,
): value is Partial<Record<SiteSpecComponentType, string>> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([type, variant]) =>
      SITE_SPEC_COMPONENT_TYPES.includes(type as SiteSpecComponentType) &&
      isNonBlankString(variant),
  );
}

function validComponentVariantRecord(
  value: unknown,
): value is Partial<Record<SiteSpecComponentType, string[]>> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([type, variants]) =>
      SITE_SPEC_COMPONENT_TYPES.includes(type as SiteSpecComponentType) &&
      isStringArray(variants) &&
      variants.length > 0 &&
      unique(variants),
  );
}

function qualifiedVariants(type: SiteSpecComponentType): readonly string[] {
  const readiness = getComponentReleaseReadiness(type);
  if (readiness.status !== "m1_e_a_qualified") {
    fail(
      "DESIGN_FAMILY_V2_COMPONENT_UNQUALIFIED",
      `${type} is not M1-e-A qualified`,
    );
  }
  const evidence = M1_E_A_COMPONENT_QUALIFICATIONS[type];
  const artifact = evidence
    ? M1_E_A_COMPONENT_QUALIFICATION_ARTIFACTS[
        evidence.variants
          .artifactId as keyof typeof M1_E_A_COMPONENT_QUALIFICATION_ARTIFACTS
      ]
    : undefined;
  if (!artifact || artifact.part !== "variants") {
    fail(
      "DESIGN_FAMILY_V2_COMPONENT_UNQUALIFIED",
      `${type} has no qualified variant artifact`,
    );
  }
  return artifact.variantValues;
}

function validateStylePreset(value: unknown): DesignStylePresetV2 {
  const preset = isRecord(value) ? value : null;
  if (
    !preset ||
    !hasOnlyKeys(preset, [
      "schemaVersion",
      "id",
      "version",
      "status",
      "rendererPresetId",
      "rendererTokenDigest",
      "defaultComponentVariants",
    ]) ||
    preset.schemaVersion !== DESIGN_STYLE_PRESET_V2_SCHEMA_VERSION ||
    !isDesignAbstractionCode(preset.id) ||
    !isNonBlankString(preset.version) ||
    !validStatus(preset.status) ||
    !SITE_SPEC_STYLE_PRESETS.includes(
      preset.rendererPresetId as SiteSpecStylePreset,
    ) ||
    !isSha256(preset.rendererTokenDigest) ||
    !validComponentRecord(preset.defaultComponentVariants)
  ) {
    fail("DESIGN_CATALOG_V2_INVALID", "style preset is invalid");
  }
  for (const [componentType, variant] of Object.entries(
    preset.defaultComponentVariants,
  )) {
    if (
      !qualifiedVariants(componentType as SiteSpecComponentType).includes(
        variant,
      )
    ) {
      fail(
        "DESIGN_FAMILY_V2_VARIANT_UNQUALIFIED",
        `style preset ${preset.id} selects ${componentType}:${variant}`,
      );
    }
  }
  return preset as unknown as DesignStylePresetV2;
}

export function designStylePresetV2Digest(value: DesignStylePresetV2): string {
  return designSha256(value);
}

function validateDemoVisualPack(value: unknown): DemoVisualPackV2 {
  const pack = isRecord(value) ? value : null;
  if (
    !pack ||
    !hasOnlyKeys(pack, [
      "schemaVersion",
      "id",
      "version",
      "status",
      "compatibleFamilyIds",
      "assets",
      "paletteTags",
      "minimumContrastRatio",
    ]) ||
    pack.schemaVersion !== DEMO_VISUAL_PACK_V2_SCHEMA_VERSION ||
    !isDesignAbstractionCode(pack.id) ||
    !isNonBlankString(pack.version) ||
    !validStatus(pack.status) ||
    !isDesignAbstractionCodeArray(pack.compatibleFamilyIds) ||
    pack.compatibleFamilyIds.length === 0 ||
    !unique(pack.compatibleFamilyIds) ||
    !Array.isArray(pack.assets) ||
    pack.assets.length === 0 ||
    !isDesignAbstractionCodeArray(pack.paletteTags) ||
    !isFiniteNumber(pack.minimumContrastRatio) ||
    pack.minimumContrastRatio < 1 ||
    pack.minimumContrastRatio > 21
  ) {
    fail("DESIGN_CATALOG_V2_INVALID", "demo visual pack is invalid");
  }
  const assets: DemoVisualAssetV2[] = [];
  for (const rawAsset of pack.assets) {
    const asset = isRecord(rawAsset) ? rawAsset : null;
    if (
      !asset ||
      !hasOnlyKeys(asset, [
        "id",
        "role",
        "repositoryPath",
        "sha256",
        "mimeType",
        "altTemplate",
        "sourceManifestId",
      ]) ||
      !isDesignAbstractionCode(asset.id) ||
      !isDesignAbstractionCode(asset.role) ||
      !isRelativeRepositoryPath(asset.repositoryPath) ||
      !isSha256(asset.sha256) ||
      !MIMES.has(String(asset.mimeType)) ||
      !isDesignAbstractionCode(asset.altTemplate) ||
      !isDesignAbstractionCode(asset.sourceManifestId)
    ) {
      fail("DESIGN_CATALOG_V2_INVALID", "demo visual pack asset is invalid");
    }
    assets.push(asset as unknown as DemoVisualAssetV2);
  }
  if (!unique(assets.map((asset) => asset.id))) {
    fail(
      "DESIGN_CATALOG_V2_INVALID",
      "demo visual pack asset ids must be unique",
    );
  }
  return pack as unknown as DemoVisualPackV2;
}

export function demoVisualPackV2Digest(value: DemoVisualPackV2): string {
  return designSha256(value);
}

function validCompatibilityRule(
  value: unknown,
): value is DesignCompatibilityRuleV2 {
  const rule = isRecord(value) ? value : null;
  if (!rule || !isNonBlankString(rule.code)) return false;
  if (
    [
      "no_adjacent_full_bleed",
      "requires_evidence",
      "requires_wide_asset_for_full_bleed",
    ].includes(rule.code)
  ) {
    return hasOnlyKeys(rule, ["code"]);
  }
  if (rule.code === "max_consecutive_card_grid") {
    return (
      hasOnlyKeys(rule, ["code", "maximum"]) &&
      [1, 2, 3].includes(rule.maximum as number)
    );
  }
  if (rule.code === "max_consecutive_dark_surface") {
    return (
      hasOnlyKeys(rule, ["code", "maximum"]) &&
      [1, 2].includes(rule.maximum as number)
    );
  }
  return (
    rule.code === "requires_minimum_product_count" &&
    hasOnlyKeys(rule, ["code", "minimum"]) &&
    [2, 3, 4].includes(rule.minimum as number)
  );
}

function compatibilityKey(rule: DesignCompatibilityRuleV2): string {
  return designSha256(rule);
}

function validateBlueprint(value: unknown): PageBlueprintV2 {
  const blueprint = isRecord(value) ? value : null;
  if (
    !blueprint ||
    !hasOnlyKeys(blueprint, ["id", "pageKind", "sections", "mobileReflow"]) ||
    !isDesignAbstractionCode(blueprint.id) ||
    !["home", "inner"].includes(String(blueprint.pageKind)) ||
    !Array.isArray(blueprint.sections) ||
    blueprint.sections.length === 0 ||
    !isDesignAbstractionCodeArray(blueprint.mobileReflow) ||
    blueprint.mobileReflow.length === 0
  ) {
    if (
      !blueprint ||
      !Array.isArray(blueprint.sections) ||
      blueprint.sections.length === 0
    ) {
      fail("DESIGN_FAMILY_V2_INVALID", "blueprint must contain sections");
    }
    fail("DESIGN_FAMILY_V2_INVALID", "blueprint metadata is invalid");
  }
  const sections: BlueprintSectionV2[] = [];
  for (const rawSection of blueprint.sections) {
    const section = isRecord(rawSection) ? rawSection : null;
    if (
      !section ||
      !hasOnlyKeys(section, [
        "id",
        "role",
        "componentType",
        "variant",
        "required",
        "requiresEvidence",
        "assetRoles",
        "contentBudgetKey",
      ]) ||
      !isDesignAbstractionCode(section.id) ||
      !isDesignAbstractionCode(section.role) ||
      !SITE_SPEC_COMPONENT_TYPES.includes(
        section.componentType as SiteSpecComponentType,
      ) ||
      !isNonBlankString(section.variant) ||
      typeof section.required !== "boolean" ||
      typeof section.requiresEvidence !== "boolean" ||
      !isDesignAbstractionCodeArray(section.assetRoles) ||
      !isDesignAbstractionCode(section.contentBudgetKey)
    ) {
      fail("DESIGN_FAMILY_V2_INVALID", "blueprint section is invalid");
    }
    const componentType = section.componentType as SiteSpecComponentType;
    if (!qualifiedVariants(componentType).includes(section.variant)) {
      fail(
        "DESIGN_FAMILY_V2_VARIANT_UNQUALIFIED",
        `blueprint ${blueprint.id} selects ${componentType}:${section.variant}`,
      );
    }
    sections.push(section as unknown as BlueprintSectionV2);
  }
  if (!unique(sections.map((section) => section.id))) {
    fail("DESIGN_FAMILY_V2_INVALID", "blueprint section ids must be unique");
  }
  return blueprint as unknown as PageBlueprintV2;
}

export function validateTemplateFamilyV2(value: unknown): TemplateFamilyV2 {
  const family = isRecord(value) ? value : null;
  if (
    !family ||
    !hasOnlyKeys(family, [
      "schemaVersion",
      "id",
      "version",
      "status",
      "designDnaId",
      "compatibleArchetypes",
      "compatibleIndustries",
      "stylePresetIds",
      "blueprints",
      "safeFallbackBlueprintIds",
      "componentVariants",
      "heroOptions",
      "compatibilityRules",
      "contentBudgets",
      "assetRequirements",
      "demoVisualPackIds",
      "motionPolicy",
      "qualityBaselineId",
      "sourceManifestIds",
      "goldenFixtureIds",
    ]) ||
    family.schemaVersion !== DESIGN_TEMPLATE_FAMILY_V2_SCHEMA_VERSION ||
    !isDesignAbstractionCode(family.id) ||
    !isNonBlankString(family.version) ||
    !validStatus(family.status) ||
    !isDesignAbstractionCode(family.designDnaId) ||
    !isDesignAbstractionCodeArray(family.compatibleArchetypes) ||
    family.compatibleArchetypes.length === 0 ||
    !isDesignAbstractionCodeArray(family.compatibleIndustries) ||
    family.compatibleIndustries.length === 0 ||
    !isDesignAbstractionCodeArray(family.stylePresetIds) ||
    family.stylePresetIds.length < 2 ||
    !unique(family.stylePresetIds) ||
    !isRecord(family.blueprints) ||
    Object.keys(family.blueprints).length === 0 ||
    !isRecord(family.safeFallbackBlueprintIds) ||
    !validComponentVariantRecord(family.componentVariants) ||
    !Array.isArray(family.heroOptions) ||
    family.heroOptions.length < 2 ||
    family.heroOptions.length > 3 ||
    !Array.isArray(family.compatibilityRules) ||
    family.compatibilityRules.length === 0 ||
    !isRecord(family.contentBudgets) ||
    Object.values(family.contentBudgets).some(
      (budget) => !validBudget(budget),
    ) ||
    !isDesignAbstractionCodeArray(family.assetRequirements) ||
    !isDesignAbstractionCodeArray(family.demoVisualPackIds) ||
    family.demoVisualPackIds.length === 0 ||
    !isRecord(family.motionPolicy) ||
    !isDesignAbstractionCode(family.qualityBaselineId) ||
    !isDesignAbstractionCodeArray(family.sourceManifestIds) ||
    family.sourceManifestIds.length === 0 ||
    !isDesignAbstractionCodeArray(family.goldenFixtureIds) ||
    family.goldenFixtureIds.length < 2
  ) {
    fail("DESIGN_FAMILY_V2_INVALID", "template family metadata is invalid");
  }
  const typedFamily = family as unknown as TemplateFamilyV2;
  const motion = typedFamily.motionPolicy;
  if (
    !hasOnlyKeys(motion, ["intensity", "allowed", "forbidden"]) ||
    !["none", "low", "medium"].includes(String(motion.intensity)) ||
    !isDesignAbstractionCodeArray(motion.allowed) ||
    !isDesignAbstractionCodeArray(motion.forbidden)
  ) {
    fail(
      "DESIGN_FAMILY_V2_INVALID",
      "template family motion policy is invalid",
    );
  }
  const pageEntries = Object.entries(typedFamily.blueprints);
  if (
    !pageEntries.every(
      ([pageKey, alternatives]) =>
        isDesignAbstractionCode(pageKey) &&
        Array.isArray(alternatives) &&
        alternatives.length > 0,
    )
  ) {
    fail("DESIGN_FAMILY_V2_INVALID", "template family blueprints are invalid");
  }
  const blueprints = pageEntries.flatMap(([, alternatives]) =>
    alternatives.map(validateBlueprint),
  );
  if (!unique(blueprints.map((blueprint) => blueprint.id))) {
    fail("DESIGN_FAMILY_V2_INVALID", "blueprint ids must be unique");
  }
  if (
    blueprints.filter((blueprint) => blueprint.pageKind === "home").length <
      2 ||
    blueprints.filter((blueprint) => blueprint.pageKind === "inner").length < 2
  ) {
    fail(
      "DESIGN_FAMILY_V2_MINIMUMS_UNMET",
      "a family needs at least two home and two inner blueprints",
    );
  }
  const fallbackIds = Object.entries(typedFamily.safeFallbackBlueprintIds);
  if (
    fallbackIds.length !== pageEntries.length ||
    fallbackIds.some(
      ([pageKey, blueprintId]) =>
        !isDesignAbstractionCode(pageKey) ||
        !isDesignAbstractionCode(blueprintId) ||
        !typedFamily.blueprints[pageKey]?.some(
          (blueprint) => blueprint.id === blueprintId,
        ),
    )
  ) {
    fail("DESIGN_FAMILY_V2_INVALID", "safe fallback blueprints are invalid");
  }
  const allowedVariants = typedFamily.componentVariants;
  for (const blueprint of blueprints) {
    for (const section of blueprint.sections) {
      const allowed = allowedVariants[section.componentType];
      if (!allowed || !allowed.includes(section.variant)) {
        fail(
          "DESIGN_FAMILY_V2_VARIANT_UNQUALIFIED",
          `${family.id} does not allow ${section.componentType}:${section.variant}`,
        );
      }
      if (
        !Object.hasOwn(typedFamily.contentBudgets, section.contentBudgetKey)
      ) {
        fail(
          "DESIGN_FAMILY_V2_INVALID",
          `${typedFamily.id} has no budget for ${section.contentBudgetKey}`,
        );
      }
    }
  }
  const heroKeys = new Set<string>();
  for (const option of typedFamily.heroOptions) {
    const item = isRecord(option) ? option : null;
    if (
      !item ||
      !hasOnlyKeys(item, ["componentType", "variant"]) ||
      !SITE_SPEC_COMPONENT_TYPES.includes(
        item.componentType as SiteSpecComponentType,
      ) ||
      !isNonBlankString(item.variant) ||
      !allowedVariants[item.componentType as SiteSpecComponentType]?.includes(
        item.variant,
      )
    ) {
      fail("DESIGN_FAMILY_V2_INVALID", "hero option is invalid");
    }
    heroKeys.add(`${item.componentType}:${item.variant}`);
  }
  if (heroKeys.size !== typedFamily.heroOptions.length) {
    fail("DESIGN_FAMILY_V2_INVALID", "hero options must be distinct");
  }
  if (
    typedFamily.compatibilityRules.some(
      (rule) => !validCompatibilityRule(rule),
    ) ||
    !unique(typedFamily.compatibilityRules.map(compatibilityKey))
  ) {
    fail("DESIGN_FAMILY_V2_INVALID", "compatibility rules are invalid");
  }
  return typedFamily;
}

export function designTemplateFamilyV2Digest(value: TemplateFamilyV2): string {
  return designSha256(value);
}

function validateCatalogV2Draft(value: unknown): DesignCatalogV2Draft {
  const catalog = isRecord(value) ? value : null;
  if (
    !catalog ||
    !hasOnlyKeys(catalog, [
      "schemaVersion",
      "catalogVersion",
      "sourceManifests",
      "designRules",
      "designDnas",
      "stylePresets",
      "demoVisualPacks",
      "families",
    ]) ||
    catalog.schemaVersion !== DESIGN_CATALOG_V2_SCHEMA_VERSION ||
    !isNonBlankString(catalog.catalogVersion) ||
    !Array.isArray(catalog.sourceManifests) ||
    !Array.isArray(catalog.designRules) ||
    !Array.isArray(catalog.designDnas) ||
    !Array.isArray(catalog.stylePresets) ||
    !Array.isArray(catalog.demoVisualPacks) ||
    !Array.isArray(catalog.families)
  ) {
    fail("DESIGN_CATALOG_V2_INVALID", "catalog envelope is invalid");
  }
  let sourceManifests: DesignSourceManifest[];
  let designRules: DesignRule[];
  let designDnas: DesignDna[];
  let stylePresets: DesignStylePresetV2[];
  let demoVisualPacks: DemoVisualPackV2[];
  let families: TemplateFamilyV2[];
  try {
    sourceManifests = catalog.sourceManifests.map((manifest) =>
      validateDesignSourceManifest(manifest),
    );
    designRules = catalog.designRules.map((rule) =>
      validateDesignRule(rule, { sourceManifests }),
    );
    designDnas = catalog.designDnas.map(validateDesignDna);
    stylePresets = catalog.stylePresets.map(validateStylePreset);
    demoVisualPacks = catalog.demoVisualPacks.map(validateDemoVisualPack);
    families = catalog.families.map(validateTemplateFamilyV2);
  } catch (error) {
    if (error instanceof DesignCatalogV2ContractError) throw error;
    fail("DESIGN_CATALOG_V2_INVALID", "catalog contains an invalid entry");
  }
  if (
    !uniqueIds(sourceManifests) ||
    !uniqueIds(designRules) ||
    !uniqueIds(designDnas) ||
    !uniqueIds(stylePresets) ||
    !uniqueIds(demoVisualPacks) ||
    !uniqueIds(families)
  ) {
    fail("DESIGN_CATALOG_V2_INVALID", "catalog identifiers must be unique");
  }
  const dnaIds = new Set(designDnas.map((dna) => dna.id));
  const sourceIds = new Set(sourceManifests.map((manifest) => manifest.id));
  const presetById = new Map(stylePresets.map((preset) => [preset.id, preset]));
  const packById = new Map(demoVisualPacks.map((pack) => [pack.id, pack]));
  for (const pack of demoVisualPacks) {
    if (pack.assets.some((asset) => !sourceIds.has(asset.sourceManifestId))) {
      fail(
        "DESIGN_CATALOG_V2_REFERENCE_UNKNOWN",
        `visual pack ${pack.id} references an unknown source`,
      );
    }
  }
  for (const family of families) {
    if (
      !dnaIds.has(family.designDnaId) ||
      family.sourceManifestIds.some((id) => !sourceIds.has(id))
    ) {
      fail(
        "DESIGN_CATALOG_V2_REFERENCE_UNKNOWN",
        `family ${family.id} references an unknown DNA or source`,
      );
    }
    const presets = family.stylePresetIds.map((id) => presetById.get(id));
    const packs = family.demoVisualPackIds.map((id) => packById.get(id));
    if (presets.some((preset) => !preset) || packs.some((pack) => !pack)) {
      fail(
        "DESIGN_CATALOG_V2_REFERENCE_UNKNOWN",
        `family ${family.id} references an unknown preset or visual pack`,
      );
    }
    if (packs.some((pack) => !pack?.compatibleFamilyIds.includes(family.id))) {
      fail(
        "DESIGN_CATALOG_V2_REFERENCE_UNKNOWN",
        `visual pack is not compatible with family ${family.id}`,
      );
    }
    if (
      family.status === "approved" &&
      (presets.some((preset) => preset?.status !== "approved") ||
        packs.some((pack) => pack?.status !== "approved"))
    ) {
      fail(
        "DESIGN_CATALOG_V2_APPROVAL_INVALID",
        `approved family ${family.id} requires approved presets and visual packs`,
      );
    }
  }
  return {
    schemaVersion: DESIGN_CATALOG_V2_SCHEMA_VERSION,
    catalogVersion: catalog.catalogVersion,
    sourceManifests,
    designRules,
    designDnas,
    stylePresets,
    demoVisualPacks,
    families,
  };
}

export function finalizeDesignCatalogV2(
  value: DesignCatalogV2Draft,
): DesignCatalogV2 {
  const draft = validateCatalogV2Draft(value);
  return { ...draft, digest: designSha256(draft) };
}

export function validateDesignCatalogV2(value: unknown): DesignCatalogV2 {
  const catalog = isRecord(value) ? value : null;
  if (
    !catalog ||
    !hasOnlyKeys(catalog, [
      "schemaVersion",
      "catalogVersion",
      "sourceManifests",
      "designRules",
      "designDnas",
      "stylePresets",
      "demoVisualPacks",
      "families",
      "digest",
    ]) ||
    !isSha256(catalog.digest)
  ) {
    fail("DESIGN_CATALOG_V2_INVALID", "catalog envelope or digest is invalid");
  }
  const draft = validateCatalogV2Draft({
    schemaVersion: catalog.schemaVersion,
    catalogVersion: catalog.catalogVersion,
    sourceManifests: catalog.sourceManifests,
    designRules: catalog.designRules,
    designDnas: catalog.designDnas,
    stylePresets: catalog.stylePresets,
    demoVisualPacks: catalog.demoVisualPacks,
    families: catalog.families,
  });
  if (catalog.digest !== designSha256(draft)) {
    fail(
      "DESIGN_CATALOG_V2_DIGEST_MISMATCH",
      "catalog digest does not match its contents",
    );
  }
  return { ...draft, digest: catalog.digest };
}

function validateBriefV2Draft(value: unknown): DesignBriefV2Draft {
  const brief = isRecord(value) ? value : null;
  const assets =
    brief && isRecord(brief.assetStrategy) ? brief.assetStrategy : null;
  if (
    !brief ||
    !hasOnlyKeys(brief, [
      "schemaVersion",
      "catalogVersion",
      "catalogDigest",
      "familyId",
      "familyVersion",
      "familyDigest",
      "stylePresetId",
      "stylePresetVersion",
      "stylePresetDigest",
      "blueprintIds",
      "componentVariantSelections",
      "assetStrategy",
      "contentBudgets",
      "localePolicy",
      "motionIntensity",
      "variationSeed",
      "archetype",
      "componentLibraryVersion",
      "rendererVersion",
      "reasons",
      "warnings",
    ]) ||
    brief.schemaVersion !== DESIGN_BRIEF_V2_SCHEMA_VERSION ||
    !isNonBlankString(brief.catalogVersion) ||
    !isSha256(brief.catalogDigest) ||
    !isDesignAbstractionCode(brief.familyId) ||
    !isNonBlankString(brief.familyVersion) ||
    !isSha256(brief.familyDigest) ||
    !isDesignAbstractionCode(brief.stylePresetId) ||
    !isNonBlankString(brief.stylePresetVersion) ||
    !isSha256(brief.stylePresetDigest) ||
    !isRecord(brief.blueprintIds) ||
    Object.keys(brief.blueprintIds).length === 0 ||
    !Object.entries(brief.blueprintIds).every(
      ([key, id]) =>
        isDesignAbstractionCode(key) && isDesignAbstractionCode(id),
    ) ||
    !validComponentRecord(brief.componentVariantSelections) ||
    !assets ||
    !hasOnlyKeys(assets, [
      "availableRoles",
      "demoVisualPackId",
      "demoVisualPackVersion",
      "demoVisualPackDigest",
      "allowGeneratedImages",
      "allowVideo",
    ]) ||
    !isDesignAbstractionCodeArray(assets.availableRoles) ||
    assets.allowGeneratedImages !== false ||
    assets.allowVideo !== false ||
    !isRecord(brief.contentBudgets) ||
    Object.values(brief.contentBudgets).some(
      (budget) => !validBudget(budget),
    ) ||
    !isStringArray(brief.localePolicy) ||
    brief.localePolicy.length === 0 ||
    !unique(brief.localePolicy) ||
    !["none", "low", "medium"].includes(String(brief.motionIntensity)) ||
    !isNonBlankString(brief.variationSeed) ||
    !isDesignAbstractionCode(brief.archetype) ||
    !isNonBlankString(brief.componentLibraryVersion) ||
    !isNonBlankString(brief.rendererVersion) ||
    !isStringArray(brief.reasons) ||
    !isStringArray(brief.warnings)
  ) {
    fail("DESIGN_BRIEF_V2_INVALID", "design brief metadata is invalid");
  }
  const hasPack = assets.demoVisualPackId !== undefined;
  if (
    hasPack !== (assets.demoVisualPackVersion !== undefined) ||
    hasPack !== (assets.demoVisualPackDigest !== undefined) ||
    (hasPack &&
      (!isDesignAbstractionCode(assets.demoVisualPackId) ||
        !isNonBlankString(assets.demoVisualPackVersion) ||
        !isSha256(assets.demoVisualPackDigest)))
  ) {
    fail("DESIGN_BRIEF_V2_INVALID", "demo visual pack pin is invalid");
  }
  for (const [type, variant] of Object.entries(
    brief.componentVariantSelections,
  )) {
    if (!qualifiedVariants(type as SiteSpecComponentType).includes(variant)) {
      fail(
        "DESIGN_BRIEF_V2_VARIANT_MISMATCH",
        `brief selects ${type}:${variant}`,
      );
    }
  }
  return brief as unknown as DesignBriefV2Draft;
}

export function finalizeDesignBriefV2(
  value: DesignBriefV2Draft,
): DesignBriefV2 {
  const draft = validateBriefV2Draft(value);
  return { ...draft, digest: designSha256(draft) };
}

export function validateDesignBriefV2(value: unknown): DesignBriefV2 {
  const brief = isRecord(value) ? value : null;
  if (
    !brief ||
    !hasOnlyKeys(brief, [
      "schemaVersion",
      "catalogVersion",
      "catalogDigest",
      "familyId",
      "familyVersion",
      "familyDigest",
      "stylePresetId",
      "stylePresetVersion",
      "stylePresetDigest",
      "blueprintIds",
      "componentVariantSelections",
      "assetStrategy",
      "contentBudgets",
      "localePolicy",
      "motionIntensity",
      "variationSeed",
      "archetype",
      "componentLibraryVersion",
      "rendererVersion",
      "reasons",
      "warnings",
      "digest",
    ]) ||
    !isSha256(brief.digest)
  ) {
    fail(
      "DESIGN_BRIEF_V2_INVALID",
      "design brief envelope or digest is invalid",
    );
  }
  const { digest, ...draftValue } = brief;
  const draft = validateBriefV2Draft(draftValue);
  if (digest !== designSha256(draft)) {
    fail(
      "DESIGN_BRIEF_V2_DIGEST_MISMATCH",
      "design brief digest does not match its contents",
    );
  }
  return { ...draft, digest };
}

/** Resolves a fully pinned, approved v2 family without invoking an assembler. */
export function validateDesignBriefV2AgainstCatalog(
  catalogInput: DesignCatalogV2,
  briefInput: unknown,
): TemplateFamilyV2 {
  const catalog = validateDesignCatalogV2(catalogInput);
  const brief = validateDesignBriefV2(briefInput);
  if (
    brief.catalogVersion !== catalog.catalogVersion ||
    brief.catalogDigest !== catalog.digest
  ) {
    fail(
      "DESIGN_BRIEF_V2_CATALOG_MISMATCH",
      "brief does not pin this catalog revision",
    );
  }
  const family = catalog.families.find((item) => item.id === brief.familyId);
  if (!family || family.status !== "approved") {
    fail(
      "DESIGN_BRIEF_V2_FAMILY_UNAVAILABLE",
      "brief selected a family that is not approved",
    );
  }
  if (
    brief.familyVersion !== family.version ||
    brief.familyDigest !== designTemplateFamilyV2Digest(family)
  ) {
    fail(
      "DESIGN_BRIEF_V2_FAMILY_MISMATCH",
      "brief does not pin this family revision",
    );
  }
  const preset = catalog.stylePresets.find(
    (item) => item.id === brief.stylePresetId,
  );
  if (
    !preset ||
    preset.status !== "approved" ||
    !family.stylePresetIds.includes(preset.id) ||
    brief.stylePresetVersion !== preset.version ||
    brief.stylePresetDigest !== designStylePresetV2Digest(preset)
  ) {
    fail(
      "DESIGN_BRIEF_V2_PRESET_MISMATCH",
      "brief does not pin an approved family preset",
    );
  }
  const familyPageKeys = Object.keys(family.blueprints).sort();
  const briefPageKeys = Object.keys(brief.blueprintIds).sort();
  if (
    JSON.stringify(familyPageKeys) !== JSON.stringify(briefPageKeys) ||
    familyPageKeys.some(
      (pageKey) =>
        !family.blueprints[pageKey]?.some(
          (blueprint) => blueprint.id === brief.blueprintIds[pageKey],
        ),
    )
  ) {
    fail(
      "DESIGN_BRIEF_V2_BLUEPRINT_MISMATCH",
      "brief must select one valid blueprint for every family page key",
    );
  }
  const selectedSections = familyPageKeys.flatMap((pageKey) => {
    const blueprintId = brief.blueprintIds[pageKey];
    return (
      family.blueprints[pageKey]?.find(
        (blueprint) => blueprint.id === blueprintId,
      )?.sections ?? []
    );
  });
  const requiredSelections = new Map<SiteSpecComponentType, string>();
  for (const section of selectedSections) {
    const previous = requiredSelections.get(section.componentType);
    if (previous && previous !== section.variant) {
      fail(
        "DESIGN_BRIEF_V2_VARIANT_MISMATCH",
        `selected blueprints require conflicting variants for ${section.componentType}`,
      );
    }
    requiredSelections.set(section.componentType, section.variant);
  }
  if (
    Object.keys(brief.componentVariantSelections).length !==
      requiredSelections.size ||
    [...requiredSelections].some(
      ([type, variant]) => brief.componentVariantSelections[type] !== variant,
    )
  ) {
    fail(
      "DESIGN_BRIEF_V2_VARIANT_MISMATCH",
      "brief must pin every selected component variant exactly",
    );
  }
  const approvedBudgetKeys = Object.keys(family.contentBudgets);
  if (
    JSON.stringify(Object.keys(brief.contentBudgets).sort()) !==
      JSON.stringify(approvedBudgetKeys.sort()) ||
    approvedBudgetKeys.some((key) => {
      const requested = brief.contentBudgets[key];
      const approved = family.contentBudgets[key];
      return (
        !requested ||
        requested.minimum < approved.minimum ||
        requested.maximum > approved.maximum
      );
    })
  ) {
    fail(
      "DESIGN_BRIEF_V2_BUDGET_MISMATCH",
      "brief budgets must stay within the family bounds",
    );
  }
  if (brief.motionIntensity !== family.motionPolicy.intensity) {
    fail(
      "DESIGN_BRIEF_V2_MOTION_MISMATCH",
      "brief motion intensity differs from the family policy",
    );
  }
  const packId = brief.assetStrategy.demoVisualPackId;
  if (packId) {
    const pack = catalog.demoVisualPacks.find((item) => item.id === packId);
    if (
      !pack ||
      pack.status !== "approved" ||
      !family.demoVisualPackIds.includes(pack.id) ||
      !pack.compatibleFamilyIds.includes(family.id) ||
      brief.assetStrategy.demoVisualPackVersion !== pack.version ||
      brief.assetStrategy.demoVisualPackDigest !== demoVisualPackV2Digest(pack)
    ) {
      fail(
        "DESIGN_BRIEF_V2_VISUAL_PACK_MISMATCH",
        "brief does not pin an approved compatible visual pack",
      );
    }
  }
  return family;
}
