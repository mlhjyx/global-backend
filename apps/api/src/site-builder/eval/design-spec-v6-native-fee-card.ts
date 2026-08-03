import {
  assertDesignSpecNativeFeeCardManifestForContract,
  buildDesignSpecNativeFeeCardForContract,
  DESIGN_SPEC_V2_NATIVE_FEE_CARD_DISPATCHES,
  type DesignSpecNativeFeeCard,
  type DesignSpecNativeFeeCardContract,
  type DesignSpecV2NativeFeeCardInput,
} from "./design-spec-v2-native-fee-card";

export const DESIGN_SPEC_V6_NATIVE_FEE_CARD_ID =
  "site-builder-design-spec-v6-native-fee-card/2026-08-04-v1" as const;
export const DESIGN_SPEC_V6_NATIVE_FEE_CARD_SCHEMA_VERSION =
  "site-builder-design-spec-v6-native-fee-card/v1" as const;

const V6_CONTRACT: DesignSpecNativeFeeCardContract = Object.freeze({
  feeCardId: DESIGN_SPEC_V6_NATIVE_FEE_CARD_ID,
  schemaVersion: DESIGN_SPEC_V6_NATIVE_FEE_CARD_SCHEMA_VERSION,
  fixedSourceCommitSha: "5c37bb9270db6893144f07c2431e74a830d6b9f4",
  suiteId: "site-builder.design-spec-evaluation-suite/2026-08-03-v15",
  sourceBundleContractId: "design-spec-evaluation-source-bundle/v15",
  sourceBundleSha256:
    "c6deda364bb15efe15d2237ea761573ba5501d8c10fd44578abd5926a2833e72",
  manifestSha256:
    "1a74fab9ac803bfc50636fdb51ab7ac1b04623a8053c8d17a37a60294c99facd",
  dispatches: DESIGN_SPEC_V2_NATIVE_FEE_CARD_DISPATCHES,
  errorPrefix: "design_spec v6",
});

export type DesignSpecV6NativeFeeCard = Omit<
  DesignSpecNativeFeeCard,
  "schemaVersion" | "feeCardId"
> & {
  schemaVersion: typeof DESIGN_SPEC_V6_NATIVE_FEE_CARD_SCHEMA_VERSION;
  feeCardId: typeof DESIGN_SPEC_V6_NATIVE_FEE_CARD_ID;
};

/** Validates only the v6 current-source manifest before a public price read. */
export function assertDesignSpecV6NativeFeeCardManifest(value: unknown): void {
  assertDesignSpecNativeFeeCardManifestForContract(value, V6_CONTRACT);
}
export function buildDesignSpecV6NativeFeeCard(
  input: DesignSpecV2NativeFeeCardInput,
): DesignSpecV6NativeFeeCard {
  return buildDesignSpecNativeFeeCardForContract(
    input,
    V6_CONTRACT,
  ) as DesignSpecV6NativeFeeCard;
}
