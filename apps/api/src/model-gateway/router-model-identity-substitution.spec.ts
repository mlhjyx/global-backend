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
import { restoreModelResultFromReplay } from '../durable-results/model-result-replay';

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

/** One upstream body per physical wire, in order (first call, then repair). */
function stubUpstreamSequence(texts: readonly string[]): void {
  const fetchMock = vi.fn();
  for (const text of texts) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => text,
      json: async () => JSON.parse(text),
    });
  }
  vi.stubGlobal('fetch', fetchMock);
}

const oneChunk = (model: string, content: string) =>
  sse([
    { model, choices: [{ delta: { content }, finish_reason: 'stop' }] },
    { model, choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
  ]);

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
    settle: vi.fn(async (
      _reservation: unknown,
      observed: bigint,
      _projection?: unknown,
      _receiptFacts?: unknown,
    ) => ({
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
        modelSubstitution: { requestedModel: PRO, substituteModels: [FLASH] },
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
      expect.objectContaining({ model: FLASH, modelSubstitution: { requestedModel: PRO, substituteModels: [FLASH] } }),
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

  it('prices a substituted call exactly like the same call answered by pro', async () => {
    // 1,000,000 tokens price at 100 cents with the blended, model-agnostic
    // token rate: more than the 40-cent reservation. The observed amount
    // reaches the store unchanged, so its LEAST(observed, reserved) charge,
    // cap-variance flag and account exhaustion still apply.
    const usage = { prompt_tokens: 900_000, completion_tokens: 100_000 };
    const observedFor = async (stream: string): Promise<bigint> => {
      stubUpstream(stream);
      const budgetStore = spyBudgetStore(400_000n);
      const { gateway } = gatewayWith(
        streamingProvider(),
        'deepseek-v4-pro>deepseek-v4-flash',
        budgetStore,
      );
      await gateway.generateStructured(structured(), ctx());
      expect(budgetStore.settle).toHaveBeenCalledTimes(1);
      return budgetStore.settle.mock.calls[0][1] as bigint;
    };

    const flash = await observedFor(flashStream(usage));
    const pro = await observedFor(
      sse([
        { model: 'deepseek.deepseek-v4-pro', choices: [{ delta: { content: '{"a":1}' }, finish_reason: 'stop' }] },
        { model: PRO, choices: [], usage },
      ]),
    );

    expect(flash).toBe(1_000_000n);
    expect(flash).toBe(pro);
  });

  it('records a durable receipt charge no larger than the reserved quote', async () => {
    stubUpstream(
      sse([
        {
          model: FLASH_BUILD,
          choices: [{ delta: { content: '{"industry":"i","summary":"s"}' }, finish_reason: 'stop' }],
        },
        { model: FLASH_BUILD, choices: [], usage: { prompt_tokens: 900_000, completion_tokens: 100_000 } },
      ]),
    );
    const budgetStore = spyBudgetStore(400_000n);
    const { gateway } = gatewayWith(
      streamingProvider(),
      'deepseek-v4-pro>deepseek-v4-flash',
      budgetStore,
    );

    await gateway.generateStructured(
      {
        task: 'company_understanding.extract_profile',
        prompt: 'p',
        model: PRO,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['industry', 'summary'],
          properties: { industry: { type: 'string' }, summary: { type: 'string' } },
        },
      },
      ctx({ durableResultSchema: 'understanding-profile/v1' }),
    );

    expect(budgetStore.settle.mock.calls[0][3]).toMatchObject({
      costBasis: 'token_pricing',
      usage: { chargedMicrousd: '400000', upperBoundMicrousd: '400000' },
    });
  });

  it('records the substitute on an unusable substituted answer and leaves the overrun to the store', async () => {
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
        modelSubstitution: { requestedModel: PRO, substituteModels: [FLASH] },
      }),
    );
    // Same blended token price as any other call; the store, not the gateway,
    // caps the charge and flags the overrun.
    expect(budgetStore.settle.mock.calls[0][1]).toBe(1_000_000n);
  });

  it('projects and replays the substitute, not pro, as the durable result', async () => {
    stubUpstream(
      sse([
        {
          model: FLASH_BUILD,
          choices: [{ delta: { content: '{"industry":"i","summary":"s"}' }, finish_reason: 'stop' }],
        },
        { model: FLASH_BUILD, choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
      ]),
    );
    const budgetStore = spyBudgetStore();
    const { gateway } = gatewayWith(
      streamingProvider(),
      'deepseek-v4-pro>deepseek-v4-flash',
      budgetStore,
    );

    await gateway.generateStructured(
      {
        task: 'company_understanding.extract_profile',
        prompt: 'p',
        model: PRO,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['industry', 'summary'],
          properties: { industry: { type: 'string' }, summary: { type: 'string' } },
        },
      },
      ctx({ durableResultSchema: 'understanding-profile/v1' }),
    );

    const projection = budgetStore.settle.mock.calls[0][2];
    expect(projection).toBeDefined();
    expect(
      restoreModelResultFromReplay('understanding-profile/v1', projection),
    ).toMatchObject({
      model: FLASH,
      reportedModel: FLASH_BUILD,
      modelResolutionSource: 'upstream_response',
    });
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

  it.each([
    ['a task that has not opted in', 'adhoc.unregistered_task', undefined],
    ['an opted-in task when the deployment has none', SUBSTITUTABLE_TASK, undefined],
    ['an opted-in task even with the setting on', SUBSTITUTABLE_TASK, 'deepseek-v4-pro>deepseek-v4-flash'],
  ])('refuses substitutes a caller supplies itself (%s)', async (_label, task, setting) => {
    stubUpstream(flashStream());
    const { gateway, budgetStore } = gatewayWith(streamingProvider(), setting);

    await expect(
      gateway.generateStructured(structured(task), ctx({ modelIdentitySubstitutes: [FLASH] })),
    ).rejects.toThrow('MODEL_IDENTITY_SUBSTITUTES_CALLER_SUPPLIED');
    expect(budgetStore.reserve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
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

describe('RouterModelGateway — operations a substitute answered in part', () => {
  const PRO_ALIAS = 'deepseek.deepseek-v4-pro';

  it('flags a Flash first answer even when the pro repair produced the result', async () => {
    stubUpstreamSequence([oneChunk(FLASH_BUILD, '{"b":1}'), oneChunk(PRO_ALIAS, '{"a":1}')]);
    const { gateway, trace } = gatewayWith(
      streamingProvider(),
      'deepseek-v4-pro>deepseek-v4-flash',
    );

    const out = await gateway.generateStructured(structured(), ctx());

    // The returned answer is pro's; the operation still used a Flash wire.
    expect(out).toMatchObject({ data: { a: 1 }, model: PRO, callCount: 2 });
    expect(trace.record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'OK',
        model: PRO,
        modelSubstitution: { requestedModel: PRO, substituteModels: [FLASH] },
      }),
    );
  });

  it('labels the result Flash when the Flash repair produced it', async () => {
    stubUpstreamSequence([oneChunk(PRO_ALIAS, '{"b":1}'), oneChunk(FLASH_BUILD, '{"a":2}')]);
    const { gateway, trace } = gatewayWith(
      streamingProvider(),
      'deepseek-v4-pro>deepseek-v4-flash',
    );

    await expect(gateway.generateStructured(structured(), ctx())).resolves.toMatchObject({
      data: { a: 2 },
      model: FLASH,
    });
    expect(trace.record).toHaveBeenCalledWith(
      expect.objectContaining({
        model: FLASH,
        modelSubstitution: { requestedModel: PRO, substituteModels: [FLASH] },
      }),
    );
  });

  it('flags a failed repair whose first answer came from Flash', async () => {
    stubUpstreamSequence([oneChunk(FLASH_BUILD, '{"b":1}'), oneChunk(PRO_ALIAS, '{"b":2}')]);
    const { gateway, trace } = gatewayWith(
      streamingProvider(),
      'deepseek-v4-pro>deepseek-v4-flash',
    );

    await expect(gateway.generateStructured(structured(), ctx())).rejects.toMatchObject({
      reasonCode: 'STRUCTURED_OUTPUT_SCHEMA_INVALID_AFTER_REPAIR',
    });
    expect(trace.record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ERROR',
        model: PRO,
        modelSubstitution: { requestedModel: PRO, substituteModels: [FLASH] },
      }),
    );
  });

  it('names Flash on a stream that broke after Flash-named chunks', async () => {
    stubUpstream(
      `data: ${JSON.stringify({ model: FLASH_BUILD, choices: [{ delta: { content: '{"a":' } }] })}\n\n` +
        'data: {not json\n\n',
    );
    const { gateway, trace } = gatewayWith(
      streamingProvider(),
      'deepseek-v4-pro>deepseek-v4-flash',
    );

    await expect(gateway.generateStructured(structured(), ctx())).rejects.toMatchObject({
      reasonCode: 'CHAT_COMPLETIONS_STREAM_LINE_INVALID',
      model: FLASH,
    });
    expect(trace.record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ERROR',
        model: FLASH,
        modelSubstitution: { requestedModel: PRO, substituteModels: [FLASH] },
      }),
    );
  });

  it('keeps a broken stream under the requested model when the setting is off', async () => {
    stubUpstream(
      `data: ${JSON.stringify({ model: FLASH_BUILD, choices: [{ delta: { content: '{"a":' } }] })}\n\n` +
        'data: {not json\n\n',
    );
    const { gateway, trace } = gatewayWith(streamingProvider());

    await expect(gateway.generateStructured(structured(), ctx())).rejects.toMatchObject({
      reasonCode: 'CHAT_COMPLETIONS_STREAM_LINE_INVALID',
      model: PRO,
    });
    const entry = trace.record.mock.calls[0][0] as Record<string, unknown>;
    expect(entry.model).toBe(PRO);
    expect(entry).not.toHaveProperty('modelSubstitution');
  });

  it('refuses substitutes a context only inherits, keeping nothing else from it', async () => {
    stubUpstream(flashStream());
    const { gateway, budgetStore } = gatewayWith(streamingProvider());
    const authorizeExternalAction = vi.fn(async () => true);
    const inherited = Object.assign(
      Object.create({ modelIdentitySubstitutes: [FLASH], authorizeExternalAction }) as AiContext,
      { workspaceId: WORKSPACE, runId: 'run-1' },
    );

    await expect(
      gateway.generateStructured(structured('adhoc.unregistered_task'), inherited),
    ).rejects.toThrow('MODEL_IDENTITY_SUBSTITUTES_CALLER_SUPPLIED');
    expect(budgetStore.reserve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('RouterModelGateway — answers whose identity the upstream never stated', () => {
  const unnamed = sse([
    { choices: [{ delta: { content: '{"a":7}' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
  ]);

  it('marks an unnamed answer as unproven while substitutes are admitted', async () => {
    stubUpstream(unnamed);
    const { gateway, trace } = gatewayWith(
      streamingProvider(),
      'deepseek-v4-pro>deepseek-v4-flash',
    );

    await expect(gateway.generateStructured(structured(), ctx())).resolves.toMatchObject({
      model: PRO,
      modelResolutionSource: 'requested_fallback',
    });
    const entry = trace.record.mock.calls[0][0] as Record<string, unknown>;
    expect(entry).toMatchObject({ status: 'OK', model: PRO, modelIdentityUnproven: true });
    expect(entry).not.toHaveProperty('modelSubstitution');
  });

  it.each([
    ['the setting is off', undefined, SUBSTITUTABLE_TASK],
    ['the task has not opted in', 'deepseek-v4-pro>deepseek-v4-flash', 'adhoc.unregistered_task'],
  ])('adds no marker when %s', async (_label, setting, task) => {
    stubUpstream(unnamed);
    const { gateway, trace } = gatewayWith(streamingProvider(), setting);

    await gateway.generateStructured(structured(task), ctx());

    const entry = trace.record.mock.calls[0][0] as Record<string, unknown>;
    expect(entry).not.toHaveProperty('modelIdentityUnproven');
    expect(entry).not.toHaveProperty('modelSubstitution');
  });
});

describe('OpenAICompatibleProvider — substitutes outside the gateway', () => {
  it('honours only repository-reviewed substitutes even if a context carries others', async () => {
    stubUpstream(
      sse([{ model: 'gemini-3.5-flash', choices: [{ delta: { content: '{"a":1}' }, finish_reason: 'stop' }] }]),
    );

    const error = await streamingProvider()
      .generateStructured(
        { task: 't', prompt: 'p', schema: {}, model: PRO },
        ctx({ modelIdentitySubstitutes: ['gemini-3.5-flash'] }),
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(ProviderIdentityError);
  });

  it('accepts the exact substitute name on the Responses transport but not the chat-only build alias', async () => {
    const responses = new OpenAICompatibleProvider({
      id: 'gateway',
      baseUrl: 'http://gw.test/v1',
      apiKey: 'k',
      model: 'default-model',
      modelTransports: { [PRO]: 'openai-responses' },
    });
    const body = (model: string) =>
      JSON.stringify({
        model,
        status: 'completed',
        output: [{ content: [{ type: 'output_text', text: '{"a":1}' }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    const call = () =>
      responses.generateStructured(
        { task: 't', prompt: 'p', schema: {}, model: PRO, maxTokens: 100 },
        ctx({ modelIdentitySubstitutes: [FLASH] }),
      );

    stubUpstream(body(FLASH));
    await expect(call()).resolves.toMatchObject({ model: FLASH, reportedModel: FLASH });

    stubUpstream(body(FLASH_BUILD));
    await expect(call()).rejects.toBeInstanceOf(ProviderIdentityError);
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
