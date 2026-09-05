import { describe, expect, it, vi } from "vitest";
import { RouterModelGateway } from "../model-gateway/router-model-gateway";
import type { ModelProvider } from "../model-gateway/model-provider";
import type { ModelRouter } from "../model-gateway/model-router";
import type { ModelResult } from "../model-gateway/types";
import { ProviderOutputError } from "../model-gateway/providers/provider-output-error";
import { createProviderTransportObservation } from "../model-gateway/provider-transport-observation";
import { parseSettlementDerivationKeyring } from "../model-gateway/settlement-wire-identity";
import { ToolBroker } from "../tools/tool-broker";
import { ToolRegistry } from "../tools/tool-registry";
import { RateLimiter } from "../tools/rate-limiter";
import type { Tool, ToolResult } from "../tools/tool-contract";
import {
  PaidCallDeniedError,
  PaidOperationUnknownError,
} from "./site-build-cost-ledger";
import { createSiteBuildCostReconciliationCatalogFromEnv } from "./site-build-cost-reconciliation-resolver";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SITE_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const ATTEMPT_ID = "44444444-4444-4444-8444-444444444444";
const FENCE = "55555555-5555-4555-8555-555555555555";
const SETTLEMENT_PREFLIGHT = {
  schemaVersion: "site-builder-paid-model-preflight-evidence/v2" as const,
  attestationId: "site-builder-runtime-test",
  snapshotSha256: "a".repeat(64),
  resolverId: "new-api-request-bound-reconciliation-v1",
  taskId: "site_builder.brand_profile",
  alias: "gpt-5.6-terra",
  protocol: "openai-responses" as const,
  expectedChannelId: 7,
  pricingAuthority: "openox_model_marketplace" as const,
  pricingSourceUrl: "https://openox.tech/api/public/pricing-catalog",
  pricingSnapshotSha256: "b".repeat(64),
  pricingCurrency: "CNY" as const,
  inputPriceMicrounitsPerMillionTokens: 2_000_000,
  outputPriceMicrounitsPerMillionTokens: 10_000_000,
  ledgerMicrousdPerPricingUnit: 1_000_000,
  gatewayCredentialQuotaCapPoints: 5_000_000,
  gatewayCredentialRemainingPoints: 4_500_000,
  maxOutputTokensPerCall: 1_000,
  pricedMaximumMicrousd: 50_000,
};

function settledUsage(
  usage: ModelResult<unknown>["usage"],
  physicalWireAttempt: 1 | 2 = 1,
): ModelResult<unknown>["usage"] {
  return {
    ...usage,
    gatewaySettlements: [
      {
        status: "settled",
        physicalWireAttempt,
        resolverId: SETTLEMENT_PREFLIGHT.resolverId,
        alias: SETTLEMENT_PREFLIGHT.alias,
        protocol: SETTLEMENT_PREFLIGHT.protocol,
        channelId: SETTLEMENT_PREFLIGHT.expectedChannelId,
        basis: "openox_catalog_token_pricing",
        quota: 500,
        costMicrousd: 1_000,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        upstreamIdState: "observed",
        transportObservation: createProviderTransportObservation({
          physicalWireAttempt,
          finalPhase: "gateway_request_id_observed",
          gatewayIdState: "observed",
          upstreamIdState: "observed",
          payloadState: "available",
          readbackProbes: [],
        }),
      },
    ],
  };
}

function provider(
  implementation: () => Promise<ModelResult<unknown>>,
): ModelProvider {
  return {
    id: "gateway",
    preflightPaidCall: vi.fn(async () => SETTLEMENT_PREFLIGHT),
    generateText: vi.fn(async (_input, ctx) => {
      const result = await implementation();
      return {
        ...result,
        usage: settledUsage(
          result.usage,
          ctx.paidCost?.settlementPhysicalWire?.identity.physicalWireAttempt ??
            1,
        ),
      };
    }),
    generateStructured: vi.fn(async (_input, ctx) => {
      const result = await implementation();
      return {
        ...result,
        usage: settledUsage(
          result.usage,
          ctx.paidCost?.settlementPhysicalWire?.identity.physicalWireAttempt ??
            1,
        ),
      };
    }),
    embed: vi.fn(async () => {
      const result = await implementation();
      return { ...result, usage: settledUsage(result.usage) };
    }),
    health: vi.fn(async () => ({ healthy: true })),
  } as unknown as ModelProvider;
}

const paidModelContext = {
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  paidCost: {
    siteId: SITE_ID,
    scopeKey: `${ATTEMPT_ID}:fallback-0`,
    taskAttemptId: ATTEMPT_ID,
    fenceToken: FENCE,
  },
};

const TEST_SETTLEMENT_KEYRING = parseSettlementDerivationKeyring(
  Buffer.from(
    `schema=site-build-settlement-derivation-keyring/v1\n` +
      `settlement-test ACTIVE ${"A".repeat(43)}\n`,
  ),
);
const DEFAULT_RECONCILIATION_CATALOG =
  createSiteBuildCostReconciliationCatalogFromEnv({
    SITE_BUILD_COST_RECONCILIATION_CATALOG_JSON: JSON.stringify({
      schemaVersion: "site-build-cost-reconciliation-catalog/v1",
      catalogId: "site-builder-product-pricing-test",
      resolverId: "new-api-request-bound-reconciliation-v1",
      pricingAuthority: "openox_model_marketplace",
      pricingSnapshotSha256: "f".repeat(64),
      pricingCurrency: "USD",
      ledgerMicrousdPerPricingUnit: 1_000_000,
      entries: [
        {
          providerId: "gateway",
          taskId: "site_builder.brand_profile",
          alias: "gpt-5.6-terra",
          protocol: "openai-responses",
          expectedChannelId: 7,
          maxOutputTokensPerCall: 4_000,
          gatewayCredentialQuotaCapPoints: 5_000_000,
          inputPriceMicrounitsPerMillionTokens: 2_000_000,
          outputPriceMicrounitsPerMillionTokens: 10_000_000,
        },
      ],
    }),
  });

function installSettlementV1(gateway: RouterModelGateway): void {
  const paidLedger = gateway.paidLedger as unknown as Record<string, unknown>;
  const legacyReserve = paidLedger.reserveOperation as (
    input: unknown,
  ) => Promise<{ kind: string; [key: string]: unknown }>;
  paidLedger.reserveModelOperation ??= async (input: unknown) => {
    const decision = await legacyReserve(input);
    return decision.kind === "execute"
      ? {
          kind: "execute",
          spendId: "66666666-6666-4666-8666-666666666666",
          wireAttemptId: "77777777-7777-4777-8777-777777777777",
          physicalWireAttempt: 1,
        }
      : decision;
  };
  paidLedger.allocateModelPhysicalWire ??= async () => ({
    kind: "execute",
    spendId: "66666666-6666-4666-8666-666666666666",
    wireAttemptId: "88888888-8888-4888-8888-888888888888",
    physicalWireAttempt: 2,
  });
  paidLedger.beginModelPhysicalWire ??= async () => "DISPATCH";
  paidLedger.claimModelReadbackProbe ??= async () => null;
  paidLedger.recordModelReadbackProbe ??= async () => undefined;
  paidLedger.recordModelPhysicalWireReceipt ??= async () => undefined;
  paidLedger.finalizeModelPhysicalWire ??= async () => undefined;
  paidLedger.finalizeModelPhysicalWireNotDispatched ??= async () => undefined;
  gateway.costReconciliationCatalog ??= DEFAULT_RECONCILIATION_CATALOG;
  gateway.settlementDerivationKeyring = TEST_SETTLEMENT_KEYRING;
  gateway.settlementReadbackResolver = { resolve: vi.fn() } as never;
}

describe("RouterModelGateway persistent paid-call gate", () => {
  it("uses the SaaS Grant ledger without requiring a per-call settlement attestation", async () => {
    const model = provider(async () => ({
      data: { ok: true },
      provider: "gateway",
      model: "gpt-5.6-terra",
    }));
    delete (model as Partial<ModelProvider>).preflightPaidCall;
    const reserveOperation = vi.fn(async () => ({ kind: "execute" as const }));
    const settleOperation = vi.fn(async () => "SETTLED");
    const gateway = new RouterModelGateway({
      route: () => [model],
    } as unknown as ModelRouter);
    gateway.paidLedger = {
      reserveOperation,
      settleOperation,
    } as never;
    installSettlementV1(gateway);

    await expect(
      gateway.generateStructured(
        {
          task: "site_builder.brand_profile",
          prompt: "p",
          schema: {},
          model: "gpt-5.6-terra",
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        paidModelContext,
      ),
    ).resolves.toMatchObject({ data: { ok: true } });
    expect(reserveOperation).toHaveBeenCalledOnce();
    expect(model.generateStructured).toHaveBeenCalledOnce();
    expect(settleOperation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "SUCCEEDED" }),
    );
  });

  it("returns a valid durable output when exact cost exceeds reservation and the ledger records CAP_VARIANCE", async () => {
    const model = provider(async () => ({
      data: { ok: true },
      provider: "gateway",
      model: "gpt-5.6-terra",
      usage: { costUsd: 9 },
    }));
    const disablePaidCalls = vi.fn();
    const gateway = new RouterModelGateway({
      route: () => [model],
    } as unknown as ModelRouter);
    gateway.paidLedger = {
      reserveOperation: vi.fn(async () => ({ kind: "execute" as const })),
      settleOperation: vi.fn(async () => "OVER_RESERVATION"),
      disablePaidCalls,
    } as never;
    installSettlementV1(gateway);

    await expect(
      gateway.generateStructured(
        {
          task: "site_builder.brand_profile",
          prompt: "p",
          schema: {},
          model: "gpt-5.6-terra",
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        paidModelContext,
      ),
    ).resolves.toMatchObject({ data: { ok: true } });
    expect(disablePaidCalls).not.toHaveBeenCalled();
  });

  it("keeps recovery identity in the dedicated wire row instead of Spend metadata", async () => {
    const model = provider(async () => ({
      data: { ok: true },
      provider: "gateway",
      model: "gpt-5.6-terra",
    }));
    const settleOperation = vi.fn(async () => "SETTLED");
    const gateway = new RouterModelGateway({
      route: () => [model],
    } as unknown as ModelRouter);
    gateway.paidLedger = {
      reserveOperation: vi.fn(async () => ({ kind: "execute" as const })),
      settleOperation,
    } as never;
    installSettlementV1(gateway);
    gateway.costReconciliationCatalog =
      createSiteBuildCostReconciliationCatalogFromEnv({
        SITE_BUILD_COST_RECONCILIATION_CATALOG_JSON: JSON.stringify({
          schemaVersion: "site-build-cost-reconciliation-catalog/v1",
          catalogId: "site-builder-product-pricing-2026-08-16",
          resolverId: "new-api-request-bound-reconciliation-v1",
          pricingAuthority: "openox_model_marketplace",
          pricingSnapshotSha256: "f".repeat(64),
          pricingCurrency: "USD",
          ledgerMicrousdPerPricingUnit: 1_000_000,
          entries: [
            {
              providerId: "gateway",
              taskId: "site_builder.brand_profile",
              alias: "gpt-5.6-terra",
              protocol: "openai-responses",
              expectedChannelId: 72,
              maxOutputTokensPerCall: 4_000,
              gatewayCredentialQuotaCapPoints: 2_000,
              inputPriceMicrounitsPerMillionTokens: 2_000_000,
              outputPriceMicrounitsPerMillionTokens: 10_000_000,
            },
          ],
        }),
      });

    await expect(
      gateway.generateStructured(
        {
          task: "site_builder.brand_profile",
          prompt: "p",
          schema: {},
          model: "gpt-5.6-terra",
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        paidModelContext,
      ),
    ).resolves.toMatchObject({ data: { ok: true } });

    const settlement = settleOperation.mock.calls[0]?.[0];
    const persistedMeta = {
      ...settlement.scope.meta,
      ...settlement.measurement.meta,
      ...settlement.meta,
    };
    expect(persistedMeta).not.toHaveProperty("settlementContext");
    expect(persistedMeta).not.toHaveProperty("settlementWireIdentities");
    expect(JSON.stringify(persistedMeta)).not.toContain("requestId");
  });

  it("denies the paid call before reservation when the catalog has no entry for the route", async () => {
    const model = provider(async () => ({
      data: { ok: true },
      provider: "gateway",
      model: "gpt-5.6-terra",
    }));
    const reserveOperation = vi.fn(async () => ({ kind: "execute" as const }));
    const gateway = new RouterModelGateway({
      route: () => [model],
    } as unknown as ModelRouter);
    gateway.paidLedger = {
      reserveOperation,
      settleOperation: vi.fn(async () => "SETTLED"),
    } as never;
    installSettlementV1(gateway);
    // 目录只登记 brand_profile；copy 任务无条目时必须 fail closed——
    // 否则 spend meta 缺 settlementContext，对账只能在 24h 后 EXPIRED。
    gateway.costReconciliationCatalog =
      createSiteBuildCostReconciliationCatalogFromEnv({
        SITE_BUILD_COST_RECONCILIATION_CATALOG_JSON: JSON.stringify({
          schemaVersion: "site-build-cost-reconciliation-catalog/v1",
          catalogId: "site-builder-product-pricing-2026-08-16",
          resolverId: "new-api-request-bound-reconciliation-v1",
          pricingAuthority: "openox_model_marketplace",
          pricingSnapshotSha256: "f".repeat(64),
          pricingCurrency: "USD",
          ledgerMicrousdPerPricingUnit: 1_000_000,
          entries: [
            {
              providerId: "gateway",
              taskId: "site_builder.brand_profile",
              alias: "gpt-5.6-terra",
              protocol: "openai-responses",
              expectedChannelId: 72,
              maxOutputTokensPerCall: 4_000,
              gatewayCredentialQuotaCapPoints: 2_000,
              inputPriceMicrounitsPerMillionTokens: 2_000_000,
              outputPriceMicrounitsPerMillionTokens: 10_000_000,
            },
          ],
        }),
      });

    await expect(
      gateway.generateStructured(
        {
          task: "site_builder.copy",
          prompt: "p",
          schema: {},
          model: "gpt-5.6-terra",
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        paidModelContext,
      ),
    ).rejects.toMatchObject({
      name: "PaidCallDeniedError",
      decision: "COST_RECONCILIATION_CONTEXT_UNAVAILABLE",
    });
    expect(reserveOperation).not.toHaveBeenCalled();
    expect(model.generateStructured).not.toHaveBeenCalled();
  });

  it("releases a reservation when suppression denies before the first paid wire", async () => {
    const model = provider(async () => ({
      data: { ok: true },
      provider: "gateway",
      model: "gpt-5.6-terra",
    }));
    const settleOperation = vi.fn(async () => "SETTLED");
    const disablePaidCalls = vi.fn(async () => undefined);
    const finalizeModelPhysicalWireNotDispatched = vi.fn(async () => undefined);
    const gateway = new RouterModelGateway({
      route: () => [model],
    } as unknown as ModelRouter);
    gateway.paidLedger = {
      reserveOperation: vi.fn(async () => ({ kind: "execute" as const })),
      settleOperation,
      disablePaidCalls,
      finalizeModelPhysicalWireNotDispatched,
    } as never;
    installSettlementV1(gateway);

    await expect(
      gateway.generateStructured(
        {
          task: "site_builder.brand_profile",
          prompt: "p",
          schema: {},
          model: "gpt-5.6-terra",
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        {
          ...paidModelContext,
          authorizeExternalAction: vi.fn(async () => false),
        },
      ),
    ).rejects.toMatchObject({
      name: "ExternalActionDeniedError",
      decision: "suppression_action_gate",
      callCount: 0,
    });

    expect(model.generateStructured).not.toHaveBeenCalled();
    expect(finalizeModelPhysicalWireNotDispatched).toHaveBeenCalledOnce();
    expect(
      finalizeModelPhysicalWireNotDispatched.mock.invocationCallOrder[0],
    ).toBeLessThan(settleOperation.mock.invocationCallOrder[0]!);
    expect(settleOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "RELEASED",
        errorCode: "SUPPRESSION_ACTION_GATE",
        measurement: expect.objectContaining({
          basis: "not_incurred",
          budgetChargeMicrousd: 0,
          callCount: 0,
        }),
      }),
    );
    expect(disablePaidCalls).not.toHaveBeenCalled();
  });

  it("settles the incurred first wire when suppression denies structured repair", async () => {
    const model = provider(async () => ({
      data: {},
      provider: "gateway",
      model: "gpt-5.6-terra",
      reportedModel: "gpt-5.6-terra",
      modelResolutionSource: "upstream_response",
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
    const settleOperation = vi.fn(async () => "SETTLED");
    const disablePaidCalls = vi.fn(async () => undefined);
    const authorizeExternalAction = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const gateway = new RouterModelGateway({
      route: () => [model],
    } as unknown as ModelRouter);
    gateway.paidLedger = {
      reserveOperation: vi.fn(async () => ({ kind: "execute" as const })),
      settleOperation,
      disablePaidCalls,
    } as never;
    installSettlementV1(gateway);

    await expect(
      gateway.generateStructured(
        {
          task: "site_builder.brand_profile",
          prompt: "p",
          schema: {
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
          },
          model: "gpt-5.6-terra",
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        { ...paidModelContext, authorizeExternalAction },
      ),
    ).rejects.toMatchObject({
      name: "ExternalActionDeniedError",
      callCount: 1,
    });

    expect(authorizeExternalAction).toHaveBeenCalledTimes(2);
    expect(model.generateStructured).toHaveBeenCalledOnce();
    expect(settleOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "FAILED",
        errorCode: "SUPPRESSION_ACTION_GATE",
        measurement: expect.objectContaining({
          basis: "token_pricing",
          budgetChargeMicrousd: 1_000,
          callCount: 1,
        }),
      }),
    );
    expect(disablePaidCalls).not.toHaveBeenCalled();
  });

  it("reserves before execution and settles request-bound gateway cost with provenance", async () => {
    const order: string[] = [];
    const model = provider(async () => {
      order.push("provider");
      return {
        data: { ok: true },
        provider: "gateway",
        model: "gpt-5.6-terra",
        reportedModel: "gpt-5.6-terra",
        modelResolutionSource: "upstream_response",
        usage: { inputTokens: 1_000, outputTokens: 500 },
      };
    });
    vi.mocked(model.preflightPaidCall!).mockImplementation(async () => {
      order.push("preflight");
      return SETTLEMENT_PREFLIGHT;
    });
    const paidLedger = {
      reserveOperation: vi.fn(async () => {
        order.push("reserve");
        return { kind: "execute" as const };
      }),
      settleOperation: vi.fn(async () => {
        order.push("settle");
        return "SETTLED";
      }),
    };
    const gateway = new RouterModelGateway({
      route: () => [model],
    } as unknown as ModelRouter);
    gateway.paidLedger = paidLedger as never;
    installSettlementV1(gateway);

    const result = await gateway.generateStructured(
      {
        task: "site_builder.brand_profile",
        prompt: "p",
        schema: {},
        model: "gpt-5.6-terra",
        maxCostCents: 40,
        maxTokens: 1_000,
      },
      paidModelContext,
    );

    expect(result.data).toEqual({ ok: true });
    expect(order).toEqual(["reserve", "provider", "settle"]);
    expect(model.preflightPaidCall).not.toHaveBeenCalled();
    expect(paidLedger.reserveOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        siteId: SITE_ID,
        buildRunId: RUN_ID,
        taskAttemptId: ATTEMPT_ID,
        fenceToken: FENCE,
        kind: "model",
        taskId: "site_builder.brand_profile",
        subject: "gpt-5.6-terra@gateway",
        // structured output may make one bounded repair call.
        reservationMicrousd: 800_000,
        operationKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(paidLedger.settleOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "SUCCEEDED",
        measurement: expect.objectContaining({
          basis: "token_pricing",
          reportedCostMicrousd: null,
          calculatedCostMicrousd: 1_000,
        }),
        meta: expect.objectContaining({
          provider: "gateway",
          requestedModel: "gpt-5.6-terra",
          resolvedModel: "gpt-5.6-terra",
          reportedModel: "gpt-5.6-terra",
          modelResolutionSource: "upstream_response",
        }),
      }),
    );
  });

  it("keeps the logical operation key stable without attestation state", async () => {
    const model = provider(async () => ({
      data: { ok: true },
      provider: "gateway",
      model: "gpt-5.6-terra",
      reportedModel: "gpt-5.6-terra",
      modelResolutionSource: "upstream_response",
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
    vi.mocked(model.preflightPaidCall!)
      .mockResolvedValueOnce(SETTLEMENT_PREFLIGHT)
      .mockResolvedValueOnce({
        ...SETTLEMENT_PREFLIGHT,
        attestationId: "site-builder-runtime-rotated-test",
        snapshotSha256: "c".repeat(64),
      });
    const paidLedger = {
      reserveOperation: vi.fn(async () => ({ kind: "execute" as const })),
      settleOperation: vi.fn(async () => "SETTLED"),
    };
    const gateway = new RouterModelGateway({
      route: () => [model],
    } as unknown as ModelRouter);
    gateway.paidLedger = paidLedger as never;
    installSettlementV1(gateway);
    const input = {
      task: "site_builder.brand_profile",
      prompt: "p",
      schema: {},
      model: "gpt-5.6-terra",
      maxCostCents: 40,
      maxTokens: 1_000,
    };

    await gateway.generateStructured(input, paidModelContext);
    await gateway.generateStructured(input, paidModelContext);

    const firstKey = paidLedger.reserveOperation.mock.calls[0]![0].operationKey;
    const secondKey =
      paidLedger.reserveOperation.mock.calls[1]![0].operationKey;
    expect(firstKey).toBe(secondKey);
    expect(model.preflightPaidCall).not.toHaveBeenCalled();
    expect(paidLedger.reserveOperation.mock.calls[1]![0].meta).toEqual({
      op: "generateStructured",
      provider: "gateway",
      requestedModel: "gpt-5.6-terra",
    });
  });

  it("passes task cancellation to the paid provider after reserving", async () => {
    const model = provider(async () => ({
      data: { ok: true },
      provider: "gateway",
      model: "gpt-5.6-terra",
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
    const controller = new AbortController();
    const gateway = new RouterModelGateway({
      route: () => [model],
    } as unknown as ModelRouter);
    gateway.paidLedger = {
      reserveOperation: vi.fn(async () => ({ kind: "execute" as const })),
      settleOperation: vi.fn(async () => "SETTLED"),
    } as never;
    installSettlementV1(gateway);

    await gateway.generateStructured(
      {
        task: "site_builder.brand_profile",
        prompt: "p",
        schema: {},
        model: "gpt-5.6-terra",
        maxCostCents: 40,
        maxTokens: 1_000,
        signal: controller.signal,
      },
      paidModelContext,
    );

    expect(model.preflightPaidCall).not.toHaveBeenCalled();
    expect(model.generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        paidCost: expect.objectContaining({
          siteId: SITE_ID,
          settlementPhysicalWire: expect.any(Object),
        }),
      }),
    );
  });

  it("suppresses structured repair when the first physical settlement is unknown", async () => {
    const model = provider(async () => ({
      data: { ok: true },
      provider: "gateway",
      model: "gpt-5.6-terra",
    }));
    vi.mocked(model.generateStructured).mockResolvedValue({
      data: {},
      provider: "gateway",
      model: "gpt-5.6-terra",
      reportedModel: "gpt-5.6-terra",
      modelResolutionSource: "upstream_response",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        gatewaySettlements: [
          {
            status: "unknown",
            physicalWireAttempt: 1,
            resolverId: SETTLEMENT_PREFLIGHT.resolverId,
            reason: "gateway_log_missing",
            transportObservation: createProviderTransportObservation({
              physicalWireAttempt: 1,
              finalPhase: "gateway_log_missing",
              gatewayIdState: "observed",
              upstreamIdState: "unknown",
              payloadState: "available",
              readbackProbes: [],
            }),
          },
        ],
      },
    });
    const settleOperation = vi.fn(async () => "SETTLED");
    const disablePaidCalls = vi.fn(async () => undefined);
    const gateway = new RouterModelGateway({
      route: () => [model],
    } as unknown as ModelRouter);
    gateway.paidLedger = {
      reserveOperation: vi.fn(async () => ({ kind: "execute" as const })),
      settleOperation,
      disablePaidCalls,
    } as never;
    installSettlementV1(gateway);

    await expect(
      gateway.generateStructured(
        {
          task: "site_builder.brand_profile",
          prompt: "p",
          schema: {
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
          },
          model: "gpt-5.6-terra",
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        paidModelContext,
      ),
    ).rejects.toBeInstanceOf(PaidOperationUnknownError);

    expect(model.generateStructured).toHaveBeenCalledOnce();
    expect(settleOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "UNKNOWN",
        measurement: expect.objectContaining({ basis: "unknown" }),
        disablePaidCallsReason: "MODEL_SETTLEMENT_GATEWAY_LOG_MISSING",
      }),
    );
    // Recovery identity lives only in the dedicated wire table. Spend metadata
    // retains the closed observation but never the raw request id or nonce.
    const settlement = settleOperation.mock.calls[0]?.[0];
    const persistedMeta = {
      ...settlement.scope.meta,
      ...settlement.measurement.meta,
      ...settlement.meta,
    };
    expect(persistedMeta.gatewaySettlements).toEqual([
      expect.objectContaining({
        status: "unknown",
        physicalWireAttempt: 1,
        resolverId: SETTLEMENT_PREFLIGHT.resolverId,
      }),
    ]);
    expect(JSON.stringify(persistedMeta)).not.toContain("requestId");
    expect(disablePaidCalls).not.toHaveBeenCalled();
  });

  it("skips a non-attested dev stub after a known settled provider failure", async () => {
    const knownFailure = new ProviderOutputError(
      "provider returned a schema-invalid result",
      settledUsage({ inputTokens: 10, outputTokens: 5 }),
      {
        callCount: 1,
        provider: "gateway",
        model: "gpt-5.6-terra",
        reportedModel: "gpt-5.6-terra",
        modelResolutionSource: "upstream_response",
      },
    );
    const model = provider(async () => {
      throw knownFailure;
    });
    const stub = {
      id: "stub",
      generateStructured: vi.fn(async () => ({
        data: { ok: true },
        provider: "stub",
        model: "stub",
      })),
    } as unknown as ModelProvider;
    const settleOperation = vi.fn(async () => "SETTLED");
    const gateway = new RouterModelGateway({
      route: () => [model, stub],
    } as unknown as ModelRouter);
    gateway.paidLedger = {
      reserveOperation: vi.fn(async () => ({ kind: "execute" as const })),
      settleOperation,
    } as never;
    installSettlementV1(gateway);

    await expect(
      gateway.generateStructured(
        {
          task: "site_builder.brand_profile",
          prompt: "p",
          schema: {},
          model: "gpt-5.6-terra",
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        paidModelContext,
      ),
    ).rejects.toBe(knownFailure);

    expect(stub.generateStructured).not.toHaveBeenCalled();
    expect(settleOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "FAILED",
        measurement: expect.objectContaining({ basis: "token_pricing" }),
      }),
    );
  });

  it("persists only the caller-approved durable model replay projection", async () => {
    const rawResult = {
      data: {
        valueProps: ["Contact Jane Doe at jane@example.com"],
      },
      provider: "gateway",
      model: "gpt-5.6-terra",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const model = provider(async () => rawResult);
    const durableReplayResult = vi.fn(() => ({
      data: { valueProps: ["[persistence-gated]"] },
      provider: "gateway",
      model: "gpt-5.6-terra",
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
    const settleOperation = vi.fn(async () => "SETTLED");
    const gateway = new RouterModelGateway({
      route: () => [model],
    } as unknown as ModelRouter);
    gateway.paidLedger = {
      reserveOperation: vi.fn(async () => ({ kind: "execute" as const })),
      settleOperation,
    } as never;
    installSettlementV1(gateway);

    await expect(
      gateway.generateStructured(
        {
          task: "site_builder.brand_profile",
          prompt: "p",
          schema: {},
          model: "gpt-5.6-terra",
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        {
          ...paidModelContext,
          paidCost: {
            ...paidModelContext.paidCost,
            durableReplayResult,
          },
        },
      ),
    ).resolves.toMatchObject(rawResult);

    expect(durableReplayResult).toHaveBeenCalledWith(
      expect.objectContaining({
        data: rawResult.data,
        provider: rawResult.provider,
        model: rawResult.model,
        usage: expect.objectContaining(rawResult.usage),
      }),
    );
    expect(settleOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "SUCCEEDED",
        result: expect.objectContaining({
          data: { valueProps: ["[persistence-gated]"] },
        }),
      }),
    );
    expect(JSON.stringify(settleOperation.mock.calls)).not.toContain(
      "jane@example.com",
    );
  });

  it("omits model replay payloads when the caller did not install a persistence gate", async () => {
    const rawResult = {
      data: { privateValue: "raw-provider-output" },
      provider: "gateway",
      model: "gpt-5.6-terra",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const settleOperation = vi.fn(async () => "SETTLED");
    const gateway = new RouterModelGateway({
      route: () => [provider(async () => rawResult)],
    } as unknown as ModelRouter);
    gateway.paidLedger = {
      reserveOperation: vi.fn(async () => ({ kind: "execute" as const })),
      settleOperation,
    } as never;
    installSettlementV1(gateway);

    await expect(
      gateway.generateStructured(
        {
          task: "site_builder.brand_profile",
          prompt: "p",
          schema: {},
          model: "gpt-5.6-terra",
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        paidModelContext,
      ),
    ).resolves.toMatchObject(rawResult);
    expect(settleOperation).toHaveBeenCalledWith(
      expect.objectContaining({ result: undefined }),
    );
    expect(JSON.stringify(settleOperation.mock.calls)).not.toContain(
      "raw-provider-output",
    );
  });

  it("fails closed when a settled paid model has no approved replay payload", async () => {
    const execute = vi.fn(async () => {
      throw new Error("must not execute");
    });
    const gateway = new RouterModelGateway({
      route: () => [provider(execute)],
    } as unknown as ModelRouter);
    gateway.paidLedger = {
      reserveOperation: vi.fn(async () => ({
        kind: "replay" as const,
        status: "SUCCEEDED",
        result: null,
        meta: null,
        errorCode: null,
      })),
      settleOperation: vi.fn(),
    } as never;
    installSettlementV1(gateway);

    const error = await gateway
      .generateStructured(
        {
          task: "site_builder.brand_profile",
          prompt: "p",
          schema: {},
          model: "gpt-5.6-terra",
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        paidModelContext,
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PaidOperationUnknownError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("records a rejected durable projection as a paid failure without retaining raw output", async () => {
    const rawResult = {
      data: { contact: "jane@example.com" },
      provider: "gateway",
      model: "gpt-5.6-terra",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const projectionError = new Error("persistence gate rejected PII");
    const settleOperation = vi.fn(async () => "SETTLED");
    const gateway = new RouterModelGateway({
      route: () => [provider(async () => rawResult)],
    } as unknown as ModelRouter);
    gateway.paidLedger = {
      reserveOperation: vi.fn(async () => ({ kind: "execute" as const })),
      settleOperation,
    } as never;
    installSettlementV1(gateway);

    await expect(
      gateway.generateStructured(
        {
          task: "site_builder.brand_profile",
          prompt: "p",
          schema: {},
          model: "gpt-5.6-terra",
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        {
          ...paidModelContext,
          paidCost: {
            ...paidModelContext.paidCost,
            durableReplayResult: () => {
              throw projectionError;
            },
          },
        },
      ),
    ).rejects.toBe(projectionError);
    expect(settleOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "FAILED",
        errorCode: "DURABLE_REPLAY_REJECTED",
      }),
    );
    expect(settleOperation.mock.calls[0]![0]).not.toHaveProperty("result");
    expect(JSON.stringify(settleOperation.mock.calls)).not.toContain(
      "jane@example.com",
    );
  });

  it("replays a cached provider result without calling or settling the provider again", async () => {
    const model = provider(async () => {
      throw new Error("must not execute");
    });
    const cached = {
      data: { cached: true },
      provider: "gateway",
      model: "gpt-5.6-terra",
      usage: { inputTokens: 2, outputTokens: 1 },
    };
    const paidLedger = {
      reserveOperation: vi.fn(async () => ({
        kind: "replay" as const,
        status: "SUCCEEDED",
        result: cached,
        meta: null,
        errorCode: null,
      })),
      settleOperation: vi.fn(),
    };
    const gateway = new RouterModelGateway({
      route: () => [model],
    } as unknown as ModelRouter);
    gateway.paidLedger = paidLedger as never;
    installSettlementV1(gateway);

    await expect(
      gateway.generateStructured(
        {
          task: "site_builder.brand_profile",
          prompt: "p",
          schema: {},
          model: "gpt-5.6-terra",
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        paidModelContext,
      ),
    ).resolves.toEqual(cached);
    expect(model.generateStructured).not.toHaveBeenCalled();
    expect(paidLedger.settleOperation).not.toHaveBeenCalled();
  });

  it("never calls a fallback provider after replaying a durable failed spend", async () => {
    const primary = provider(async () => {
      throw new Error("must not execute primary");
    });
    const fallback = provider(async () => {
      throw new Error("must not execute fallback");
    });
    fallback.id = "fallback";
    const reserveOperation = vi.fn(async () => ({
      kind: "replay" as const,
      status: "FAILED",
      result: null,
      meta: null,
      errorCode: "PROVIDER_OUTPUT_ERROR",
    }));
    const gateway = new RouterModelGateway({
      route: () => [primary, fallback],
    } as unknown as ModelRouter);
    gateway.paidLedger = {
      reserveOperation,
      settleOperation: vi.fn(),
      disablePaidCalls: vi.fn(),
    } as never;
    installSettlementV1(gateway);

    await expect(
      gateway.generateStructured(
        {
          task: "site_builder.brand_profile",
          prompt: "p",
          schema: {},
          model: "gpt-5.6-terra",
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        paidModelContext,
      ),
    ).rejects.toMatchObject({ errorCode: "PROVIDER_OUTPUT_ERROR" });
    expect(reserveOperation).toHaveBeenCalledOnce();
    expect(primary.generateStructured).not.toHaveBeenCalled();
    expect(fallback.generateStructured).not.toHaveBeenCalled();
  });

  it("fails closed when a paid context reaches a worker without the persistent ledger", async () => {
    const model = provider(async () => ({
      data: { ok: true },
      provider: "gateway",
      model: "gpt-5.6-terra",
    }));
    const gateway = new RouterModelGateway({
      route: () => [model],
    } as unknown as ModelRouter);

    await expect(
      gateway.generateStructured(
        {
          task: "site_builder.brand_profile",
          prompt: "p",
          schema: {},
          model: "gpt-5.6-terra",
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        paidModelContext,
      ),
    ).rejects.toBeInstanceOf(PaidCallDeniedError);
    expect(model.generateStructured).not.toHaveBeenCalled();
  });

  it("turns a success-settlement ACK loss into a non-fallback paid-operation error", async () => {
    const execute = vi.fn(async () => ({
      data: { ok: true },
      provider: "gateway",
      model: "gpt-5.6-terra",
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
    const model = provider(execute);
    const disablePaidCalls = vi.fn(async () => undefined);
    const gateway = new RouterModelGateway({
      route: () => [model],
    } as unknown as ModelRouter);
    gateway.paidLedger = {
      reserveOperation: vi.fn(async () => ({ kind: "execute" as const })),
      settleOperation: vi.fn(async () => {
        throw new Error("database response lost");
      }),
      disablePaidCalls,
    } as never;
    installSettlementV1(gateway);

    await expect(
      gateway.generateStructured(
        {
          task: "site_builder.brand_profile",
          prompt: "p",
          schema: {},
          model: "gpt-5.6-terra",
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        paidModelContext,
      ),
    ).rejects.toBeInstanceOf(PaidOperationUnknownError);
    expect(execute).toHaveBeenCalledOnce();
    expect(disablePaidCalls).toHaveBeenCalledWith(
      WORKSPACE_ID,
      RUN_ID,
      "MODEL_SETTLEMENT_DATABASE_ACK_UNKNOWN",
    );
  });

  it("freezes the BuildRun when settlement returns a non-SETTLED decision", async () => {
    const model = provider(async () => ({
      data: { ok: true },
      provider: "gateway",
      model: "gpt-5.6-terra",
      reportedModel: "gpt-5.6-terra",
      modelResolutionSource: "upstream_response",
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
    const disablePaidCalls = vi.fn(async () => undefined);
    const gateway = new RouterModelGateway({
      route: () => [model],
    } as unknown as ModelRouter);
    gateway.paidLedger = {
      reserveOperation: vi.fn(async () => ({ kind: "execute" as const })),
      settleOperation: vi.fn(async () => "STALE_FENCE"),
      disablePaidCalls,
    } as never;
    installSettlementV1(gateway);

    const error = await gateway
      .generateStructured(
        {
          task: "site_builder.brand_profile",
          prompt: "p",
          schema: {},
          model: "gpt-5.6-terra",
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        paidModelContext,
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PaidOperationUnknownError);
    expect((error as PaidOperationUnknownError).errorCode).toBe(
      "SETTLEMENT_STALE_FENCE",
    );
    expect(disablePaidCalls).toHaveBeenCalledWith(
      WORKSPACE_ID,
      RUN_ID,
      "SETTLEMENT_STALE_FENCE",
    );
  });

  it("keeps a valid output and charges its reservation while exact cost is pending", async () => {
    const model = provider(async () => ({
      data: { ok: true },
      provider: "gateway",
      model: "gpt-5.6-terra",
    }));
    vi.mocked(model.generateStructured).mockResolvedValue({
      data: { ok: true },
      provider: "gateway",
      model: "gpt-5.6-terra",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        gatewaySettlements: [
          {
            status: "unknown",
            requestId: "req_unknown_001",
            resolverId: SETTLEMENT_PREFLIGHT.resolverId,
            reason: "log_unavailable",
          },
        ],
      },
    });
    const settleOperation = vi.fn(async () => "SETTLED");
    const disablePaidCalls = vi.fn(async () => undefined);
    const gateway = new RouterModelGateway({
      route: () => [model],
    } as unknown as ModelRouter);
    gateway.paidLedger = {
      reserveOperation: vi.fn(async () => ({ kind: "execute" as const })),
      settleOperation,
      disablePaidCalls,
    } as never;
    installSettlementV1(gateway);

    await expect(
      gateway.generateStructured(
        {
          task: "site_builder.brand_profile",
          prompt: "p",
          schema: {},
          model: "gpt-5.6-terra",
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        paidModelContext,
      ),
    ).resolves.toMatchObject({ data: { ok: true } });
    expect(settleOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "SUCCEEDED",
        measurement: expect.objectContaining({
          basis: "estimated_upper_bound",
          budgetChargeMicrousd: 800_000,
        }),
      }),
    );
    expect(disablePaidCalls).not.toHaveBeenCalled();
  });
});

function paidTool(execute: () => Promise<unknown>): Tool {
  return {
    id: "crawl4ai.fetch",
    version: "1.0.0",
    category: "fetch",
    cost: { unit: "call", estimatedCents: 3, external: true },
    rateLimit: { rps: 100, concurrency: 2 },
    compliance: {
      sourcePolicy: "none",
      respectsRobots: true,
      personalData: false,
      allowedPurpose: ["site_builder"],
      reversible: true,
      authRequired: false,
      risk: "low",
    },
    capabilities: { produces: ["domain"], accepts: ["domain"] },
    idempotencyKey: () => "crawl-key",
    durableResultStrategy: {
      kind: "artifact_reference",
      schema: "crawl4ai-fetch/v1",
      maxBytes: 1_000,
      mediaTypes: ["text/markdown"],
      privacyClass: "PERSONAL_DATA",
      ttlSeconds: 86_400,
    },
    durableReplayResult: (result: ToolResult<{ text: string }>) => ({
      ...result,
      data: { text: "[scrubbed-replay]" },
    }),
    healthCheck: async () => ({ healthy: true }),
    execute: async () => ({ data: await execute(), costCents: 2 }),
  } as Tool;
}

const paidToolContext = {
  workspaceId: WORKSPACE_ID,
  siteId: SITE_ID,
  runId: RUN_ID,
  taskContractId: "site_builder.brand_profile",
  paidCost: {
    scopeKey: ATTEMPT_ID,
    taskAttemptId: ATTEMPT_ID,
    fenceToken: FENCE,
  },
};

describe("ToolBroker persistent paid-call gate", () => {
  it("uses the tool idempotency key for durable reserve and labels legacy cents as estimate", async () => {
    const order: string[] = [];
    const tool = paidTool(async () => {
      order.push("tool");
      return { text: "ok" };
    });
    const registry = new ToolRegistry();
    registry.register(tool);
    const paidLedger = {
      reserveOperation: vi.fn(async () => {
        order.push("reserve");
        return { kind: "execute" as const };
      }),
      settleOperation: vi.fn(async () => {
        order.push("settle");
        return "SETTLED";
      }),
    };
    const broker = new ToolBroker({
      registry,
      limiter: new RateLimiter(),
      paidLedger: paidLedger as never,
    });

    await expect(
      broker.invoke(
        "crawl4ai.fetch",
        { url: "https://example.com" },
        paidToolContext,
      ),
    ).resolves.toMatchObject({ data: { text: "ok" }, costCents: 2 });
    expect(order).toEqual(["reserve", "tool", "settle"]);
    expect(paidLedger.reserveOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKey: expect.stringMatching(/^[0-9a-f]{64}$/),
        subject: "crawl4ai.fetch@1.0.0",
        reservationMicrousd: 30_000,
      }),
    );
    expect(paidLedger.settleOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "SUCCEEDED",
        result: {
          data: { text: "[scrubbed-replay]" },
          costCents: 2,
        },
        measurement: expect.objectContaining({
          basis: "legacy_estimate",
          estimatedCostMicrousd: 20_000,
        }),
      }),
    );
  });

  it("returns a cached ToolResult without executing or settling again", async () => {
    const execute = vi.fn(async () => ({ text: "new" }));
    const registry = new ToolRegistry();
    registry.register(paidTool(execute));
    const paidLedger = {
      reserveOperation: vi.fn(async () => ({
        kind: "replay" as const,
        status: "SUCCEEDED",
        result: { data: { text: "cached" }, costCents: 2 },
        meta: null,
        errorCode: null,
      })),
      settleOperation: vi.fn(),
    };
    const broker = new ToolBroker({
      registry,
      limiter: new RateLimiter(),
      paidLedger: paidLedger as never,
    });

    await expect(
      broker.invoke(
        "crawl4ai.fetch",
        { url: "https://example.com" },
        paidToolContext,
      ),
    ).resolves.toEqual({
      data: { text: "[scrubbed-replay]" },
      costCents: 2,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(paidLedger.settleOperation).not.toHaveBeenCalled();
  });

  it("turns a success-settlement ACK loss into a paid-operation unknown error", async () => {
    const execute = vi.fn(async () => ({ text: "executed-once" }));
    const registry = new ToolRegistry();
    registry.register(paidTool(execute));
    const broker = new ToolBroker({
      registry,
      limiter: new RateLimiter(),
      paidLedger: {
        reserveOperation: vi.fn(async () => ({ kind: "execute" as const })),
        settleOperation: vi.fn(async () => {
          throw new Error("database response lost");
        }),
      } as never,
    });

    await expect(
      broker.invoke(
        "crawl4ai.fetch",
        { url: "https://example.com" },
        paidToolContext,
      ),
    ).rejects.toBeInstanceOf(PaidOperationUnknownError);
    expect(execute).toHaveBeenCalledOnce();
  });
});
