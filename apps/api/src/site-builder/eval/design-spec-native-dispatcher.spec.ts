import { describe, expect, it } from "vitest";

import type { DesignSpecNativeFeeCard } from "./design-spec-native-fee-card";
import { sha256CanonicalJson } from "./eval-provenance";
import {
  DesignSpecNativeSettlementCampaign,
  nativePicoUnitsForUsage,
} from "./design-spec-native-dispatcher";

function createFeeCard(): DesignSpecNativeFeeCard {
  const card = {
    schemaVersion: "site-builder-design-spec-native-fee-card/v1",
    feeCardId: "site-builder-design-spec-native-fee-card/2026-08-03-v1",
    status: "READY_FOR_CREDENTIAL_ATTESTATION",
    dispatchAuthorization: "NOT_AUTHORIZED",
    fixedSourceCommitSha: "e493ba1d09fe37feea927f70d12f17aadadc5c6a",
    manifestSha256: "83dedcb2057d4e375114c42b5c03becbc9b057b1bfa1f3fc511bfec600827e72",
    suite: {
      suiteId: "site-builder.design-spec-evaluation-suite/2026-08-01-v14",
      sourceBundleContractId: "design-spec-evaluation-source-bundle/v14",
      sourceBundleSha256:
        "3e95d15837d7ad6ea234a67211b3a7564f92e9c3826911024b767de222df9528",
    },
    pricing: {
      authority: "openox_model_marketplace",
      catalogEndpoint: "https://openox.tech/api/public/pricing-catalog",
      capturedAt: "2026-08-03T00:00:00.000Z",
      catalogResponseSha256: "a".repeat(64),
    },
    tokenEnvelope: {
      initialInputTokens: 6438,
      repairInputTokens: 10745,
      outputTokensPerWireCall: 4000,
    },
  entries: [
    {
      alias: "gpt-5.6-terra",
      protocol: "openai-responses",
      currency: "CNY",
      executionCount: 24,
      effectiveInputRateMicrounitsPerMillionTokens: 2_000_000,
      effectiveOutputRateMicrounitsPerMillionTokens: 12_000_000,
      initialCallMaximum: { nativePicoUnits: "60876000000", formatted: "0" },
      repairCallMaximum: { nativePicoUnits: "69490000000", formatted: "0" },
      maximumCost: { nativePicoUnits: "3128784000000", formatted: "0" },
    },
    {
      alias: "gpt-5.5",
      protocol: "openai-responses",
      currency: "CNY",
      executionCount: 25,
      effectiveInputRateMicrounitsPerMillionTokens: 5_000_000,
      effectiveOutputRateMicrounitsPerMillionTokens: 30_000_000,
      initialCallMaximum: { nativePicoUnits: "152190000000", formatted: "0" },
      repairCallMaximum: { nativePicoUnits: "173725000000", formatted: "0" },
      maximumCost: { nativePicoUnits: "8147875000000", formatted: "0" },
    },
    {
      alias: "claude-sonnet-5",
      protocol: "anthropic-messages",
      currency: "USD",
      executionCount: 24,
      effectiveInputRateMicrounitsPerMillionTokens: 2_520_000,
      effectiveOutputRateMicrounitsPerMillionTokens: 12_600_000,
      initialCallMaximum: { nativePicoUnits: "66623760000", formatted: "0" },
      repairCallMaximum: { nativePicoUnits: "77477400000", formatted: "0" },
      maximumCost: { nativePicoUnits: "3458427840000", formatted: "0" },
    },
  ],
    totalsByCurrency: {
      CNY: { nativePicoUnits: "11276659000000", formatted: "11.276659" },
      USD: { nativePicoUnits: "3458427840000", formatted: "3.45842784" },
    },
    expectedCost: "not_known_before_usage",
    mechanicalPolicyCeiling: {
      amountCents: 2920,
      meaning: "mechanical_only_not_a_native_currency_budget",
    },
    noForeignExchangeConversion: true,
  } as const;
  return {
    ...card,
    cardSha256: sha256CanonicalJson(card),
  } as DesignSpecNativeFeeCard;
}

const feeCard = createFeeCard();

function nativeCampaign(
  card = feeCard,
  authorizedFeeCardSha256 = feeCard.cardSha256,
) {
  return new DesignSpecNativeSettlementCampaign({
    feeCard: card,
    authorizedFeeCardSha256,
    caps: { CNY: "11276659000000", USD: "3458427840000" },
  });
}

describe("design_spec native dispatcher settlement bridge", () => {
  it("prices each wire in the dispatch's OpenOx native currency without FX", () => {
    expect(
      nativePicoUnitsForUsage(feeCard, {
        alias: "gpt-5.5",
        protocol: "openai-responses",
        inputTokens: 100,
        outputTokens: 50,
      }),
    ).toEqual({ currency: "CNY", nativePicoUnits: "2000000000" });
    expect(
      nativePicoUnitsForUsage(feeCard, {
        alias: "claude-sonnet-5",
        protocol: "anthropic-messages",
        inputTokens: 100,
        outputTokens: 50,
      }),
    ).toEqual({ currency: "USD", nativePicoUnits: "882000000" });
  });

  it("rejects a fee card whose admitted dispatch set has been widened", () => {
    const widened = {
      ...feeCard,
      entries: [
        ...feeCard.entries,
        {
          ...feeCard.entries[0]!,
          alias: "retired-model",
        },
      ],
    } as DesignSpecNativeFeeCard;

    expect(() =>
      nativePicoUnitsForUsage(widened, {
        alias: "gpt-5.5",
        protocol: "openai-responses",
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).toThrow("native fee card");
  });

  it("rejects a self-consistent fee card with lower native rates unless its digest was authorized", () => {
    const tampered = createFeeCard();
    const altered = {
      ...tampered,
      entries: tampered.entries.map((entry) =>
        entry.alias === "gpt-5.5"
          ? { ...entry, effectiveInputRateMicrounitsPerMillionTokens: 1 }
          : entry,
      ),
    };
    const { cardSha256: _previousDigest, ...unsignedAltered } = altered;
    const lowered = {
      ...altered,
      cardSha256: sha256CanonicalJson(unsignedAltered),
    } as DesignSpecNativeFeeCard;

    expect(() => nativeCampaign(lowered)).toThrow("authorized fee card digest");
  });

  it("reserves the fee-card maximum before dispatch and settles a native amount", () => {
    const campaign = nativeCampaign();

    campaign.reserve({
      executionId: "design-spec:gpt-5.5:fixture:attempt:1",
      alias: "gpt-5.5",
      protocol: "openai-responses",
    });
    campaign.settleObservedUsage({
      executionId: "design-spec:gpt-5.5:fixture:attempt:1",
      inputTokens: 100,
      outputTokens: 50,
    });

    expect(campaign.snapshot()).toMatchObject({
      frozen: false,
      totalsByCurrency: {
        CNY: {
          committedPicoUnits: "2000000000",
          reservedPicoUnits: "0",
        },
        USD: { committedPicoUnits: "0" },
      },
    });
  });

  it("fails closed and freezes after an unknown post-dispatch settlement", () => {
    const campaign = nativeCampaign();
    const executionId = "design-spec:claude:fixture:attempt:1";

    campaign.reserve({
      executionId,
      alias: "claude-sonnet-5",
      protocol: "anthropic-messages",
    });
    campaign.freezeUnknownSettlement(executionId);

    expect(campaign.snapshot()).toMatchObject({
      frozen: true,
      freezeReason: "unknown_settlement",
    });
    expect(() =>
      campaign.reserve({
        executionId: "design-spec:terra:fixture:attempt:1",
        alias: "gpt-5.6-terra",
        protocol: "openai-responses",
      }),
    ).toThrow("native-currency campaign is frozen");
  });
});
