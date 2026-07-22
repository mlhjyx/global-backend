import { hasOnlyKeys, isFiniteNumber, isNonBlankString, isRecord, isStringArray } from "./design-integrity";
import type { ContentBudget } from "./template-family";

export const DESIGN_BRIEF_SCHEMA_VERSION = "site-builder-design-brief/v1" as const;

export interface DesignBrief {
  schemaVersion: typeof DESIGN_BRIEF_SCHEMA_VERSION;
  catalogVersion: string;
  catalogDigest: string;
  familyId: string;
  familyVersion: string;
  familyDigest: string;
  stylePresetId: string;
  blueprintIds: Record<string, string>;
  componentVariantOverrides: Record<string, string>;
  assetStrategy: {
    availableRoles: string[];
    demoVisualPackId?: string;
    allowGeneratedImages: boolean;
    allowVideo: boolean;
  };
  contentBudgets: Record<string, ContentBudget>;
  localePolicy: string[];
  motionIntensity: "none" | "low" | "medium";
  variationSeed: string;
  reasons: string[];
  warnings: string[];
}

const SHA256 = /^[a-f0-9]{64}$/;

function validBudget(value: unknown): boolean {
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

function stringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(isNonBlankString);
}

export function validateDesignBrief(value: unknown): DesignBrief {
  const brief = isRecord(value) ? value : null;
  const assetStrategy = brief && isRecord(brief.assetStrategy) ? brief.assetStrategy : null;
  const valid =
    brief &&
    hasOnlyKeys(brief, [
      "schemaVersion",
      "catalogVersion",
      "catalogDigest",
      "familyId",
      "familyVersion",
      "familyDigest",
      "stylePresetId",
      "blueprintIds",
      "componentVariantOverrides",
      "assetStrategy",
      "contentBudgets",
      "localePolicy",
      "motionIntensity",
      "variationSeed",
      "reasons",
      "warnings",
    ]) &&
    brief.schemaVersion === DESIGN_BRIEF_SCHEMA_VERSION &&
    isNonBlankString(brief.catalogVersion) &&
    typeof brief.catalogDigest === "string" &&
    SHA256.test(brief.catalogDigest) &&
    isNonBlankString(brief.familyId) &&
    isNonBlankString(brief.familyVersion) &&
    typeof brief.familyDigest === "string" &&
    SHA256.test(brief.familyDigest) &&
    isNonBlankString(brief.stylePresetId) &&
    stringRecord(brief.blueprintIds) &&
    Object.keys(brief.blueprintIds).length > 0 &&
    stringRecord(brief.componentVariantOverrides) &&
    assetStrategy &&
    hasOnlyKeys(assetStrategy, [
      "availableRoles",
      "demoVisualPackId",
      "allowGeneratedImages",
      "allowVideo",
    ]) &&
    isStringArray(assetStrategy.availableRoles) &&
    (assetStrategy.demoVisualPackId === undefined || isNonBlankString(assetStrategy.demoVisualPackId)) &&
    typeof assetStrategy.allowGeneratedImages === "boolean" &&
    typeof assetStrategy.allowVideo === "boolean" &&
    isRecord(brief.contentBudgets) &&
    Object.values(brief.contentBudgets).every(validBudget) &&
    isStringArray(brief.localePolicy) &&
    brief.localePolicy.length > 0 &&
    ["none", "low", "medium"].includes(String(brief.motionIntensity)) &&
    isNonBlankString(brief.variationSeed) &&
    isStringArray(brief.reasons) &&
    isStringArray(brief.warnings);
  if (!valid) throw new Error("DESIGN_BRIEF_INVALID");
  return brief as unknown as DesignBrief;
}
