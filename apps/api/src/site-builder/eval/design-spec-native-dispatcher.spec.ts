import { describe, expect, it } from "vitest";

import type { DesignSpecNativeFeeCard } from "./design-spec-native-fee-card";
import {
  DesignSpecNativeSettlementCampaign,
  nativePicoUnitsForUsage,
} from "./design-spec-native-dispatcher";

const feeCard = {
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
} as unknown as DesignSpecNativeFeeCard;

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
    ).toThrow("dispatch set drifted");
  });

  it("reserves the fee-card maximum before dispatch and settles a native amount", () => {
    const campaign = new DesignSpecNativeSettlementCampaign({
      feeCard,
      caps: { CNY: "11276659000000", USD: "3458427840000" },
    });

    campaign.reserve({
      executionId: "design-spec:gpt-5.5:fixture:attempt:1",
      alias: "gpt-5.5",
      protocol: "openai-responses",
    });
    campaign.settle({
      executionId: "design-spec:gpt-5.5:fixture:attempt:1",
      currency: "CNY",
      actualPicoUnits: "2000000000",
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
    const campaign = new DesignSpecNativeSettlementCampaign({
      feeCard,
      caps: { CNY: "11276659000000", USD: "3458427840000" },
    });
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
