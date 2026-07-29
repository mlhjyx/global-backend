import { describe, expect, it } from 'vitest';
import {
  buildSiteBuildCostSummary,
  legacyToolCostMeasurement,
  modelCostMeasurement,
  paidOperationKey,
  SITE_BUILD_COST_SUMMARY_VERSION,
} from './site-build-cost-ledger';
import { VERIFIED_GATEWAY_MODEL_TRANSPORTS } from '../model-gateway/model-transports';
import { resolveTaskRoute, SITE_BUILDER_TASK_IDS } from './agents/task-routes';

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

  it('keeps unpriced model usage unknown and charges only the conservative budget reservation', () => {
    expect(
      modelCostMeasurement({
        taskId: 'site_builder.brand_profile',
        requestedModel: 'operator-override-without-price',
        usage: { inputTokens: 25, outputTokens: 5 },
        reservationMicrousd: 800_000,
      }),
    ).toMatchObject({
      basis: 'unknown',
      budgetChargeMicrousd: 800_000,
      reportedCostMicrousd: null,
      calculatedCostMicrousd: null,
      estimatedCostMicrousd: null,
      inputTokens: 25,
      outputTokens: 5,
    });
  });

  it('accepts request-bound new-api settlement for every current Site Builder dispatch', () => {
    for (const taskId of SITE_BUILDER_TASK_IDS) {
      const route = resolveTaskRoute(taskId);
      for (const alias of [route.primary, ...route.fallbacks]) {
        const protocol =
          VERIFIED_GATEWAY_MODEL_TRANSPORTS[alias] ??
          'openai-chat-completions';
        const settlementPreflight = {
          schemaVersion:
            'site-builder-paid-model-preflight-evidence/v1' as const,
          attestationId: 'runtime-seven-task-test',
          snapshotSha256: 'a'.repeat(64),
          resolverId: 'new-api-token-log-v1',
          taskId,
          alias,
          protocol,
          expectedChannelId: 17,
          quotaPerUnit: 500_000,
          credentialQuotaCapMicrousd: 10_000_000,
          credentialRemainingMicrousd: 9_000_000,
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
                quota: 1_250,
                quotaPerUnit: settlementPreflight.quotaPerUnit,
                costMicrousd: 2_500,
                inputTokens: 100,
                outputTokens: 20,
              },
            ],
          },
          reservationMicrousd: 400_000,
        });
        expect(measurement).toMatchObject({
          basis: 'provider_reported',
          budgetChargeMicrousd: 2_500,
          reportedCostMicrousd: 2_500,
        });
      }
    }
  });

  it('keeps partial or channel-mismatched multi-wire settlement unknown', () => {
    const settlementPreflight = {
      schemaVersion: 'site-builder-paid-model-preflight-evidence/v1' as const,
      attestationId: 'runtime-repair-test',
      snapshotSha256: 'b'.repeat(64),
      resolverId: 'new-api-token-log-v1',
      taskId: 'site_builder.copy',
      alias: 'deepseek-v4-pro',
      protocol: 'openai-chat-completions' as const,
      expectedChannelId: 11,
      quotaPerUnit: 500_000,
      credentialQuotaCapMicrousd: 10_000_000,
      credentialRemainingMicrousd: 9_000_000,
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
              quota: 500,
              quotaPerUnit: settlementPreflight.quotaPerUnit,
              costMicrousd: 1_000,
              inputTokens: 10,
              outputTokens: 5,
            },
          ],
        },
        reservationMicrousd: 400_000,
      }),
    ).toMatchObject({
      basis: 'unknown',
      budgetChargeMicrousd: 400_000,
      reportedCostMicrousd: null,
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
        capMicrousd: 5_000_000,
        reservedMicrousd: 0,
        chargedMicrousd: 821_000,
        remainingMicrousd: 4_179_000,
        paidCallsEnabled: false,
        disabledReason: 'budget_exhausted',
        exhaustedAt: '2026-07-19T10:00:00.000Z',
      },
      totals: {
        reportedCostMicrousd: 0,
        calculatedCostMicrousd: 1_000,
        estimatedCostMicrousd: 20_000,
        unknownOperations: 1,
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
    });
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
