import {
  assertDesignSpecNativeFeeCardManifestForContract,
  buildDesignSpecNativeFeeCardForContract,
  DESIGN_SPEC_V2_NATIVE_FEE_CARD_DISPATCHES,
  type DesignSpecNativeFeeCard,
  type DesignSpecNativeFeeCardContract,
  type DesignSpecV2NativeFeeCardInput,
} from "./design-spec-v2-native-fee-card";

export const DESIGN_SPEC_V5_NATIVE_FEE_CARD_ID =
  "site-builder-design-spec-v5-native-fee-card/2026-08-04-v1" as const;
export const DESIGN_SPEC_V5_NATIVE_FEE_CARD_SCHEMA_VERSION =
  "site-builder-design-spec-v5-native-fee-card/v1" as const;

const V5_CONTRACT: DesignSpecNativeFeeCardContract = Object.freeze({
  feeCardId: DESIGN_SPEC_V5_NATIVE_FEE_CARD_ID,
  schemaVersion: DESIGN_SPEC_V5_NATIVE_FEE_CARD_SCHEMA_VERSION,
  fixedSourceCommitSha: "377f8a3ae983bad0e4ae43f767a4bc59d8f7d0a9",
  suiteId: "site-builder.design-spec-evaluation-suite/2026-08-03-v15",
  sourceBundleContractId: "design-spec-evaluation-source-bundle/v15",
  sourceBundleSha256:
    "0a14c446ddb0527204b6c0a472597403aaf61998c1d12975595ae921ffd8e98d",
  manifestSha256:
    "bcc0ac261f56a5c950e11483a3dc28f33ed678c626891367a45b6c1f56429dc4",
  dispatches: DESIGN_SPEC_V2_NATIVE_FEE_CARD_DISPATCHES,
  errorPrefix: "design_spec v5",
});

export type DesignSpecV5NativeFeeCard = Omit<
  DesignSpecNativeFeeCard,
  "schemaVersion" | "feeCardId"
> & {
  schemaVersion: typeof DESIGN_SPEC_V5_NATIVE_FEE_CARD_SCHEMA_VERSION;
  feeCardId: typeof DESIGN_SPEC_V5_NATIVE_FEE_CARD_ID;
};

/** Validates only the v5 current-source manifest before a public price read. */
export function assertDesignSpecV5NativeFeeCardManifest(value: unknown): void {
  assertDesignSpecNativeFeeCardManifestForContract(value, V5_CONTRACT);
}

export function buildDesignSpecV5NativeFeeCard(
  input: DesignSpecV2NativeFeeCardInput,
): DesignSpecV5NativeFeeCard {
  return buildDesignSpecNativeFeeCardForContract(
    input,
    V5_CONTRACT,
  ) as DesignSpecV5NativeFeeCard;
}
