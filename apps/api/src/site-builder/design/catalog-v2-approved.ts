import type { DesignCatalogV2Draft } from "@global/contracts";
import { M1_E_B_B3_CATALOG_V2_DRAFT } from "./catalog-v2-b3-drafts";

/**
 * B6 is the only promotion point. Draft digests remain available in Git history,
 * while every runtime dependency receives one coordinated 1.0.0 identity.
 */
export const M1_E_B_CATALOG_V2_APPROVED: DesignCatalogV2Draft = {
  ...structuredClone(M1_E_B_B3_CATALOG_V2_DRAFT),
  catalogVersion: "m1-e-b/1.0.0",
  stylePresets: M1_E_B_B3_CATALOG_V2_DRAFT.stylePresets.map((preset) => ({
    ...structuredClone(preset),
    version: "1.0.0",
    status: "approved",
  })),
  demoVisualPacks: M1_E_B_B3_CATALOG_V2_DRAFT.demoVisualPacks.map((pack) => ({
    ...structuredClone(pack),
    version: "1.0.0",
    status: "approved",
  })),
  families: M1_E_B_B3_CATALOG_V2_DRAFT.families.map((family) => ({
    ...structuredClone(family),
    version: "1.0.0",
    status: "approved",
  })),
};
