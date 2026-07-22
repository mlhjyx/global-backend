import {
  designSha256,
  hasOnlyKeys,
  isNonBlankString,
  isRecord,
} from "./design-integrity";
import { validateDesignBrief, type DesignBrief } from "./design-brief";
import { validateDesignDna, type DesignDna } from "./design-dna";
import {
  validateDesignRule,
  type DesignRule,
  type DesignRuleValidationContext,
} from "./design-observation";
import {
  designTemplateFamilyDigest,
  validateTemplateFamily,
  type TemplateFamily,
} from "./template-family";

export const DESIGN_CATALOG_SCHEMA_VERSION =
  "site-builder-design-catalog/v1" as const;

export interface DesignCatalogDraft {
  schemaVersion: typeof DESIGN_CATALOG_SCHEMA_VERSION;
  catalogVersion: string;
  designRules: DesignRule[];
  designDnas: DesignDna[];
  families: TemplateFamily[];
}

export interface DesignCatalog extends DesignCatalogDraft {
  digest: string;
}

export type DesignCatalogContractErrorCode =
  | "DESIGN_CATALOG_INVALID"
  | "DESIGN_CATALOG_DIGEST_MISMATCH"
  | "DESIGN_BRIEF_CATALOG_MISMATCH"
  | "DESIGN_BRIEF_FAMILY_UNAVAILABLE"
  | "DESIGN_BRIEF_FAMILY_MISMATCH"
  | "DESIGN_BRIEF_UNSUPPORTED_PRESET"
  | "DESIGN_BRIEF_UNSUPPORTED_BLUEPRINT"
  | "DESIGN_BRIEF_UNSUPPORTED_VARIANT"
  | "DESIGN_BRIEF_UNSUPPORTED_BUDGET";

export class DesignCatalogContractError extends Error {
  constructor(
    readonly code: DesignCatalogContractErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "DesignCatalogContractError";
  }
}

function fail(code: DesignCatalogContractErrorCode, message: string): never {
  throw new DesignCatalogContractError(code, message);
}

function uniqueIds(values: readonly { id: string }[]): boolean {
  return new Set(values.map((item) => item.id)).size === values.length;
}

function validateCatalogDraft(
  value: unknown,
  context?: DesignRuleValidationContext,
  requireRuleProvenance = false,
): DesignCatalogDraft {
  const catalog = isRecord(value) ? value : null;
  if (
    !catalog ||
    !hasOnlyKeys(catalog, [
      "schemaVersion",
      "catalogVersion",
      "designRules",
      "designDnas",
      "families",
    ]) ||
    catalog.schemaVersion !== DESIGN_CATALOG_SCHEMA_VERSION ||
    !isNonBlankString(catalog.catalogVersion) ||
    !Array.isArray(catalog.designRules) ||
    !Array.isArray(catalog.designDnas) ||
    !Array.isArray(catalog.families)
  ) {
    fail("DESIGN_CATALOG_INVALID", "catalog envelope is invalid");
  }
  let rules: DesignRule[];
  let dnas: DesignDna[];
  let families: TemplateFamily[];
  try {
    if (requireRuleProvenance && catalog.designRules.length > 0 && !context) {
      fail(
        "DESIGN_CATALOG_INVALID",
        "catalog publication needs validated rule provenance",
      );
    }
    rules = catalog.designRules.map((rule) =>
      validateDesignRule(rule, context),
    );
    dnas = catalog.designDnas.map(validateDesignDna);
    families = catalog.families.map(validateTemplateFamily);
  } catch {
    fail("DESIGN_CATALOG_INVALID", "catalog contains an invalid entry");
  }
  if (!uniqueIds(rules) || !uniqueIds(dnas) || !uniqueIds(families)) {
    fail("DESIGN_CATALOG_INVALID", "catalog identifiers must be unique");
  }
  const ruleIds = new Set(rules.map((rule) => rule.id));
  const dnaIds = new Set(dnas.map((dna) => dna.id));
  if (
    dnas.some((dna) => dna.ruleIds.some((ruleId) => !ruleIds.has(ruleId))) ||
    families.some((family) => !dnaIds.has(family.designDnaId))
  ) {
    fail(
      "DESIGN_CATALOG_INVALID",
      "catalog references an unknown rule or design DNA",
    );
  }
  return {
    schemaVersion: DESIGN_CATALOG_SCHEMA_VERSION,
    catalogVersion: catalog.catalogVersion,
    designRules: rules,
    designDnas: dnas,
    families,
  };
}

export function finalizeDesignCatalog(
  value: DesignCatalogDraft,
  context?: DesignRuleValidationContext,
): DesignCatalog {
  const draft = validateCatalogDraft(value, context, true);
  return { ...draft, digest: designSha256(draft) };
}

export function validateDesignCatalog(value: unknown): DesignCatalog {
  const catalog = isRecord(value) ? value : null;
  if (
    !catalog ||
    !hasOnlyKeys(catalog, [
      "schemaVersion",
      "catalogVersion",
      "designRules",
      "designDnas",
      "families",
      "digest",
    ])
  ) {
    fail("DESIGN_CATALOG_INVALID", "catalog envelope is invalid");
  }
  if (
    typeof catalog.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(catalog.digest)
  ) {
    fail("DESIGN_CATALOG_INVALID", "catalog digest is invalid");
  }
  const draft = validateCatalogDraft({
    schemaVersion: catalog.schemaVersion,
    catalogVersion: catalog.catalogVersion,
    designRules: catalog.designRules,
    designDnas: catalog.designDnas,
    families: catalog.families,
  });
  const expectedDigest = designSha256(draft);
  if (catalog.digest !== expectedDigest) {
    fail(
      "DESIGN_CATALOG_DIGEST_MISMATCH",
      "catalog digest does not match its contents",
    );
  }
  return { ...draft, digest: catalog.digest };
}

/**
 * Resolves only a fully pinned, approved family. This is a catalog contract
 * seam, not a renderer or SiteSpec consumer; M1-e will attach those consumers.
 */
export function validateDesignBriefAgainstCatalog(
  catalogInput: DesignCatalog,
  briefInput: unknown,
): TemplateFamily {
  const catalog = validateDesignCatalog(catalogInput);
  const brief: DesignBrief = validateDesignBrief(briefInput);
  if (
    brief.catalogVersion !== catalog.catalogVersion ||
    brief.catalogDigest !== catalog.digest
  ) {
    fail(
      "DESIGN_BRIEF_CATALOG_MISMATCH",
      "brief does not pin this catalog revision",
    );
  }
  const family = catalog.families.find((item) => item.id === brief.familyId);
  if (!family || family.status !== "approved") {
    fail(
      "DESIGN_BRIEF_FAMILY_UNAVAILABLE",
      "brief selected a family that is not approved",
    );
  }
  if (
    brief.familyVersion !== family.version ||
    brief.familyDigest !== designTemplateFamilyDigest(family)
  ) {
    fail(
      "DESIGN_BRIEF_FAMILY_MISMATCH",
      "brief does not pin this family revision",
    );
  }
  if (!family.stylePresetIds.includes(brief.stylePresetId)) {
    fail(
      "DESIGN_BRIEF_UNSUPPORTED_PRESET",
      "brief selected an unsupported style preset",
    );
  }
  for (const [page, blueprintId] of Object.entries(brief.blueprintIds)) {
    if (
      !family.blueprints[page]?.some(
        (blueprint) => blueprint.id === blueprintId,
      )
    ) {
      fail(
        "DESIGN_BRIEF_UNSUPPORTED_BLUEPRINT",
        `brief selected ${page}:${blueprintId}`,
      );
    }
  }
  for (const [component, variant] of Object.entries(
    brief.componentVariantOverrides,
  )) {
    if (!family.componentVariants[component]?.includes(variant)) {
      fail(
        "DESIGN_BRIEF_UNSUPPORTED_VARIANT",
        `brief selected ${component}:${variant}`,
      );
    }
  }
  const approvedBudgetKeys = new Set(Object.keys(family.contentBudgets));
  if (
    Object.keys(brief.contentBudgets).some(
      (key) => !approvedBudgetKeys.has(key),
    ) ||
    [...approvedBudgetKeys].some(
      (key) => brief.contentBudgets[key] === undefined,
    ) ||
    Object.entries(brief.contentBudgets).some(([key, budget]) => {
      const approved = family.contentBudgets[key];
      return (
        !approved ||
        budget.minimum < approved.minimum ||
        budget.maximum > approved.maximum
      );
    })
  ) {
    fail(
      "DESIGN_BRIEF_UNSUPPORTED_BUDGET",
      "brief content budgets must stay within the approved family bounds",
    );
  }
  return family;
}
