import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelPolicyRegistry } from "../agents/model-policy.registry";
import { buildTaskEvaluationPlan } from "./model-evaluation-harness";
import {
  SITE_BUILDER_MODEL_EVALUATION_COST_SAFETY_ID,
  createModelEvaluationCostSafetyAttestation,
  type ModelEvaluationCostSafetyAttestation,
} from "./model-evaluation-cost-safety";
import {
  createCredentialBoundModelEvaluationWireClient,
  createFileBackedModelEvaluationAuthorizationLedger,
  modelEvaluationLedgerDirectorySha256,
  type ModelEvaluationAuthorizationLedger,
  type ModelEvaluationWireClient,
  type ModelEvaluationWireResponse,
} from "./model-evaluation-executor";

let fakeAttestationSequence = 0;
const fakeLedgerRoot = mkdtempSync(
  join(tmpdir(), "site-builder-model-evaluation-ledger-"),
);
process.once("exit", () => {
  rmSync(fakeLedgerRoot, { recursive: true, force: true });
});

export function createFakeModelEvaluationCostSafety(
  resolverId: string,
  campaignBudgetCents = 10_000,
  ledgerOverride?: Readonly<{ ledgerId: string; directory: string }>,
) {
  fakeAttestationSequence += 1;
  const suffix = fakeAttestationSequence.toString().padStart(4, "0");
  const ledgerId =
    ledgerOverride?.ledgerId ?? `fake-durable-evaluation-ledger/${suffix}`;
  const ledgerDirectory =
    ledgerOverride?.directory ?? join(fakeLedgerRoot, suffix);
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
      authorizationId: `fake-evaluation-approval/2026-07-28-${suffix}`,
      ledgerId,
      ledgerDirectorySha256:
        modelEvaluationLedgerDirectorySha256(ledgerDirectory),
      approvedAt: "2026-07-28T00:00:00.000Z",
      approvedCampaignBudgetCents: campaignBudgetCents,
      approvedDispatchExecutions: 500,
    },
    credential: {
      attestationId: `fake-evaluation-credential/2026-07-28-${suffix}`,
      observedAt: "2026-07-28T00:00:00.000Z",
      snapshotSha256:
        "1111111111111111111111111111111111111111111111111111111111111111",
      bearerTokenSha256: createHash("sha256")
        .update("fake-limited-evaluation-token")
        .digest("hex"),
      gatewayOrigin: "https://fake-model-evaluation.invalid",
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

export function bindFakeModelEvaluationWireCredential<T extends object>(
  wireClient: T,
  costSafety: ModelEvaluationCostSafetyAttestation,
): T {
  const receiver = wireClient as ModelEvaluationWireClient;
  const openAIResponses = receiver.openAIResponses.bind(receiver);
  const anthropicMessages = receiver.anthropicMessages.bind(receiver);
  const openAIChatCompletions = receiver.openAIChatCompletions.bind(receiver);
  const fakeFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const headers = new Headers(init?.headers);
    if (
      headers.get("authorization") !== "Bearer fake-limited-evaluation-token"
    ) {
      return new Response("unauthorized", { status: 401 });
    }
    const executionId = headers.get("x-site-builder-evaluation-execution-id");
    if (!executionId || typeof init?.body !== "string") {
      return new Response("invalid fake request", { status: 400 });
    }
    const request = {
      executionId,
      body: JSON.parse(init.body) as never,
      signal: init.signal as AbortSignal,
    };
    let response: ModelEvaluationWireResponse;
    if (url.pathname.endsWith("/responses")) {
      response = await openAIResponses(request);
    } else if (url.pathname.endsWith("/messages")) {
      response = await anthropicMessages(request);
    } else if (url.pathname.endsWith("/chat/completions")) {
      response = await openAIChatCompletions(request);
    } else {
      return new Response("unexpected fake protocol", { status: 404 });
    }
    const responseIsRecord =
      typeof response === "object" && response !== null && "body" in response;
    const responseBody = responseIsRecord ? response.body : response;
    const providerReportedCostCents = responseIsRecord
      ? response.providerReportedCostCents
      : undefined;
    return new Response(JSON.stringify(responseBody ?? null), {
      status: 200,
      headers:
        providerReportedCostCents === undefined
          ? undefined
          : {
              "x-provider-cost-cents": String(providerReportedCostCents),
            },
    });
  };
  return createCredentialBoundModelEvaluationWireClient({
    credential: {
      attestationId: costSafety.credential.attestationId,
      snapshotSha256: costSafety.credential.snapshotSha256,
      bearerTokenSha256: costSafety.credential.bearerTokenSha256,
      gatewayOrigin: costSafety.credential.gatewayOrigin,
      bearerToken: "fake-limited-evaluation-token",
    },
    baseUrl: "https://fake-model-evaluation.invalid/v1",
    fetch: fakeFetch as typeof fetch,
  }) as T;
}

export function createFakeModelEvaluationAuthorizationLedger(
  costSafety: ModelEvaluationCostSafetyAttestation,
): ModelEvaluationAuthorizationLedger {
  const suffix = costSafety.authorization.authorizationId.split("-").at(-1);
  if (!suffix) throw new Error("fake authorization suffix is required");
  return createFileBackedModelEvaluationAuthorizationLedger({
    ledgerId: costSafety.authorization.ledgerId,
    directory: join(fakeLedgerRoot, suffix),
  });
}
