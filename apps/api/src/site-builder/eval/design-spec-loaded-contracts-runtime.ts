import { createHash } from "node:crypto";

import {
  DESIGN_BRIEF_V2_SCHEMA_VERSION,
  DESIGN_CATALOG_SCHEMA_VERSION,
  DESIGN_CATALOG_V2_SCHEMA_VERSION,
  DesignCatalogV2ContractError,
  demoVisualPackV2Digest,
  designStylePresetV2Digest,
  designTemplateFamilyV2Digest,
  finalizeDesignBriefV2,
  finalizeDesignCatalog,
  finalizeDesignCatalogV2,
  validateDesignBriefAgainstCatalog,
  validateDesignBriefV2,
  validateDesignBriefV2AgainstCatalog,
} from "@global/contracts";

const LOADED_RUNTIME_FUNCTION_TO_STRING = Function.prototype.toString;
const APPLY_LOADED_RUNTIME_INTRINSIC = Reflect.apply;

function loadedRuntimeValue(value: unknown): string {
  if (typeof value === "function") {
    return APPLY_LOADED_RUNTIME_INTRINSIC(
      LOADED_RUNTIME_FUNCTION_TO_STRING,
      value,
      [],
    ) as string;
  }
  if (typeof value === "string") return value;
  throw new Error(
    "design_spec contracts runtime export is not fingerprintable",
  );
}

const DESIGN_SPEC_LOADED_CONTRACT_EXPORTS = Object.freeze([
  ["DESIGN_BRIEF_V2_SCHEMA_VERSION", DESIGN_BRIEF_V2_SCHEMA_VERSION],
  ["DESIGN_CATALOG_SCHEMA_VERSION", DESIGN_CATALOG_SCHEMA_VERSION],
  ["DESIGN_CATALOG_V2_SCHEMA_VERSION", DESIGN_CATALOG_V2_SCHEMA_VERSION],
  ["DesignCatalogV2ContractError", DesignCatalogV2ContractError],
  ["demoVisualPackV2Digest", demoVisualPackV2Digest],
  ["designStylePresetV2Digest", designStylePresetV2Digest],
  ["designTemplateFamilyV2Digest", designTemplateFamilyV2Digest],
  ["finalizeDesignBriefV2", finalizeDesignBriefV2],
  ["finalizeDesignCatalog", finalizeDesignCatalog],
  ["finalizeDesignCatalogV2", finalizeDesignCatalogV2],
  ["validateDesignBriefAgainstCatalog", validateDesignBriefAgainstCatalog],
  ["validateDesignBriefV2", validateDesignBriefV2],
  ["validateDesignBriefV2AgainstCatalog", validateDesignBriefV2AgainstCatalog],
] as const);

export const DESIGN_SPEC_LOADED_CONTRACTS_RUNTIME_FINGERPRINT = createHash(
  "sha256",
)
  .update(
    JSON.stringify(
      DESIGN_SPEC_LOADED_CONTRACT_EXPORTS.map(([name, value]) => [
        name,
        loadedRuntimeValue(value),
      ]),
    ),
  )
  .digest("hex");
