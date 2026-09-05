import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "./model-provider";
import type { ModelRouter } from "./model-router";
import {
  NEW_API_REQUEST_BOUND_RESOLVER_ID,
  type NewApiRequestBoundSettlement,
} from "./new-api-request-bound-settlement";
import { RouterModelGateway } from "./router-model-gateway";
import { parseSettlementDerivationKeyring } from "./settlement-wire-identity";
import {
  PaidOperationUnknownError,
  type SiteBuildCostLedger,
} from "../site-builder/site-build-cost-ledger";
import { createSiteBuildCostReconciliationCatalogFromEnv } from "../site-builder/site-build-cost-reconciliation-resolver";
import {
  ProviderSettlementError,
  ProviderWireInFlightError,
} from "./providers/provider-output-error";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.provider";
import type { AiTraceSink } from "./ai-trace.sink";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SITE_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const ATTEMPT_ID = "44444444-4444-4444-8444-444444444444";
const FENCE = "55555555-5555-4555-8555-555555555555";
const WIRE_ID_1 = "66666666-6666-4666-8666-666666666666";
const WIRE_ID_2 = "77777777-7777-4777-8777-777777777777";

const CATALOG = JSON.stringify({
  schemaVersion: "site-build-cost-reconciliation-catalog/v1",
  catalogId: "site-builder-product-pricing-test",
  resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
  pricingAuthority: "openox_model_marketplace",
  pricingSnapshotSha256: "b".repeat(64),
  pricingCurrency: "USD",
  ledgerMicrousdPerPricingUnit: 1_000_000,
  entries: [
    {
      providerId: "gateway",
      taskId: "site_builder.copy",
      alias: "gpt-5.6-terra",
      protocol: "openai-responses",
      expectedChannelId: 72,
      maxOutputTokensPerCall: 4_000,
      gatewayCredentialQuotaCapPoints: 2_000_000,
      inputPriceMicrounitsPerMillionTokens: 2_000_000,
      outputPriceMicrounitsPerMillionTokens: 10_000_000,
    },
  ],
});

const KEYRING = parseSettlementDerivationKeyring(
  Buffer.from(
    `schema=site-build-settlement-derivation-keyring/v1\n` +
      `settlement-test ACTIVE ${"A".repeat(43)}\n`,
  ),
);

const CONTEXT = {
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  paidCost: {
    siteId: SITE_ID,
    scopeKey: `${ATTEMPT_ID}:fallback-0`,
    taskAttemptId: ATTEMPT_ID,
    fenceToken: FENCE,
  },
};

function exactReadback(input: {
  requestId: string;
}): NewApiRequestBoundSettlement {
  return {
    status: "settled",
    requestId: input.requestId,
    resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
    alias: "gpt-5.6-terra",
    protocol: "openai-responses",
    channelId: 72,
    quota: 1_250,
    inputTokens: 120,
    outputTokens: 30,
    upstreamIdState: "observed",
    receiptDigest: "c".repeat(64),
    physicalCallCount: 0,
    readbackProbes: [],
  };
}

function ledger() {
  return {
    reserveModelOperation: vi.fn(async () => ({
      kind: "execute" as const,
      spendId: "88888888-8888-4888-8888-888888888888",
      wireAttemptId: WIRE_ID_1,
      physicalWireAttempt: 1 as const,
    })),
    allocateModelPhysicalWire: vi.fn(async () => ({
      kind: "execute" as const,
      spendId: "88888888-8888-4888-8888-888888888888",
      wireAttemptId: WIRE_ID_2,
      physicalWireAttempt: 2 as const,
    })),
    beginModelPhysicalWire: vi.fn(async () => "DISPATCH" as const),
    claimModelReadbackProbe: vi.fn(
      async () => "99999999-9999-4999-8999-999999999999",
    ),
    recordModelReadbackProbe: vi.fn(async () => undefined),
    recordModelPhysicalWireReceipt: vi.fn(async () => undefined),
    finalizeModelPhysicalWire: vi.fn(async () => undefined),
    finalizeModelPhysicalWireNotDispatched: vi.fn(async () => undefined),
    settleOperation: vi.fn(async () => "SETTLED"),
    disablePaidCalls: vi.fn(async () => undefined),
  };
}

function model(
  output: (attempt: 1 | 2) => unknown,
  bodyUsage = { inputTokens: 120, outputTokens: 30 },
): ModelProvider {
  return {
    id: "gateway",
    supports: () => true,
    health: async () => ({ healthy: true }),
    generateStructured: vi.fn(async (_input, ctx) => {
      const runtime = ctx.paidCost?.settlementPhysicalWire;
      if (!runtime) throw new Error("missing settlement runtime");
      const begin = await runtime.begin();
      if (begin !== "DISPATCH") throw new Error("unexpected replay");
      const observation = await runtime.resolve({
        usage: bodyUsage,
        payloadState: "available",
        gatewayIdState: "observed",
        upstreamAckUnknown: false,
      });
      return {
        data: output(runtime.identity.physicalWireAttempt),
        provider: "gateway",
        model: "gpt-5.6-terra",
        reportedModel: "gpt-5.6-terra",
        modelResolutionSource: "upstream_response" as const,
        usage: {
          ...bodyUsage,
          gatewaySettlements: [observation],
        },
      };
    }),
    generateText: vi.fn() as never,
    reviewVision: vi.fn() as never,
    embed: vi.fn() as never,
  };
}

function gateway(input: {
  provider: ModelProvider;
  paidLedger: ReturnType<typeof ledger>;
  resolve?: (input: {
    requestId: string;
  }) => Promise<NewApiRequestBoundSettlement>;
  trace?: Pick<AiTraceSink, "record">;
}) {
  const instance = new RouterModelGateway(
    {
      route: () => [input.provider],
    } as unknown as ModelRouter,
    input.trace as AiTraceSink | undefined,
  );
  instance.paidLedger = input.paidLedger as unknown as SiteBuildCostLedger;
  instance.costReconciliationCatalog =
    createSiteBuildCostReconciliationCatalogFromEnv({
      SITE_BUILD_COST_RECONCILIATION_CATALOG_JSON: CATALOG,
    });
  instance.settlementDerivationKeyring = KEYRING;
  instance.settlementReadbackResolver = {
    resolve:
      input.resolve ??
      (async (request) => exactReadback({ requestId: request.requestId! })),
  } as never;
  return instance;
}

afterEach(() => vi.unstubAllGlobals());

describe("RouterModelGateway settlement-readback/v1", () => {
  it.each(["content", "model", "status"] as const)("keeps invalid model %s out of trace and Spend metadata", async (field) => {
    const sentinel = "invalid-model-output-sentinel";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
            status: field === "status" ? sentinel : "completed",
            model: field === "model" ? sentinel : "gpt-5.6-terra",
            output: [{ content: [{ type: "output_text", text: field === "content" ? sentinel : '{"ok":true}' }] }],
              usage: { input_tokens: 120, output_tokens: 30 },
            }),
            {
              status: 200,
              headers: { "x-oneapi-request-id": "gateway-observed" },
            },
          ),
      ),
    );
    const paidLedger = ledger();
    const trace = { record: vi.fn() };
    const provider = new OpenAICompatibleProvider({
      id: "gateway",
      baseUrl: "http://127.0.0.1:3001/v1",
      apiKey: "k",
      model: "gpt-5.6-terra",
      modelTransports: { "gpt-5.6-terra": "openai-responses" },
    });
    const instance = gateway({ provider, paidLedger, trace });

    const error = await instance
      .generateStructured(
        {
          task: "site_builder.copy",
          prompt: "bounded",
          schema: { type: "object" },
          model: "gpt-5.6-terra",
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        CONTEXT,
      )
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).cause).toBeUndefined();
    expect(String(error)).not.toContain(sentinel);
    const traceEntry = trace.record.mock.calls.at(-1)?.[0];
    expect(traceEntry).toMatchObject({ status: "ERROR" });
    expect(JSON.stringify(traceEntry)).not.toContain(sentinel);
    const settlement = paidLedger.settleOperation.mock.calls.at(-1)?.[0];
    expect(JSON.stringify(settlement?.meta)).not.toContain(sentinel);
  });

  it("does not let a READBACK_ONLY replay seize a live dispatch terminal state", async () => {
    let releaseWinner!: () => void;
    let markWinnerStarted!: () => void;
    const winnerGate = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    const winnerStarted = new Promise<void>((resolve) => {
      markWinnerStarted = resolve;
    });
    let physicalCalls = 0;
    const provider: ModelProvider = {
      id: "gateway",
      supports: () => true,
      health: async () => ({ healthy: true }),
      generateStructured: vi.fn(async (_input, ctx) => {
        const runtime = ctx.paidCost?.settlementPhysicalWire;
        if (!runtime) throw new Error("missing settlement runtime");
        if ((await runtime.begin()) === "READBACK_ONLY") {
          throw new ProviderWireInFlightError();
        }
        physicalCalls += 1;
        markWinnerStarted();
        await winnerGate;
        const observation = await runtime.resolve({
          usage: { inputTokens: 120, outputTokens: 30 },
          payloadState: "available",
          gatewayIdState: "observed",
          upstreamAckUnknown: false,
        });
        return {
          data: { ok: true },
          provider: "gateway",
          model: "gpt-5.6-terra",
          usage: {
            inputTokens: 120,
            outputTokens: 30,
            gatewaySettlements: [observation],
          },
        };
      }),
      generateText: vi.fn() as never,
      reviewVision: vi.fn() as never,
      embed: vi.fn() as never,
    };
    const paidLedger = ledger();
    paidLedger.beginModelPhysicalWire
      .mockResolvedValueOnce("DISPATCH")
      .mockResolvedValueOnce("READBACK_ONLY");
    const instance = gateway({ provider, paidLedger });
    const request = {
      task: "site_builder.copy",
      prompt: "bounded",
      schema: { type: "object" },
      model: "gpt-5.6-terra",
      maxCostCents: 40,
      maxTokens: 1_000,
    };

    const winner = instance.generateStructured(request, CONTEXT);
    await winnerStarted;
    await expect(
      instance.generateStructured(request, CONTEXT),
    ).rejects.toMatchObject({
      name: "PaidOperationUnknownError",
      errorCode: "MODEL_WIRE_IN_FLIGHT",
    });
    expect(physicalCalls).toBe(1);
    expect(paidLedger.finalizeModelPhysicalWire).not.toHaveBeenCalled();
    expect(paidLedger.settleOperation).not.toHaveBeenCalled();

    releaseWinner();
    await expect(winner).resolves.toMatchObject({ data: { ok: true } });
    expect(physicalCalls).toBe(1);
    expect(paidLedger.finalizeModelPhysicalWire).toHaveBeenCalledOnce();
    expect(paidLedger.settleOperation).toHaveBeenCalledOnce();
  });

  it("closes a provider-proven zero-call failure as NOT_DISPATCHED before release", async () => {
    const paidLedger = ledger();
    const provider: ModelProvider = {
      id: "gateway",
      supports: () => true,
      health: async () => ({ healthy: true }),
      generateStructured: vi.fn(async () => {
        throw new ProviderSettlementError(
          "MODEL_SETTLEMENT_GATEWAY_UNAVAILABLE",
          undefined,
          { callCount: 0, provider: "gateway", model: "gpt-5.6-terra" },
        );
      }),
      generateText: vi.fn() as never,
      reviewVision: vi.fn() as never,
      embed: vi.fn() as never,
    };
    const instance = gateway({ provider, paidLedger });

    await expect(
      instance.generateStructured(
        {
          task: "site_builder.copy",
          prompt: "bounded",
          schema: { type: "object" },
          model: "gpt-5.6-terra",
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        CONTEXT,
      ),
    ).rejects.toMatchObject({
      name: "ProviderSettlementError",
      callCount: 0,
    });

    expect(paidLedger.beginModelPhysicalWire).not.toHaveBeenCalled();
    expect(paidLedger.claimModelReadbackProbe).not.toHaveBeenCalled();
    expect(
      paidLedger.finalizeModelPhysicalWireNotDispatched,
    ).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      wireAttemptId: WIRE_ID_1,
    });
    expect(
      paidLedger.finalizeModelPhysicalWireNotDispatched.mock
        .invocationCallOrder[0],
    ).toBeLessThan(paidLedger.settleOperation.mock.invocationCallOrder[0]!);
    expect(paidLedger.settleOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "RELEASED",
        errorCode: "MODEL_SETTLEMENT_GATEWAY_UNAVAILABLE",
        measurement: expect.objectContaining({
          basis: "not_incurred",
          budgetChargeMicrousd: 0,
          callCount: 0,
        }),
      }),
    );
    expect(paidLedger.disablePaidCalls).not.toHaveBeenCalled();
  });

  it("reserves immutable wire context and settles one exact physical call", async () => {
    const paidLedger = ledger();
    const provider = model(() => ({ ok: true }));
    const instance = gateway({ provider, paidLedger });

    await expect(
      instance.generateStructured(
        {
          task: "site_builder.copy",
          prompt: "bounded",
          schema: { type: "object" },
          model: "gpt-5.6-terra",
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        CONTEXT,
      ),
    ).resolves.toMatchObject({ data: { ok: true } });

    expect(paidLedger.reserveModelOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "model",
        meta: expect.not.objectContaining({
          settlementContext: expect.anything(),
          settlementWireIdentities: expect.anything(),
        }),
        wire: expect.objectContaining({
          protocol: "openai-responses",
          requestedAlias: "gpt-5.6-terra",
          expectedChannelId: 72,
          maximumWireCalls: 2,
          actualMaxOutputTokens: 1_000,
          catalogMaxOutputTokens: 4_000,
          wireIdentity: expect.objectContaining({
            physicalWireAttempt: 1,
            requestId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
            nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
          }),
        }),
      }),
    );
    expect(paidLedger.beginModelPhysicalWire).toHaveBeenCalledOnce();
    expect(paidLedger.finalizeModelPhysicalWire).toHaveBeenCalledWith(
      expect.objectContaining({
        wireAttemptId: WIRE_ID_1,
        observation: expect.objectContaining({ status: "settled" }),
      }),
    );
    expect(paidLedger.settleOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "SUCCEEDED",
        measurement: expect.objectContaining({
          basis: "token_pricing",
          calculatedCostMicrousd: 540,
          callCount: 1,
        }),
      }),
    );
  });

  it("keeps a valid payload successful at the upper bound when readback is unavailable", async () => {
    const paidLedger = ledger();
    const provider = model(() => ({ ok: true }), {
      inputTokens: 3_000_000_000,
      outputTokens: 3_000_000_000,
    });
    const instance = gateway({
      provider,
      paidLedger,
      resolve: async (request) => ({
        status: "unknown",
        requestId: request.requestId,
        resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
        reason: "gateway_log_unavailable",
        physicalCallCount: 0,
        readbackProbes: [],
      }),
    });

    const durableReplayResult = vi.fn((result: Record<string, unknown>) => {
      const usage = result.usage as { inputTokens?: number; outputTokens?: number };
      expect(usage.inputTokens).toBeUndefined();
      expect(usage.outputTokens).toBeUndefined();
      return result;
    });
    await expect(
      instance.generateStructured(
        {
          task: "site_builder.copy",
          prompt: "bounded",
          schema: { type: "object" },
          model: "gpt-5.6-terra",
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        { ...CONTEXT, paidCost: { ...CONTEXT.paidCost, durableReplayResult } },
      ),
    ).resolves.toMatchObject({ data: { ok: true } });
    expect(paidLedger.settleOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "SUCCEEDED",
        measurement: expect.objectContaining({
          basis: "estimated_upper_bound",
          budgetChargeMicrousd: 800_000,
          inputTokens: null,
          outputTokens: null,
        }),
      }),
    );
    expect(paidLedger.disablePaidCalls).not.toHaveBeenCalled();
    expect(durableReplayResult).toHaveBeenCalledOnce();
    expect(paidLedger.allocateModelPhysicalWire).not.toHaveBeenCalled();
  });

  it("does not allocate repair attempt two after an unknown first wire", async () => {
    const paidLedger = ledger();
    const provider = model(() => ({ wrong: true }));
    const instance = gateway({
      provider,
      paidLedger,
      resolve: async (request) => ({
        status: "unknown",
        requestId: request.requestId,
        resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
        reason: "gateway_log_missing",
        physicalCallCount: 0,
        readbackProbes: [],
      }),
    });

    await expect(
      instance.generateStructured(
        {
          task: "site_builder.copy",
          prompt: "bounded",
          schema: {
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
          },
          model: "gpt-5.6-terra",
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        CONTEXT,
      ),
    ).rejects.toBeInstanceOf(PaidOperationUnknownError);
    expect(provider.generateStructured).toHaveBeenCalledTimes(1);
    expect(paidLedger.allocateModelPhysicalWire).not.toHaveBeenCalled();
    expect(paidLedger.settleOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "UNKNOWN",
        errorCode: "MODEL_SETTLEMENT_GATEWAY_LOG_MISSING",
      }),
    );
  });

  it("allocates attempt two only after the first exact receipt", async () => {
    const paidLedger = ledger();
    const provider = model((attempt) =>
      attempt === 1 ? { wrong: true } : { ok: true },
    );
    const instance = gateway({ provider, paidLedger });

    await expect(
      instance.generateStructured(
        {
          task: "site_builder.copy",
          prompt: "bounded",
          schema: {
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
          },
          model: "gpt-5.6-terra",
          maxCostCents: 40,
          maxTokens: 1_000,
        },
        CONTEXT,
      ),
    ).resolves.toMatchObject({ data: { ok: true }, callCount: 2 });
    expect(paidLedger.allocateModelPhysicalWire).toHaveBeenCalledOnce();
    expect(provider.generateStructured).toHaveBeenCalledTimes(2);
    expect(paidLedger.settleOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "SUCCEEDED",
        measurement: expect.objectContaining({
          basis: "token_pricing",
          callCount: 2,
          calculatedCostMicrousd: 1_080,
        }),
      }),
    );
  });
});
