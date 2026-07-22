import {
  DESIGN_CATALOG_SCHEMA_VERSION,
  finalizeDesignCatalog,
  validateDesignBriefAgainstCatalog,
  type DesignBrief,
  type DesignCatalog,
  type TemplateFamily,
} from "@global/contracts";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * DI-0 intentionally ships an empty, immutable catalog envelope. Real
 * approved families are an M1-e deliverable; an empty catalog is safer than
 * smuggling an unreviewed demonstration family into the runtime.
 */
export const STATIC_DESIGN_CATALOG: DesignCatalog = deepFreeze(finalizeDesignCatalog({
  schemaVersion: DESIGN_CATALOG_SCHEMA_VERSION,
  catalogVersion: "di-0-foundation/1",
  designRules: [],
  designDnas: [],
  families: [],
}));

export function resolveDesignBriefFromCatalog(
  catalog: DesignCatalog,
  brief: DesignBrief | unknown,
): TemplateFamily {
  return validateDesignBriefAgainstCatalog(catalog, brief);
}
