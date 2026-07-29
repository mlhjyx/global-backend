import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { VERIFIED_GATEWAY_MODEL_TRANSPORTS } from '../model-gateway/model-transports';
import { PaidModelPreflightError } from '../model-gateway/paid-model-settlement';
import { resolveTaskRoute, SITE_BUILDER_TASK_IDS } from './agents/task-routes';
import {
  NewApiSiteBuilderModelSettlement,
  loadSiteBuilderModelSettlement,
  settlementAttestationSnapshotSha256,
  settlementChannelSnapshotSha256,
  settlementPricingSnapshotSha256,
  SITE_BUILDER_MODEL_SETTLEMENT_ATTESTATION_VERSION,
  type PricingRow,
  type SettlementDispatch,
  type SettlementSnapshot,
  type SiteBuilderModelSettlementAttestation,
} from './site-builder-model-settlement';

const API_KEY = 'test-runtime-token';
const NOW = new Date('2026-07-29T06:00:00.000Z');
const GATEWAY_ORIGIN = 'https://gateway.example.test';
const QUOTA_PER_UNIT = 500_000;
const CHANNEL_ID = 17;
const PRICING_VERSION = 'c'.repeat(64);

function protocolFor(alias: string) {
  return VERIFIED_GATEWAY_MODEL_TRANSPORTS[alias] ?? 'openai-chat-completions';
}

function dispatches(): SettlementDispatch[] {
  return SITE_BUILDER_TASK_IDS.flatMap((taskId) => {
    const route = resolveTaskRoute(taskId);
    return [route.primary, ...route.fallbacks].map((alias) => ({
      taskId,
      alias,
      protocol: protocolFor(alias),
      channelId: CHANNEL_ID,
      quotaType: 0 as const,
      modelRatio: 1,
      completionRatio: 1,
      groupRatio: 1,
      pricingVersion: PRICING_VERSION,
    }));
  });
}

function allowlist(entries: readonly SettlementDispatch[]): string[] {
  return [...new Set(entries.map((entry) => entry.alias))].sort();
}

function pricingRows(models: readonly string[]): PricingRow[] {
  return models.map((model) => ({
    model_name: model,
    quota_type: 0,
    model_ratio: 1,
    completion_ratio: 1,
    pricing_version: PRICING_VERSION,
  }));
}

function fixture() {
  const entries = dispatches();
  const models = allowlist(entries);
  const prices = pricingRows(models);
  const snapshot: SettlementSnapshot = {
    attestationId: 'site-builder-runtime-20260729-test',
    capturedAt: '2026-07-29T05:30:00.000Z',
    expiresAt: '2026-07-29T07:30:00.000Z',
    gateway: {
      origin: GATEWAY_ORIGIN,
      quotaPerUnit: QUOTA_PER_UNIT,
      pricingSnapshotSha256: settlementPricingSnapshotSha256(prices, models),
      channelSnapshotSha256: settlementChannelSnapshotSha256(entries),
    },
    credential: {
      bearerTokenSha256:
        '7268834abc98ce207e4fdeb7b7189e365f62f4b6b85ce2739750a8c3bda0438a',
      purpose: 'site_builder_runtime',
      quotaMode: 'limited',
      quotaCapMicrousd: 10_000_000,
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
  if (url.pathname === '/api/status') {
    return Promise.resolve(
      jsonResponse({ data: { quota_per_unit: QUOTA_PER_UNIT } }),
    );
  }
  if (url.pathname === '/api/pricing') {
    return Promise.resolve(jsonResponse({ data: prices }));
  }
  throw new Error(`unexpected test URL ${url.pathname}`);
}

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
      expect(
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
          { now: () => NOW, fetch: vi.fn(liveFetch) as typeof fetch },
        ),
      ).toBeInstanceOf(NewApiSiteBuilderModelSettlement);
      expect(() =>
        loadSiteBuilderModelSettlement(
          {
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
      { fetch: fetchMock as typeof fetch, now: () => NOW },
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
        quotaPerUnit: QUOTA_PER_UNIT,
      });
      expect(evidence.pricedMaximumMicrousd).toBeLessThanOrEqual(800_000);
      expect(JSON.stringify(evidence)).not.toContain(API_KEY);
    }
    expect(fetchMock).toHaveBeenCalledTimes(entries.length * 4);
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
      { fetch: fetchMock as typeof fetch, now: () => NOW },
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
      { fetch: fetchMock as typeof fetch, wait: async () => undefined },
    );

    await expect(
      settlement.resolve({
        requestId: 'req_exact_123456',
        evidence: {
          schemaVersion: 'site-builder-paid-model-preflight-evidence/v1',
          attestationId: attestation.snapshot.attestationId,
          snapshotSha256: attestation.snapshotSha256,
          resolverId: 'new-api-token-log-v1',
          taskId: 'site_builder.brand_profile',
          alias: 'gpt-5.6-terra',
          protocol: 'openai-responses',
          expectedChannelId: CHANNEL_ID,
          quotaPerUnit: QUOTA_PER_UNIT,
          credentialQuotaCapMicrousd: 10_000_000,
          credentialRemainingMicrousd: 9_000_000,
          pricedMaximumMicrousd: 100_000,
        },
        usage: { inputTokens: 100, outputTokens: 20 },
      }),
    ).resolves.toMatchObject({
      status: 'settled',
      requestId: 'req_exact_123456',
      alias: 'gpt-5.6-terra',
      channelId: CHANNEL_ID,
      costMicrousd: 2_500,
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
          schemaVersion: 'site-builder-paid-model-preflight-evidence/v1',
          attestationId: attestation.snapshot.attestationId,
          snapshotSha256: attestation.snapshotSha256,
          resolverId: 'new-api-token-log-v1',
          taskId: 'site_builder.brand_profile',
          alias: 'gpt-5.6-terra',
          protocol: 'openai-responses',
          expectedChannelId: CHANNEL_ID,
          quotaPerUnit: QUOTA_PER_UNIT,
          credentialQuotaCapMicrousd: 10_000_000,
          credentialRemainingMicrousd: 9_000_000,
          pricedMaximumMicrousd: 100_000,
        },
      }),
    ).resolves.toMatchObject({
      status: 'unknown',
      reason: 'channel_mismatch',
    });
  });
});
