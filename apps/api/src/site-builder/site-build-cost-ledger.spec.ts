import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSiteBuildCostSummary,
  boundedReconciliationMeta,
  legacyToolCostMeasurement,
  modelCostMeasurement,
  paidOperationKey,
  reconciliationDueAction,
  SiteBuildCostLedger,
  SITE_BUILD_COST_SUMMARY_VERSION,
} from "./site-build-cost-ledger";
import { VERIFIED_GATEWAY_MODEL_TRANSPORTS } from "../model-gateway/model-transports";
import {
  resolveTaskExecutionTarget,
  SITE_BUILDER_TASK_IDS,
} from "./agents/task-routes";

describe("R4-B cost truth classification", () => {
  it("uses measured tokens and the frozen MODEL-1 price snapshot without calling it provider-reported", () => {
    const measurement = modelCostMeasurement({
      taskId: "site_builder.brand_profile",
      requestedModel: "gpt-5.6-terra",
      resolvedModel: "gpt-5.6-terra",
      usage: { inputTokens: 1_000, outputTokens: 500 },
      reservationMicrousd: 800_000,
    });

    expect(measurement).toMatchObject({
      basis: "token_pricing",
      budgetChargeMicrousd: 1_000,
      calculatedCostMicrousd: 1_000,
      reportedCostMicrousd: null,
      estimatedCostMicrousd: null,
      inputTokens: 1_000,
      outputTokens: 500,
    });
    expect(measurement.meta).toMatchObject({
      pricingSnapshot: {
        model: "gpt-5.6-terra",
        inputUsdPerMillionTokens: 0.25,
        outputUsdPerMillionTokens: 1.5,
      },
    });
  });

  it("prefers provider-reported cost and preserves exact zero", () => {
    expect(
      modelCostMeasurement({
        taskId: "site_builder.brand_profile",
        requestedModel: "gpt-5.6-terra",
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        reservationMicrousd: 800_000,
      }),
    ).toMatchObject({
      basis: "provider_reported",
      budgetChargeMicrousd: 0,
      reportedCostMicrousd: 0,
      calculatedCostMicrousd: null,
      estimatedCostMicrousd: null,
    });
  });

  it("keeps valid unpriced model output successful at the conservative upper bound", () => {
    expect(
      modelCostMeasurement({
        taskId: "site_builder.brand_profile",
        requestedModel: "operator-override-without-price",
        usage: { inputTokens: 25, outputTokens: 5 },
        reservationMicrousd: 800_000,
      }),
    ).toMatchObject({
      basis: "estimated_upper_bound",
      budgetChargeMicrousd: 800_000,
      reportedCostMicrousd: null,
      calculatedCostMicrousd: null,
      estimatedCostMicrousd: 800_000,
      inputTokens: 25,
      outputTokens: 5,
    });
  });

  it("drops provider token counters wider than the durable integer boundary", () => {
    expect(
      modelCostMeasurement({
        taskId: "site_builder.brand_profile",
        requestedModel: "operator-override-without-price",
        usage: { inputTokens: 3_000_000_000, outputTokens: 3_000_000_000 },
        reservationMicrousd: 800_000,
      }),
    ).toMatchObject({
      basis: "estimated_upper_bound",
      budgetChargeMicrousd: 800_000,
      inputTokens: null,
      outputTokens: null,
    });
  });

  it("accepts request-bound new-api settlement for every active model dispatch", () => {
    for (const taskId of SITE_BUILDER_TASK_IDS) {
      const target = resolveTaskExecutionTarget(taskId);
      if (target.kind === "deterministic_fallback") continue;
      const route = target.route;
      for (const alias of [route.primary, ...route.fallbacks]) {
        const protocol =
          VERIFIED_GATEWAY_MODEL_TRANSPORTS[alias] ?? "openai-chat-completions";
        const settlementPreflight = {
          schemaVersion:
            "site-builder-paid-model-preflight-evidence/v2" as const,
          attestationId: "runtime-seven-task-test",
          snapshotSha256: "a".repeat(64),
          resolverId: "new-api-token-log-v1",
          taskId,
          alias,
          protocol,
          expectedChannelId: 17,
          pricingAuthority: "openox_model_marketplace" as const,
          pricingSourceUrl: "https://openox.tech/api/public/pricing-catalog",
          pricingSnapshotSha256: "c".repeat(64),
          pricingCurrency: "CNY" as const,
          inputPriceMicrounitsPerMillionTokens: 2_000_000,
          outputPriceMicrounitsPerMillionTokens: 10_000_000,
          ledgerMicrousdPerPricingUnit: 1_000_000,
          gatewayCredentialQuotaCapPoints: 5_000_000,
          gatewayCredentialRemainingPoints: 4_500_000,
          maxOutputTokensPerCall: 1_000,
          pricedMaximumMicrousd: 100_000,
        };
        const measurement = modelCostMeasurement({
          taskId,
          requestedModel: alias,
          resolvedModel: alias,
          settlementPreflight,
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            gatewaySettlements: [
              {
                status: "settled",
                requestId: `req_${taskId.replaceAll(".", "_")}_${alias}`,
                resolverId: settlementPreflight.resolverId,
                alias,
                protocol,
                channelId: settlementPreflight.expectedChannelId,
                basis: "openox_catalog_token_pricing" as const,
                quota: 1_250,
                costMicrousd: 2_500,
                inputTokens: 100,
                outputTokens: 20,
              },
            ],
          },
          reservationMicrousd: 400_000,
        });
        expect(measurement).toMatchObject({
          basis: "token_pricing",
          budgetChargeMicrousd: 2_500,
          reportedCostMicrousd: null,
          calculatedCostMicrousd: 2_500,
        });
      }
    }
  });

  it("keeps valid partial settlement successful at the conservative upper bound", () => {
    const settlementPreflight = {
      schemaVersion: "site-builder-paid-model-preflight-evidence/v2" as const,
      attestationId: "runtime-repair-test",
      snapshotSha256: "b".repeat(64),
      resolverId: "new-api-token-log-v1",
      taskId: "site_builder.copy",
      alias: "deepseek-v4-pro",
      protocol: "openai-chat-completions" as const,
      expectedChannelId: 11,
      pricingAuthority: "openox_model_marketplace" as const,
      pricingSourceUrl: "https://openox.tech/api/public/pricing-catalog",
      pricingSnapshotSha256: "c".repeat(64),
      pricingCurrency: "CNY" as const,
      inputPriceMicrounitsPerMillionTokens: 2_000_000,
      outputPriceMicrounitsPerMillionTokens: 10_000_000,
      ledgerMicrousdPerPricingUnit: 1_000_000,
      gatewayCredentialQuotaCapPoints: 5_000_000,
      gatewayCredentialRemainingPoints: 4_500_000,
      maxOutputTokensPerCall: 1_000,
      pricedMaximumMicrousd: 400_000,
    };
    expect(
      modelCostMeasurement({
        taskId: settlementPreflight.taskId,
        requestedModel: settlementPreflight.alias,
        settlementPreflight,
        callCount: 2,
        usage: {
          gatewaySettlements: [
            {
              status: "settled",
              requestId: "req_first_wire_call",
              resolverId: settlementPreflight.resolverId,
              alias: settlementPreflight.alias,
              protocol: settlementPreflight.protocol,
              channelId: settlementPreflight.expectedChannelId + 1,
              basis: "openox_catalog_token_pricing" as const,
              quota: 500,
              costMicrousd: 1_000,
              inputTokens: 10,
              outputTokens: 5,
            },
          ],
        },
        reservationMicrousd: 400_000,
      }),
    ).toMatchObject({
      basis: "estimated_upper_bound",
      budgetChargeMicrousd: 400_000,
      estimatedCostMicrousd: 400_000,
      reportedCostMicrousd: null,
    });
  });

  it("fails closed on replayed request IDs, model drift, or cost above the attested bound", () => {
    const settlementPreflight = {
      schemaVersion: "site-builder-paid-model-preflight-evidence/v2" as const,
      attestationId: "runtime-strict-settlement-test",
      snapshotSha256: "d".repeat(64),
      resolverId: "new-api-token-log-v1",
      taskId: "site_builder.copy",
      alias: "deepseek-v4-pro",
      protocol: "openai-chat-completions" as const,
      expectedChannelId: 11,
      pricingAuthority: "openox_model_marketplace" as const,
      pricingSourceUrl: "https://openox.tech/api/public/pricing-catalog",
      pricingSnapshotSha256: "e".repeat(64),
      pricingCurrency: "CNY" as const,
      inputPriceMicrounitsPerMillionTokens: 2_000_000,
      outputPriceMicrounitsPerMillionTokens: 10_000_000,
      ledgerMicrousdPerPricingUnit: 1_000_000,
      gatewayCredentialQuotaCapPoints: 5_000_000,
      gatewayCredentialRemainingPoints: 4_500_000,
      maxOutputTokensPerCall: 1_000,
      pricedMaximumMicrousd: 50_000,
    };
    const observation = (requestId: string, costMicrousd = 1_000) => ({
      status: "settled" as const,
      requestId,
      resolverId: settlementPreflight.resolverId,
      alias: settlementPreflight.alias,
      protocol: settlementPreflight.protocol,
      channelId: settlementPreflight.expectedChannelId,
      basis: "openox_catalog_token_pricing" as const,
      quota: 500,
      costMicrousd,
      inputTokens: 10,
      outputTokens: 5,
    });
    const measure = (input: {
      resolvedModel: string;
      callCount: number;
      gatewaySettlements: ReturnType<typeof observation>[];
    }) =>
      modelCostMeasurement({
        taskId: settlementPreflight.taskId,
        requestedModel: settlementPreflight.alias,
        settlementPreflight,
        resolvedModel: input.resolvedModel,
        callCount: input.callCount,
        usage: { gatewaySettlements: input.gatewaySettlements },
        reservationMicrousd: 80_000,
      });

    expect(
      measure({
        resolvedModel: settlementPreflight.alias,
        callCount: 2,
        gatewaySettlements: [
          observation("req_reused_wire_id"),
          observation("req_reused_wire_id"),
        ],
      }).basis,
    ).toBe("estimated_upper_bound");
    expect(
      measure({
        resolvedModel: "different-upstream-model",
        callCount: 1,
        gatewaySettlements: [observation("req_model_drift")],
      }).basis,
    ).toBe("estimated_upper_bound");
    expect(
      measure({
        resolvedModel: settlementPreflight.alias,
        callCount: 1,
        gatewaySettlements: [observation("req_cost_over_bound", 50_001)],
      }).basis,
    ).toBe("estimated_upper_bound");
    expect(
      measure({
        resolvedModel: settlementPreflight.alias,
        callCount: 1,
        gatewaySettlements: [
          {
            ...observation("req_output_tokens_over_bound"),
            outputTokens: 1_001,
          },
        ],
      }).basis,
    ).toBe("estimated_upper_bound");
  });

  it("persists authoritative token totals from every settled log observation", () => {
    const settlementPreflight = {
      schemaVersion: "site-builder-paid-model-preflight-evidence/v2" as const,
      attestationId: "runtime-token-total-test",
      snapshotSha256: "f".repeat(64),
      resolverId: "new-api-token-log-v1",
      taskId: "site_builder.copy",
      alias: "deepseek-v4-pro",
      protocol: "openai-chat-completions" as const,
      expectedChannelId: 11,
      pricingAuthority: "openox_model_marketplace" as const,
      pricingSourceUrl: "https://openox.tech/api/public/pricing-catalog",
      pricingSnapshotSha256: "a".repeat(64),
      pricingCurrency: "CNY" as const,
      inputPriceMicrounitsPerMillionTokens: 2_000_000,
      outputPriceMicrounitsPerMillionTokens: 10_000_000,
      ledgerMicrousdPerPricingUnit: 1_000_000,
      gatewayCredentialQuotaCapPoints: 5_000_000,
      gatewayCredentialRemainingPoints: 4_500_000,
      maxOutputTokensPerCall: 1_000,
      pricedMaximumMicrousd: 50_000,
    };
    const settled = (
      requestId: string,
      inputTokens: number,
      outputTokens: number,
    ) => ({
      status: "settled" as const,
      requestId,
      resolverId: settlementPreflight.resolverId,
      alias: settlementPreflight.alias,
      protocol: settlementPreflight.protocol,
      channelId: settlementPreflight.expectedChannelId,
      basis: "openox_catalog_token_pricing" as const,
      quota: 500,
      costMicrousd: 1_000,
      inputTokens,
      outputTokens,
    });

    expect(
      modelCostMeasurement({
        taskId: settlementPreflight.taskId,
        requestedModel: settlementPreflight.alias,
        resolvedModel: settlementPreflight.alias,
        settlementPreflight,
        callCount: 2,
        usage: {
          gatewaySettlements: [
            settled("req_token_total_1", 10, 5),
            settled("req_token_total_2", 20, 7),
          ],
        },
        reservationMicrousd: 80_000,
      }),
    ).toMatchObject({
      basis: "token_pricing",
      inputTokens: 30,
      outputTokens: 12,
      calculatedCostMicrousd: 2_000,
    });
  });

  it("labels legacy ToolBroker costCents as an estimate instead of actual cost", () => {
    expect(legacyToolCostMeasurement(2, 30_000)).toEqual({
      basis: "legacy_estimate",
      budgetChargeMicrousd: 20_000,
      reportedCostMicrousd: null,
      calculatedCostMicrousd: null,
      estimatedCostMicrousd: 20_000,
      inputTokens: null,
      outputTokens: null,
      callCount: 1,
      meta: { legacyCostCents: 2 },
    });
  });
});

describe("R4-B stable BuildRun cost summary", () => {
  it("preserves the PostgreSQL BIGINT maximum as canonical decimal strings", () => {
    const maximum = 9_223_372_036_854_775_807n;
    const summary = buildSiteBuildCostSummary(
      {
        capMicrousd: maximum,
        reservedMicrousd: 0n,
        chargedMicrousd: maximum,
        paidCallsEnabled: false,
        disabledReason: "budget_exhausted",
        exhaustedAt: null,
      },
      [
        {
          kind: "model",
          status: "SUCCEEDED",
          costBasis: "provider_reported",
          budgetChargeMicrousd: maximum,
          reportedCostMicrousd: maximum,
          calculatedCostMicrousd: null,
          estimatedCostMicrousd: null,
          inputTokens: 1,
          outputTokens: 1,
          callCount: 1,
        },
      ],
    );

    expect(summary.budget).toMatchObject({
      authorizedCapMicrousd: "9223372036854775807",
      conservativeChargedMicrousd: "9223372036854775807",
      remainingMicrousd: "0",
    });
    expect(summary.totals).toMatchObject({
      reportedCostMicrousd: "9223372036854775807",
      exactCostMicrousd: "9223372036854775807",
    });
    expect(() => JSON.stringify(summary)).not.toThrow();
  });

  it("keeps budget charge separate from reported, calculated, estimated and unknown totals", () => {
    const summary = buildSiteBuildCostSummary(
      {
        capMicrousd: 5_000_000n,
        reservedMicrousd: 0n,
        chargedMicrousd: 821_000n,
        paidCallsEnabled: false,
        disabledReason: "budget_exhausted",
        exhaustedAt: new Date("2026-07-19T10:00:00.000Z"),
      },
      [
        {
          kind: "model",
          status: "SUCCEEDED",
          budgetChargeMicrousd: 1_000n,
          reportedCostMicrousd: null,
          calculatedCostMicrousd: 1_000n,
          estimatedCostMicrousd: null,
          inputTokens: 1_000,
          outputTokens: 500,
          callCount: 1,
        },
        {
          kind: "tool",
          status: "SUCCEEDED",
          budgetChargeMicrousd: 20_000n,
          reportedCostMicrousd: null,
          calculatedCostMicrousd: null,
          estimatedCostMicrousd: 20_000n,
          inputTokens: null,
          outputTokens: null,
          callCount: 1,
        },
        {
          id: "00000000-0000-4000-8000-000000000003",
          kind: "model",
          status: "UNKNOWN",
          costBasis: "unknown",
          budgetChargeMicrousd: 800_000n,
          reportedCostMicrousd: null,
          calculatedCostMicrousd: null,
          estimatedCostMicrousd: null,
          inputTokens: null,
          outputTokens: null,
          callCount: null,
        },
      ],
    );

    expect(summary).toEqual({
      schemaVersion: SITE_BUILD_COST_SUMMARY_VERSION,
      currency: "USD",
      unit: "microusd",
      budget: {
        authorizedCapMicrousd: "5000000",
        conservativeChargedMicrousd: "821000",
        capMicrousd: "5000000",
        reservedMicrousd: "0",
        chargedMicrousd: "821000",
        remainingMicrousd: "4179000",
        paidCallsEnabled: false,
        disabledReason: "budget_exhausted",
        exhaustedAt: "2026-07-19T10:00:00.000Z",
      },
      totals: {
        reportedCostMicrousd: "0",
        calculatedCostMicrousd: "1000",
        estimatedCostMicrousd: "20000",
        unknownOperations: 1,
        exactCostMicrousd: "1000",
        upperBoundCostMicrousd: "0",
      },
      usage: {
        inputTokens: 1_000,
        outputTokens: 500,
        modelCalls: 1,
        toolCalls: 1,
      },
      operations: {
        succeeded: 2,
        failed: 0,
        unknown: 1,
        released: 0,
      },
      reconciliation: {
        pendingOperations: 1,
        resolvedOperations: 0,
        conflictOperations: 0,
        asOf: null,
        revision: 0,
      },
    });
  });

  it.each([
    ["UNRESOLVED", 1],
    ["RESOLVED", 0],
    ["CONFLICT", 0],
    ["EXPIRED", 0],
  ] as const)(
    "projects UNKNOWN cost reconciliation status %s with pending=%i without changing execution truth",
    (status, pendingOperations) => {
      const spendId = "00000000-0000-4000-8000-000000000003";
      const summary = buildSiteBuildCostSummary(
        {
          capMicrousd: 800_000n,
          reservedMicrousd: 0n,
          chargedMicrousd: 800_000n,
          paidCallsEnabled: false,
          disabledReason: "MODEL_SETTLEMENT_UNKNOWN",
          exhaustedAt: null,
        },
        [
          {
            id: spendId,
            kind: "model",
            status: "UNKNOWN",
            costBasis: "unknown",
            budgetChargeMicrousd: 800_000n,
            reportedCostMicrousd: null,
            calculatedCostMicrousd: null,
            estimatedCostMicrousd: null,
            inputTokens: null,
            outputTokens: null,
            callCount: 1,
          },
        ],
        [
          {
            spendId,
            status,
            exactCostMicrousd: status === "RESOLVED" ? 400n : null,
            createdAt: new Date("2026-09-02T00:00:00.000Z"),
          },
        ],
      );

      expect(summary.operations).toMatchObject({ unknown: 1, failed: 0 });
      expect(summary.reconciliation.pendingOperations).toBe(pendingOperations);
    },
  );

  it("uses the persisted 1m/5m/30m/2h/12h retry cadence and expires at 24h", () => {
    const created = new Date("2026-08-16T00:00:00.000Z");
    const at = (milliseconds: number) =>
      new Date(created.getTime() + milliseconds);
    expect(
      reconciliationDueAction({
        now: at(59_999),
        spendCreatedAt: created,
        observations: [],
      }),
    ).toBe("WAIT");
    expect(
      reconciliationDueAction({
        now: at(60_000),
        spendCreatedAt: created,
        observations: [],
      }),
    ).toBe("RESOLVE");

    const delays = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000];
    let observedAt = at(60_000);
    const observations: Array<{ status: string; observedAt: Date }> = [
      { status: "UNRESOLVED", observedAt },
    ];
    for (const delay of delays) {
      expect(
        reconciliationDueAction({
          now: new Date(observedAt.getTime() + delay - 1),
          spendCreatedAt: created,
          observations,
        }),
      ).toBe("WAIT");
      observedAt = new Date(observedAt.getTime() + delay);
      expect(
        reconciliationDueAction({
          now: observedAt,
          spendCreatedAt: created,
          observations,
        }),
      ).toBe("RESOLVE");
      observations.push({ status: "UNRESOLVED", observedAt });
    }

    expect(
      reconciliationDueAction({
        now: at(24 * 60 * 60_000),
        spendCreatedAt: created,
        observations,
      }),
    ).toBe("EXPIRE");
    expect(
      reconciliationDueAction({
        now: at(25 * 60 * 60_000),
        spendCreatedAt: created,
        observations: [{ status: "RESOLVED", observedAt: at(60_000) }],
      }),
    ).toBe("TERMINAL");
  });

  it("rejects secrets, prompts, response bodies and oversized reconciliation metadata", () => {
    expect(
      boundedReconciliationMeta({ reason: "resolver_unavailable", retry: 2 }),
    ).toEqual({
      reason: "resolver_unavailable",
      retry: 2,
    });
    for (const key of [
      "credential",
      "authorizationToken",
      "prompt",
      "responseBody",
      "email",
    ]) {
      expect(() => boundedReconciliationMeta({ [key]: "sensitive" })).toThrow(
        "forbidden key",
      );
    }
    expect(() =>
      boundedReconciliationMeta({ reason: "x".repeat(513) }),
    ).toThrow("too long");
  });

  it("re-enumerates an exact recovery settled before the reconciliation append ACK", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "00000000-0000-4000-8000-000000000001",
        workspaceId: "00000000-0000-4000-8000-000000000002",
        siteId: "00000000-0000-4000-8000-000000000003",
        buildRunId: "00000000-0000-4000-8000-000000000004",
        spendId: "00000000-0000-4000-8000-000000000005",
        operationKey: "a".repeat(64),
        physicalWireAttempt: 1,
        derivationKeyId: "settlement-test",
        settlementRequestId: "R".repeat(43),
        settlementNonceSha256: "b".repeat(64),
        resolverId: "new-api-request-bound-reconciliation-v1",
        protocol: "openai-responses",
        requestedAlias: "gpt-5.6-terra",
        expectedChannelId: 72,
        actualMaxOutputTokens: 1000,
        maximumQuotaPoints: 2000n,
        inputPriceMicrounitsPerMillion: 2000000n,
        outputPriceMicrounitsPerMillion: 10000000n,
        ledgerMicrousdPerPricingUnit: 1000000n,
        state: "OBSERVED",
        receipt: { id: "00000000-0000-4000-8000-000000000006" },
        createdAt: new Date("2026-08-16T00:00:00.000Z"),
        observedAt: new Date("2026-08-16T00:00:00.000Z"),
        spend: {
          // Simulates a crash after completeProviderSpendReconciliation
          // committed FAILED/token_pricing but before appendReconciliation.
          status: "FAILED",
          costBasis: "token_pricing",
          errorCode: "MODEL_OUTPUT_UNAVAILABLE_AFTER_RECOVERY",
          createdAt: new Date("2026-08-16T00:00:00.000Z"),
          reconciliations: [],
        },
      },
    ]);
    const prisma = {
      withWorkspace: vi.fn(
        async (_workspaceId: string, fn: (tx: unknown) => unknown) =>
          fn({ siteBuildProviderWireAttempt: { findMany } }),
      ),
    };
    const ledger = new SiteBuildCostLedger(prisma as never, {
      now: () => new Date("2026-08-16T00:01:00.000Z"),
    });

    await expect(
      ledger.listPendingReconciliations(
        "00000000-0000-4000-8000-000000000002",
        1,
      ),
    ).resolves.toHaveLength(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 2,
        where: expect.objectContaining({
          state: {
            in: [
              "ALLOCATED",
              "DISPATCH_STARTED",
              "OBSERVED",
              "UNKNOWN",
              "NOT_DISPATCHED",
            ],
          },
          spend: expect.objectContaining({
            OR: [
              { status: "RESERVED" },
              {
                status: "FAILED",
                errorCode: "MODEL_OUTPUT_UNAVAILABLE_AFTER_RECOVERY",
              },
              {
                status: "RELEASED",
                errorCode: "MODEL_WIRE_NOT_DISPATCHED",
              },
              { costBasis: { in: ["estimated_upper_bound", "unknown"] } },
            ],
          }),
        }),
      }),
    );
  });

  it("prioritizes the unresolved dispatched wire over a recorded earlier receipt for the same Spend", async () => {
    const common = {
      workspaceId: "00000000-0000-4000-8000-000000000002",
      siteId: "00000000-0000-4000-8000-000000000003",
      buildRunId: "00000000-0000-4000-8000-000000000004",
      spendId: "00000000-0000-4000-8000-000000000005",
      operationKey: "a".repeat(64),
      derivationKeyId: "settlement-test",
      settlementNonceSha256: "b".repeat(64),
      resolverId: "new-api-request-bound-reconciliation-v1",
      protocol: "openai-responses",
      requestedAlias: "gpt-5.6-terra",
      expectedChannelId: 72,
      actualMaxOutputTokens: 1000,
      maximumQuotaPoints: 2000n,
      inputPriceMicrounitsPerMillion: 2000000n,
      outputPriceMicrounitsPerMillion: 10000000n,
      ledgerMicrousdPerPricingUnit: 1000000n,
      createdAt: new Date("2026-08-16T00:00:00.000Z"),
      spend: {
        status: "RESERVED",
        costBasis: null,
        createdAt: new Date("2026-08-16T00:00:00.000Z"),
        reconciliations: [],
      },
    };
    const findMany = vi.fn(async () => [
      {
        ...common,
        id: "00000000-0000-4000-8000-000000000011",
        physicalWireAttempt: 1,
        settlementRequestId: "R".repeat(43),
        state: "OBSERVED",
        receipt: { id: "00000000-0000-4000-8000-000000000021" },
      },
      {
        ...common,
        id: "00000000-0000-4000-8000-000000000012",
        physicalWireAttempt: 2,
        settlementRequestId: "S".repeat(43),
        state: "DISPATCH_STARTED",
        dispatchStartedAt: new Date("2026-08-16T00:00:00.000Z"),
        receipt: null,
      },
    ]);
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, fn) =>
        fn({ siteBuildProviderWireAttempt: { findMany } }),
      ),
    } as never;

    await expect(
      new SiteBuildCostLedger(prisma, {
        now: () => new Date("2026-08-16T00:01:00.000Z"),
      }).listPendingReconciliations(common.workspaceId, 1),
    ).resolves.toEqual([]);

    const ledger = new SiteBuildCostLedger(prisma, {
      now: () => new Date("2026-08-16T00:10:00.000Z"),
    });

    const [candidate] = await ledger.listPendingReconciliations(
      common.workspaceId,
      1,
    );

    expect(candidate).toMatchObject({
      wireAttemptId: "00000000-0000-4000-8000-000000000012",
      physicalWireAttempt: 2,
      wireState: "DISPATCH_STARTED",
      receiptRecorded: false,
    });
  });

  it("atomically freezes a RESERVED Spend after every allocated wire is final", async () => {
    const queryRaw = vi.fn(async () => [{ decision: "SETTLED" }]);
    const tx = {
      $queryRaw: queryRaw,
      siteBuildSpend: {
        findFirst: vi.fn(async () => ({
          status: "RESERVED",
          operationKey: "a".repeat(64),
          fenceToken: "00000000-0000-4000-8000-000000000010",
          reservationMicrousd: 800_000n,
        })),
      },
      siteBuildProviderWireAttempt: {
        findMany: vi.fn(async () => [
          {
            id: "00000000-0000-4000-8000-000000000011",
            physicalWireAttempt: 1,
            state: "UNKNOWN",
          },
        ]),
      },
      siteBuildProviderWireReceipt: { findMany: vi.fn(async () => []) },
    };
    const database = {
      withWorkspace: vi.fn(async (_workspaceId, fn) => fn(tx)),
    } as never;
    const ledger = new SiteBuildCostLedger(database, {
      providerWireDatabase: database,
    });

    await expect(
      ledger.completeProviderSpendReconciliation({
        workspaceId: "00000000-0000-4000-8000-000000000002",
        siteId: "00000000-0000-4000-8000-000000000003",
        buildRunId: "00000000-0000-4000-8000-000000000004",
        spendId: "00000000-0000-4000-8000-000000000005",
        resolverId: "new-api-request-bound-reconciliation-v1",
        observedAt: new Date("2026-08-16T00:01:00.000Z"),
      }),
    ).resolves.toMatchObject({
      status: "UNRESOLVED",
      meta: { reason: "provider_wire_receipts_incomplete" },
    });
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(queryRaw.mock.calls[0]).toEqual(
      expect.arrayContaining([
        800_000n,
        1,
        "MODEL_SETTLEMENT_DATABASE_ACK_UNKNOWN",
      ]),
    );
  });

  it("releases a RESERVED Spend when every attempt is durably NOT_DISPATCHED", async () => {
    const queryRaw = vi.fn(async () => [{ decision: "SETTLED" }]);
    const tx = {
      $queryRaw: queryRaw,
      siteBuildSpend: {
        findFirst: vi.fn(async () => ({
          status: "RESERVED",
          operationKey: "a".repeat(64),
          fenceToken: "00000000-0000-4000-8000-000000000010",
          reservationMicrousd: 800_000n,
        })),
      },
      siteBuildProviderWireAttempt: {
        findMany: vi.fn(async () => [
          {
            id: "00000000-0000-4000-8000-000000000011",
            physicalWireAttempt: 1,
            state: "NOT_DISPATCHED",
          },
        ]),
      },
      siteBuildProviderWireReceipt: { findMany: vi.fn(async () => []) },
    };
    const database = {
      withWorkspace: vi.fn(async (_workspaceId, operation) => operation(tx)),
    } as never;
    const ledger = new SiteBuildCostLedger({} as never, {
      providerWireDatabase: database,
    });

    await expect(
      ledger.completeProviderSpendReconciliation({
        workspaceId: "00000000-0000-4000-8000-000000000002",
        siteId: "00000000-0000-4000-8000-000000000003",
        buildRunId: "00000000-0000-4000-8000-000000000004",
        spendId: "00000000-0000-4000-8000-000000000005",
        resolverId: "new-api-request-bound-reconciliation-v1",
        observedAt: new Date("2026-08-17T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      status: "RESOLVED",
      receiptDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      costBasis: "not_incurred",
      exactCostMicrousd: "0",
      inputTokens: 0,
      outputTokens: 0,
      meta: {
        reason: "provider_wire_not_dispatched",
        physicalWireCount: 0,
        notDispatchedCount: 1,
      },
    });
    expect(queryRaw.mock.calls[0]).toEqual(
      expect.arrayContaining([
        "RELEASED",
        0n,
        "not_incurred",
        "MODEL_WIRE_NOT_DISPATCHED",
      ]),
    );
  });

  it("expires a send-cut gap only after durably closing the wire and freezing the Spend", async () => {
    const candidate = {
      workspaceId: "00000000-0000-4000-8000-000000000002",
      siteId: "00000000-0000-4000-8000-000000000003",
      buildRunId: "00000000-0000-4000-8000-000000000004",
      spendId: "00000000-0000-4000-8000-000000000005",
      wireAttemptId: "00000000-0000-4000-8000-000000000006",
      operationKey: "a".repeat(64),
      physicalWireAttempt: 1 as const,
      derivationKeyId: "settlement-test",
      settlementRequestId: "R".repeat(43),
      settlementNonceSha256: "b".repeat(64),
      resolverId: "new-api-request-bound-reconciliation-v1",
      alias: "gpt-5.6-terra",
      protocol: "openai-responses" as const,
      expectedChannelId: 72,
      actualMaxOutputTokens: 1000,
      maximumQuotaPoints: 2000,
      inputPriceMicrounitsPerMillionTokens: 2000000,
      outputPriceMicrounitsPerMillionTokens: 10000000,
      ledgerMicrousdPerPricingUnit: 1000000,
      wireState: "DISPATCH_STARTED" as const,
      receiptRecorded: false,
      action: "EXPIRE" as const,
    };
    const ledger = new SiteBuildCostLedger({} as never, {
      now: () => new Date("2026-08-17T00:00:00.000Z"),
    });
    vi.spyOn(ledger, "listPendingReconciliations").mockResolvedValue([
      candidate,
    ]);
    const finalize = vi
      .spyOn(ledger, "finalizeModelPhysicalWire")
      .mockResolvedValue(undefined);
    const complete = vi
      .spyOn(ledger, "completeProviderSpendReconciliation")
      .mockResolvedValue({
        status: "UNRESOLVED",
        resolverId: candidate.resolverId,
        observedAt: new Date("2026-08-17T00:00:00.000Z"),
        meta: { reason: "provider_wire_receipts_incomplete" },
      });
    const append = vi
      .spyOn(ledger, "appendReconciliation")
      .mockResolvedValue({} as never);
    const resolve = vi.fn();

    await expect(
      ledger.runReconciliationSweep({
        workspaceId: candidate.workspaceId,
        resolve,
      }),
    ).resolves.toEqual({ attempted: 1, resolved: 0 });

    expect(resolve).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        wireAttemptId: candidate.wireAttemptId,
        observation: expect.objectContaining({
          status: "unknown",
          reason: "gateway_log_missing",
        }),
      }),
    );
    expect(complete).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({
          status: "EXPIRED",
          meta: { reason: "reconciliation_window_expired" },
        }),
      }),
    );
  });

  it("safely resumes an attempt-one wire that is still provably before the send cut", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => [
        {
          decision: "REPLAY",
          spend_id: "00000000-0000-4000-8000-000000000005",
          spend_status: "RESERVED",
          cached_result: null,
          cached_meta: null,
          cached_error_code: null,
          wire_attempt_id: "00000000-0000-4000-8000-000000000006",
          physical_wire_attempt: 1,
          wire_state: "ALLOCATED",
          wire_derivation_key_id: "settlement-test",
          wire_settlement_request_id: "R".repeat(43),
          wire_settlement_nonce_sha256: "b".repeat(64),
        },
      ]),
    };
    const providerWireDatabase = {
      withWorkspace: vi.fn(async (_workspaceId, operation) => operation(tx)),
    };
    const ledger = new SiteBuildCostLedger({} as never, {
      providerWireDatabase: providerWireDatabase as never,
    });

    await expect(
      ledger.reserveModelOperation({
        workspaceId: "00000000-0000-4000-8000-000000000002",
        siteId: "00000000-0000-4000-8000-000000000003",
        buildRunId: "00000000-0000-4000-8000-000000000004",
        operationKey: "a".repeat(64),
        kind: "model",
        taskId: "site_builder.copy",
        subject: "gpt-5.6-terra@gateway",
        reservationMicrousd: 800_000,
        wire: {
          wireIdentity: {
            schemaVersion: "site-build-settlement-wire-identity/v1",
            physicalWireAttempt: 1,
            derivationKeyId: "settlement-test",
            requestId: "R".repeat(43),
            nonce: "N".repeat(43),
            nonceSha256: "b".repeat(64),
          },
          protocol: "openai-responses",
          requestedAlias: "gpt-5.6-terra",
          expectedChannelId: 72,
          promptUtf8Bytes: 100,
          maximumWireCalls: 2,
          actualMaxOutputTokens: 1000,
          catalogMaxOutputTokens: 4000,
          maximumQuotaPoints: 2000,
          catalogId: "catalog-v1",
          catalogSha256: "c".repeat(64),
          pricingSnapshotSha256: "d".repeat(64),
          inputPriceMicrounitsPerMillionTokens: 2000000,
          outputPriceMicrounitsPerMillionTokens: 10000000,
          ledgerMicrousdPerPricingUnit: 1000000,
        },
      }),
    ).resolves.toEqual({
      kind: "execute",
      spendId: "00000000-0000-4000-8000-000000000005",
      wireAttemptId: "00000000-0000-4000-8000-000000000006",
      physicalWireAttempt: 1,
      wireIdentity: {
        schemaVersion: "site-build-settlement-wire-identity/v1",
        physicalWireAttempt: 1,
        derivationKeyId: "settlement-test",
        requestId: "R".repeat(43),
        nonceSha256: "b".repeat(64),
      },
    });
  });

  it("does not terminalize an ALLOCATED wire until the bounded recovery window expires", async () => {
    const createdAt = new Date("2026-08-16T00:00:00.000Z");
    const row = {
      id: "00000000-0000-4000-8000-000000000006",
      workspaceId: "00000000-0000-4000-8000-000000000002",
      siteId: "00000000-0000-4000-8000-000000000003",
      buildRunId: "00000000-0000-4000-8000-000000000004",
      spendId: "00000000-0000-4000-8000-000000000005",
      operationKey: "a".repeat(64),
      physicalWireAttempt: 1,
      derivationKeyId: "settlement-test",
      settlementRequestId: "R".repeat(43),
      settlementNonceSha256: "b".repeat(64),
      resolverId: "new-api-request-bound-reconciliation-v1",
      protocol: "openai-responses",
      requestedAlias: "gpt-5.6-terra",
      expectedChannelId: 72,
      actualMaxOutputTokens: 1000,
      maximumQuotaPoints: 2000n,
      inputPriceMicrounitsPerMillion: 2000000n,
      outputPriceMicrounitsPerMillion: 10000000n,
      ledgerMicrousdPerPricingUnit: 1000000n,
      state: "ALLOCATED",
      receipt: null,
      createdAt,
      spend: {
        status: "RESERVED",
        costBasis: null,
        // A late repair wire must own its own recovery clock even when the
        // logical Spend was created by attempt one more than a day earlier.
        createdAt: new Date("2026-08-15T00:00:00.000Z"),
        reconciliations: [],
      },
    };
    const database = {
      withWorkspace: vi.fn(async (_workspaceId, operation) =>
        operation({
          siteBuildProviderWireAttempt: {
            findMany: vi.fn(async () => [row]),
          },
        }),
      ),
    } as never;

    await expect(
      new SiteBuildCostLedger(database, {
        now: () => new Date("2026-08-16T23:59:59.999Z"),
      }).listPendingReconciliations(row.workspaceId),
    ).resolves.toEqual([]);
    await expect(
      new SiteBuildCostLedger(database, {
        now: () => new Date("2026-08-17T00:00:00.000Z"),
      }).listPendingReconciliations(row.workspaceId),
    ).resolves.toEqual([
      expect.objectContaining({
        wireState: "ALLOCATED",
        action: "EXPIRE",
      }),
    ]);
  });

  it("expires an ALLOCATED wire as NOT_DISPATCHED without a readback query", async () => {
    const candidate = {
      workspaceId: "00000000-0000-4000-8000-000000000002",
      siteId: "00000000-0000-4000-8000-000000000003",
      buildRunId: "00000000-0000-4000-8000-000000000004",
      spendId: "00000000-0000-4000-8000-000000000005",
      wireAttemptId: "00000000-0000-4000-8000-000000000006",
      operationKey: "a".repeat(64),
      physicalWireAttempt: 1 as const,
      derivationKeyId: "settlement-test",
      settlementRequestId: "R".repeat(43),
      settlementNonceSha256: "b".repeat(64),
      resolverId: "new-api-request-bound-reconciliation-v1",
      alias: "gpt-5.6-terra",
      protocol: "openai-responses" as const,
      expectedChannelId: 72,
      actualMaxOutputTokens: 1000,
      maximumQuotaPoints: 2000,
      inputPriceMicrounitsPerMillionTokens: 2000000,
      outputPriceMicrounitsPerMillionTokens: 10000000,
      ledgerMicrousdPerPricingUnit: 1000000,
      wireState: "ALLOCATED" as const,
      receiptRecorded: false,
      action: "EXPIRE" as const,
    };
    const ledger = new SiteBuildCostLedger({} as never);
    vi.spyOn(ledger, "listPendingReconciliations").mockResolvedValue([
      candidate,
    ]);
    const closeWire = vi
      .spyOn(ledger, "finalizeModelPhysicalWireNotDispatched")
      .mockResolvedValue(undefined);
    vi.spyOn(ledger, "completeProviderSpendReconciliation").mockResolvedValue({
      status: "UNRESOLVED",
      resolverId: candidate.resolverId,
      observedAt: new Date(),
      meta: { reason: "provider_wire_receipts_incomplete" },
    });
    const append = vi
      .spyOn(ledger, "appendReconciliation")
      .mockResolvedValue({} as never);
    const resolve = vi.fn();

    await ledger.runReconciliationSweep({
      workspaceId: candidate.workspaceId,
      resolve,
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(closeWire).toHaveBeenCalledWith({
      workspaceId: candidate.workspaceId,
      wireAttemptId: candidate.wireAttemptId,
    });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({ status: "EXPIRED" }),
      }),
    );
  });

  it("makes an exact receipt replay produce zero run, reconciliation, and outbox writes", async () => {
    const updateRun = vi.fn();
    const createOutbox = vi.fn();
    const createReconciliation = vi.fn();
    const receiptDigest = "b".repeat(64);
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn(async () => []),
      siteBuildSpend: {
        findFirst: vi.fn(async () => ({
          id: "00000000-0000-4000-8000-000000000001",
          reservationMicrousd: 100n,
        })),
        findMany: vi.fn(async () => []),
      },
      siteBuildSpendReconciliation: {
        findFirst: vi.fn(async () => ({ id: "prior", receiptDigest })),
        findMany: vi.fn(async () => [
          {
            spendId: "00000000-0000-4000-8000-000000000001",
            status: "RESOLVED",
            exactCostMicrousd: 40n,
            createdAt: new Date("2026-08-16T00:01:00.000Z"),
          },
        ]),
        create: createReconciliation,
      },
      siteBuildBudget: {
        findUnique: vi.fn(async () => ({
          capMicrousd: 100n,
          reservedMicrousd: 0n,
          chargedMicrousd: 100n,
          paidCallsEnabled: false,
          disabledReason: "run_succeeded",
          exhaustedAt: null,
        })),
      },
      siteBuildRun: { update: updateRun },
      outboxEvent: { create: createOutbox },
    };
    const prisma = {
      withWorkspace: vi.fn(
        async (_workspaceId: string, fn: (inner: unknown) => unknown) => fn(tx),
      ),
    };
    const ledger = new SiteBuildCostLedger(prisma as never);

    await ledger.appendReconciliation({
      workspaceId: "00000000-0000-4000-8000-000000000002",
      siteId: "00000000-0000-4000-8000-000000000003",
      buildRunId: "00000000-0000-4000-8000-000000000004",
      spendId: "00000000-0000-4000-8000-000000000001",
      observation: {
        status: "RESOLVED",
        resolverId: "resolver-v1",
        receiptDigest,
        costBasis: "provider_reported",
        exactCostMicrousd: "40",
        observedAt: new Date("2026-08-16T00:01:00.000Z"),
      },
    });

    expect(createReconciliation).not.toHaveBeenCalled();
    expect(updateRun).not.toHaveBeenCalled();
    expect(createOutbox).not.toHaveBeenCalled();
  });

  it("persists a first RESOLVED receipt and emits one cost-summary outbox event", async () => {
    const receiptDigest = "c".repeat(64);
    const createReconciliation = vi.fn(async () => ({
      id: "reconciliation-1",
    }));
    const updateRun = vi.fn(async () => ({ id: "run-1" }));
    const createOutbox = vi.fn(async () => ({ id: "outbox-1" }));
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn(async () => []),
      siteBuildSpend: {
        findFirst: vi.fn(async () => ({
          id: "00000000-0000-4000-8000-000000000001",
          reservationMicrousd: 100n,
        })),
        findMany: vi.fn(async () => []),
      },
      siteBuildSpendReconciliation: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null),
        findMany: vi.fn(async () => [
          {
            spendId: "00000000-0000-4000-8000-000000000001",
            status: "RESOLVED",
            exactCostMicrousd: 40n,
            createdAt: new Date("2026-08-16T00:01:00.000Z"),
          },
        ]),
        create: createReconciliation,
      },
      siteBuildBudget: {
        findUnique: vi.fn(async () => ({
          capMicrousd: 100n,
          reservedMicrousd: 0n,
          chargedMicrousd: 100n,
          paidCallsEnabled: false,
          disabledReason: "run_succeeded",
          exhaustedAt: null,
        })),
      },
      siteBuildRun: { update: updateRun },
      outboxEvent: { create: createOutbox },
    };
    const ledger = new SiteBuildCostLedger({
      withWorkspace: vi.fn(
        async (_workspaceId: string, fn: (inner: unknown) => unknown) => fn(tx),
      ),
    } as never);

    await ledger.appendReconciliation({
      workspaceId: "00000000-0000-4000-8000-000000000002",
      siteId: "00000000-0000-4000-8000-000000000003",
      buildRunId: "00000000-0000-4000-8000-000000000004",
      spendId: "00000000-0000-4000-8000-000000000001",
      observation: {
        status: "RESOLVED",
        resolverId: "new-api-request-bound-reconciliation-v1",
        requestId: "req-cost-reconcile-001",
        receiptDigest,
        costBasis: "token_pricing",
        exactCostMicrousd: "40",
        inputTokens: 10,
        outputTokens: 2,
        observedAt: new Date("2026-08-16T00:01:00.000Z"),
      },
    });

    expect(createReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "RESOLVED",
          receiptDigest,
          exactCostMicrousd: 40n,
        }),
      }),
    );
    expect(updateRun).toHaveBeenCalledTimes(1);
    expect(createOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "SiteBuildCostSummaryUpdated",
        }),
      }),
    );
  });

  it("appends CAP_VARIANCE beside an over-reservation exact receipt and projects the conflict once", async () => {
    const createReconciliation = vi.fn(async () => ({ id: "reconciliation" }));
    const updateRun = vi.fn(async () => ({ id: "run-1" }));
    const createOutbox = vi.fn(async () => ({ id: "outbox-1" }));
    const disable = vi.fn(async () => [{ disable_site_build_paid_calls: 1 }]);
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: disable,
      siteBuildSpend: {
        findFirst: vi.fn(async () => ({
          id: "00000000-0000-4000-8000-000000000001",
          reservationMicrousd: 100n,
        })),
        findMany: vi.fn(async () => [
          {
            id: "00000000-0000-4000-8000-000000000001",
            kind: "model",
            status: "SUCCEEDED",
            costBasis: "estimated_upper_bound",
            budgetChargeMicrousd: 100n,
            reportedCostMicrousd: null,
            calculatedCostMicrousd: null,
            estimatedCostMicrousd: 100n,
            inputTokens: 10,
            outputTokens: 2,
            callCount: 1,
          },
        ]),
      },
      siteBuildSpendReconciliation: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ attemptNo: 3 }),
        findMany: vi.fn(async () => [
          {
            spendId: "00000000-0000-4000-8000-000000000001",
            status: "RESOLVED",
            exactCostMicrousd: 140n,
            createdAt: new Date("2026-08-16T00:01:00.000Z"),
          },
          {
            spendId: "00000000-0000-4000-8000-000000000001",
            status: "CONFLICT",
            exactCostMicrousd: null,
            createdAt: new Date("2026-08-16T00:01:00.000Z"),
          },
        ]),
        create: createReconciliation,
      },
      siteBuildBudget: {
        findUnique: vi.fn(async () => ({
          capMicrousd: 100n,
          reservedMicrousd: 0n,
          chargedMicrousd: 100n,
          paidCallsEnabled: false,
          disabledReason: "reconciliation_cap_variance",
          exhaustedAt: new Date("2026-08-16T00:01:00.000Z"),
        })),
      },
      siteBuildRun: { update: updateRun },
      outboxEvent: { create: createOutbox },
    };
    const ledger = new SiteBuildCostLedger({
      withWorkspace: vi.fn(
        async (_workspaceId: string, fn: (inner: unknown) => unknown) => fn(tx),
      ),
    } as never);

    const summary = await ledger.appendReconciliation({
      workspaceId: "00000000-0000-4000-8000-000000000002",
      siteId: "00000000-0000-4000-8000-000000000003",
      buildRunId: "00000000-0000-4000-8000-000000000004",
      spendId: "00000000-0000-4000-8000-000000000001",
      observation: {
        status: "RESOLVED",
        resolverId: "new-api-request-bound-reconciliation-v1",
        requestId: "req-cost-reconcile-variance",
        receiptDigest: "d".repeat(64),
        costBasis: "token_pricing",
        exactCostMicrousd: "140",
        inputTokens: 10,
        outputTokens: 2,
        observedAt: new Date("2026-08-16T00:01:00.000Z"),
      },
    });

    expect(createReconciliation).toHaveBeenCalledTimes(2);
    expect(createReconciliation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          attemptNo: 5,
          status: "CONFLICT",
          resolverId: "site-build-cap-variance-v1",
          meta: {
            reason: "CAP_VARIANCE",
            observedMicrousd: "140",
            authorizedMicrousd: "100",
          },
        }),
      }),
    );
    expect(disable).toHaveBeenCalledOnce();
    expect(summary.reconciliation).toMatchObject({
      resolvedOperations: 1,
      conflictOperations: 1,
      revision: 2,
    });
    expect(createOutbox).toHaveBeenCalledOnce();
  });

  it("derives a stable SHA-256 operation key from the full logical identity", () => {
    const a = paidOperationKey([
      "run-1",
      "site_builder.brand_profile",
      "model",
      "gpt-5.6-terra",
      "fallback-0",
    ]);
    const b = paidOperationKey([
      "run-1",
      "site_builder.brand_profile",
      "model",
      "gpt-5.6-terra",
      "fallback-0",
    ]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(
      paidOperationKey([
        "run-1",
        "site_builder.brand_profile",
        "model",
        "claude-sonnet-5",
        "fallback-1",
      ]),
    ).not.toBe(a);
  });
});

const coverageScope = { workspaceId: "ws", siteId: "site", buildRunId: "run" };
const coverageNow = new Date("2026-09-13T00:00:00Z");
const coverageFence = {
  workspaceId: "ws",
  attemptId: "task",
  fenceToken: "owned-fence",
};
function ledgerFixture() {
  const budget = {
    ...coverageScope,
    capMicrousd: 100n,
    reservedMicrousd: 20n,
    chargedMicrousd: 10n,
    paidCallsEnabled: true,
    disabledReason: null,
    exhaustedAt: null,
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ decision: "SETTLED" }]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    siteBuildBudget: { findUnique: vi.fn().mockResolvedValue(budget) },
    siteBuildBudgetGrant: {
      findUnique: vi.fn().mockResolvedValue({ ...budget }),
    },
    siteBuildRun: {
      findUnique: vi.fn().mockResolvedValue({ status: "running" }),
      update: vi.fn().mockResolvedValue({}),
    },
    siteBuildSpend: {
      findFirst: vi
        .fn()
        .mockResolvedValue({
          id: "spend",
          reservationMicrousd: 100n,
          status: "SUCCEEDED",
          operationKey: "a".repeat(64),
          fenceToken: "owned-fence",
        }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    siteBuildSpendReconciliation: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    siteBuildProviderWireAttempt: { findMany: vi.fn().mockResolvedValue([]) },
    siteBuildProviderWireReceipt: { findMany: vi.fn().mockResolvedValue([]) },
    siteBuildTaskAttempt: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn(async ({ data }) => ({ id: "task", ...data })),
      create: vi.fn(async ({ data }) => ({ id: "task", ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    outboxEvent: { create: vi.fn().mockResolvedValue({}) },
  };
  const database = {
    withWorkspace: vi.fn(async (_workspace, operation) => operation(tx)),
  };
  const ledger = new SiteBuildCostLedger(database as never, {
    providerWireDatabase: database as never,
    now: () => coverageNow,
    randomUUID: () => "owned-fence",
  });
  return { budget, tx, database, ledger };
}
const coverageObservation = {
  status: "RESOLVED" as const,
  resolverId: "resolver",
  observedAt: coverageNow,
  receiptDigest: "b".repeat(64),
  costBasis: "token_pricing" as const,
  exactCostMicrousd: "10",
};
afterEach(() => vi.restoreAllMocks());

describe("ledger authorization and owned task boundary cases", () => {
  it.each([
    "budget",
    "grant",
    "budget-workspace",
    "grant-workspace",
    "budget-site",
    "grant-site",
    "cap",
  ])(
    "denies inconsistent %s authority before any paid operation",
    async (field) => {
      const f = ledgerFixture();
      const budget = { ...f.budget };
      const grant = { ...f.budget };
      if (field === "budget-workspace") budget.workspaceId = "other";
      if (field === "grant-workspace") grant.workspaceId = "other";
      if (field === "budget-site") budget.siteId = "other";
      if (field === "grant-site") grant.siteId = "other";
      if (field === "cap") grant.capMicrousd++;
      f.tx.siteBuildBudget.findUnique.mockResolvedValue(
        field === "budget" ? null : budget,
      );
      f.tx.siteBuildBudgetGrant.findUnique.mockResolvedValue(
        field === "grant" ? null : grant,
      );
      await expect(
        f.ledger.assertAuthorizedBudget(coverageScope),
      ).rejects.toThrow("DENIED_BUDGET_AUTHORIZATION");
      expect(f.tx.$queryRaw).not.toHaveBeenCalled();
    },
  );
  it("accepts equal workspace/site/cap authority without mutating it", async () => {
    const f = ledgerFixture();
    await expect(
      f.ledger.assertAuthorizedBudget(coverageScope),
    ).resolves.toBeUndefined();
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
  });
  it.each([null, "wrong", []])(
    "rejects a terminal task without an object replay payload",
    async (resultJson) => {
      const f = ledgerFixture();
      f.tx.siteBuildTaskAttempt.findUnique.mockResolvedValue({
        status: "SUCCEEDED",
        resultJson,
      });
      await expect(
        f.ledger.claimTaskAttempt({ ...coverageScope, taskId: "copy" }),
      ).rejects.toThrow("no stable result");
      expect(f.tx.siteBuildTaskAttempt.create).not.toHaveBeenCalled();
    },
  );
  it.each(["missing-run", "stopped", "missing-budget", "disabled"])(
    "does not claim a fresh task after %s authority loss",
    async (failure) => {
      const f = ledgerFixture();
      if (failure === "missing-run")
        f.tx.siteBuildRun.findUnique.mockResolvedValue(null);
      if (failure === "stopped")
        f.tx.siteBuildRun.findUnique.mockResolvedValue({ status: "cancelled" });
      if (failure === "missing-budget")
        f.tx.siteBuildBudget.findUnique.mockResolvedValue(null);
      if (failure === "disabled")
        f.tx.siteBuildBudget.findUnique.mockResolvedValue({
          ...f.budget,
          paidCallsEnabled: false,
        });
      await expect(
        f.ledger.claimTaskAttempt({ ...coverageScope, taskId: "copy" }),
      ).rejects.toThrow("DENIED");
      expect(f.tx.siteBuildTaskAttempt.create).not.toHaveBeenCalled();
    },
  );
  it("reclaims MODEL_SUCCEEDED output even after paid calls have been disabled", async () => {
    const f = ledgerFixture();
    f.tx.siteBuildTaskAttempt.findUnique.mockResolvedValue({
      id: "task",
      status: "MODEL_SUCCEEDED",
      leaseUntil: new Date(0),
      attemptNo: 2,
    });
    f.tx.siteBuildBudget.findUnique.mockResolvedValue(null);
    expect(
      await f.ledger.claimTaskAttempt({ ...coverageScope, taskId: "copy" }),
    ).toMatchObject({ kind: "claimed", attempt: { id: "task", attemptNo: 3 } });
    expect(f.tx.siteBuildTaskAttempt.create).not.toHaveBeenCalled();
  });
  it.each(["missing", "token", "expired", "cas"])(
    "refuses freezing task input after %s fence loss",
    async (failure) => {
      const f = ledgerFixture();
      const row = {
        fenceToken: failure === "token" ? "other" : coverageFence.fenceToken,
        leaseUntil:
          failure === "expired"
            ? new Date(0)
            : new Date(coverageNow.getTime() + 1000),
      };
      f.tx.siteBuildTaskAttempt.findUnique.mockResolvedValue(
        failure === "missing" ? null : row,
      );
      if (failure === "cas")
        f.tx.siteBuildTaskAttempt.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        f.ledger.freezeTaskInput(coverageFence, { items: [{ b: 2, a: 1 }] }),
      ).rejects.toThrow();
    },
  );
  it("canonicalizes nested arrays and refuses non-object task payloads", async () => {
    const f = ledgerFixture();
    f.tx.siteBuildTaskAttempt.findUnique.mockResolvedValue({
      fenceToken: coverageFence.fenceToken,
      leaseUntil: new Date(coverageNow.getTime() + 1000),
    });
    expect(
      await f.ledger.freezeTaskInput(coverageFence, {
        z: [{ b: 2, a: 1 }],
        a: null,
      }),
    ).toMatchObject({
      input: { a: null, z: [{ a: 1, b: 2 }] },
      replayed: false,
    });
    for (const invalid of [null, [], "text"])
      await expect(
        f.ledger.storeTaskOutput(coverageFence, invalid as never),
      ).rejects.toThrow("JSON object");
  });
  it.each(["storeTaskOutput", "completeTask"] as const)(
    "propagates %s compare-and-set failure",
    async (method) => {
      const f = ledgerFixture();
      f.tx.siteBuildTaskAttempt.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        f.ledger[method](coverageFence, { done: true }),
      ).rejects.toThrow();
    },
  );
  it("does not close a run with a blank terminal reason or absent budget", async () => {
    const f = ledgerFixture();
    await expect(
      f.ledger.closeAndSummarize({ ...coverageScope, reason: " " }),
    ).rejects.toThrow("reason");
    f.tx.siteBuildBudget.findUnique.mockResolvedValue(null);
    await expect(
      f.ledger.closeAndSummarize({ ...coverageScope, reason: "run_succeeded" }),
    ).rejects.toThrow("DENIED_NO_BUDGET");
  });
});

describe("append-only reconciliation identity and cap variance", () => {
  it.each([
    "empty-resolver",
    "long-resolver",
    "digest",
    "missing-digest",
    "missing-basis",
    "numeric-cost",
    "negative-cost",
    "leading-zero",
    "overflow",
    "unresolved-cost",
    "unresolved-basis",
  ])("rejects malformed %s before persistence", async (field) => {
    const f = ledgerFixture();
    const observation: Record<string, unknown> = { ...coverageObservation };
    if (field === "empty-resolver") observation.resolverId = " ";
    if (field === "long-resolver") observation.resolverId = "x".repeat(192);
    if (field === "digest") observation.receiptDigest = "not-a-digest";
    if (field === "missing-digest") delete observation.receiptDigest;
    if (field === "missing-basis") delete observation.costBasis;
    if (field === "numeric-cost") observation.exactCostMicrousd = 10;
    if (field === "negative-cost") observation.exactCostMicrousd = "-1";
    if (field === "leading-zero") observation.exactCostMicrousd = "01";
    if (field === "overflow")
      observation.exactCostMicrousd = "9223372036854775808";
    if (field === "unresolved-cost" || field === "unresolved-basis") {
      observation.status = "UNRESOLVED";
      if (field === "unresolved-cost") delete observation.costBasis;
      else delete observation.exactCostMicrousd;
    }
    await expect(
      f.ledger.appendReconciliation({
        ...coverageScope,
        spendId: "spend",
        observation: observation as never,
      }),
    ).rejects.toThrow();
    expect(f.database.withWorkspace).not.toHaveBeenCalled();
  });
  it("requires an owned spend scope before appending an observation", async () => {
    const f = ledgerFixture();
    f.tx.siteBuildSpend.findFirst.mockResolvedValue(null);
    await expect(
      f.ledger.appendReconciliation({
        ...coverageScope,
        spendId: "spend",
        observation: coverageObservation,
      }),
    ).rejects.toThrow("spend scope");
  });
  it("replays the exact receipt without another event or append", async () => {
    const f = ledgerFixture();
    f.tx.siteBuildSpendReconciliation.findFirst.mockResolvedValue({
      receiptDigest: coverageObservation.receiptDigest,
    });
    await f.ledger.appendReconciliation({
      ...coverageScope,
      spendId: "spend",
      observation: coverageObservation,
    });
    expect(f.tx.siteBuildSpendReconciliation.create).not.toHaveBeenCalled();
    expect(f.tx.outboxEvent.create).not.toHaveBeenCalled();
  });
  it("records conflict rather than replacing an earlier resolved receipt", async () => {
    const f = ledgerFixture();
    f.tx.siteBuildSpendReconciliation.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ receiptDigest: "c".repeat(64) })
      .mockResolvedValueOnce({ attemptNo: 3 });
    await f.ledger.appendReconciliation({
      ...coverageScope,
      spendId: "spend",
      observation: {
        ...coverageObservation,
        requestId: "synthetic-request",
        inputTokens: 3,
        outputTokens: 2,
      },
    });
    expect(
      f.tx.siteBuildSpendReconciliation.create.mock.calls[0][0].data,
    ).toMatchObject({
      status: "CONFLICT",
      attemptNo: 4,
      exactCostMicrousd: null,
      meta: { reason: "conflicting_resolved_receipt" },
    });
  });
  it.each([false, true])(
    "records cap variance and disables paid calls without losing exact cost, prior=%s",
    async (prior) => {
      const f = ledgerFixture();
      if (prior)
        f.tx.siteBuildSpendReconciliation.findFirst
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ attemptNo: 2 });
      await f.ledger.appendReconciliation({
        ...coverageScope,
        spendId: "spend",
        observation: {
          ...coverageObservation,
          exactCostMicrousd: "101",
          requestId: "synthetic-request",
          inputTokens: 1,
          outputTokens: 1,
        },
      });
      expect(f.tx.siteBuildSpendReconciliation.create).toHaveBeenCalledTimes(2);
      expect(
        f.tx.siteBuildSpendReconciliation.create.mock.calls[0][0].data
          .exactCostMicrousd,
      ).toBe(101n);
      expect(
        f.tx.siteBuildSpendReconciliation.create.mock.calls[1][0].data,
      ).toMatchObject({
        status: "CONFLICT",
        attemptNo: prior ? 4 : 2,
        meta: {
          reason: "CAP_VARIANCE",
          observedMicrousd: "101",
          authorizedMicrousd: "100",
        },
      });
      expect(f.tx.$queryRaw).toHaveBeenCalledOnce();
      expect(f.tx.outboxEvent.create).toHaveBeenCalledOnce();
    },
  );
  it("keeps unresolved observations non-exact and fails if the summary budget vanishes", async () => {
    const f = ledgerFixture();
    f.tx.siteBuildBudget.findUnique.mockResolvedValue(null);
    await expect(
      f.ledger.appendReconciliation({
        ...coverageScope,
        spendId: "spend",
        observation: {
          status: "UNRESOLVED",
          resolverId: "resolver",
          observedAt: coverageNow,
        },
      }),
    ).rejects.toThrow("DENIED_NO_BUDGET");
    expect(
      f.tx.siteBuildSpendReconciliation.create.mock.calls[0][0].data,
    ).toMatchObject({
      exactCostMicrousd: null,
      receiptDigest: null,
      costBasis: null,
      inputTokens: null,
    });
    expect(f.tx.outboxEvent.create).not.toHaveBeenCalled();
  });
});

const coverageReservation = {
  ...coverageScope,
  operationKey: "a".repeat(64),
  kind: "tool" as const,
  taskId: "task",
  subject: "tool",
  reservationMicrousd: 100,
};
describe("unknown settlement and missing database acknowledgements", () => {
  it.each(["invalid-key", "empty", "unknown-replay", "unknown", "denied"])(
    "fails closed on %s reservation result",
    async (failure) => {
      const f = ledgerFixture();
      if (failure === "empty") f.tx.$queryRaw.mockResolvedValue([]);
      else
        f.tx.$queryRaw.mockResolvedValue([
          {
            decision:
              failure === "unknown-replay"
                ? "REPLAY"
                : failure === "unknown"
                  ? "UNKNOWN"
                  : "DENIED",
            spend_status: failure === "unknown-replay" ? "UNKNOWN" : null,
          },
        ]);
      await expect(
        f.ledger.reserveOperation({
          ...coverageReservation,
          operationKey:
            failure === "invalid-key"
              ? "bad"
              : coverageReservation.operationKey,
        }),
      ).rejects.toThrow();
    },
  );
  it("preserves absent status on a recorded replay without treating it as execution", async () => {
    const f = ledgerFixture();
    f.tx.$queryRaw.mockResolvedValue([
      {
        decision: "REPLAY",
        spend_status: null,
        cached_result: null,
        cached_error_code: null,
      },
    ]);
    expect(await f.ledger.reserveOperation(coverageReservation)).toMatchObject({
      kind: "replay",
      status: "UNKNOWN",
    });
  });
  it.each(["paired", "result", "disable", "blank-disable", "known-disable"])(
    "refuses invalid UNKNOWN %s settlement before persistence",
    async (failure) => {
      const f = ledgerFixture();
      const measurement = {
        basis: "unknown",
        budgetChargeMicrousd: 100,
        reportedCostMicrousd: null,
        calculatedCostMicrousd: null,
        estimatedCostMicrousd: null,
        inputTokens: null,
        outputTokens: null,
        callCount: 1,
        meta: {},
      };
      await expect(
        f.ledger.settleOperation({
          scope: coverageReservation,
          status:
            failure === "paired" || failure === "known-disable"
              ? "SUCCEEDED"
              : "UNKNOWN",
          measurement: {
            ...measurement,
            ...(failure === "known-disable" ? { basis: "token_pricing" } : {}),
          } as never,
          result: failure === "result" ? { output: true } : undefined,
          disablePaidCallsReason:
            failure === "disable"
              ? undefined
              : failure === "blank-disable"
                ? " "
                : "unknown",
        }),
      ).rejects.toThrow();
      expect(f.tx.$queryRaw).not.toHaveBeenCalled();
    },
  );
  it("reports missing settlement response without inventing a successful ACK", async () => {
    const f = ledgerFixture();
    f.tx.$queryRaw.mockResolvedValue([]);
    expect(
      await f.ledger.settleOperation({
        scope: coverageReservation,
        status: "SUCCEEDED",
        measurement: legacyToolCostMeasurement(1, 100),
      }),
    ).toBe("MISSING");
  });
  it("requires the budget when over-reservation truth must be projected", async () => {
    const f = ledgerFixture();
    f.tx.$queryRaw.mockResolvedValue([{ decision: "OVER_RESERVATION" }]);
    f.tx.siteBuildBudget.findUnique.mockResolvedValue(null);
    await expect(
      f.ledger.settleOperation({
        scope: coverageReservation,
        status: "SUCCEEDED",
        measurement: legacyToolCostMeasurement(1, 100),
      }),
    ).rejects.toThrow("DENIED_NO_BUDGET");
  });
  it.each([
    "recordModelReadbackProbe",
    "finalizeModelPhysicalWire",
    "recordModelPhysicalWireReceipt",
    "finalizeModelPhysicalWireFromReceipt",
    "finalizeModelPhysicalWireNotDispatched",
  ] as const)("does not accept an empty %s response", async (method) => {
    const f = ledgerFixture();
    f.tx.$queryRaw.mockResolvedValue([]);
    const observation = {
      status: "settled",
      alias: "model",
      protocol: "openai-responses",
      channelId: 1,
      quota: 1,
      costMicrousd: 1,
      inputTokens: 1,
      outputTokens: 1,
      upstreamIdState: "observed",
      transportObservation: {
        finalPhase: "gateway_log_found",
        gatewayIdState: "observed",
        upstreamIdState: "observed",
        payloadState: "available",
      },
    };
    await expect(
      f.ledger[method]({
        workspaceId: "ws",
        wireAttemptId: "wire",
        probeId: "probe",
        probe: { phase: "http_response", httpStatusClass: 2 },
        observation,
        receiptDigest: "b".repeat(64),
        observedAt: coverageNow,
      } as never),
    ).rejects.toMatchObject({
      errorCode: expect.stringContaining("ACK_UNKNOWN"),
    });
  });
});

describe("provider receipt aggregation boundaries", () => {
  function completeFixture() {
    const f = ledgerFixture();
    const wire = { id: "wire", physicalWireAttempt: 1, state: "OBSERVED" };
    const receipt = {
      wireAttemptId: "wire",
      receiptDigest: "b".repeat(64),
      exactCostMicrousd: 10n,
      inputTokens: 1,
      outputTokens: 1,
    };
    f.tx.siteBuildProviderWireAttempt.findMany.mockResolvedValue([wire]);
    f.tx.siteBuildProviderWireReceipt.findMany.mockResolvedValue([receipt]);
    return { ...f, wire, receipt };
  }
  const scope = {
    ...coverageScope,
    spendId: "spend",
    resolverId: "resolver",
    observedAt: coverageNow,
  };
  it.each(["spend", "wires"])(
    "does not reconcile missing %s provenance",
    async (missing) => {
      const f = completeFixture();
      if (missing === "spend")
        f.tx.siteBuildSpend.findFirst.mockResolvedValue(null);
      else f.tx.siteBuildProviderWireAttempt.findMany.mockResolvedValue([]);
      expect(
        await f.ledger.completeProviderSpendReconciliation(scope),
      ).toMatchObject({
        status: "UNRESOLVED",
        meta: { reason: "provider_wire_scope_unavailable" },
      });
    },
  );
  it.each(["count", "duplicate", "foreign"])(
    "rejects incomplete %s receipt sets",
    async (failure) => {
      const f = completeFixture();
      if (failure === "count")
        f.tx.siteBuildProviderWireReceipt.findMany.mockResolvedValue([]);
      if (failure === "duplicate") {
        f.tx.siteBuildProviderWireAttempt.findMany.mockResolvedValue([
          f.wire,
          { ...f.wire, id: "second" },
        ]);
        f.tx.siteBuildProviderWireReceipt.findMany.mockResolvedValue([
          f.receipt,
          f.receipt,
        ]);
      }
      if (failure === "foreign") f.receipt.wireAttemptId = "foreign";
      expect(
        await f.ledger.completeProviderSpendReconciliation(scope),
      ).toMatchObject({
        status: "UNRESOLVED",
        meta: { reason: "provider_wire_receipts_incomplete" },
      });
    },
  );
  it.each(["cost", "input", "output"])(
    "rejects unsafe %s aggregates rather than truncating exact facts",
    async (field) => {
      const f = completeFixture();
      if (field === "cost")
        f.receipt.exactCostMicrousd = 9_223_372_036_854_775_808n;
      if (field === "input")
        f.receipt.inputTokens = Number.MAX_SAFE_INTEGER + 1;
      if (field === "output")
        f.receipt.outputTokens = Number.MAX_SAFE_INTEGER + 1;
      expect(
        await f.ledger.completeProviderSpendReconciliation(scope),
      ).toMatchObject({
        status: "UNRESOLVED",
        meta: { reason: "provider_wire_receipt_aggregate_invalid" },
      });
    },
  );
  it("does not finish a reserved spend while a physical dispatch remains active", async () => {
    const f = completeFixture();
    f.tx.siteBuildSpend.findFirst.mockResolvedValue({ status: "RESERVED" });
    f.wire.state = "DISPATCH_STARTED";
    expect(
      await f.ledger.completeProviderSpendReconciliation(scope),
    ).toMatchObject({
      status: "UNRESOLVED",
      meta: { reason: "provider_wire_observation_incomplete" },
    });
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
  });
  it.each(["empty", "denied"])(
    "does not turn %s settlement ACK into resolved spend truth",
    async (failure) => {
      const f = completeFixture();
      f.tx.siteBuildSpend.findFirst.mockResolvedValue({
        status: "RESERVED",
        operationKey: "a".repeat(64),
        fenceToken: null,
        reservationMicrousd: 100n,
      });
      f.tx.$queryRaw.mockResolvedValue(
        failure === "empty" ? [] : [{ decision: "DENIED" }],
      );
      expect(
        await f.ledger.completeProviderSpendReconciliation(scope),
      ).toMatchObject({
        status: "UNRESOLVED",
        meta: { reason: "provider_spend_ack_recovery_unavailable" },
      });
    },
  );
  it("retains unknown charge when no receipt exists after physical dispatch", async () => {
    const f = completeFixture();
    f.tx.siteBuildSpend.findFirst.mockResolvedValue({
      status: "RESERVED",
      operationKey: "a".repeat(64),
      fenceToken: null,
      reservationMicrousd: 100n,
    });
    f.wire.state = "UNKNOWN";
    f.tx.siteBuildProviderWireReceipt.findMany.mockResolvedValue([]);
    expect(
      await f.ledger.completeProviderSpendReconciliation(scope),
    ).toMatchObject({ status: "UNRESOLVED" });
    const values = f.tx.$queryRaw.mock.calls[0].slice(1);
    expect(values).toContain(100n);
    expect(values.filter((v) => v === null).length).toBeGreaterThanOrEqual(2);
  });
});

function coverageWireRow() {
  return {
    id: "wire",
    ...coverageScope,
    spendId: "spend",
    operationKey: "a".repeat(64),
    physicalWireAttempt: 1,
    derivationKeyId: "synthetic",
    settlementRequestId: "synthetic-request",
    settlementNonceSha256: "b".repeat(64),
    resolverId: "resolver",
    protocol: "openai-responses",
    requestedAlias: "model",
    expectedChannelId: 1,
    actualMaxOutputTokens: 100,
    maximumQuotaPoints: 10n,
    inputPriceMicrounitsPerMillion: 10n,
    outputPriceMicrounitsPerMillion: 10n,
    ledgerMicrousdPerPricingUnit: 10n,
    state: "OBSERVED",
    createdAt: new Date(coverageNow.getTime() - 120_000) as Date | null,
    observedAt: new Date(coverageNow.getTime() - 120_000) as Date | null,
    dispatchStartedAt: null as Date | null,
    receipt: null as { id: string } | null,
    spend: {
      createdAt: new Date(coverageNow.getTime() - 120_000) as Date | null,
      reconciliations: [] as Array<{ status: string; observedAt: Date }>,
    },
  };
}
describe("bounded reconciliation enumeration and expiration", () => {
  it.each([
    "missing-start",
    "live",
    "missing-time",
    "too-soon",
    "terminal",
    "unsafe-integer",
    "allocated-young",
  ])("does not enumerate %s work as immediately resolvable", async (reason) => {
    const f = ledgerFixture();
    const row = coverageWireRow();
    if (reason === "missing-start") row.state = "DISPATCH_STARTED";
    if (reason === "live") {
      row.state = "DISPATCH_STARTED";
      row.dispatchStartedAt = coverageNow;
    }
    if (reason === "missing-time") {
      row.createdAt = null;
      row.observedAt = null;
      row.spend.createdAt = null;
    }
    if (reason === "too-soon") row.observedAt = coverageNow;
    if (reason === "terminal")
      row.spend.reconciliations = [
        { status: "RESOLVED", observedAt: coverageNow },
      ];
    if (reason === "unsafe-integer")
      row.maximumQuotaPoints = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    if (reason === "allocated-young") row.state = "ALLOCATED";
    f.tx.siteBuildProviderWireAttempt.findMany.mockResolvedValue([row]);
    expect(await f.ledger.listPendingReconciliations("ws")).toEqual([]);
  });
  it("chooses the earliest unresolved physical boundary within each spend and caps the output page", async () => {
    const f = ledgerFixture();
    const old = new Date(coverageNow.getTime() - 86_400_000);
    const rows = [
      { ...coverageWireRow(), id: "observed", receipt: { id: "receipt" } },
      { ...coverageWireRow(), id: "unknown", state: "UNKNOWN" },
      {
        ...coverageWireRow(),
        id: "started-receipt",
        state: "DISPATCH_STARTED",
        dispatchStartedAt: old,
        receipt: { id: "receipt" },
      },
      {
        ...coverageWireRow(),
        id: "started",
        state: "DISPATCH_STARTED",
        dispatchStartedAt: old,
      },
      {
        ...coverageWireRow(),
        id: "allocated",
        state: "ALLOCATED",
        createdAt: old,
      },
      { ...coverageWireRow(), id: "different", spendId: "other" },
    ];
    f.tx.siteBuildProviderWireAttempt.findMany.mockResolvedValue(rows);
    const result = await f.ledger.listPendingReconciliations("ws", 1);
    expect(result).toHaveLength(1);
    expect(result[0].wireAttemptId).toBe("started");
  });
  it("falls back through observed, dispatch, created and spend timestamps without dropping due work", async () => {
    const f = ledgerFixture();
    const rows = [
      coverageWireRow(),
      {
        ...coverageWireRow(),
        spendId: "two",
        observedAt: null,
        dispatchStartedAt: new Date(0),
      },
      { ...coverageWireRow(), spendId: "three", observedAt: null },
      {
        ...coverageWireRow(),
        spendId: "four",
        observedAt: null,
        createdAt: null,
      },
    ];
    f.tx.siteBuildProviderWireAttempt.findMany.mockResolvedValue(rows);
    expect(await f.ledger.listPendingReconciliations("ws", 10)).toHaveLength(4);
  });
  it("records resolver failure as unresolved and continues to the next candidate", async () => {
    const f = ledgerFixture();
    const candidate = {
      ...coverageWireRow(),
      wireAttemptId: "wire",
      action: "RESOLVE" as const,
    };
    vi.spyOn(f.ledger, "listPendingReconciliations").mockResolvedValue([
      candidate,
      { ...candidate, spendId: "other" },
    ] as never);
    const append = vi
      .spyOn(f.ledger, "appendReconciliation")
      .mockResolvedValue({} as never);
    const resolve = vi
      .fn()
      .mockRejectedValueOnce(new Error("synthetic unavailable"))
      .mockResolvedValueOnce(coverageObservation);
    expect(
      await f.ledger.runReconciliationSweep({ workspaceId: "ws", resolve }),
    ).toEqual({ attempted: 2, resolved: 1 });
    expect(append.mock.calls[0][0].observation).toMatchObject({
      status: "UNRESOLVED",
      meta: { reason: "resolver_unavailable" },
    });
  });
  it.each([
    "allocated-unresolved",
    "allocated-error",
    "recorded-unresolved",
    "started-unresolved",
    "observed-unresolved",
  ])("expires %s conservatively without declaring exact zero", async (kind) => {
    const f = ledgerFixture();
    const candidate = {
      ...coverageWireRow(),
      wireAttemptId: "wire",
      action: "EXPIRE",
      wireState: kind.startsWith("allocated")
        ? "ALLOCATED"
        : kind.startsWith("started")
          ? "DISPATCH_STARTED"
          : "OBSERVED",
      receiptRecorded: kind === "recorded-unresolved",
    };
    vi.spyOn(f.ledger, "listPendingReconciliations").mockResolvedValue([
      candidate,
    ] as never);
    vi.spyOn(
      f.ledger,
      "finalizeModelPhysicalWireNotDispatched",
    ).mockResolvedValue(undefined);
    vi.spyOn(f.ledger, "finalizeModelPhysicalWire").mockResolvedValue(
      undefined,
    );
    vi.spyOn(
      f.ledger,
      "finalizeModelPhysicalWireFromReceipt",
    ).mockResolvedValue(undefined);
    const complete = vi
      .spyOn(f.ledger, "completeProviderSpendReconciliation")
      .mockResolvedValue({
        status: "UNRESOLVED",
        resolverId: "resolver",
        observedAt: coverageNow,
      });
    if (kind === "allocated-error")
      complete.mockRejectedValue(new Error("synthetic database ACK unknown"));
    const append = vi
      .spyOn(f.ledger, "appendReconciliation")
      .mockResolvedValue({} as never);
    expect(
      await f.ledger.runReconciliationSweep({
        workspaceId: "ws",
        resolve: vi.fn(),
      }),
    ).toEqual({ attempted: 1, resolved: 0 });
    expect(append.mock.calls[0][0].observation).toMatchObject({
      status: kind === "allocated-error" ? "UNRESOLVED" : "EXPIRED",
    });
    expect(
      append.mock.calls[0][0].observation.exactCostMicrousd,
    ).toBeUndefined();
  });
});

describe("bounded accounting metadata and conservative measurement", () => {
  it.each([
    { a: { b: { c: { d: { e: 1 } } } } },
    { rows: Array.from({ length: 33 }, () => 1) },
    Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`field${i}`, 1])),
    { ["x".repeat(65)]: 1 },
    Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`field${i}`, "x".repeat(512)]),
    ),
    { rows: Array.from({ length: 32 }, () => [1, 2, 3, 4]) },
  ])(
    "rejects complex or oversized metadata without truncating evidence",
    (meta) => {
      expect(() => boundedReconciliationMeta(meta)).toThrow();
    },
  );
  it("preserves bounded nested arrays and null values", () => {
    expect(
      boundedReconciliationMeta({ ids: ["one", null, { ordinal: 2 }] }),
    ).toEqual({ ids: ["one", null, { ordinal: 2 }] });
  });
  it("waits after the bounded retry schedule is exhausted until expiration", () => {
    expect(
      reconciliationDueAction({
        now: coverageNow,
        spendCreatedAt: new Date(coverageNow.getTime() - 1000),
        observations: Array.from({ length: 5 }, () => ({
          status: "UNRESOLVED",
          observedAt: coverageNow,
        })),
      }),
    ).toBe("WAIT");
  });
  it("rejects negative summary amounts instead of serializing invalid ledger truth", () => {
    const f = ledgerFixture();
    expect(() =>
      buildSiteBuildCostSummary({ ...f.budget, capMicrousd: -1n }, []),
    ).toThrow();
  });
  it("treats negative legacy cost as unknown and keeps the reservation upper bound", () => {
    expect(legacyToolCostMeasurement(-1, 100)).toMatchObject({
      basis: "unknown",
      budgetChargeMicrousd: 100,
    });
  });
  it("keeps known-price output with incomplete token usage conservatively charged", () => {
    expect(
      modelCostMeasurement({
        taskId: "site_builder.brand_profile",
        requestedModel: "gpt-5.6-terra",
        resolvedModel: "gpt-5.6-terra",
        usage: { inputTokens: 10 },
        reservationMicrousd: 100,
      }),
    ).toMatchObject({
      basis: "estimated_upper_bound",
      budgetChargeMicrousd: 100,
      meta: {
        reason: "token_usage_incomplete",
        resolvedModel: "gpt-5.6-terra",
      },
    });
  });
  it("does not apply the requested price to a different resolved model", () => {
    expect(
      modelCostMeasurement({
        taskId: "site_builder.brand_profile",
        requestedModel: "gpt-5.6-terra",
        resolvedModel: "different-model",
        usage: { inputTokens: 10, outputTokens: 2 },
        reservationMicrousd: 100,
      }),
    ).toMatchObject({
      basis: "estimated_upper_bound",
      meta: { reason: "no_verified_price" },
    });
  });
});
