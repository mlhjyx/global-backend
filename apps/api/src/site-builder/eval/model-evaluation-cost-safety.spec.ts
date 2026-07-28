import { describe, expect, it, vi } from "vitest";

import {
  SITE_BUILDER_MODEL_EVALUATION_COST_SAFETY_ID,
  assertModelEvaluationCostSafetyDispatch,
  createModelEvaluationCostSafetyAttestation,
  isTrustedModelEvaluationCostSafetyAttestation,
  type ModelEvaluationCostSafetyInput,
} from "./model-evaluation-cost-safety";

function validInput(): ModelEvaluationCostSafetyInput {
  return {
    contractId: SITE_BUILDER_MODEL_EVALUATION_COST_SAFETY_ID,
    authorization: {
      authorizationId: "brand-profile-evaluation-approval/2026-07-28-v1",
      ledgerId: "brand-profile-evaluation-ledger/2026-07-28-v1",
      ledgerDirectorySha256:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      approvedAt: "2026-07-28T00:00:00.000Z",
      approvedCampaignBudgetCents: 1_000,
      approvedDispatchExecutions: 37,
    },
    credential: {
      attestationId: "brand-profile-evaluation-token/2026-07-28-v1",
      observedAt: "2026-07-28T00:00:00.000Z",
      snapshotSha256:
        "1111111111111111111111111111111111111111111111111111111111111111",
      bearerTokenSha256:
        "3333333333333333333333333333333333333333333333333333333333333333",
      gatewayOrigin: "https://new-api.example.invalid",
      purpose: "site_builder_model_evaluation",
      quotaMode: "limited",
      scopeExact: true,
      quotaCapCents: 1_500,
      remainingQuotaCents: 1_500,
      allowedDispatches: [
        {
          mode: "target",
          alias: "gpt-5.6-terra",
          protocol: "openai-responses",
        },
        {
          mode: "legacy_comparator",
          alias: "deepseek-v4-pro",
          protocol: "openai-chat-completions",
        },
      ],
    },
    pricing: {
      snapshotId: "brand-profile-prices/2026-07-28-v1",
      snapshotSha256:
        "2222222222222222222222222222222222222222222222222222222222222222",
      basis: "frozen_unit_price_snapshot",
      defaultOrUnconfiguredRatioAllowed: false,
      resolverId: "brand-profile-settlement/v1",
      entries: [
        {
          alias: "gpt-5.6-terra",
          protocol: "openai-responses",
          inputCentsPerMillionTokens: 100,
          outputCentsPerMillionTokens: 600,
        },
        {
          alias: "deepseek-v4-pro",
          protocol: "openai-chat-completions",
          inputCentsPerMillionTokens: 50,
          outputCentsPerMillionTokens: 100,
        },
      ],
    },
    limits: {
      campaignBudgetCents: 1_000,
      maxDispatchExecutions: 37,
      maxWireCalls: 74,
      maxPromptUtf8BytesPerCall: 65_536,
      maxOutputTokensPerCall: 12_000,
    },
    settlement: {
      requestIdentityField: "executionId",
      requireVerifiedRequestSettlement: true,
      unknownSettlementPolicy: "freeze_campaign",
    },
    media: {
      genericChannelTest: "forbidden",
      allowedDispatches: [],
    },
  };
}

type UnsafeCostSafetyInput = {
  credential: { quotaMode: string };
  pricing: { defaultOrUnconfiguredRatioAllowed: boolean };
  settlement: {
    requestIdentityField: string;
    unknownSettlementPolicy: string;
  };
  media: { genericChannelTest: string };
};

const invalidAttestationMutations: readonly [
  string,
  (input: UnsafeCostSafetyInput) => void,
][] = [
  [
    "unlimited quota",
    (input) => {
      input.credential.quotaMode = "unlimited";
    },
  ],
  [
    "default or unconfigured ratio",
    (input) => {
      input.pricing.defaultOrUnconfiguredRatioAllowed = true;
    },
  ],
  [
    "missing request identity",
    (input) => {
      input.settlement.requestIdentityField = "none";
    },
  ],
  [
    "non-freezing unknown settlement",
    (input) => {
      input.settlement.unknownSettlementPolicy = "continue";
    },
  ],
  [
    "generic media test",
    (input) => {
      input.media.genericChannelTest = "allowed";
    },
  ],
];

describe("model evaluation cost safety contract", () => {
  it("brands and deeply freezes a finite, exact, explicitly priced scope", () => {
    const input = validInput();
    const attestation = createModelEvaluationCostSafetyAttestation(input);

    input.credential.allowedDispatches[0]!.alias = "changed-after-branding";
    expect(attestation.credential.allowedDispatches[0]!.alias).toBe(
      "gpt-5.6-terra",
    );
    expect(isTrustedModelEvaluationCostSafetyAttestation(attestation)).toBe(
      true,
    );
    expect(Object.isFrozen(attestation)).toBe(true);
    expect(Object.isFrozen(attestation.credential.allowedDispatches)).toBe(
      true,
    );
  });

  it("uses captured freeze intrinsics before branding an attestation", () => {
    const freeze = vi
      .spyOn(Object, "freeze")
      .mockImplementation((value) => value);
    const isFrozen = vi.spyOn(Object, "isFrozen").mockReturnValue(false);
    const values = vi.spyOn(Object, "values").mockReturnValue([]);
    let attestation;
    try {
      attestation = createModelEvaluationCostSafetyAttestation(validInput());
    } finally {
      freeze.mockRestore();
      isFrozen.mockRestore();
      values.mockRestore();
    }

    expect(isTrustedModelEvaluationCostSafetyAttestation(attestation)).toBe(
      true,
    );
    expect(Object.isFrozen(attestation)).toBe(true);
    expect(Object.isFrozen(attestation.limits)).toBe(true);
    expect(Object.isFrozen(attestation.pricing.entries)).toBe(true);
  });

  it.each(invalidAttestationMutations)(
    "rejects %s before an attestation can be trusted",
    (_label, mutate) => {
      const input = validInput() as unknown as UnsafeCostSafetyInput;
      mutate(input);
      expect(() =>
        createModelEvaluationCostSafetyAttestation(
          input as unknown as ModelEvaluationCostSafetyInput,
        ),
      ).toThrow("model evaluation cost safety attestation is invalid");
    },
  );

  it("rejects a missing bearer secret digest", () => {
    const input = validInput();
    delete (input.credential as { bearerTokenSha256?: string })
      .bearerTokenSha256;
    expect(() => createModelEvaluationCostSafetyAttestation(input)).toThrow(
      "attestation is invalid",
    );
  });

  it("rejects a non-canonical or non-HTTPS gateway origin", () => {
    const input = validInput();
    input.credential.gatewayOrigin = "http://new-api.example.invalid/";
    expect(() => createModelEvaluationCostSafetyAttestation(input)).toThrow(
      "attestation is invalid",
    );
  });

  it("requires pricing to cover the credential scope exactly", () => {
    const input = validInput();
    input.pricing.entries = input.pricing.entries.slice(0, 1);
    expect(() => createModelEvaluationCostSafetyAttestation(input)).toThrow(
      "frozen pricing must cover the credential dispatch scope exactly",
    );
  });

  it("enforces repository absolute stops and rejects undeclared fields", () => {
    const oversized = validInput();
    oversized.credential.quotaCapCents = 25_001;
    oversized.credential.remainingQuotaCents = 25_001;
    expect(() => createModelEvaluationCostSafetyAttestation(oversized)).toThrow(
      "model evaluation cost safety attestation is invalid",
    );

    const extraField = validInput() as ModelEvaluationCostSafetyInput & {
      unlimitedQuota: boolean;
    };
    extraField.unlimitedQuota = true;
    expect(() =>
      createModelEvaluationCostSafetyAttestation(extraField),
    ).toThrow("model evaluation cost safety attestation is invalid");
  });

  it("binds explicit spend authorization to the exact campaign limits", () => {
    const budgetDrift = validInput();
    budgetDrift.authorization.approvedCampaignBudgetCents = 999;
    expect(() =>
      createModelEvaluationCostSafetyAttestation(budgetDrift),
    ).toThrow("model evaluation cost safety attestation is invalid");

    const callDrift = validInput();
    callDrift.authorization.approvedDispatchExecutions = 36;
    expect(() => createModelEvaluationCostSafetyAttestation(callDrift)).toThrow(
      "model evaluation cost safety attestation is invalid",
    );
  });

  it("keeps Chat out of target dispatch and non-Chat out of legacy comparison", () => {
    const targetChat = validInput();
    targetChat.credential.allowedDispatches[0] = {
      mode: "target",
      alias: "deepseek-v4-pro",
      protocol: "openai-chat-completions",
    };
    expect(() =>
      createModelEvaluationCostSafetyAttestation(targetChat),
    ).toThrow("legacy Chat cannot be admitted as a target dispatch");

    const legacyResponses = validInput();
    legacyResponses.credential.allowedDispatches[1] = {
      mode: "legacy_comparator",
      alias: "deepseek-v4-pro",
      protocol: "openai-responses",
    };
    expect(() =>
      createModelEvaluationCostSafetyAttestation(legacyResponses),
    ).toThrow("legacy comparator must use isolated Chat Completions");

    const unknownProtocol = validInput();
    unknownProtocol.credential.allowedDispatches[0]!.protocol =
      "unknown-protocol" as "openai-responses";
    expect(() =>
      createModelEvaluationCostSafetyAttestation(unknownProtocol),
    ).toThrow("credential dispatch scope is invalid");
  });

  it("rejects alias, prompt, output, and wire-call cap drift", () => {
    const attestation =
      createModelEvaluationCostSafetyAttestation(validInput());
    const canonical = {
      mode: "target" as const,
      alias: "gpt-5.6-terra",
      protocol: "openai-responses" as const,
      maxOutputTokens: 12_000,
      promptUtf8Bytes: 20_000,
      maximumWireCalls: 2,
      perCallCostCapCents: 40,
    };
    expect(() =>
      assertModelEvaluationCostSafetyDispatch(attestation, canonical),
    ).not.toThrow();
    for (const drift of [
      { ...canonical, alias: "gpt-5.6-sol" },
      { ...canonical, maxOutputTokens: 12_001 },
      { ...canonical, promptUtf8Bytes: 65_537 },
      { ...canonical, maximumWireCalls: 0 },
      { ...canonical, perCallCostCapCents: 0 },
    ]) {
      expect(() =>
        assertModelEvaluationCostSafetyDispatch(attestation, drift),
      ).toThrow("model evaluation dispatch exceeds cost safety scope");
    }
  });

  it("rejects a frozen price whose worst-case request can exceed the hard budget", () => {
    const input = validInput();
    input.pricing.entries[0]!.outputCentsPerMillionTokens = 1_000_000;
    const attestation = createModelEvaluationCostSafetyAttestation(input);

    expect(() =>
      assertModelEvaluationCostSafetyDispatch(attestation, {
        mode: "target",
        alias: "gpt-5.6-terra",
        protocol: "openai-responses",
        maxOutputTokens: 12_000,
        promptUtf8Bytes: 1_000,
        maximumWireCalls: 1,
        perCallCostCapCents: 1_000,
      }),
    ).toThrow("model evaluation dispatch exceeds priced cost safety");
  });
});
