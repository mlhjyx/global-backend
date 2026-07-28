import { modelPolicyRegistry } from "../agents/model-policy.registry";
import { buildTaskEvaluationPlan } from "./model-evaluation-harness";
import {
  SITE_BUILDER_MODEL_EVALUATION_COST_SAFETY_ID,
  createModelEvaluationCostSafetyAttestation,
} from "./model-evaluation-cost-safety";

export function createFakeModelEvaluationCostSafety(
  resolverId: string,
  campaignBudgetCents = 10_000,
) {
  const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
  const legacy = modelPolicyRegistry.getLegacyTaskPolicy(plan.taskId).route;
  const allowedDispatches = [
    ...plan.candidates.map((candidate) => ({
      mode: "target" as const,
      alias: candidate.alias,
      protocol: candidate.expectedProtocol,
    })),
    ...[legacy.primary, ...legacy.fallbacks].map((alias) => ({
      mode: "legacy_comparator" as const,
      alias,
      protocol: "openai-chat-completions" as const,
    })),
  ];
  const prices = new Map(
    allowedDispatches.map((entry) => [
      `${entry.alias}:${entry.protocol}`,
      {
        alias: entry.alias,
        protocol: entry.protocol,
        inputCentsPerMillionTokens: 100,
        outputCentsPerMillionTokens: 200,
      },
    ]),
  );
  return createModelEvaluationCostSafetyAttestation({
    contractId: SITE_BUILDER_MODEL_EVALUATION_COST_SAFETY_ID,
    authorization: {
      authorizationId: "fake-evaluation-approval/2026-07-28-v1",
      approvedAt: "2026-07-28T00:00:00.000Z",
      approvedCampaignBudgetCents: campaignBudgetCents,
      approvedDispatchExecutions: 500,
    },
    credential: {
      attestationId: "fake-evaluation-credential/2026-07-28-v1",
      observedAt: "2026-07-28T00:00:00.000Z",
      snapshotSha256:
        "1111111111111111111111111111111111111111111111111111111111111111",
      purpose: "site_builder_model_evaluation",
      quotaMode: "limited",
      scopeExact: true,
      quotaCapCents: campaignBudgetCents,
      remainingQuotaCents: campaignBudgetCents,
      allowedDispatches,
    },
    pricing: {
      snapshotId: "fake-evaluation-prices/2026-07-28-v1",
      snapshotSha256:
        "2222222222222222222222222222222222222222222222222222222222222222",
      basis: "frozen_unit_price_snapshot",
      defaultOrUnconfiguredRatioAllowed: false,
      resolverId,
      entries: [...prices.values()],
    },
    limits: {
      campaignBudgetCents,
      maxDispatchExecutions: 500,
      maxWireCalls: 1_000,
      maxPromptUtf8BytesPerCall: 1_048_576,
      maxOutputTokensPerCall: 100_000,
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
  });
}
