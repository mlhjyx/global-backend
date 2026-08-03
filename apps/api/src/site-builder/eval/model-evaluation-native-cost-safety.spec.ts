import { describe, expect, it } from "vitest";

import {
  assertNativeModelEvaluationDispatch,
  createNativeModelEvaluationCostSafetyAttestation,
  isTrustedNativeModelEvaluationCostSafetyAttestation,
  nativeMaximumPicoUnitsForModelEvaluationWire,
  nativeModelEvaluationPricingFeeCardSha256,
  nativePicoUnitsForModelEvaluationUsage,
  type NativeModelEvaluationCostSafetyInput,
} from "./model-evaluation-native-cost-safety";

function validInput(): NativeModelEvaluationCostSafetyInput {
  const input: NativeModelEvaluationCostSafetyInput = {
    contractId:
      "site-builder-model-evaluation-native-cost-safety/2026-08-03-v2",
    authorization: {
      authorizationId: "design-spec-native-dispatch-authorization-20260803",
      ledgerId: "design-spec-native-dispatch-ledger",
      ledgerDirectorySha256: "a".repeat(64),
      approvedAt: "2026-08-03T08:00:00.000Z",
      approvedMaximumsByCurrency: {
        CNY: "11276659000000",
        USD: "3458427840000",
      },
      approvedDispatchExecutions: 73,
      approvedWireCalls: 146,
      preparedFixedCommitSha: "b".repeat(40),
      preparedManifestSha256: "c".repeat(64),
      preparedFeeCardSha256: "d".repeat(64),
      preparedSuiteId:
        "site-builder.design-spec-evaluation-suite/2026-08-03-v15",
      preparedSourceBundleContractId:
        "design-spec-evaluation-source-bundle/v15",
      preparedSourceBundleSha256: "e".repeat(64),
    },
    credential: {
      attestationId: "design-spec-native-credential-20260803",
      observedAt: "2026-08-03T08:00:00.000Z",
      snapshotSha256: "f".repeat(64),
      bearerTokenSha256: "1".repeat(64),
      gatewayOrigin: "http://127.0.0.1:3001",
      purpose: "site_builder_model_evaluation",
      quotaMode: "limited",
      scopeExact: true,
      allowedDispatches: [
        {
          mode: "target",
          alias: "gpt-5.6-terra",
          protocol: "openai-responses",
          currency: "CNY",
        },
        {
          mode: "target",
          alias: "gpt-5.5",
          protocol: "openai-responses",
          currency: "CNY",
        },
        {
          mode: "target",
          alias: "claude-sonnet-5",
          protocol: "anthropic-messages",
          currency: "USD",
        },
      ],
      gatewaySettlement: {
        purposeGroup: "design-spec-eval",
        tokenLogPath: "/api/log/token",
        routes: [
          {
            alias: "gpt-5.6-terra",
            protocol: "openai-responses",
            channelId: 11,
          },
          {
            alias: "gpt-5.5",
            protocol: "openai-responses",
            channelId: 12,
          },
          {
            alias: "claude-sonnet-5",
            protocol: "anthropic-messages",
            channelId: 13,
          },
        ],
      },
    },
    pricing: {
      authority: "openox_model_marketplace",
      catalogEndpoint: "https://openox.tech/api/public/pricing-catalog",
      capturedAt: "2026-08-03T08:00:00.000Z",
      catalogResponseSha256: "2".repeat(64),
      noForeignExchangeConversion: true,
      entries: [
        {
          alias: "gpt-5.6-terra",
          protocol: "openai-responses",
          currency: "CNY",
          inputRateMicrounitsPerMillionTokens: 2_000_000,
          outputRateMicrounitsPerMillionTokens: 12_000_000,
        },
        {
          alias: "gpt-5.5",
          protocol: "openai-responses",
          currency: "CNY",
          inputRateMicrounitsPerMillionTokens: 5_000_000,
          outputRateMicrounitsPerMillionTokens: 30_000_000,
        },
        {
          alias: "claude-sonnet-5",
          protocol: "anthropic-messages",
          currency: "USD",
          inputRateMicrounitsPerMillionTokens: 2_520_000,
          outputRateMicrounitsPerMillionTokens: 12_600_000,
        },
      ],
    },
    limits: {
      maximumsByCurrency: {
        CNY: "11276659000000",
        USD: "3458427840000",
      },
      maxDispatchExecutions: 73,
      maxWireCalls: 146,
      maxInputTokensInitialWire: 6438,
      maxInputTokensRepairWire: 10745,
      maxOutputTokensPerWire: 4000,
    },
    settlement: {
      requestIdentityField: "executionId",
      requireVerifiedRequestSettlement: true,
      unknownSettlementPolicy: "freeze_campaign",
    },
  };
  input.authorization.preparedFeeCardSha256 =
    nativeModelEvaluationPricingFeeCardSha256(input.pricing);
  return input;
}

describe("native model-evaluation cost safety", () => {
  it("brands an exact, frozen three-target no-FX attestation", () => {
    const attestation =
      createNativeModelEvaluationCostSafetyAttestation(validInput());

    expect(
      isTrustedNativeModelEvaluationCostSafetyAttestation(attestation),
    ).toBe(true);
    expect(Object.isFrozen(attestation)).toBe(true);
    expect(Object.isFrozen(attestation.pricing.entries)).toBe(true);
  });

  it("rejects widened, retired, deferred, media, and legacy dispatch scope before pricing", () => {
    const input = validInput();
    input.credential.allowedDispatches.push({
      mode: "target",
      alias: "minimax-m3",
      protocol: "openai-chat-completions",
      currency: "CNY",
    });

    expect(() =>
      createNativeModelEvaluationCostSafetyAttestation(input),
    ).toThrow("native model evaluation cost safety attestation is invalid");

    const attestation =
      createNativeModelEvaluationCostSafetyAttestation(validInput());
    expect(() =>
      assertNativeModelEvaluationDispatch(attestation, {
        mode: "target",
        alias: "gemini-3.5-flash",
        protocol: "google-generate-content",
        wireAttempt: "initial",
        maximumWireCalls: 1,
        maxOutputTokens: 4000,
        inputTokens: 1,
      }),
    ).toThrow("native model evaluation dispatch is not authorized");

    expect(() =>
      assertNativeModelEvaluationDispatch(attestation, {
        mode: "target",
        alias: "gpt-5.5",
        protocol: "openai-responses",
        wireAttempt: "initial",
        maximumWireCalls: 1,
        maxOutputTokens: 4000,
        inputTokens: 6439,
      }),
    ).toThrow("native model evaluation dispatch is not authorized");
  });

  it("requires the credential snapshot to bind exact token-log purpose and channels", () => {
    const missingChannel = validInput();
    missingChannel.credential.gatewaySettlement.routes[1]!.channelId = 0;
    expect(() =>
      createNativeModelEvaluationCostSafetyAttestation(missingChannel),
    ).toThrow("native model evaluation cost safety attestation is invalid");

    const substitutedRoute = validInput();
    substitutedRoute.credential.gatewaySettlement.routes[1]!.alias =
      "gpt-5.6-terra";
    expect(() =>
      createNativeModelEvaluationCostSafetyAttestation(substitutedRoute),
    ).toThrow("native model evaluation cost safety attestation is invalid");

    const wrongPurpose = validInput();
    wrongPurpose.credential.gatewaySettlement.purposeGroup =
      "general-purpose" as "design-spec-eval";
    expect(() =>
      createNativeModelEvaluationCostSafetyAttestation(wrongPurpose),
    ).toThrow("native model evaluation cost safety attestation is invalid");
  });

  it("prices CNY and USD independently in pico-units without a cents or FX path", () => {
    const attestation =
      createNativeModelEvaluationCostSafetyAttestation(validInput());

    expect(
      nativePicoUnitsForModelEvaluationUsage(attestation, {
        executionId: "design-spec:gpt55:1",
        alias: "gpt-5.5",
        protocol: "openai-responses",
        wireAttempt: "initial",
        inputTokens: 100,
        outputTokens: 50,
      }),
    ).toEqual({
      state: "settled",
      executionId: "design-spec:gpt55:1",
      currency: "CNY",
      nativePicoUnits: "2000000000",
      basis: "frozen_openox_native_pricing@2026-08-03T08:00:00.000Z",
    });
    expect(
      nativePicoUnitsForModelEvaluationUsage(attestation, {
        executionId: "design-spec:sonnet:1",
        alias: "claude-sonnet-5",
        protocol: "anthropic-messages",
        wireAttempt: "repair",
        inputTokens: 100,
        outputTokens: 50,
      }),
    ).toMatchObject({
      state: "settled",
      currency: "USD",
      nativePicoUnits: "882000000",
    });
    expect(
      nativeMaximumPicoUnitsForModelEvaluationWire(attestation, {
        alias: "gpt-5.5",
        protocol: "openai-responses",
        wireAttempt: "initial",
      }),
    ).toEqual({ currency: "CNY", nativePicoUnits: "152190000000" });
  });

  it("rejects a fee-card or manifest substitution and all implicit FX", () => {
    const manifestDrift = validInput();
    manifestDrift.authorization.preparedManifestSha256 = "not-a-sha256";
    expect(() =>
      createNativeModelEvaluationCostSafetyAttestation(manifestDrift),
    ).toThrow("native model evaluation cost safety attestation is invalid");

    const fxDrift = validInput();
    fxDrift.pricing.noForeignExchangeConversion = false;
    expect(() =>
      createNativeModelEvaluationCostSafetyAttestation(fxDrift),
    ).toThrow("native model evaluation cost safety attestation is invalid");

    const wrongHttpsOrigin = validInput();
    wrongHttpsOrigin.credential.gatewayOrigin = "https://gateway.example.test";
    expect(() =>
      createNativeModelEvaluationCostSafetyAttestation(wrongHttpsOrigin),
    ).toThrow("native model evaluation cost safety attestation is invalid");

    const historicalV14 = validInput();
    historicalV14.authorization.preparedManifestSha256 =
      "83dedcb2057d4e375114c42b5c03becbc9b057b1bfa1f3fc511bfec600827e72";
    historicalV14.authorization.preparedFeeCardSha256 =
      "de3f778561ce1cc630629b8674ca7932b991a9ded61fa02a3220aa13578dd869";
    historicalV14.authorization.preparedSuiteId =
      "site-builder.design-spec-evaluation-suite/2026-08-01-v14";
    historicalV14.authorization.preparedSourceBundleContractId =
      "design-spec-evaluation-source-bundle/v14";
    expect(() =>
      createNativeModelEvaluationCostSafetyAttestation(historicalV14),
    ).toThrow("native model evaluation cost safety attestation is invalid");

    const underReserved = validInput();
    underReserved.limits.maximumsByCurrency.CNY = "1";
    underReserved.authorization.approvedMaximumsByCurrency.CNY = "1";
    expect(() =>
      createNativeModelEvaluationCostSafetyAttestation(underReserved),
    ).toThrow("native model evaluation cost safety attestation is invalid");

    const aboveApprovedCnyCap = validInput();
    aboveApprovedCnyCap.pricing.entries[1] = {
      ...aboveApprovedCnyCap.pricing.entries[1]!,
      inputRateMicrounitsPerMillionTokens: 5_000_001,
    };
    aboveApprovedCnyCap.limits.maximumsByCurrency.CNY = "11276659429575";
    aboveApprovedCnyCap.authorization.approvedMaximumsByCurrency.CNY =
      "11276659429575";
    expect(() =>
      createNativeModelEvaluationCostSafetyAttestation(aboveApprovedCnyCap),
    ).toThrow("native model evaluation cost safety attestation is invalid");
  });

  it("binds the prepared fee-card digest to every admitted pricing entry", () => {
    const rateSubstitution = validInput();
    // These countervailing input-rate changes retain the aggregate CNY total:
    // 24 * 429_575 === 25 * 412_392. They must still invalidate the card.
    rateSubstitution.pricing.entries[0] = {
      ...rateSubstitution.pricing.entries[0]!,
      inputRateMicrounitsPerMillionTokens: 2_429_575,
    };
    rateSubstitution.pricing.entries[1] = {
      ...rateSubstitution.pricing.entries[1]!,
      inputRateMicrounitsPerMillionTokens: 4_587_608,
    };

    expect(() =>
      createNativeModelEvaluationCostSafetyAttestation(rateSubstitution),
    ).toThrow("native model evaluation cost safety attestation is invalid");
  });

  it("rejects sparse dispatch allowlists and live Array toJSON key bypasses", () => {
    const sparseDispatches = validInput();
    const admitted = sparseDispatches.credential.allowedDispatches;
    sparseDispatches.credential.allowedDispatches = [
      admitted[2]!,
    ] as typeof sparseDispatches.credential.allowedDispatches;
    sparseDispatches.credential.allowedDispatches.length = 3;
    expect(() =>
      createNativeModelEvaluationCostSafetyAttestation(sparseDispatches),
    ).toThrow("native model evaluation cost safety attestation is invalid");

    const unknownRootField = validInput() as NativeModelEvaluationCostSafetyInput &
      Record<string, unknown>;
    unknownRootField.unrecognizedAuthorizationField = true;
    const originalToJson = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "toJSON",
    );
    try {
      Object.defineProperty(Array.prototype, "toJSON", {
        configurable: true,
        value: () => [],
      });
      expect(() =>
        createNativeModelEvaluationCostSafetyAttestation(unknownRootField),
      ).toThrow("native model evaluation cost safety attestation is invalid");
    } finally {
      if (originalToJson) {
        Object.defineProperty(Array.prototype, "toJSON", originalToJson);
      } else {
        Reflect.deleteProperty(Array.prototype, "toJSON");
      }
    }
  });

  it("keeps admission correct after mutable validation intrinsics are tampered", () => {
    const originalObjectKeys = Object.keys;
    const originalObjectHasOwn = Object.hasOwn;
    const originalDateParse = Date.parse;
    const originalStructuredClone = globalThis.structuredClone;
    const originalMap = Array.prototype.map;
    const originalSort = Array.prototype.sort;
    const originalEvery = Array.prototype.every;
    const originalSome = Array.prototype.some;
    const originalFind = Array.prototype.find;
    const originalBigIntToString = BigInt.prototype.toString;
    let maximumPicoUnits: string | undefined;
    try {
      Object.keys = (() => {
        throw new Error("tampered Object.keys");
      }) as typeof Object.keys;
      Object.hasOwn = (() => {
        throw new Error("tampered Object.hasOwn");
      }) as typeof Object.hasOwn;
      Date.parse = (() => {
        throw new Error("tampered Date.parse");
      }) as typeof Date.parse;
      globalThis.structuredClone = (() => {
        throw new Error("tampered structuredClone");
      }) as typeof structuredClone;
      Array.prototype.map = (() => {
        throw new Error("tampered Array.map");
      }) as typeof Array.prototype.map;
      Array.prototype.sort = (() => {
        throw new Error("tampered Array.sort");
      }) as typeof Array.prototype.sort;
      Array.prototype.every = (() => {
        throw new Error("tampered Array.every");
      }) as typeof Array.prototype.every;
      Array.prototype.some = (() => {
        throw new Error("tampered Array.some");
      }) as typeof Array.prototype.some;
      Array.prototype.find = (() => {
        throw new Error("tampered Array.find");
      }) as typeof Array.prototype.find;
      BigInt.prototype.toString = (() =>
        "0") as typeof BigInt.prototype.toString;

      const attestation =
        createNativeModelEvaluationCostSafetyAttestation(validInput());
      maximumPicoUnits = nativeMaximumPicoUnitsForModelEvaluationWire(
        attestation,
        {
          alias: "gpt-5.5",
          protocol: "openai-responses",
          wireAttempt: "initial",
        },
      ).nativePicoUnits;
    } finally {
      Object.keys = originalObjectKeys;
      Object.hasOwn = originalObjectHasOwn;
      Date.parse = originalDateParse;
      globalThis.structuredClone = originalStructuredClone;
      Array.prototype.map = originalMap;
      Array.prototype.sort = originalSort;
      Array.prototype.every = originalEvery;
      Array.prototype.some = originalSome;
      Array.prototype.find = originalFind;
      BigInt.prototype.toString = originalBigIntToString;
    }
    expect(maximumPicoUnits).toBe("152190000000");
  });

  it("does not use mutable array iteration or URL parsing for admission", () => {
    const input = validInput();
    const originalIterator = Array.prototype[Symbol.iterator];
    const originalUrl = globalThis.URL;
    let accepted: boolean;
    try {
      Array.prototype[Symbol.iterator] = (() =>
        ({
          next: () => {
            throw new Error("tampered Array iterator");
          },
        }) as Iterator<never>) as (typeof Array.prototype)[typeof Symbol.iterator];
      globalThis.URL = class {
        constructor() {
          throw new Error("tampered URL parser");
        }
      } as unknown as typeof URL;
      accepted =
        isTrustedNativeModelEvaluationCostSafetyAttestation(
          createNativeModelEvaluationCostSafetyAttestation(input),
        ) === true;
    } finally {
      Array.prototype[Symbol.iterator] = originalIterator;
      globalThis.URL = originalUrl;
    }
    expect(accepted).toBe(true);
  });
});
