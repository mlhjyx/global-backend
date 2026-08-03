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
    manifestSha256:
      "83dedcb2057d4e375114c42b5c03becbc9b057b1bfa1f3fc511bfec600827e72",
    suite: {
      suiteId: "site-builder.design-spec-evaluation-suite/2026-08-01-v14",
      sourceBundleContractId: "design-spec-evaluation-source-bundle/v14",
      sourceBundleSha256:
        "3e95d15837d7ad6ea234a67211b3a7564f92e9c3826911024b767de222df9528",
    },
    pricing: {
      authority: "openox_model_marketplace",
      catalogEndpoint: "https://openox.tech/api/public/pricing-catalog",
      capturedAt: "2026-08-03T01:52:16.229Z",
      catalogResponseSha256:
        "6a3655b12380ab4b229e895bd3c08ae961ef4b05d87b8eb035ff8d1b492593b4",
    },
    tokenEnvelope: {
      initialInputTokens: 6438,
      repairInputTokens: 10745,
      outputTokensPerWireCall: 4000,
    },
    entries: [
      {
        alias: "claude-sonnet-5",
        protocol: "anthropic-messages",
        currency: "USD",
        executionCount: 24,
        maximumWireCalls: 48,
        groupName: "special",
        pricingVersion:
          "c835a1a0a0b0aa97e176abf40f37cd3b735b807aaef3978e507b34eac629d08b",
        effectiveInputRateMicrounitsPerMillionTokens: 2_520_000,
        effectiveOutputRateMicrounitsPerMillionTokens: 12_600_000,
        initialCallMaximum: {
          nativePicoUnits: "66623760000",
          formatted: "0.06662376",
        },
        repairCallMaximum: {
          nativePicoUnits: "77477400000",
          formatted: "0.0774774",
        },
        maximumCost: {
          nativePicoUnits: "3458427840000",
          formatted: "3.45842784",
        },
      },
      {
        alias: "gpt-5.5",
        protocol: "openai-responses",
        currency: "CNY",
        executionCount: 25,
        maximumWireCalls: 50,
        groupName: "gpt-unified",
        pricingVersion:
          "4917874ce52479175007e300a171ce8027bcedbb2c280961b7aa5699c02e44df",
        effectiveInputRateMicrounitsPerMillionTokens: 5_000_000,
        effectiveOutputRateMicrounitsPerMillionTokens: 30_000_000,
        initialCallMaximum: {
          nativePicoUnits: "152190000000",
          formatted: "0.15219",
        },
        repairCallMaximum: {
          nativePicoUnits: "173725000000",
          formatted: "0.173725",
        },
        maximumCost: {
          nativePicoUnits: "8147875000000",
          formatted: "8.147875",
        },
      },
      {
        alias: "gpt-5.6-terra",
        protocol: "openai-responses",
        currency: "CNY",
        executionCount: 24,
        maximumWireCalls: 48,
        groupName: "gpt-unified",
        pricingVersion:
          "f69fc361b1b58c6478d49f08afe0867af2b234af4d96dd941835b3d5bf2590ba",
        effectiveInputRateMicrounitsPerMillionTokens: 2_000_000,
        effectiveOutputRateMicrounitsPerMillionTokens: 12_000_000,
        initialCallMaximum: {
          nativePicoUnits: "60876000000",
          formatted: "0.060876",
        },
        repairCallMaximum: {
          nativePicoUnits: "69490000000",
          formatted: "0.06949",
        },
        maximumCost: {
          nativePicoUnits: "3128784000000",
          formatted: "3.128784",
        },
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

function nativeCampaign(card = feeCard) {
  return new DesignSpecNativeSettlementCampaign({ feeCard: card });
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

  it("derives its native campaign caps from the #263 fee card", () => {
    expect(nativeCampaign().snapshot()).toMatchObject({
      frozen: false,
      totalsByCurrency: {
        CNY: { capPicoUnits: "11276659000000" },
        USD: { capPicoUnits: "3458427840000" },
      },
    });
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

  it("rejects a self-consistent fee card with drifted fixed-source provenance", () => {
    const tampered = createFeeCard();
    const altered = {
      ...tampered,
      fixedSourceCommitSha: "a".repeat(40),
    };
    const { cardSha256: _previousDigest, ...unsignedAltered } = altered;
    const lowered = {
      ...altered,
      cardSha256: sha256CanonicalJson(unsignedAltered),
    } as DesignSpecNativeFeeCard;

    expect(() =>
      nativePicoUnitsForUsage(lowered, {
        alias: "gpt-5.5",
        protocol: "openai-responses",
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).toThrow("integrity");
  });

  it("rejects a self-consistent fee card that does not equal the #263 fee card", () => {
    const altered = structuredClone(feeCard) as DesignSpecNativeFeeCard;
    const loweredEntry = {
      ...altered.entries[0]!,
      effectiveInputRateMicrounitsPerMillionTokens: 1,
      effectiveOutputRateMicrounitsPerMillionTokens: 1,
      initialCallMaximum: { nativePicoUnits: "10438", formatted: "0" },
      repairCallMaximum: { nativePicoUnits: "14745", formatted: "0" },
      maximumCost: { nativePicoUnits: "604392", formatted: "0" },
    };
    const { cardSha256: _previousDigest, ...cardWithoutDigest } = altered;
    const unsignedAltered = {
      ...cardWithoutDigest,
      entries: [loweredEntry, ...altered.entries.slice(1)],
    };
    const unsignedLowered = {
      ...unsignedAltered,
      totalsByCurrency: {
        ...unsignedAltered.totalsByCurrency,
        CNY: { nativePicoUnits: "8147875604392", formatted: "8.147875604392" },
      },
    };
    const lowered = {
      ...unsignedLowered,
      cardSha256: sha256CanonicalJson(unsignedLowered),
    } as DesignSpecNativeFeeCard;

    expect(() =>
      nativePicoUnitsForUsage(lowered, {
        alias: "gpt-5.6-terra",
        protocol: "openai-responses",
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).toThrow("integrity");
  });

  it("reserves the fee-card maximum before dispatch and settles a native amount", () => {
    const campaign = nativeCampaign();

    campaign.reserve({
      executionId: "design-spec:gpt-5.5:fixture:attempt:1",
      wireAttempt: "initial",
      alias: "gpt-5.5",
      protocol: "openai-responses",
    });
    campaign.settleObservedUsage({
      executionId: "design-spec:gpt-5.5:fixture:attempt:1",
      wireAttempt: "initial",
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

  it("enforces and settles initial and repair wire ceilings independently", () => {
    const executionId = "design-spec:gpt-5.5:fixture:attempt:per-wire";
    const initialOverage = nativeCampaign();

    initialOverage.reserve({
      executionId,
      wireAttempt: "initial",
      alias: "gpt-5.5",
      protocol: "openai-responses",
    });
    expect(() =>
      initialOverage.settleObservedUsage({
        executionId,
        wireAttempt: "initial",
        inputTokens: 6438,
        outputTokens: 4001,
      }),
    ).toThrow("token envelope");
    expect(initialOverage.snapshot()).toMatchObject({
      frozen: true,
      freezeReason: "unknown_settlement",
    });

    const initialInputOverage = nativeCampaign();
    initialInputOverage.reserve({
      executionId: "design-spec:terra:fixture:attempt:input-overage",
      wireAttempt: "initial",
      alias: "gpt-5.6-terra",
      protocol: "openai-responses",
    });
    expect(() =>
      initialInputOverage.settleObservedUsage({
        executionId: "design-spec:terra:fixture:attempt:input-overage",
        wireAttempt: "initial",
        inputTokens: 6439,
        outputTokens: 0,
      }),
    ).toThrow("token envelope");
    expect(initialInputOverage.snapshot()).toMatchObject({
      frozen: true,
      freezeReason: "unknown_settlement",
    });

    const campaign = nativeCampaign();
    campaign.reserve({
      executionId,
      wireAttempt: "initial",
      alias: "gpt-5.5",
      protocol: "openai-responses",
    });
    campaign.settleObservedUsage({
      executionId,
      wireAttempt: "initial",
      inputTokens: 6438,
      outputTokens: 4000,
    });
    campaign.reserve({
      executionId,
      wireAttempt: "repair",
      alias: "gpt-5.5",
      protocol: "openai-responses",
    });
    campaign.settleObservedUsage({
      executionId,
      wireAttempt: "repair",
      inputTokens: 10745,
      outputTokens: 4000,
    });

    expect(campaign.snapshot()).toMatchObject({
      frozen: false,
      totalsByCurrency: {
        CNY: {
          committedPicoUnits: "325915000000",
          reservedPicoUnits: "0",
        },
      },
    });
  });

  it("requires a settled initial wire and preserves its dispatch for repair", () => {
    const campaign = nativeCampaign();
    const executionId = "design-spec:gpt-5.5:fixture:attempt:ordered-wires";

    expect(() =>
      campaign.reserve({
        executionId,
        wireAttempt: "repair",
        alias: "gpt-5.5",
        protocol: "openai-responses",
      }),
    ).toThrow("settled initial wire");

    campaign.reserve({
      executionId,
      wireAttempt: "initial",
      alias: "gpt-5.5",
      protocol: "openai-responses",
    });
    campaign.settleObservedUsage({
      executionId,
      wireAttempt: "initial",
      inputTokens: 1,
      outputTokens: 1,
    });

    expect(() =>
      campaign.reserve({
        executionId,
        wireAttempt: "repair",
        alias: "gpt-5.6-terra",
        protocol: "openai-responses",
      }),
    ).toThrow("does not match");
    expect(() =>
      campaign.reserve({
        executionId,
        wireAttempt: "initial",
        alias: "gpt-5.5",
        protocol: "openai-responses",
      }),
    ).toThrow("already reserved or settled");
  });

  it("rejects executions above the fee-card count for one dispatch", () => {
    const campaign = nativeCampaign();
    for (let index = 0; index < 25; index += 1) {
      const executionId = `design-spec:gpt-5.5:fixture:attempt:count-${index}`;
      campaign.reserve({
        executionId,
        wireAttempt: "initial",
        alias: "gpt-5.5",
        protocol: "openai-responses",
      });
      campaign.settleObservedUsage({
        executionId,
        wireAttempt: "initial",
        inputTokens: 1,
        outputTokens: 1,
      });
    }
    expect(() =>
      campaign.reserve({
        executionId: "design-spec:gpt-5.5:fixture:attempt:count-over",
        wireAttempt: "initial",
        alias: "gpt-5.5",
        protocol: "openai-responses",
      }),
    ).toThrow("execution count");
  });

  it("does not let a patched Set prototype bypass repair ordering", () => {
    const campaign = nativeCampaign();
    const originalHas = Set.prototype.has;
    Set.prototype.has = () => true;
    try {
      expect(() =>
        campaign.reserve({
          executionId: "design-spec:gpt-5.5:fixture:attempt:prototype",
          wireAttempt: "repair",
          alias: "gpt-5.5",
          protocol: "openai-responses",
        }),
      ).toThrow("settled initial wire");
    } finally {
      Set.prototype.has = originalHas;
    }
  });

  it("fails closed and freezes after an unknown post-dispatch settlement", () => {
    const campaign = nativeCampaign();
    const executionId = "design-spec:claude:fixture:attempt:1";

    campaign.reserve({
      executionId,
      wireAttempt: "initial",
      alias: "claude-sonnet-5",
      protocol: "anthropic-messages",
    });
    campaign.freezeUnknownSettlement({ executionId, wireAttempt: "initial" });

    expect(campaign.snapshot()).toMatchObject({
      frozen: true,
      freezeReason: "unknown_settlement",
    });
    expect(() =>
      campaign.reserve({
        executionId: "design-spec:terra:fixture:attempt:1",
        wireAttempt: "initial",
        alias: "gpt-5.6-terra",
        protocol: "openai-responses",
      }),
    ).toThrow("native-currency campaign is frozen");
  });
});
