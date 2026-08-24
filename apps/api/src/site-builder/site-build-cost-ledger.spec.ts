import { describe, expect, it, vi } from 'vitest';
import {
  buildSiteBuildCostSummary,
  boundedReconciliationMeta,
  legacyToolCostMeasurement,
  modelCostMeasurement,
  paidOperationKey,
  reconciliationDueAction,
  SiteBuildCostLedger,
  SITE_BUILD_COST_SUMMARY_VERSION,
} from './site-build-cost-ledger';
import { VERIFIED_GATEWAY_MODEL_TRANSPORTS } from '../model-gateway/model-transports';
import {
  resolveTaskExecutionTarget,
  SITE_BUILDER_TASK_IDS,
} from './agents/task-routes';

describe('R4-B cost truth classification', () => {
  it('uses measured tokens and the frozen MODEL-1 price snapshot without calling it provider-reported', () => {
    const measurement = modelCostMeasurement({
      taskId: 'site_builder.brand_profile',
      requestedModel: 'gpt-5.6-terra',
      resolvedModel: 'gpt-5.6-terra',
      usage: { inputTokens: 1_000, outputTokens: 500 },
      reservationMicrousd: 800_000,
    });

    expect(measurement).toMatchObject({
      basis: 'token_pricing',
      budgetChargeMicrousd: 1_000,
      calculatedCostMicrousd: 1_000,
      reportedCostMicrousd: null,
      estimatedCostMicrousd: null,
      inputTokens: 1_000,
      outputTokens: 500,
    });
    expect(measurement.meta).toMatchObject({
      pricingSnapshot: {
        model: 'gpt-5.6-terra',
        inputUsdPerMillionTokens: 0.25,
        outputUsdPerMillionTokens: 1.5,
      },
    });
  });

  it('prefers provider-reported cost and preserves exact zero', () => {
    expect(
      modelCostMeasurement({
        taskId: 'site_builder.brand_profile',
        requestedModel: 'gpt-5.6-terra',
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        reservationMicrousd: 800_000,
      }),
    ).toMatchObject({
      basis: 'provider_reported',
      budgetChargeMicrousd: 0,
      reportedCostMicrousd: 0,
      calculatedCostMicrousd: null,
      estimatedCostMicrousd: null,
    });
  });

  it('keeps valid unpriced model output successful at the conservative upper bound', () => {
    expect(
      modelCostMeasurement({
        taskId: 'site_builder.brand_profile',
        requestedModel: 'operator-override-without-price',
        usage: { inputTokens: 25, outputTokens: 5 },
        reservationMicrousd: 800_000,
      }),
    ).toMatchObject({
      basis: 'estimated_upper_bound',
      budgetChargeMicrousd: 800_000,
      reportedCostMicrousd: null,
      calculatedCostMicrousd: null,
      estimatedCostMicrousd: 800_000,
      inputTokens: 25,
      outputTokens: 5,
    });
  });

  it('accepts request-bound new-api settlement for every active model dispatch', () => {
    for (const taskId of SITE_BUILDER_TASK_IDS) {
      const target = resolveTaskExecutionTarget(taskId);
      if (target.kind === 'deterministic_fallback') continue;
      const route = target.route;
      for (const alias of [route.primary, ...route.fallbacks]) {
        const protocol = VERIFIED_GATEWAY_MODEL_TRANSPORTS[alias] ?? 'openai-chat-completions';
        const settlementPreflight = {
          schemaVersion: 'site-builder-paid-model-preflight-evidence/v2' as const,
          attestationId: 'runtime-seven-task-test',
          snapshotSha256: 'a'.repeat(64),
          resolverId: 'new-api-token-log-v1',
          taskId,
          alias,
          protocol,
          expectedChannelId: 17,
          pricingAuthority: 'openox_model_marketplace' as const,
          pricingSourceUrl: 'https://openox.tech/api/public/pricing-catalog',
          pricingSnapshotSha256: 'c'.repeat(64),
          pricingCurrency: 'CNY' as const,
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
                status: 'settled',
                requestId: `req_${taskId.replaceAll('.', '_')}_${alias}`,
                resolverId: settlementPreflight.resolverId,
                alias,
                protocol,
                channelId: settlementPreflight.expectedChannelId,
                basis: 'openox_catalog_token_pricing' as const,
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
          basis: 'token_pricing',
          budgetChargeMicrousd: 2_500,
          reportedCostMicrousd: null,
          calculatedCostMicrousd: 2_500,
        });
      }
    }
  });

  it('keeps valid partial settlement successful at the conservative upper bound', () => {
    const settlementPreflight = {
      schemaVersion: 'site-builder-paid-model-preflight-evidence/v2' as const,
      attestationId: 'runtime-repair-test',
      snapshotSha256: 'b'.repeat(64),
      resolverId: 'new-api-token-log-v1',
      taskId: 'site_builder.copy',
      alias: 'deepseek-v4-pro',
      protocol: 'openai-chat-completions' as const,
      expectedChannelId: 11,
      pricingAuthority: 'openox_model_marketplace' as const,
      pricingSourceUrl: 'https://openox.tech/api/public/pricing-catalog',
      pricingSnapshotSha256: 'c'.repeat(64),
      pricingCurrency: 'CNY' as const,
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
              status: 'settled',
              requestId: 'req_first_wire_call',
              resolverId: settlementPreflight.resolverId,
              alias: settlementPreflight.alias,
              protocol: settlementPreflight.protocol,
              channelId: settlementPreflight.expectedChannelId + 1,
              basis: 'openox_catalog_token_pricing' as const,
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
      basis: 'estimated_upper_bound',
      budgetChargeMicrousd: 400_000,
      estimatedCostMicrousd: 400_000,
      reportedCostMicrousd: null,
    });
  });

  it('fails closed on replayed request IDs, model drift, or cost above the attested bound', () => {
    const settlementPreflight = {
      schemaVersion: 'site-builder-paid-model-preflight-evidence/v2' as const,
      attestationId: 'runtime-strict-settlement-test',
      snapshotSha256: 'd'.repeat(64),
      resolverId: 'new-api-token-log-v1',
      taskId: 'site_builder.copy',
      alias: 'deepseek-v4-pro',
      protocol: 'openai-chat-completions' as const,
      expectedChannelId: 11,
      pricingAuthority: 'openox_model_marketplace' as const,
      pricingSourceUrl: 'https://openox.tech/api/public/pricing-catalog',
      pricingSnapshotSha256: 'e'.repeat(64),
      pricingCurrency: 'CNY' as const,
      inputPriceMicrounitsPerMillionTokens: 2_000_000,
      outputPriceMicrounitsPerMillionTokens: 10_000_000,
      ledgerMicrousdPerPricingUnit: 1_000_000,
      gatewayCredentialQuotaCapPoints: 5_000_000,
      gatewayCredentialRemainingPoints: 4_500_000,
      maxOutputTokensPerCall: 1_000,
      pricedMaximumMicrousd: 50_000,
    };
    const observation = (requestId: string, costMicrousd = 1_000) => ({
      status: 'settled' as const,
      requestId,
      resolverId: settlementPreflight.resolverId,
      alias: settlementPreflight.alias,
      protocol: settlementPreflight.protocol,
      channelId: settlementPreflight.expectedChannelId,
      basis: 'openox_catalog_token_pricing' as const,
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
        gatewaySettlements: [observation('req_reused_wire_id'), observation('req_reused_wire_id')],
      }).basis,
    ).toBe('estimated_upper_bound');
    expect(
      measure({
        resolvedModel: 'different-upstream-model',
        callCount: 1,
        gatewaySettlements: [observation('req_model_drift')],
      }).basis,
    ).toBe('estimated_upper_bound');
    expect(
      measure({
        resolvedModel: settlementPreflight.alias,
        callCount: 1,
        gatewaySettlements: [observation('req_cost_over_bound', 50_001)],
      }).basis,
    ).toBe('estimated_upper_bound');
    expect(
      measure({
        resolvedModel: settlementPreflight.alias,
        callCount: 1,
        gatewaySettlements: [
          {
            ...observation('req_output_tokens_over_bound'),
            outputTokens: 1_001,
          },
        ],
      }).basis,
    ).toBe('estimated_upper_bound');
  });

  it('persists authoritative token totals from every settled log observation', () => {
    const settlementPreflight = {
      schemaVersion: 'site-builder-paid-model-preflight-evidence/v2' as const,
      attestationId: 'runtime-token-total-test',
      snapshotSha256: 'f'.repeat(64),
      resolverId: 'new-api-token-log-v1',
      taskId: 'site_builder.copy',
      alias: 'deepseek-v4-pro',
      protocol: 'openai-chat-completions' as const,
      expectedChannelId: 11,
      pricingAuthority: 'openox_model_marketplace' as const,
      pricingSourceUrl: 'https://openox.tech/api/public/pricing-catalog',
      pricingSnapshotSha256: 'a'.repeat(64),
      pricingCurrency: 'CNY' as const,
      inputPriceMicrounitsPerMillionTokens: 2_000_000,
      outputPriceMicrounitsPerMillionTokens: 10_000_000,
      ledgerMicrousdPerPricingUnit: 1_000_000,
      gatewayCredentialQuotaCapPoints: 5_000_000,
      gatewayCredentialRemainingPoints: 4_500_000,
      maxOutputTokensPerCall: 1_000,
      pricedMaximumMicrousd: 50_000,
    };
    const settled = (requestId: string, inputTokens: number, outputTokens: number) => ({
      status: 'settled' as const,
      requestId,
      resolverId: settlementPreflight.resolverId,
      alias: settlementPreflight.alias,
      protocol: settlementPreflight.protocol,
      channelId: settlementPreflight.expectedChannelId,
      basis: 'openox_catalog_token_pricing' as const,
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
            settled('req_token_total_1', 10, 5),
            settled('req_token_total_2', 20, 7),
          ],
        },
        reservationMicrousd: 80_000,
      }),
    ).toMatchObject({
      basis: 'token_pricing',
      inputTokens: 30,
      outputTokens: 12,
      calculatedCostMicrousd: 2_000,
    });
  });

  it('labels legacy ToolBroker costCents as an estimate instead of actual cost', () => {
    expect(legacyToolCostMeasurement(2, 30_000)).toEqual({
      basis: 'legacy_estimate',
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

describe('R4-B stable BuildRun cost summary', () => {
  it('preserves the PostgreSQL BIGINT maximum as canonical decimal strings', () => {
    const maximum = 9_223_372_036_854_775_807n;
    const summary = buildSiteBuildCostSummary(
      {
        capMicrousd: maximum,
        reservedMicrousd: 0n,
        chargedMicrousd: maximum,
        paidCallsEnabled: false,
        disabledReason: 'budget_exhausted',
        exhaustedAt: null,
      },
      [
        {
          kind: 'model',
          status: 'SUCCEEDED',
          costBasis: 'provider_reported',
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
      authorizedCapMicrousd: '9223372036854775807',
      conservativeChargedMicrousd: '9223372036854775807',
      remainingMicrousd: '0',
    });
    expect(summary.totals).toMatchObject({
      reportedCostMicrousd: '9223372036854775807',
      exactCostMicrousd: '9223372036854775807',
    });
    expect(() => JSON.stringify(summary)).not.toThrow();
  });

  it('keeps budget charge separate from reported, calculated, estimated and unknown totals', () => {
    const summary = buildSiteBuildCostSummary(
      {
        capMicrousd: 5_000_000n,
        reservedMicrousd: 0n,
        chargedMicrousd: 821_000n,
        paidCallsEnabled: false,
        disabledReason: 'budget_exhausted',
        exhaustedAt: new Date('2026-07-19T10:00:00.000Z'),
      },
      [
        {
          kind: 'model',
          status: 'SUCCEEDED',
          budgetChargeMicrousd: 1_000n,
          reportedCostMicrousd: null,
          calculatedCostMicrousd: 1_000n,
          estimatedCostMicrousd: null,
          inputTokens: 1_000,
          outputTokens: 500,
          callCount: 1,
        },
        {
          kind: 'tool',
          status: 'SUCCEEDED',
          budgetChargeMicrousd: 20_000n,
          reportedCostMicrousd: null,
          calculatedCostMicrousd: null,
          estimatedCostMicrousd: 20_000n,
          inputTokens: null,
          outputTokens: null,
          callCount: 1,
        },
        {
          kind: 'model',
          status: 'UNKNOWN',
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
      currency: 'USD',
      unit: 'microusd',
      budget: {
        authorizedCapMicrousd: '5000000',
        conservativeChargedMicrousd: '821000',
        capMicrousd: '5000000',
        reservedMicrousd: '0',
        chargedMicrousd: '821000',
        remainingMicrousd: '4179000',
        paidCallsEnabled: false,
        disabledReason: 'budget_exhausted',
        exhaustedAt: '2026-07-19T10:00:00.000Z',
      },
      totals: {
        reportedCostMicrousd: '0',
        calculatedCostMicrousd: '1000',
        estimatedCostMicrousd: '20000',
        unknownOperations: 1,
        exactCostMicrousd: '1000',
        upperBoundCostMicrousd: '0',
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
        pendingOperations: 0,
        resolvedOperations: 0,
        conflictOperations: 0,
        asOf: null,
        revision: 0,
      },
    });
  });

  it('uses the persisted 1m/5m/30m/2h/12h retry cadence and expires at 24h', () => {
    const created = new Date('2026-08-16T00:00:00.000Z');
    const at = (milliseconds: number) => new Date(created.getTime() + milliseconds);
    expect(reconciliationDueAction({ now: at(59_999), spendCreatedAt: created, observations: [] })).toBe('WAIT');
    expect(reconciliationDueAction({ now: at(60_000), spendCreatedAt: created, observations: [] })).toBe('RESOLVE');

    const delays = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000];
    let observedAt = at(60_000);
    const observations: Array<{ status: string; observedAt: Date }> = [
      { status: 'UNRESOLVED', observedAt },
    ];
    for (const delay of delays) {
      expect(
        reconciliationDueAction({
          now: new Date(observedAt.getTime() + delay - 1),
          spendCreatedAt: created,
          observations,
        }),
      ).toBe('WAIT');
      observedAt = new Date(observedAt.getTime() + delay);
      expect(
        reconciliationDueAction({ now: observedAt, spendCreatedAt: created, observations }),
      ).toBe('RESOLVE');
      observations.push({ status: 'UNRESOLVED', observedAt });
    }

    expect(
      reconciliationDueAction({
        now: at(24 * 60 * 60_000),
        spendCreatedAt: created,
        observations,
      }),
    ).toBe('EXPIRE');
    expect(
      reconciliationDueAction({
        now: at(25 * 60 * 60_000),
        spendCreatedAt: created,
        observations: [{ status: 'RESOLVED', observedAt: at(60_000) }],
      }),
    ).toBe('TERMINAL');
  });

  it('rejects secrets, prompts, response bodies and oversized reconciliation metadata', () => {
    expect(boundedReconciliationMeta({ reason: 'resolver_unavailable', retry: 2 })).toEqual({
      reason: 'resolver_unavailable',
      retry: 2,
    });
    for (const key of ['credential', 'authorizationToken', 'prompt', 'responseBody', 'email']) {
      expect(() => boundedReconciliationMeta({ [key]: 'sensitive' })).toThrow(
        'forbidden key',
      );
    }
    expect(() => boundedReconciliationMeta({ reason: 'x'.repeat(513) })).toThrow(
      'too long',
    );
  });

  it('filters every terminal reconciliation before the database limit so old rows cannot starve due work', async () => {
    const findMany = vi.fn(async () => [
      {
        id: '00000000-0000-4000-8000-000000000001',
        workspaceId: '00000000-0000-4000-8000-000000000002',
        siteId: '00000000-0000-4000-8000-000000000003',
        buildRunId: '00000000-0000-4000-8000-000000000004',
        operationKey: 'a'.repeat(64),
        meta: null,
        createdAt: new Date('2026-08-16T00:00:00.000Z'),
        reconciliations: [],
      },
    ]);
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, fn: (tx: unknown) => unknown) =>
        fn({ siteBuildSpend: { findMany } }),
      ),
    };
    const ledger = new SiteBuildCostLedger(prisma as never, {
      now: () => new Date('2026-08-16T00:01:00.000Z'),
    });

    await expect(
      ledger.listPendingReconciliations(
        '00000000-0000-4000-8000-000000000002',
        1,
      ),
    ).resolves.toHaveLength(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 1,
        where: expect.objectContaining({
          reconciliations: {
            none: { status: { in: ['RESOLVED', 'CONFLICT', 'EXPIRED'] } },
          },
        }),
      }),
    );
  });

  it('makes an exact receipt replay produce zero run, reconciliation, and outbox writes', async () => {
    const updateRun = vi.fn();
    const createOutbox = vi.fn();
    const createReconciliation = vi.fn();
    const receiptDigest = 'b'.repeat(64);
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn(async () => []),
      siteBuildSpend: {
        findFirst: vi.fn(async () => ({
          id: '00000000-0000-4000-8000-000000000001',
          reservationMicrousd: 100n,
        })),
        findMany: vi.fn(async () => []),
      },
      siteBuildSpendReconciliation: {
        findFirst: vi.fn(async () => ({ id: 'prior', receiptDigest })),
        findMany: vi.fn(async () => [
          {
            spendId: '00000000-0000-4000-8000-000000000001',
            status: 'RESOLVED',
            exactCostMicrousd: 40n,
            createdAt: new Date('2026-08-16T00:01:00.000Z'),
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
          disabledReason: 'run_succeeded',
          exhaustedAt: null,
        })),
      },
      siteBuildRun: { update: updateRun },
      outboxEvent: { create: createOutbox },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, fn: (inner: unknown) => unknown) =>
        fn(tx),
      ),
    };
    const ledger = new SiteBuildCostLedger(prisma as never);

    await ledger.appendReconciliation({
      workspaceId: '00000000-0000-4000-8000-000000000002',
      siteId: '00000000-0000-4000-8000-000000000003',
      buildRunId: '00000000-0000-4000-8000-000000000004',
      spendId: '00000000-0000-4000-8000-000000000001',
      observation: {
        status: 'RESOLVED',
        resolverId: 'resolver-v1',
        receiptDigest,
        costBasis: 'provider_reported',
        exactCostMicrousd: '40',
        observedAt: new Date('2026-08-16T00:01:00.000Z'),
      },
    });

    expect(createReconciliation).not.toHaveBeenCalled();
    expect(updateRun).not.toHaveBeenCalled();
    expect(createOutbox).not.toHaveBeenCalled();
  });

  it('persists a first RESOLVED receipt and emits one cost-summary outbox event', async () => {
    const receiptDigest = 'c'.repeat(64);
    const createReconciliation = vi.fn(async () => ({ id: 'reconciliation-1' }));
    const updateRun = vi.fn(async () => ({ id: 'run-1' }));
    const createOutbox = vi.fn(async () => ({ id: 'outbox-1' }));
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn(async () => []),
      siteBuildSpend: {
        findFirst: vi.fn(async () => ({
          id: '00000000-0000-4000-8000-000000000001',
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
            spendId: '00000000-0000-4000-8000-000000000001',
            status: 'RESOLVED',
            exactCostMicrousd: 40n,
            createdAt: new Date('2026-08-16T00:01:00.000Z'),
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
          disabledReason: 'run_succeeded',
          exhaustedAt: null,
        })),
      },
      siteBuildRun: { update: updateRun },
      outboxEvent: { create: createOutbox },
    };
    const ledger = new SiteBuildCostLedger(
      {
        withWorkspace: vi.fn(
          async (_workspaceId: string, fn: (inner: unknown) => unknown) => fn(tx),
        ),
      } as never,
    );

    await ledger.appendReconciliation({
      workspaceId: '00000000-0000-4000-8000-000000000002',
      siteId: '00000000-0000-4000-8000-000000000003',
      buildRunId: '00000000-0000-4000-8000-000000000004',
      spendId: '00000000-0000-4000-8000-000000000001',
      observation: {
        status: 'RESOLVED',
        resolverId: 'new-api-request-bound-reconciliation-v1',
        requestId: 'req-cost-reconcile-001',
        receiptDigest,
        costBasis: 'token_pricing',
        exactCostMicrousd: '40',
        inputTokens: 10,
        outputTokens: 2,
        observedAt: new Date('2026-08-16T00:01:00.000Z'),
      },
    });

    expect(createReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'RESOLVED',
          receiptDigest,
          exactCostMicrousd: 40n,
        }),
      }),
    );
    expect(updateRun).toHaveBeenCalledTimes(1);
    expect(createOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'SiteBuildCostSummaryUpdated',
        }),
      }),
    );
  });

  it('appends CAP_VARIANCE beside an over-reservation exact receipt and projects the conflict once', async () => {
    const createReconciliation = vi.fn(async () => ({ id: 'reconciliation' }));
    const updateRun = vi.fn(async () => ({ id: 'run-1' }));
    const createOutbox = vi.fn(async () => ({ id: 'outbox-1' }));
    const disable = vi.fn(async () => [{ disable_site_build_paid_calls: 1 }]);
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: disable,
      siteBuildSpend: {
        findFirst: vi.fn(async () => ({
          id: '00000000-0000-4000-8000-000000000001',
          reservationMicrousd: 100n,
        })),
        findMany: vi.fn(async () => [
          {
            id: '00000000-0000-4000-8000-000000000001',
            kind: 'model',
            status: 'SUCCEEDED',
            costBasis: 'estimated_upper_bound',
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
            spendId: '00000000-0000-4000-8000-000000000001',
            status: 'RESOLVED',
            exactCostMicrousd: 140n,
            createdAt: new Date('2026-08-16T00:01:00.000Z'),
          },
          {
            spendId: '00000000-0000-4000-8000-000000000001',
            status: 'CONFLICT',
            exactCostMicrousd: null,
            createdAt: new Date('2026-08-16T00:01:00.000Z'),
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
          disabledReason: 'reconciliation_cap_variance',
          exhaustedAt: new Date('2026-08-16T00:01:00.000Z'),
        })),
      },
      siteBuildRun: { update: updateRun },
      outboxEvent: { create: createOutbox },
    };
    const ledger = new SiteBuildCostLedger(
      {
        withWorkspace: vi.fn(
          async (_workspaceId: string, fn: (inner: unknown) => unknown) => fn(tx),
        ),
      } as never,
    );

    const summary = await ledger.appendReconciliation({
      workspaceId: '00000000-0000-4000-8000-000000000002',
      siteId: '00000000-0000-4000-8000-000000000003',
      buildRunId: '00000000-0000-4000-8000-000000000004',
      spendId: '00000000-0000-4000-8000-000000000001',
      observation: {
        status: 'RESOLVED',
        resolverId: 'new-api-request-bound-reconciliation-v1',
        requestId: 'req-cost-reconcile-variance',
        receiptDigest: 'd'.repeat(64),
        costBasis: 'token_pricing',
        exactCostMicrousd: '140',
        inputTokens: 10,
        outputTokens: 2,
        observedAt: new Date('2026-08-16T00:01:00.000Z'),
      },
    });

    expect(createReconciliation).toHaveBeenCalledTimes(2);
    expect(createReconciliation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          attemptNo: 5,
          status: 'CONFLICT',
          resolverId: 'site-build-cap-variance-v1',
          meta: {
            reason: 'CAP_VARIANCE',
            observedMicrousd: '140',
            authorizedMicrousd: '100',
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

  it('derives a stable SHA-256 operation key from the full logical identity', () => {
    const a = paidOperationKey([
      'run-1',
      'site_builder.brand_profile',
      'model',
      'gpt-5.6-terra',
      'fallback-0',
    ]);
    const b = paidOperationKey([
      'run-1',
      'site_builder.brand_profile',
      'model',
      'gpt-5.6-terra',
      'fallback-0',
    ]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(
      paidOperationKey([
        'run-1',
        'site_builder.brand_profile',
        'model',
        'claude-sonnet-5',
        'fallback-1',
      ]),
    ).not.toBe(a);
  });
});
