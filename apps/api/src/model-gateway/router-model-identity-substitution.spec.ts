import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouterModelGateway } from './router-model-gateway';
import type { ModelRouter } from './model-router';
import type { AiTraceSink } from './ai-trace.sink';
import type { BudgetStore } from '../tools/budget-store';
import type { AiContext } from './types';
import { OpenAICompatibleProvider } from './providers/openai-compatible.provider';
import {
  ProviderIdentityError,
  ProviderTransportError,
} from './providers/provider-output-error';
import { NEW_API_REQUEST_BOUND_RESOLVER_ID } from './new-api-request-bound-settlement';
import { createProviderTransportObservation } from './provider-transport-observation';

/**
 * D14 (owner decision 2026-10-11): the only acquisition upstream (new-api
 * channel 24 -> OpenOx) answers some deepseek-v4-pro requests with DeepSeek V4
 * Flash. A deployment may accept that reviewed substitute for registry tasks
 * that opt in; the result, trace and spend then name Flash, never pro.
 */

const SUBSTITUTABLE_TASK = 'discovery.qualify_fit';
const PRO = 'deepseek-v4-pro';
const FLASH = 'deepseek-v4-flash';
const FLASH_BUILD = 'deepseek-ai/DeepSeek-V4-Flash-0731';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['a'],
  properties: { a: { type: 'number' } },
};

const sse = (events: readonly unknown[]): string =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
  'data: [DONE]\n\n';

function stubUpstream(text: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => text,
      json: async () => JSON.parse(text),
    })),
  );
}

const flashStream = (usage = { prompt_tokens: 11, completion_tokens: 7 }) =>
  sse([
    { model: FLASH_BUILD, choices: [{ delta: { content: '{"a":' } }] },
    { model: FLASH_BUILD, choices: [{ delta: { content: '1}' }, finish_reason: 'stop' }] },
    { model: FLASH_BUILD, choices: [], usage },
  ]);

function streamingProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: 'gateway',
    baseUrl: 'http://gw.test/v1',
    apiKey: 'k',
    model: 'default-model',
    streamChatCompletions: true,
  });
}

function plainProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: 'gateway',
    baseUrl: 'http://gw.test/v1',
    apiKey: 'k',
    model: 'default-model',
  });
}

function spyBudgetStore(reservedMicrousd = 400_000n) {
  return {
    reserve: vi.fn(async () => ({
      workspaceId: WORKSPACE,
      accountKey: 'run-1',
      operationId: 'op-1',
      estimatedMicrousd: reservedMicrousd,
      replay: false,
    })),
    settle: vi.fn(async (_reservation: unknown, observed: bigint) => ({
      chargedMicrousd: observed < reservedMicrousd ? observed : reservedMicrousd,
      observedMicrousd: observed,
      capVariance: observed > reservedMicrousd,
      replay: false,
    })),
    release: vi.fn(async () => ({})),
  };
}

function gatewayWith(
  provider: OpenAICompatibleProvider,
  substitutes?: string,
  budgetStore = spyBudgetStore(),
) {
  if (substitutes !== undefined) {
    vi.stubEnv('MODEL_IDENTITY_SUBSTITUTES', substitutes);
  }
  const trace = { record: vi.fn() };
  const gateway = new RouterModelGateway(
    { route: () => [provider] } as unknown as ModelRouter,
    trace as unknown as AiTraceSink,
    budgetStore as unknown as BudgetStore,
  );
  return { gateway, trace, budgetStore };
}

const ctx = (extra: Partial<AiContext> = {}): AiContext => ({
  workspaceId: WORKSPACE,
  runId: 'run-1',
  ...extra,
});

const structured = (task = SUBSTITUTABLE_TASK, model = PRO) => ({
  task,
  prompt: 'p',
  schema: SCHEMA,
  model,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('RouterModelGateway — deployment-approved model substitutes (D14)', () => {
  it('accepts the reviewed Flash substitute for an opted-in task and records Flash everywhere', async () => {
    stubUpstream(flashStream());
    const { gateway, trace } = gatewayWith(
      streamingProvider(),
      'deepseek-v4-pro>deepseek-v4-flash',
    );

    const out = await gateway.generateStructured(structured(), ctx());

    expect(out).toMatchObject({
      data: { a: 1 },
      model: FLASH,
      reportedModel: FLASH_BUILD,
      modelResolutionSource: 'upstream_response',
    });
    expect(trace.record).toHaveBeenCalledTimes(1);
    expect(trace.record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'OK',
        model: FLASH,
        modelSubstitution: { requestedModel: PRO },
      }),
    );
  });

  it('still requests deepseek-v4-pro on the wire', async () => {
    stubUpstream(flashStream());
    const { gateway } = gatewayWith(
      streamingProvider(),
      'deepseek-v4-pro>deepseek-v4-flash',
    );

    await gateway.generateStructured(structured(), ctx());

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.model).toBe(PRO);
  });

  it('accepts the substitute for text generation too', async () => {
    stubUpstream(
      sse([
        { model: FLASH_BUILD, choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
      ]),
    );
    const { gateway, trace } = gatewayWith(
      streamingProvider(),
      'deepseek-v4-pro>deepseek-v4-flash',
    );

    const out = await gateway.generateText(
      { task: SUBSTITUTABLE_TASK, prompt: 'p', model: PRO },
      ctx(),
    );

    expect(out).toMatchObject({ data: 'ok', model: FLASH });
    expect(trace.record).toHaveBeenCalledWith(
      expect.objectContaining({ model: FLASH, modelSubstitution: { requestedModel: PRO } }),
    );
  });

  it('accepts the Flash build name in a plain chat-completions body', async () => {
    stubUpstream(
      JSON.stringify({
        model: FLASH_BUILD,
        choices: [{ message: { content: '{"a":2}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
    );
    const { gateway } = gatewayWith(
      plainProvider(),
      'deepseek-v4-pro>deepseek-v4-flash',
    );

    await expect(gateway.generateStructured(structured(), ctx())).resolves.toMatchObject({
      data: { a: 2 },
      model: FLASH,
      reportedModel: FLASH_BUILD,
    });
  });

  it('never claims pro when a stream names Flash anywhere', async () => {
    // new-api may stamp the requested name on the usage chunk it writes itself.
    stubUpstream(
      sse([
        { model: 'deepseek.deepseek-v4-pro', choices: [{ delta: { content: '{"a":' } }] },
        { model: FLASH_BUILD, choices: [{ delta: { content: '3}' }, finish_reason: 'stop' }] },
        { model: PRO, choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
      ]),
    );
    const { gateway } = gatewayWith(
      streamingProvider(),
      'deepseek-v4-pro>deepseek-v4-flash',
    );

    await expect(gateway.generateStructured(structured(), ctx())).resolves.toMatchObject({
      model: FLASH,
      reportedModel: FLASH_BUILD,
      modelResolutionSource: 'upstream_response',
    });
  });

  it('labels unnamed content Flash when only the closing chunk names Flash', async () => {
    stubUpstream(
      sse([
        { choices: [{ delta: { content: '{"a":' } }] },
        { choices: [{ delta: { content: '4}' }, finish_reason: 'stop' }] },
        { model: FLASH_BUILD, choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
      ]),
    );
    const { gateway } = gatewayWith(
      streamingProvider(),
      'deepseek-v4-pro>deepseek-v4-flash',
    );

    await expect(gateway.generateStructured(structured(), ctx())).resolves.toMatchObject({
      model: FLASH,
      reportedModel: FLASH_BUILD,
    });
  });

  it('keeps a genuine pro answer labelled pro with no substitution marker', async () => {
    stubUpstream(
      sse([
        { model: 'deepseek.deepseek-v4-pro', choices: [{ delta: { content: '{"a":5}' }, finish_reason: 'stop' }] },
        { model: PRO, choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
      ]),
    );
    const { gateway, trace } = gatewayWith(
      streamingProvider(),
      'deepseek-v4-pro>deepseek-v4-flash',
    );

    await expect(gateway.generateStructured(structured(), ctx())).resolves.toMatchObject({
      model: PRO,
    });
    const entry = trace.record.mock.calls[0][0] as Record<string, unknown>;
    expect(entry.model).toBe(PRO);
    expect(entry).not.toHaveProperty('modelSubstitution');
  });

  it('settles a substituted call at no more than the reserved pro quote', async () => {
    // 1,000,000 tokens price at 100 cents with the blended token rate, more
    // than the 40-cent reservation for a two-wire structured call.
    stubUpstream(flashStream({ prompt_tokens: 900_000, completion_tokens: 100_000 }));
    const budgetStore = spyBudgetStore(400_000n);
    const { gateway } = gatewayWith(
      streamingProvider(),
      'deepseek-v4-pro>deepseek-v4-flash',
      budgetStore,
    );

    await gateway.generateStructured(structured(), ctx());

    expect(budgetStore.settle).toHaveBeenCalledTimes(1);
    const observed = budgetStore.settle.mock.calls[0][1] as bigint;
    expect(observed).toBeLessThanOrEqual(400_000n);
  });

  it('records the substitute on an unusable substituted answer and never charges above the reservation', async () => {
    stubUpstream(
      sse([
        { model: FLASH_BUILD, choices: [{ delta: { content: '{"a":' } }] },
        { model: FLASH_BUILD, choices: [], usage: { prompt_tokens: 900_000, completion_tokens: 100_000 } },
      ]),
    );
    const budgetStore = spyBudgetStore(400_000n);
    const { gateway, trace } = gatewayWith(
      streamingProvider(),
      'deepseek-v4-pro>deepseek-v4-flash',
      budgetStore,
    );

    await expect(gateway.generateStructured(structured(), ctx())).rejects.toBeInstanceOf(
      ProviderTransportError,
    );
    expect(trace.record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ERROR',
        model: FLASH,
        modelSubstitution: { requestedModel: PRO },
      }),
    );
    expect(budgetStore.settle.mock.calls[0][1] as bigint).toBeLessThanOrEqual(400_000n);
  });

  it('fails startup on a malformed setting', () => {
    vi.stubEnv('MODEL_IDENTITY_SUBSTITUTES', 'deepseek-v4-pro');

    expect(
      () =>
        new RouterModelGateway(
          { route: () => [] } as unknown as ModelRouter,
          undefined,
          spyBudgetStore() as unknown as BudgetStore,
        ),
    ).toThrow(/^MODEL_IDENTITY_SUBSTITUTES_INVALID/);
  });
});

describe('RouterModelGateway — identity stays exact outside the approved substitution', () => {
  const expectMismatch = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProviderIdentityError);
    expect((error as Error).message).toBe('MODEL_IDENTITY_MISMATCH');
  };

  it('rejects Flash for pro when the deployment setting is absent (default)', async () => {
    stubUpstream(flashStream());
    const { gateway } = gatewayWith(streamingProvider());

    await expectMismatch(gateway.generateStructured(structured(), ctx()));
  });

  it('rejects Flash for pro when the deployment setting is empty', async () => {
    stubUpstream(flashStream());
    const { gateway } = gatewayWith(streamingProvider(), '');

    await expectMismatch(gateway.generateStructured(structured(), ctx()));
  });

  it.each(['adhoc.unregistered_task', 'site_builder.brand_profile'])(
    'rejects Flash for a task that has not opted in (%s)',
    async (task) => {
      stubUpstream(flashStream());
      const { gateway } = gatewayWith(
        streamingProvider(),
        'deepseek-v4-pro>deepseek-v4-flash',
      );

      await expectMismatch(gateway.generateStructured(structured(task), ctx()));
    },
  );

  it('ignores substitutes a caller tries to supply itself', async () => {
    stubUpstream(flashStream());
    const { gateway } = gatewayWith(streamingProvider());

    await expectMismatch(
      gateway.generateStructured(
        structured('adhoc.unregistered_task'),
        ctx({ modelIdentitySubstitutes: [FLASH] }),
      ),
    );
  });

  it('ignores caller-supplied substitutes for an opted-in task when the deployment has none', async () => {
    stubUpstream(flashStream());
    const { gateway } = gatewayWith(streamingProvider());

    await expectMismatch(
      gateway.generateStructured(structured(), ctx({ modelIdentitySubstitutes: [FLASH] })),
    );
  });

  it('rejects another model family even with the setting on', async () => {
    stubUpstream(
      sse([{ model: 'gpt-5.6-sol', choices: [{ delta: { content: '{"a":1}' }, finish_reason: 'stop' }] }]),
    );
    const { gateway } = gatewayWith(
      streamingProvider(),
      'deepseek-v4-pro>deepseek-v4-flash',
    );

    await expectMismatch(gateway.generateStructured(structured(), ctx()));
  });

  it('rejects an unreviewed Flash build name even with the setting on', async () => {
    stubUpstream(
      sse([
        { model: 'deepseek-ai/DeepSeek-V4-Flash-0801', choices: [{ delta: { content: '{"a":1}' }, finish_reason: 'stop' }] },
      ]),
    );
    const { gateway } = gatewayWith(
      streamingProvider(),
      'deepseek-v4-pro>deepseek-v4-flash',
    );

    await expectMismatch(gateway.generateStructured(structured(), ctx()));
  });

  it('does not apply the pair in the other direction (pro for a flash request)', async () => {
    stubUpstream(
      sse([
        { model: 'deepseek.deepseek-v4-pro', choices: [{ delta: { content: '{"a":1}' }, finish_reason: 'stop' }] },
      ]),
    );
    const { gateway } = gatewayWith(
      streamingProvider(),
      'deepseek-v4-pro>deepseek-v4-flash',
    );

    await expectMismatch(gateway.generateStructured(structured(SUBSTITUTABLE_TASK, FLASH), ctx()));
  });
});

describe('OpenAICompatibleProvider — paid calls never take a substitute', () => {
  const requestId = 'R'.repeat(43);
  const paidCtx = {
    workspaceId: WORKSPACE,
    runId: '22222222-2222-4222-8222-222222222222',
    modelIdentitySubstitutes: [FLASH],
    paidCost: {
      siteId: '33333333-3333-4333-8333-333333333333',
      scopeKey: 'copy:model:0',
      settlementPhysicalWire: {
        identity: {
          schemaVersion: 'site-build-settlement-wire-identity/v1' as const,
          physicalWireAttempt: 1 as const,
          derivationKeyId: 'settlement-test',
          requestId,
          nonce: 'N'.repeat(43),
          nonceSha256: 'a'.repeat(64),
        },
        begin: async () => 'DISPATCH' as const,
        resolve: async (input: {
          payloadState: 'not_read' | 'available' | 'unavailable';
          gatewayIdState: 'observed' | 'missing' | 'not_observable';
        }) => ({
          status: 'unknown' as const,
          physicalWireAttempt: 1 as const,
          requestId,
          resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID,
          reason: 'gateway_log_unavailable' as const,
          transportObservation: createProviderTransportObservation({
            physicalWireAttempt: 1,
            finalPhase: 'gateway_log_unavailable',
            gatewayIdState: input.gatewayIdState,
            upstreamIdState: 'unknown',
            payloadState: input.payloadState,
            readbackProbes: [],
          }),
        }),
      },
    },
  } as unknown as AiContext;

  it('rejects the Flash build for a paid pro call even when substitutes are present on the context', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: FLASH_BUILD,
              choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    const error = await plainProvider()
      .generateStructured({ task: 't', prompt: 'p', schema: {}, model: PRO }, paidCtx)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(ProviderIdentityError);
    expect((error as Error).message).toBe('MODEL_IDENTITY_MISMATCH');
  });
});
