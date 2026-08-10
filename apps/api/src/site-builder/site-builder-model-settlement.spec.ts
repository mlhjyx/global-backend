import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { VERIFIED_GATEWAY_MODEL_TRANSPORTS } from '../model-gateway/model-transports';
import { PaidModelPreflightError } from '../model-gateway/paid-model-settlement';
import {
  resolveTaskExecutionTarget,
  SITE_BUILDER_GENERATIVE_TASK_IDS,
} from './agents/task-routes';
import {
  NewApiSiteBuilderModelSettlement,
  loadSiteBuilderModelSettlement,
  settlementAttestationSnapshotSha256,
  settlementChannelSnapshotSha256,
  settlementOpenOxPrice,
  settlementPricingSnapshotSha256,
  SITE_BUILDER_MODEL_SETTLEMENT_ATTESTATION_VERSION,
  type OpenOxPricingCatalog,
  type SettlementDispatch,
  type SettlementSnapshot,
  type SiteBuilderModelSettlementAttestation,
} from './site-builder-model-settlement';

const API_KEY = 'test-runtime-token';
const NOW = new Date('2026-07-29T06:00:00.000Z');
const GATEWAY_ORIGIN = 'https://gateway.example.test';
const CHANNEL_ID = 17;
const REVIEWED_RUNTIME_ROUTE_ENV = {
  SITE_BUILDER_FALLBACKS_COPY: 'glm-5.2',
} satisfies NodeJS.ProcessEnv;

function protocolFor(alias: string) {
  return VERIFIED_GATEWAY_MODEL_TRANSPORTS[alias] ?? 'openai-chat-completions';
}

function routeEntries() {
  return SITE_BUILDER_GENERATIVE_TASK_IDS.flatMap((taskId) => {
    const target = resolveTaskExecutionTarget(taskId, REVIEWED_RUNTIME_ROUTE_ENV);
    if (target.kind === 'deterministic_fallback') return [];
    const route = target.route;
    return [route.primary, ...route.fallbacks].map((alias) => ({
      taskId,
      alias,
      protocol: protocolFor(alias),
    }));
  });
}

function productLineFor(alias: string): string {
  if (alias.startsWith('gpt-')) return 'gpt';
  if (alias.startsWith('claude-')) return 'claude';
  if (alias.startsWith('glm-')) return 'glm';
  if (alias.startsWith('minimax-')) return 'minimax';
  if (alias.startsWith('doubao-')) return 'doubao';
  return 'deepseek';
}

function groupFor(alias: string): string {
  const productLine = productLineFor(alias);
  if (productLine === 'gpt') return 'gpt-unified';
  if (productLine === 'claude') return 'special';
  return productLine;
}

function pricingCatalog(models: readonly string[]): OpenOxPricingCatalog {
  const productLines = [...new Set(models.map(productLineFor))];
  return {
    success: true,
    data: {
      models: models.map((modelId) => ({
        model_id: modelId,
        product_line: productLineFor(modelId),
        input_rate: '2',
        output_rate: '10',
        cache_read_rate: '0.2',
        cache_write_rate: '2.5',
        group_rates: modelId === 'glm-5.2' ? { billing_multiplier: '1' } : null,
        status: 'enabled',
        updated_at: '2026-07-29T05:00:00.000Z',
      })),
      groups: productLines.map((productLine) => ({
        name:
          productLine === 'gpt'
            ? 'gpt-unified'
            : productLine === 'claude'
              ? 'special'
              : productLine,
        product_line: productLine,
        rate_multiplier: '1',
      })),
    },
  };
}

function dispatches(catalog: OpenOxPricingCatalog): SettlementDispatch[] {
  return routeEntries().map((entry) => {
    const price = settlementOpenOxPrice(
      catalog,
      entry.alias,
      groupFor(entry.alias),
    );
    if (!price) throw new Error(`missing fake OpenOx price ${entry.alias}`);
    return {
      ...entry,
      channelId: CHANNEL_ID,
      upstreamModelId: entry.alias,
      upstreamProductLine: price.productLine,
      upstreamGroupName: groupFor(entry.alias),
      pricingCurrency: price.currency,
      inputPriceMicrounitsPerMillionTokens:
        price.inputPriceMicrounitsPerMillionTokens,
      outputPriceMicrounitsPerMillionTokens:
        price.outputPriceMicrounitsPerMillionTokens,
      cacheReadPriceMicrounitsPerMillionTokens:
        price.cacheReadPriceMicrounitsPerMillionTokens,
      cacheWritePriceMicrounitsPerMillionTokens:
        price.cacheWritePriceMicrounitsPerMillionTokens,
      ledgerMicrousdPerPricingUnit: 1_000_000,
      pricingVersion: price.pricingVersion,
    };
  });
}

function allowlist(entries: readonly SettlementDispatch[]): string[] {
  return [...new Set(entries.map((entry) => entry.alias))].sort();
}

function fixture() {
  const routeModels = [...new Set(routeEntries().map((entry) => entry.alias))];
  const prices = pricingCatalog(routeModels);
  const entries = dispatches(prices);
  const models = allowlist(entries);
  const snapshot: SettlementSnapshot = {
    attestationId: 'site-builder-runtime-20260729-test',
    capturedAt: '2026-07-29T05:30:00.000Z',
    expiresAt: '2026-07-29T07:30:00.000Z',
    gateway: {
      origin: GATEWAY_ORIGIN,
      channelSnapshotSha256: settlementChannelSnapshotSha256(entries),
    },
    pricing: {
      authority: 'openox_model_marketplace',
      origin: 'https://openox.tech',
      catalogEndpoint: '/api/public/pricing-catalog',
      snapshotSha256: settlementPricingSnapshotSha256(prices, entries),
      ledgerConversionPolicy: 'openox_1_to_1_balance_credit',
      ledgerMicrousdPerUsd: 1_000_000,
      ledgerMicrousdPerCny: 1_000_000,
    },
    credential: {
      bearerTokenSha256:
        '7268834abc98ce207e4fdeb7b7189e365f62f4b6b85ce2739750a8c3bda0438a',
      purpose: 'site_builder_runtime',
      quotaMode: 'limited',
      quotaCapPoints: 5_000_000,
      scopeExact: true,
      modelAllowlist: models,
    },
    dispatches: entries,
    settlement: {
      resolverId: 'new-api-token-log-v1',
      requestIdentityHeader: 'x-oneapi-request-id',
      logEndpoint: '/api/log/token',
      unknownSettlementPolicy: 'freeze_campaign',
    },
  };
  const attestation: SiteBuilderModelSettlementAttestation = {
    schemaVersion: SITE_BUILDER_MODEL_SETTLEMENT_ATTESTATION_VERSION,
    snapshot,
    snapshotSha256: settlementAttestationSnapshotSha256(snapshot),
  };
  return { attestation, entries, models, prices };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function liveFetch(input: string | URL | Request): Promise<Response> {
  const { models, prices } = fixture();
  const url = new URL(String(input));
  if (url.pathname.startsWith('/v1/models/')) {
    return Promise.resolve(
      jsonResponse({ id: decodeURIComponent(url.pathname.slice(11)) }),
    );
  }
  if (url.pathname === '/api/usage/token') {
    return Promise.resolve(
      jsonResponse({
        data: {
          unlimited_quota: false,
          model_limits_enabled: true,
          model_limits: Object.fromEntries(models.map((model) => [model, 1])),
          total_granted: 5_000_000,
          total_available: 4_500_000,
        },
      }),
    );
  }
  if (url.pathname === '/api/public/pricing-catalog') {
    return Promise.resolve(jsonResponse(prices));
  }
  throw new Error(`unexpected test URL ${url.pathname}`);
}

describe('OpenOx pricing family admission', () => {
  it.each([
    ['minimax-m3', 'minimax'],
    ['doubao-seed-2.0-pro', 'doubao'],
    ['doubao-seed-2.0-lite', 'doubao'],
  ])('prices %s in CNY when OpenOx publishes its %s row', (alias) => {
    const catalog = pricingCatalog([alias]);
    expect(
      settlementOpenOxPrice(catalog, alias, groupFor(alias)),
    ).toMatchObject({
      productLine: productLineFor(alias),
      currency: 'CNY',
    });
  });

  it('rejects ambiguous duplicate model or matching group rows', () => {
    const original = pricingCatalog(['claude-sonnet-5']);
    const data = original.data as {
      models: Record<string, unknown>[];
      groups: Record<string, unknown>[];
    };
    for (const ambiguous of [
      {
        ...original,
        data: { ...data, models: [...data.models, { ...data.models[0] }] },
      },
      {
        ...original,
        data: { ...data, groups: [...data.groups, { ...data.groups[0] }] },
      },
    ]) {
      expect(
        settlementOpenOxPrice(ambiguous, 'claude-sonnet-5', 'special'),
      ).toBeNull();
    }
  });
});

function paidContext() {
  return {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    runId: '22222222-2222-4222-8222-222222222222',
    paidCost: {
      siteId: '33333333-3333-4333-8333-333333333333',
      scopeKey: 'attempt:model:0',
    },
  };
}

describe('Site Builder zero-generation model preflight', () => {
  it('loads only a digest-bound, current, exact-scope attestation', () => {
    const { attestation } = fixture();
    const directory = mkdtempSync(join(tmpdir(), 'site-builder-settlement-'));
    const path = join(directory, 'attestation.json');
    const bytes = JSON.stringify(attestation);
    writeFileSync(path, bytes, { mode: 0o600 });
    try {
      expect(() =>
        loadSiteBuilderModelSettlement(
          {
            MODEL_GATEWAY_URL: `${GATEWAY_ORIGIN}/v1`,
            MODEL_GATEWAY_KEY: API_KEY,
            SITE_BUILDER_MODEL_SETTLEMENT_ATTESTATION_PATH: path,
            SITE_BUILDER_MODEL_SETTLEMENT_ATTESTATION_SHA256: createHash(
              'sha256',
            )
              .update(bytes)
              .digest('hex'),
          },
          { now: () => NOW },
        ),
      ).not.toThrow();
      expect(
        loadSiteBuilderModelSettlement(
          {
            ...REVIEWED_RUNTIME_ROUTE_ENV,
            MODEL_GATEWAY_URL: `${GATEWAY_ORIGIN}/v1`,
            MODEL_GATEWAY_KEY: API_KEY,
            SITE_BUILDER_MODEL_SETTLEMENT_ATTESTATION_PATH: path,
            SITE_BUILDER_MODEL_SETTLEMENT_ATTESTATION_SHA256: createHash(
              'sha256',
            )
              .update(bytes)
              .digest('hex'),
          },
          { now: () => NOW, fetch: vi.fn(liveFetch) as typeof fetch },
        ),
      ).toBeInstanceOf(NewApiSiteBuilderModelSettlement);
      expect(() =>
        loadSiteBuilderModelSettlement(
          {
            ...REVIEWED_RUNTIME_ROUTE_ENV,
            MODEL_GATEWAY_URL: `${GATEWAY_ORIGIN}/v1`,
            MODEL_GATEWAY_KEY: API_KEY,
            SITE_BUILDER_MODEL_SETTLEMENT_ATTESTATION_PATH: path,
            SITE_BUILDER_MODEL_SETTLEMENT_ATTESTATION_SHA256: '0'.repeat(64),
          },
          { now: () => NOW },
        ),
      ).toThrow('attestation file digest mismatch');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('covers every current task route and produces bounded redacted evidence', async () => {
    const { attestation, entries } = fixture();
    const fetchMock = vi.fn(liveFetch);
    const settlement = new NewApiSiteBuilderModelSettlement(
      attestation,
      API_KEY,
      {
        fetch: fetchMock as typeof fetch,
        now: () => NOW,
      },
    );

    for (const dispatch of entries) {
      const evidence = await settlement.preflight(
        {
          taskId: dispatch.taskId,
          op: 'generateStructured',
          providerId: 'gateway',
          gatewayOrigin: GATEWAY_ORIGIN,
          credentialSha256:
            '7268834abc98ce207e4fdeb7b7189e365f62f4b6b85ce2739750a8c3bda0438a',
          alias: dispatch.alias,
          protocol: dispatch.protocol,
          promptUtf8BytesPerCall: 500,
          maxOutputTokens: 1_000,
          maximumWireCalls: 2,
          reservationMicrousd: 800_000,
        },
        paidContext(),
      );
      expect(evidence).toMatchObject({
        taskId: dispatch.taskId,
        alias: dispatch.alias,
        protocol: dispatch.protocol,
        expectedChannelId: CHANNEL_ID,
        pricingAuthority: 'openox_model_marketplace',
        pricingSourceUrl: 'https://openox.tech/api/public/pricing-catalog',
      });
      expect(evidence.pricedMaximumMicrousd).toBeLessThanOrEqual(800_000);
      expect(JSON.stringify(evidence)).not.toContain(API_KEY);
    }
    expect(fetchMock).toHaveBeenCalledTimes(entries.length * 3);
  });

  it('denies an unlimited credential before any generative request', async () => {
    const { attestation, entries } = fixture();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/usage/token') {
        return jsonResponse({
          data: {
            unlimited_quota: true,
            model_limits_enabled: false,
            total_granted: 5_000_000,
            total_available: 5_000_000,
          },
        });
      }
      return liveFetch(input);
    });
    const settlement = new NewApiSiteBuilderModelSettlement(
      attestation,
      API_KEY,
      {
        fetch: fetchMock as typeof fetch,
        now: () => NOW,
      },
    );
    const dispatch = entries[0]!;

    const error = await settlement
      .preflight(
        {
          taskId: dispatch.taskId,
          op: 'generateStructured',
          providerId: 'gateway',
          gatewayOrigin: GATEWAY_ORIGIN,
          credentialSha256:
            '7268834abc98ce207e4fdeb7b7189e365f62f4b6b85ce2739750a8c3bda0438a',
          alias: dispatch.alias,
          protocol: dispatch.protocol,
          promptUtf8BytesPerCall: 500,
          maxOutputTokens: 1_000,
          maximumWireCalls: 2,
          reservationMicrousd: 800_000,
        },
        paidContext(),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PaidModelPreflightError);
    expect((error as PaidModelPreflightError).code).toBe(
      'LIVE_SCOPE_OR_QUOTA_MISMATCH',
    );
    expect(
      fetchMock.mock.calls.some(([input]) =>
        /\/(chat\/completions|responses|messages)$/.test(String(input)),
      ),
    ).toBe(false);
  });

  it('denies a current alias that is absent from the OpenOx catalog', async () => {
    const { attestation, entries, prices } = fixture();
    const dispatch = entries.find(
      (entry) => entry.alias === 'deepseek-v4-pro',
    )!;
    const missingCatalog = structuredClone(prices);
    missingCatalog.data!.models = (
      missingCatalog.data!.models as Array<{ model_id: string }>
    ).filter((model) => model.model_id !== dispatch.alias);
    const snapshot = structuredClone(attestation.snapshot);
    snapshot.pricing.snapshotSha256 = settlementPricingSnapshotSha256(
      missingCatalog,
      snapshot.dispatches,
    );
    const missingAttestation: SiteBuilderModelSettlementAttestation = {
      schemaVersion: SITE_BUILDER_MODEL_SETTLEMENT_ATTESTATION_VERSION,
      snapshot,
      snapshotSha256: settlementAttestationSnapshotSha256(snapshot),
    };
    const settlement = new NewApiSiteBuilderModelSettlement(
      missingAttestation,
      API_KEY,
      {
        now: () => NOW,
        fetch: vi.fn(async (input: string | URL | Request) => {
          const url = new URL(String(input));
          if (url.pathname === '/api/public/pricing-catalog') {
            return jsonResponse(missingCatalog);
          }
          return liveFetch(input);
        }) as typeof fetch,
      },
    );

    const error = await settlement
      .preflight(
        {
          taskId: dispatch.taskId,
          op: 'generateStructured',
          providerId: 'gateway',
          gatewayOrigin: GATEWAY_ORIGIN,
          credentialSha256:
            '7268834abc98ce207e4fdeb7b7189e365f62f4b6b85ce2739750a8c3bda0438a',
          alias: dispatch.alias,
          protocol: dispatch.protocol,
          promptUtf8BytesPerCall: 500,
          maxOutputTokens: 1_000,
          maximumWireCalls: 2,
          reservationMicrousd: 800_000,
        },
        paidContext(),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PaidModelPreflightError);
    expect((error as PaidModelPreflightError).code).toBe(
      'LIVE_PRICING_COVERAGE_INCOMPLETE',
    );
  });

  it.each([
    [
      'declared content length',
      () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-length': '1048577' },
        }),
    ],
    [
      'accumulated streamed bytes',
      () => new Response(new Uint8Array(1_048_577), { status: 200 }),
    ],
  ])(
    'rejects an OpenOx catalog that exceeds the %s limit',
    async (_case, oversizedResponse) => {
      const { attestation, entries } = fixture();
      const settlement = new NewApiSiteBuilderModelSettlement(
        attestation,
        API_KEY,
        {
          now: () => NOW,
          fetch: vi.fn(async (input: string | URL | Request) => {
            const url = new URL(String(input));
            if (url.pathname === '/api/public/pricing-catalog') {
              return oversizedResponse();
            }
            return liveFetch(input);
          }) as typeof fetch,
        },
      );
      const dispatch = entries[0]!;

      await expect(
        settlement.preflight(
          {
            taskId: dispatch.taskId,
            op: 'generateStructured',
            providerId: 'gateway',
            gatewayOrigin: GATEWAY_ORIGIN,
            credentialSha256:
              '7268834abc98ce207e4fdeb7b7189e365f62f4b6b85ce2739750a8c3bda0438a',
            alias: dispatch.alias,
            protocol: dispatch.protocol,
            promptUtf8BytesPerCall: 500,
            maxOutputTokens: 1_000,
            maximumWireCalls: 2,
            reservationMicrousd: 800_000,
          },
          paidContext(),
        ),
      ).rejects.toMatchObject({
        name: 'PaidModelPreflightError',
        code: 'LIVE_PREFLIGHT_UNAVAILABLE',
      });
    },
  );

  it('propagates caller cancellation through every live preflight read', async () => {
    const { attestation, entries } = fixture();
    const controller = new AbortController();
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            {
              once: true,
            },
          );
        }),
    );
    const settlement = new NewApiSiteBuilderModelSettlement(
      attestation,
      API_KEY,
      {
        fetch: fetchMock as typeof fetch,
        now: () => NOW,
        controlPlaneTimeoutMs: 1_000,
      },
    );
    const dispatch = entries[0]!;
    const pending = settlement.preflight(
      {
        taskId: dispatch.taskId,
        op: 'generateStructured',
        providerId: 'gateway',
        gatewayOrigin: GATEWAY_ORIGIN,
        credentialSha256:
          '7268834abc98ce207e4fdeb7b7189e365f62f4b6b85ce2739750a8c3bda0438a',
        alias: dispatch.alias,
        protocol: dispatch.protocol,
        promptUtf8BytesPerCall: 500,
        maxOutputTokens: 1_000,
        maximumWireCalls: 2,
        reservationMicrousd: 800_000,
        signal: controller.signal,
      },
      paidContext(),
    );
    controller.abort(new DOMException('cancelled', 'AbortError'));

    await expect(pending).rejects.toMatchObject({
      name: 'PaidModelPreflightError',
      code: 'REQUEST_CANCELLED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.every(
        ([, init]) => init?.signal instanceof AbortSignal,
      ),
    ).toBe(true);
  });

  it('bounds stalled control-plane preflight reads before the task timeout', async () => {
    const { attestation, entries } = fixture();
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            {
              once: true,
            },
          );
        }),
    );
    const settlement = new NewApiSiteBuilderModelSettlement(
      attestation,
      API_KEY,
      {
        fetch: fetchMock as typeof fetch,
        now: () => NOW,
        controlPlaneTimeoutMs: 10,
      },
    );
    const dispatch = entries[0]!;

    await expect(
      settlement.preflight(
        {
          taskId: dispatch.taskId,
          op: 'generateStructured',
          providerId: 'gateway',
          gatewayOrigin: GATEWAY_ORIGIN,
          credentialSha256:
            '7268834abc98ce207e4fdeb7b7189e365f62f4b6b85ce2739750a8c3bda0438a',
          alias: dispatch.alias,
          protocol: dispatch.protocol,
          promptUtf8BytesPerCall: 500,
          maxOutputTokens: 1_000,
          maximumWireCalls: 2,
          reservationMicrousd: 800_000,
        },
        paidContext(),
      ),
    ).rejects.toMatchObject({
      name: 'PaidModelPreflightError',
      code: 'LIVE_PREFLIGHT_UNAVAILABLE',
    });
  });

  it('rechecks attestation expiry after live reads complete', async () => {
    const { attestation, entries } = fixture();
    const now = vi
      .fn<() => Date>()
      .mockReturnValueOnce(NOW)
      .mockReturnValueOnce(new Date('2026-07-29T07:30:00.001Z'));
    const settlement = new NewApiSiteBuilderModelSettlement(
      attestation,
      API_KEY,
      {
        fetch: vi.fn(liveFetch) as typeof fetch,
        now,
      },
    );
    const dispatch = entries[0]!;

    await expect(
      settlement.preflight(
        {
          taskId: dispatch.taskId,
          op: 'generateStructured',
          providerId: 'gateway',
          gatewayOrigin: GATEWAY_ORIGIN,
          credentialSha256:
            '7268834abc98ce207e4fdeb7b7189e365f62f4b6b85ce2739750a8c3bda0438a',
          alias: dispatch.alias,
          protocol: dispatch.protocol,
          promptUtf8BytesPerCall: 500,
          maxOutputTokens: 1_000,
          maximumWireCalls: 2,
          reservationMicrousd: 800_000,
        },
        paidContext(),
      ),
    ).rejects.toMatchObject({
      name: 'PaidModelPreflightError',
      code: 'ATTESTATION_EXPIRED_DURING_PREFLIGHT',
    });
  });
});

describe('new-api request-bound settlement resolver', () => {
  it('accepts exactly one matching consume log row', async () => {
    const { attestation } = fixture();
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            request_id: 'req_exact_123456',
            type: 2,
            quota: 1_250,
            prompt_tokens: 100,
            completion_tokens: 20,
            model_name: 'gpt-5.6-terra',
            channel: CHANNEL_ID,
          },
        ],
      }),
    );
    const settlement = new NewApiSiteBuilderModelSettlement(
      attestation,
      API_KEY,
      {
        fetch: fetchMock as typeof fetch,
        wait: async () => undefined,
      },
    );

    await expect(
      settlement.resolve({
        requestId: 'req_exact_123456',
        evidence: {
          schemaVersion: 'site-builder-paid-model-preflight-evidence/v2',
          attestationId: attestation.snapshot.attestationId,
          snapshotSha256: attestation.snapshotSha256,
          resolverId: 'new-api-token-log-v1',
          taskId: 'site_builder.brand_profile',
          alias: 'gpt-5.6-terra',
          protocol: 'openai-responses',
          expectedChannelId: CHANNEL_ID,
          pricingAuthority: 'openox_model_marketplace',
          pricingSourceUrl: 'https://openox.tech/api/public/pricing-catalog',
          pricingSnapshotSha256: attestation.snapshot.pricing.snapshotSha256,
          pricingCurrency: 'CNY',
          inputPriceMicrounitsPerMillionTokens: 2_000_000,
          outputPriceMicrounitsPerMillionTokens: 10_000_000,
          ledgerMicrousdPerPricingUnit: 1_000_000,
          gatewayCredentialQuotaCapPoints: 5_000_000,
          gatewayCredentialRemainingPoints: 4_500_000,
          maxOutputTokensPerCall: 1_000,
          pricedMaximumMicrousd: 100_000,
        },
        usage: { inputTokens: 100, outputTokens: 20 },
      }),
    ).resolves.toMatchObject({
      status: 'settled',
      requestId: 'req_exact_123456',
      alias: 'gpt-5.6-terra',
      channelId: CHANNEL_ID,
      basis: 'openox_catalog_token_pricing',
      costMicrousd: 400,
    });
  });

  it('returns unknown when the log channel does not match the frozen channel', async () => {
    const { attestation } = fixture();
    const settlement = new NewApiSiteBuilderModelSettlement(
      attestation,
      API_KEY,
      {
        fetch: vi.fn(async () =>
          jsonResponse({
            data: [
              {
                request_id: 'req_wrong_channel',
                type: 2,
                quota: 500,
                prompt_tokens: 10,
                completion_tokens: 5,
                model_name: 'gpt-5.6-terra',
                channel: CHANNEL_ID + 1,
              },
            ],
          }),
        ) as typeof fetch,
        wait: async () => undefined,
      },
    );

    await expect(
      settlement.resolve({
        requestId: 'req_wrong_channel',
        evidence: {
          schemaVersion: 'site-builder-paid-model-preflight-evidence/v2',
          attestationId: attestation.snapshot.attestationId,
          snapshotSha256: attestation.snapshotSha256,
          resolverId: 'new-api-token-log-v1',
          taskId: 'site_builder.brand_profile',
          alias: 'gpt-5.6-terra',
          protocol: 'openai-responses',
          expectedChannelId: CHANNEL_ID,
          pricingAuthority: 'openox_model_marketplace',
          pricingSourceUrl: 'https://openox.tech/api/public/pricing-catalog',
          pricingSnapshotSha256: attestation.snapshot.pricing.snapshotSha256,
          pricingCurrency: 'CNY',
          inputPriceMicrounitsPerMillionTokens: 2_000_000,
          outputPriceMicrounitsPerMillionTokens: 10_000_000,
          ledgerMicrousdPerPricingUnit: 1_000_000,
          gatewayCredentialQuotaCapPoints: 5_000_000,
          gatewayCredentialRemainingPoints: 4_500_000,
          maxOutputTokensPerCall: 1_000,
          pricedMaximumMicrousd: 100_000,
        },
      }),
    ).resolves.toMatchObject({
      status: 'unknown',
      reason: 'channel_mismatch',
    });
  });

  it('rejects consume logs with zero prompt tokens for nonempty structured calls', async () => {
    const { attestation } = fixture();
    const settlement = new NewApiSiteBuilderModelSettlement(
      attestation,
      API_KEY,
      {
        fetch: vi.fn(async () =>
          jsonResponse({
            data: [
              {
                request_id: 'req_zero_prompt_tokens',
                type: 2,
                quota: 500,
                prompt_tokens: 0,
                completion_tokens: 5,
                model_name: 'gpt-5.6-terra',
                channel: CHANNEL_ID,
              },
            ],
          }),
        ) as typeof fetch,
        wait: async () => undefined,
      },
    );

    await expect(
      settlement.resolve({
        requestId: 'req_zero_prompt_tokens',
        evidence: {
          schemaVersion: 'site-builder-paid-model-preflight-evidence/v2',
          attestationId: attestation.snapshot.attestationId,
          snapshotSha256: attestation.snapshotSha256,
          resolverId: 'new-api-token-log-v1',
          taskId: 'site_builder.brand_profile',
          alias: 'gpt-5.6-terra',
          protocol: 'openai-responses',
          expectedChannelId: CHANNEL_ID,
          pricingAuthority: 'openox_model_marketplace',
          pricingSourceUrl: 'https://openox.tech/api/public/pricing-catalog',
          pricingSnapshotSha256: attestation.snapshot.pricing.snapshotSha256,
          pricingCurrency: 'CNY',
          inputPriceMicrounitsPerMillionTokens: 2_000_000,
          outputPriceMicrounitsPerMillionTokens: 10_000_000,
          ledgerMicrousdPerPricingUnit: 1_000_000,
          gatewayCredentialQuotaCapPoints: 5_000_000,
          gatewayCredentialRemainingPoints: 4_500_000,
          maxOutputTokensPerCall: 1_000,
          pricedMaximumMicrousd: 100_000,
        },
      }),
    ).resolves.toMatchObject({
      status: 'unknown',
      reason: 'log_invalid',
    });
  });

  it('rejects consume logs that exceed the attested per-call output limit', async () => {
    const { attestation } = fixture();
    const settlement = new NewApiSiteBuilderModelSettlement(
      attestation,
      API_KEY,
      {
        fetch: vi.fn(async () =>
          jsonResponse({
            data: [
              {
                request_id: 'req_output_limit',
                type: 2,
                quota: 500,
                prompt_tokens: 10,
                completion_tokens: 11,
                model_name: 'gpt-5.6-terra',
                channel: CHANNEL_ID,
              },
            ],
          }),
        ) as typeof fetch,
        wait: async () => undefined,
      },
    );

    await expect(
      settlement.resolve({
        requestId: 'req_output_limit',
        evidence: {
          schemaVersion: 'site-builder-paid-model-preflight-evidence/v2',
          attestationId: attestation.snapshot.attestationId,
          snapshotSha256: attestation.snapshotSha256,
          resolverId: 'new-api-token-log-v1',
          taskId: 'site_builder.brand_profile',
          alias: 'gpt-5.6-terra',
          protocol: 'openai-responses',
          expectedChannelId: CHANNEL_ID,
          pricingAuthority: 'openox_model_marketplace',
          pricingSourceUrl: 'https://openox.tech/api/public/pricing-catalog',
          pricingSnapshotSha256: attestation.snapshot.pricing.snapshotSha256,
          pricingCurrency: 'CNY',
          inputPriceMicrounitsPerMillionTokens: 2_000_000,
          outputPriceMicrounitsPerMillionTokens: 10_000_000,
          ledgerMicrousdPerPricingUnit: 1_000_000,
          gatewayCredentialQuotaCapPoints: 5_000_000,
          gatewayCredentialRemainingPoints: 4_500_000,
          maxOutputTokensPerCall: 10,
          pricedMaximumMicrousd: 100_000,
        },
      }),
    ).resolves.toMatchObject({
      status: 'unknown',
      reason: 'log_invalid',
    });
  });

  it('bounds stalled consume-log lookups as an unknown settlement', async () => {
    const { attestation } = fixture();
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            {
              once: true,
            },
          );
        }),
    );
    const settlement = new NewApiSiteBuilderModelSettlement(
      attestation,
      API_KEY,
      {
        fetch: fetchMock as typeof fetch,
        wait: async () => undefined,
        controlPlaneTimeoutMs: 10,
      },
    );

    await expect(
      settlement.resolve({
        requestId: 'req_stalled_log_lookup',
        evidence: {
          schemaVersion: 'site-builder-paid-model-preflight-evidence/v2',
          attestationId: attestation.snapshot.attestationId,
          snapshotSha256: attestation.snapshotSha256,
          resolverId: 'new-api-token-log-v1',
          taskId: 'site_builder.brand_profile',
          alias: 'gpt-5.6-terra',
          protocol: 'openai-responses',
          expectedChannelId: CHANNEL_ID,
          pricingAuthority: 'openox_model_marketplace',
          pricingSourceUrl: 'https://openox.tech/api/public/pricing-catalog',
          pricingSnapshotSha256: attestation.snapshot.pricing.snapshotSha256,
          pricingCurrency: 'CNY',
          inputPriceMicrounitsPerMillionTokens: 2_000_000,
          outputPriceMicrounitsPerMillionTokens: 10_000_000,
          ledgerMicrousdPerPricingUnit: 1_000_000,
          gatewayCredentialQuotaCapPoints: 5_000_000,
          gatewayCredentialRemainingPoints: 4_500_000,
          maxOutputTokensPerCall: 1_000,
          pricedMaximumMicrousd: 100_000,
        },
      }),
    ).resolves.toMatchObject({
      status: 'unknown',
      reason: 'log_unavailable',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
