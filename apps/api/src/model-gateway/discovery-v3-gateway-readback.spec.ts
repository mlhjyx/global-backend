import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withDiscoveryV3OperationScope } from '../discovery/discovery-v3-operation-scope';
import type { DiscoveryV3OperationClaim, DiscoveryV3OperationStore, DiscoveryV3WireUsage } from '../discovery/discovery-v3-operations';
import { projectModelResultForReplay } from '../durable-results/model-result-replay';
import type { DiscoveryV3Dispatch } from '../runtime/discovery-v3-dispatch-contract';
import { createDiscoveryV3GatewayReadbackRuntimeFromEnv, readDiscoveryV3GatewayEvidence } from './discovery-v3-gateway-readback';
import { ModelProviderRegistry } from './model-provider.registry';
import { ModelRouter } from './model-router';
import { NewApiRequestBoundSettlementResolver, NEW_API_SETTLEMENT_READBACK_CONTRACT } from './new-api-request-bound-settlement';
import { OpenAICompatibleProvider } from './providers/openai-compatible.provider';
import { RouterModelGateway } from './router-model-gateway';
import { SettlementDerivationKeyring } from './settlement-wire-identity';
import { TenantDailyCostBreaker } from './tenant-daily-cost-breaker';

const ORIGIN = 'http://127.0.0.1:18462';
const ALIAS = 'deepseek-v4-flash';
const READER = `srb1.${'D'.repeat(16)}.${'R'.repeat(43)}`;
const TENANT_FIXTURE_CREDENTIAL = 'fixture-tenant-generation';
const OPERATION_ID = '9019d819-39b4-43ef-90e7-b9c01f591171';

const command: DiscoveryV3Dispatch = {
  executionContractVersion: 3,
  workspaceId: '7092776f-132a-4236-9be6-b9ae9ac3ba93',
  runId: '961c9a32-ff97-47a1-9a4a-f8a842131288',
  planId: 'b03b5b20-a86c-4422-a250-2abf4df0af78',
  icpId: 'faf8253d-589c-4595-bcec-1c876fb306d3',
  attemptId: 'b7b3d4d7-0327-479a-8dcd-5f80e5bcffd5',
  requestSha256: 'f'.repeat(64),
  taskQueue: 'batch-discovery',
  dispatchExpiresAt: '2031-01-01T00:00:00.000Z',
};

function fixture(input: {
  gatewayLog?: (requestId: string) => object[];
  response?: () => Response | Promise<Response>;
  anthropic?: boolean;
} = {}) {
  const generateRequests: Request[] = [];
  const readbackRequests: Request[] = [];
  const claim = { status: 'CLAIMED' as const, operationId: OPERATION_ID, deadline: new Date(command.dispatchExpiresAt), proof: 'isolated-claim-proof' };
  const claimedProbes = new Set<number>();
  const store = {
    claim: vi.fn<() => Promise<DiscoveryV3OperationClaim>>(async () => claim),
    authorizeSend: vi.fn<DiscoveryV3OperationStore['authorizeSend']>(async () => 10_000),
    claimModelReadbackProbe: vi.fn<DiscoveryV3OperationStore['claimModelReadbackProbe']>(async (_command, _input, _id, _binding, sequence) => {
      if (claimedProbes.has(sequence)) return null;
      claimedProbes.add(sequence);
      return `fixture-probe-${sequence}`;
    }),
    recordModelReadbackProbe: vi.fn<DiscoveryV3OperationStore['recordModelReadbackProbe']>(async () => undefined),
    finish: vi.fn<DiscoveryV3OperationStore['finish']>(async () => undefined),
  };
  const fetchFixture: typeof fetch = async (target, init) => {
    const request = new Request(target, init);
    const url = new URL(request.url);
    if (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/messages') {
      generateRequests.push(request);
      return input.response ? input.response() : Response.json({
        model: ALIAS,
        choices: [{ message: { content: 'fixture output' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 30, cost: 890, currency: 'USD' },
      });
    }
    if (url.pathname === '/api/settlement-readback/v1') {
      readbackRequests.push(request);
      const requestId = url.searchParams.get('request_id')!;
      return Response.json({ data: input.gatewayLog?.(requestId) ?? [gatewayReceipt(requestId)] }, {
        headers: {
          'cache-control': 'no-store',
          'x-new-api-settlement-contract': NEW_API_SETTLEMENT_READBACK_CONTRACT,
        },
      });
    }
    throw new Error('unexpected fixture endpoint');
  };
  vi.stubGlobal('fetch', fetchFixture);
  const keyring = new SettlementDerivationKeyring([
    { id: 'discovery-fixture', status: 'ACTIVE', material: Buffer.alloc(32, 45) },
  ]);
  const resolver = new NewApiRequestBoundSettlementResolver({
    gatewayOrigin: ORIGIN,
    readerCredential: READER,
    resolverId: 'new-api-request-bound-reconciliation-v1',
    maximumProbeDurationMs: 500,
  }, { fetch: fetchFixture, wait: async () => undefined });
  const registry = new ModelProviderRegistry();
  const model = input.anthropic ? 'claude-sonnet-5' : ALIAS;
  registry.register(new OpenAICompatibleProvider({
    id: 'gateway', baseUrl: `${ORIGIN}/v1`, apiKey: 'fixture-default-generation', model,
    tenantApiKeys: new Map([[command.workspaceId, TENANT_FIXTURE_CREDENTIAL]]),
    ...(input.anthropic ? { modelTransports: { [model]: 'anthropic-messages' } } : {}),
  }));
  const runtime = { gatewayOrigin: ORIGIN, keyring, resolver };
  const gateway = Object.assign(new RouterModelGateway(new ModelRouter(registry)), { discoveryV3SettlementReadback: runtime });
  const runInScope = <T>(invoke: () => Promise<T>) => withDiscoveryV3OperationScope({
    command, step: 'fit/company', store: store as unknown as DiscoveryV3OperationStore,
    signal: new AbortController().signal,
  }, invoke);
  const context = { workspaceId: command.workspaceId, runId: command.runId };
  const run = () => runInScope(() => gateway.generateText({ task: 'discovery.qualify_fit', prompt: 'classify fixture', maxTokens: 150 }, context));
  const runStructured = () => runInScope(() => gateway.generateStructured({
    task: 'taxonomy.normalize', prompt: 'classify fixture', maxTokens: 64,
    schema: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } },
  }, { ...context, durableResultSchema: 'taxonomy-code/v1' }));
  return { run, runStructured, runInScope, context, gateway, store, claim, runtime, generateRequests, readbackRequests };
}

function gatewayReceipt(requestId: string, overrides: Record<string, unknown> = {}) {
  return {
    request_id: requestId,
    type: 'consume',
    model_name: ALIAS,
    channel_id: 91,
    quota: '1250',
    prompt_tokens: 120,
    completion_tokens: 30,
    usage_semantic: 'openai',
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    upstream_id_state: 'observed',
    actual_charge: { currency: 'CNY', amount_micros: '3871' },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Discovery v3 request-bound model spend', () => {
  it('persists a tenant-bound wire identity before POST and books the readback currency and actual charge', async () => {
    const { run, store, generateRequests, readbackRequests } = fixture();
    await expect(run()).resolves.toMatchObject({ data: 'fixture output' });
    expect(generateRequests).toHaveLength(1);
    expect(readbackRequests).toHaveLength(1);
    const generation = generateRequests[0]!;
    const readback = readbackRequests[0]!;
    const requestId = generation.headers.get('x-new-api-settlement-request-id');
    const nonce = generation.headers.get('x-new-api-settlement-nonce')!;
    expect(requestId).toMatch(/^[\w-]{43}$/);
    expect(nonce).toMatch(/^[\w-]{43}$/);
    expect(generation.headers.get('authorization')).toBe(`Bearer ${TENANT_FIXTURE_CREDENTIAL}`);
    expect(generation.headers.get('x-workspace-id')).toBe(command.workspaceId);
    expect(readback.headers.get('authorization')).toBe(`Bearer ${READER}`);
    expect(readback.headers.get('x-new-api-settlement-nonce')).toBe(nonce);
    expect(new URL(readback.url).searchParams.get('request_id')).toBe(requestId);
    expect(store.authorizeSend).toHaveBeenCalledWith(command, expect.objectContaining({ kind: 'MODEL' }),
      expect.objectContaining({ operationId: OPERATION_ID }), 1, {
        gatewayOrigin: ORIGIN, alias: ALIAS, protocol: 'openai-chat-completions', maxOutputTokens: 150,
        credentialSha256: createHash('sha256').update(TENANT_FIXTURE_CREDENTIAL).digest('hex'),
        identity: {
          schemaVersion: 'site-build-settlement-wire-identity/v1', physicalWireAttempt: 1,
          derivationKeyId: 'discovery-fixture', requestId, nonceSha256: createHash('sha256').update(nonce).digest('hex'),
        },
      });
    expect(store.recordModelReadbackProbe).toHaveBeenCalledWith(command, expect.objectContaining({ kind: 'MODEL' }),
      OPERATION_ID, expect.objectContaining({ alias: ALIAS }), expect.objectContaining({
        evidence: expect.objectContaining({ requestId, channelId: 91, quotaPoints: 1250, receiptSha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      }));
    expect(store.finish.mock.lastCall?.slice(0, 4)).toEqual([command, expect.objectContaining({ kind: 'MODEL' }),
      expect.objectContaining({ operationId: OPERATION_ID }), expect.objectContaining({
        outcome: 'SUCCEEDED', usage: { inputTokens: 120, outputTokens: 30 }, model: ALIAS,
        cost: { amountMicros: 3871, currency: 'CNY', basis: 'PROVIDER_REPORTED', evidenceSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      })]);
  });

  it('books a matched actual charge when the generation endpoint replies with failure', async () => {
    const { run, store, generateRequests, readbackRequests } = fixture({
      response: () => Response.json({ error: 'fixture temporarily unavailable' }, { status: 503 }),
    });
    await expect(run()).rejects.toMatchObject({ status: 503 });
    expect(generateRequests).toHaveLength(1);
    expect(readbackRequests).toHaveLength(1);
    expect(store.finish.mock.lastCall?.[3]).toMatchObject({
      outcome: 'FAILED', usage: { inputTokens: 120, outputTokens: 30 },
      cost: expect.objectContaining({ amountMicros: 3871, currency: 'CNY', basis: 'PROVIDER_REPORTED' }),
    });
  });

  it('keeps lost result acknowledgement unknown while retaining the authenticated charge and route', async () => {
    const { run, store, generateRequests, readbackRequests } = fixture({
      response: () => Promise.reject(new Error('fixture socket closed after dispatch')),
    });
    await expect(run()).rejects.toThrow('fixture socket closed after dispatch');
    expect(generateRequests).toHaveLength(1);
    expect(readbackRequests).toHaveLength(1);
    expect(store.finish.mock.lastCall?.[3]).toMatchObject({
      outcome: 'UNKNOWN', model: ALIAS, usage: { inputTokens: 120, outputTokens: 30 },
      cost: expect.objectContaining({ amountMicros: 3871, currency: 'CNY', basis: 'PROVIDER_REPORTED' }),
    });
  });

  it('uses the original nonce after key rotation for one late GET while rejecting a different operation', async () => {
    let ready = false;
    const { run, store, runtime, generateRequests, readbackRequests } = fixture({
      gatewayLog: (requestId) => ready ? [gatewayReceipt(requestId)] : [],
    });
    await expect(run()).resolves.toMatchObject({ data: 'fixture output' });
    const [, operation, , , binding] = store.authorizeSend.mock.calls[0]!;
    ready = true;
    const rotatedKeyring = new SettlementDerivationKeyring([
      { id: 'replacement-key', status: 'ACTIVE', material: Buffer.alloc(32, 89) },
      { id: 'discovery-fixture', status: 'VERIFY_ONLY', material: Buffer.alloc(32, 45) },
    ]);
    const target = { command, operation, operationId: OPERATION_ID, binding: binding!, store,
      runtime: { ...runtime, keyring: rotatedKeyring }, probeSequence: 2, usage: { inputTokens: 120, outputTokens: 30 } } as const;
    await expect(readDiscoveryV3GatewayEvidence({ ...target, operation: { ...operation, requestSha256: 'd'.repeat(64) } }))
      .resolves.toBeUndefined();
    expect(readbackRequests).toHaveLength(1);
    await expect(readDiscoveryV3GatewayEvidence(target)).resolves.toMatchObject({
      actualCharge: { amountMicros: 3871, currency: 'CNY' }, inputTokens: 120, outputTokens: 30,
    });
    await expect(readDiscoveryV3GatewayEvidence(target)).resolves.toBeUndefined();
    expect(generateRequests).toHaveLength(1);
    expect(readbackRequests).toHaveLength(2);
    expect(readbackRequests[1]!.headers.get('x-new-api-settlement-nonce')).toBe(generateRequests[0]!.headers.get('x-new-api-settlement-nonce'));
    expect(store.recordModelReadbackProbe).toHaveBeenLastCalledWith(command, operation, OPERATION_ID, binding,
      expect.objectContaining({ probe: { sequence: 2, phase: 'gateway_log_observed', httpStatusClass: 2 } }));
  });

  it('accepts late usage when the durable unknown receipt has no response counters', async () => {
    let ready = false;
    const { run, store, runtime, generateRequests, readbackRequests } = fixture({
      gatewayLog: (id) => ready ? [gatewayReceipt(id)] : [],
      response: () => Promise.reject(new Error('fixture response was lost')),
    });
    await expect(run()).rejects.toThrow('fixture response was lost');
    expect(store.finish.mock.lastCall?.[3]).toMatchObject({ outcome: 'UNKNOWN', cost: { basis: 'UNKNOWN' } });
    const [, operation, , , binding] = store.authorizeSend.mock.calls[0]!;
    ready = true;
    const persistedUsage = { inputTokens: null, outputTokens: null } as unknown as DiscoveryV3WireUsage;
    await expect(readDiscoveryV3GatewayEvidence({ command, operation, operationId: OPERATION_ID,
      binding: binding!, store, runtime, probeSequence: 2, usage: persistedUsage })).resolves.toMatchObject({
      actualCharge: { amountMicros: 3871, currency: 'CNY' }, inputTokens: 120, outputTokens: 30,
    });
    expect(generateRequests).toHaveLength(1);
    expect(readbackRequests).toHaveLength(2);
  });

  it('returns a valid result when the configured reader fails outside its response parser', async () => {
    vi.stubEnv('LLM_CENTS_PER_MTOK', '100');
    const { run, store, runtime, generateRequests } = fixture();
    vi.spyOn(runtime.resolver, 'resolve').mockRejectedValueOnce(new Error('fixture control-plane unavailable'));
    await expect(run()).resolves.toMatchObject({ data: 'fixture output' });
    expect(generateRequests).toHaveLength(1);
    expect(store.finish.mock.lastCall?.[3]).toMatchObject({
      outcome: 'SUCCEEDED', cost: { amountMicros: 150, currency: 'USD', basis: 'ESTIMATED', source: 'token' },
    });
  });

  it('only applies the daily breaker to new model sends and allows a durable structured result replay', async () => {
    const { runStructured, gateway, store, generateRequests, readbackRequests } = fixture();
    const result = projectModelResultForReplay('taxonomy-code/v1', { data: { code: 'CPV-123' }, provider: 'gateway', model: ALIAS });
    store.claim.mockResolvedValueOnce({ status: 'REPLAY', operationId: OPERATION_ID, result, resultSha256: result.digest });
    gateway.dailyCostBreaker = new TenantDailyCostBreaker({ reader: { readDailySpendUsd: async () => 2 }, thresholdUsd: 1 });
    await expect(runStructured()).resolves.toMatchObject({ data: { code: 'CPV-123' } });
    await expect(runStructured()).rejects.toMatchObject({ code: 'TENANT_DAILY_COST_ANOMALY_TRIPPED' });
    expect(generateRequests).toHaveLength(0);
    expect(readbackRequests).toHaveLength(0);
    expect(store.authorizeSend).not.toHaveBeenCalled();
  });

  it('compares Anthropic usage with cache writes and reads included in input tokens', async () => {
    const { run, store, generateRequests } = fixture({
      anthropic: true,
      response: () => Response.json({
        model: 'claude-sonnet-5', content: [{ type: 'text', text: 'fixture output' }], stop_reason: 'end_turn',
        usage: { input_tokens: 40, output_tokens: 30, cache_creation_input_tokens: 10, cache_read_input_tokens: 70 },
      }),
      gatewayLog: (id) => [gatewayReceipt(id, { model_name: 'claude-sonnet-5', usage_semantic: 'anthropic',
        prompt_tokens: 40, cache_creation_tokens: 10, cache_read_tokens: 70 })],
    });
    await expect(run()).resolves.toMatchObject({ data: 'fixture output' });
    expect(generateRequests[0]!.headers.get('x-api-key')).toBe(TENANT_FIXTURE_CREDENTIAL);
    expect(store.finish.mock.lastCall?.[3]).toMatchObject({
      outcome: 'SUCCEEDED', usage: { inputTokens: 120, outputTokens: 30 },
      cost: expect.objectContaining({ amountMicros: 3871, currency: 'CNY', basis: 'PROVIDER_REPORTED' }),
    });
  });

  it('sends the admitted chat messages if the caller edits its input during database authorization', async () => {
    const { gateway, runInScope, context, store, generateRequests } = fixture();
    const messages = [{ role: 'user' as const, content: 'admitted fixture text' }];
    store.authorizeSend.mockImplementationOnce(async () => {
      messages[0]!.content = 'mutated fixture text';
      return 10_000;
    });
    await runInScope(() => gateway.generateChatWithTools({
      task: 'discovery.qualify_fit', messages, tools: [], maxTokens: 150,
    }, context));
    expect(await generateRequests[0]!.json()).toMatchObject({ messages: [{ role: 'user', content: 'admitted fixture text' }] });
  });

  it.each([
    ['quota without an amount', { actual_charge: undefined }],
    ['a different request', { request_id: 'x'.repeat(43) }],
    ['a different usage count', { prompt_tokens: 121 }],
    ['an invalid currency', { actual_charge: { currency: 'usd', amount_micros: '3871' } }],
  ])('keeps successful body token costs estimated when readback carries %s', async (_name, overrides) => {
    vi.stubEnv('LLM_CENTS_PER_MTOK', '100');
    const { run, store, generateRequests, readbackRequests } = fixture({ gatewayLog: (id) => [gatewayReceipt(id, overrides)] });
    await expect(run()).resolves.toMatchObject({ data: 'fixture output' });
    expect(generateRequests).toHaveLength(1);
    expect(readbackRequests).toHaveLength(1);
    expect(store.finish.mock.lastCall?.[3]).toMatchObject({
      outcome: 'SUCCEEDED', usage: { inputTokens: 120, outputTokens: 30 },
      cost: { amountMicros: 150, currency: 'USD', basis: 'ESTIMATED', source: 'token' },
    });
  });

  it('requires an independently configured readback credential', async () => {
    const env = { MODEL_GATEWAY_URL: ORIGIN, MODEL_GATEWAY_KEY: TENANT_FIXTURE_CREDENTIAL,
      MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL: READER };
    await expect(createDiscoveryV3GatewayReadbackRuntimeFromEnv(env)).resolves.toBeUndefined();
    await expect(createDiscoveryV3GatewayReadbackRuntimeFromEnv({ ...env,
      DISCOVERY_V3_GATEWAY_READBACK_CREDENTIAL: READER,
      DISCOVERY_V3_GATEWAY_READBACK_KEYRING_FILE: '/missing-fixture-keyring',
    })).rejects.toThrow('DISCOVERY_V3_GATEWAY_READBACK_UNAVAILABLE');
  });
});
