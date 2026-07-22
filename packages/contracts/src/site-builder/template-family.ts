import { designSha256, hasOnlyKeys, isFiniteNumber, isNonBlankString, isRecord, isStringArray } from "./design-integrity";

export const DESIGN_TEMPLATE_FAMILY_SCHEMA_VERSION =
  "site-builder-template-family/v1" as const;

export interface ContentBudget {
  minimum: number;
  maximum: number;
}

export interface PageBlueprint {
  id: string;
  sectionRoles: string[];
  allowedComponents: string[];
}

export interface TemplateFamily {
  schemaVersion: typeof DESIGN_TEMPLATE_FAMILY_SCHEMA_VERSION;
  id: string;
  version: string;
  status: "draft" | "approved" | "deprecated";
  designDnaId: string;
  compatibleArchetypes: string[];
  compatibleIndustries: string[];
  stylePresetIds: string[];
  blueprints: Record<string, PageBlueprint[]>;
  componentVariants: Record<string, string[]>;
  adjacencyRules: string[];
  contentBudgets: Record<string, ContentBudget>;
  assetRequirements: string[];
  demoVisualPackIds: string[];
  motionPolicy: { intensity: "none" | "low" | "medium"; allowed: string[]; forbidden: string[] };
  qualityBaselineId: string;
  sourceManifestIds: string[];
}

function validBudget(value: unknown): value is ContentBudget {
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

function validBlueprint(value: unknown): value is PageBlueprint {
  const blueprint = isRecord(value) ? value : null;
  return (
    !!blueprint &&
    hasOnlyKeys(blueprint, ["id", "sectionRoles", "allowedComponents"]) &&
    isNonBlankString(blueprint.id) &&
    isStringArray(blueprint.sectionRoles) &&
    blueprint.sectionRoles.length > 0 &&
    isStringArray(blueprint.allowedComponents) &&
    blueprint.allowedComponents.length > 0
  );
}

export function validateTemplateFamily(value: unknown): TemplateFamily {
  const family = isRecord(value) ? value : null;
  const valid =
    family &&
    hasOnlyKeys(family, [
      "schemaVersion",
      "id",
      "version",
      "status",
      "designDnaId",
      "compatibleArchetypes",
      "compatibleIndustries",
      "stylePresetIds",
      "blueprints",
      "componentVariants",
      "adjacencyRules",
      "contentBudgets",
      "assetRequirements",
      "demoVisualPackIds",
      "motionPolicy",
      "qualityBaselineId",
      "sourceManifestIds",
    ]) &&
    family.schemaVersion === DESIGN_TEMPLATE_FAMILY_SCHEMA_VERSION &&
    isNonBlankString(family.id) &&
    isNonBlankString(family.version) &&
    ["draft", "approved", "deprecated"].includes(String(family.status)) &&
    isNonBlankString(family.designDnaId) &&
    isStringArray(family.compatibleArchetypes) &&
    family.compatibleArchetypes.length > 0 &&
    isStringArray(family.compatibleIndustries) &&
    family.compatibleIndustries.length > 0 &&
    isStringArray(family.stylePresetIds) &&
    family.stylePresetIds.length > 0 &&
    isRecord(family.blueprints) &&
    Object.keys(family.blueprints).length > 0 &&
    Object.values(family.blueprints).every(
      (items) => Array.isArray(items) && items.length > 0 && items.every(validBlueprint),
    ) &&
    isRecord(family.componentVariants) &&
    Object.values(family.componentVariants).every(
      (items) => isStringArray(items) && items.length > 0,
    ) &&
    isStringArray(family.adjacencyRules) &&
    isRecord(family.contentBudgets) &&
    Object.values(family.contentBudgets).every(validBudget) &&
    isStringArray(family.assetRequirements) &&
    isStringArray(family.demoVisualPackIds) &&
    isRecord(family.motionPolicy) &&
    ["none", "low", "medium"].includes(String(family.motionPolicy.intensity)) &&
    isStringArray(family.motionPolicy.allowed) &&
    isStringArray(family.motionPolicy.forbidden) &&
    isNonBlankString(family.qualityBaselineId) &&
    isStringArray(family.sourceManifestIds) &&
    family.sourceManifestIds.length > 0;
  if (!valid) throw new Error("DESIGN_TEMPLATE_FAMILY_INVALID");
  return family as unknown as TemplateFamily;
}

export function designTemplateFamilyDigest(family: TemplateFamily): string {
  return designSha256(family);
}
