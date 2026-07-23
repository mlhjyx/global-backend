import {
  DESIGN_CATALOG_SCHEMA_VERSION,
  DESIGN_CATALOG_V2_SCHEMA_VERSION,
  finalizeDesignCatalog,
  finalizeDesignCatalogV2,
  validateDesignBriefAgainstCatalog,
  validateDesignBriefV2AgainstCatalog,
  type DesignBrief,
  type DesignBriefV2,
  type DesignCatalog,
  type DesignCatalogV2,
  type TemplateFamily,
  type TemplateFamilyV2,
} from "@global/contracts";
import { M1_E_B_CATALOG_V2_APPROVED } from "./catalog-v2-approved";

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
export const STATIC_DESIGN_CATALOG: DesignCatalog = deepFreeze(
  finalizeDesignCatalog({
    schemaVersion: DESIGN_CATALOG_SCHEMA_VERSION,
    catalogVersion: "di-0-foundation/1",
    sourceManifests: [],
    designRules: [],
    designDnas: [],
    families: [],
  }),
);

/**
 * M1-e-B uses a separate v2 catalog rather than mutating DI-0's published v1
 * envelope. B6 promotes all six reviewed Families and their exact dependencies
 * together; no draft digest is accepted as runtime input.
 */
export const STATIC_DESIGN_CATALOG_V2: DesignCatalogV2 = deepFreeze(
  finalizeDesignCatalogV2(M1_E_B_CATALOG_V2_APPROVED),
);

export function resolveDesignBriefFromCatalog(
  catalog: DesignCatalog,
  brief: DesignBrief | unknown,
): TemplateFamily {
  return validateDesignBriefAgainstCatalog(catalog, brief);
}

export function resolveDesignBriefV2FromCatalog(
  catalog: DesignCatalogV2,
  brief: DesignBriefV2 | unknown,
): TemplateFamilyV2 {
  return validateDesignBriefV2AgainstCatalog(catalog, brief);
}
