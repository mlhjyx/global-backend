import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { RouterModelGateway } from './router-model-gateway';
import { ModelRouter } from './model-router';
import { ModelProvider } from './model-provider';
import {
  ProviderIdentityError,
  ProviderOutputError,
  TaskOutputValidationError,
} from './providers/provider-output-error';
import { BudgetLedger, BudgetExceededError } from '../tools/budget';
import { ModelResult, type ReviewVisionInput } from './types';
import { AiTraceSink } from './ai-trace.sink';

/**
 * 收口② D：LLM 网关预算门——task.maxCostCents 从纯声明变 reserve-then-settle 真闸。
 * 账户键 = ctx.runId ?? ctx.workspaceId；未开账户 = 不限（与 ToolBroker 同语义）。
 */

const QUALIFY_TASK = 'discovery.qualify_fit'; // task-registry 里 maxCostCents=20 的真实契约

function fakeProvider(impl?: () => Promise<ModelResult<string>>): ModelProvider {
  return {
    id: 'fake',
    generateText: vi.fn(impl ?? (async () => ({ data: 'ok', provider: 'fake', model: 'm' }))),
    generateStructured: vi.fn(async () => ({
      data: {} as never,
      provider: 'fake',
      model: 'm',
    })),
    embed: vi.fn(async () => ({ data: [], provider: 'fake', model: 'm' })),
    health: vi.fn(async () => ({ healthy: true })),
  } as unknown as ModelProvider;
}

const visionInput = (): ReviewVisionInput => ({
  task: 'site_builder.aesthetic_review.eval',
  prompt: 'review',
  model: 'gemini-3.5-flash',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok'],
    properties: { ok: { type: 'boolean' } },
  },
  images: [
    {
      materialClass: 'model_eval_fixture',
      artifactId: 'case-home-375',
      mimeType: 'image/png',
      bytes: Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]),
      sha256: createHash('sha256')
        .update(
          Uint8Array.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          ]),
        )
        .digest('hex'),
      target: { locale: 'en', pageId: 'home', breakpoint: 375 },
    },
  ],
  maxTokens: 1000,
  maxCostCents: 20,
});

function gatewayWith(provider: ModelProvider, budget: BudgetLedger): RouterModelGateway {
  const router = { route: () => [provider] } as unknown as ModelRouter;
  const gw = new RouterModelGateway(router);
  gw.budget = budget;
  return gw;
}

describe('RouterModelGateway — 预算 reserve-then-settle（收口② D）', () => {
  it('未开账户 → 不限预算（内部调用照常）', async () => {
    const budget = new BudgetLedger();
    const gw = gatewayWith(fakeProvider(), budget);
    const r = await gw.generateText({ task: QUALIFY_TASK, prompt: 'p' }, { workspaceId: 'ws-1' });
    expect(r.data).toBe('ok');
  });

  it('开账后超限 → 抛 BudgetExceededError 且模型不被调用（真拦截）', async () => {
    const budget = new BudgetLedger();
    budget.open('run-1', 30); // maxCostCents=20 → 只够 1 次
    const provider = fakeProvider();
    const gw = gatewayWith(provider, budget);

    await gw.generateText({ task: QUALIFY_TASK, prompt: 'p' }, { workspaceId: 'ws-1', runId: 'run-1' });
    await expect(
      gw.generateText({ task: QUALIFY_TASK, prompt: 'p' }, { workspaceId: 'ws-1', runId: 'run-1' }),
    ).rejects.toThrow(BudgetExceededError);
    // 第二次在 reserve 处被拦，provider 只被调了一次
    expect((provider.generateText as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('generateStructured 预留两次上限（含校验-修复重试）→ 账户仅够一次时整体在 reserve 处被拦（#51 P2）', async () => {
    const budget = new BudgetLedger();
    budget.open('run-1', 30); // maxCostCents=20 → 单次(20)够、两次(40)不够
    const provider = fakeProvider();
    const gw = gatewayWith(provider, budget);
    await expect(
      gw.generateStructured({ task: QUALIFY_TASK, prompt: 'p', schema: {} }, { workspaceId: 'ws-1', runId: 'run-1' }),
    ).rejects.toThrow(BudgetExceededError);
    // 修复预算无法预留 → 第一次模型调用也不发生（reserve 在调用前，修复不再打穿账户）
    expect((provider.generateStructured as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('generateStructured 预算充足（≥两次上限）→ 正常执行', async () => {
    const budget = new BudgetLedger();
    budget.open('run-1', 40); // 恰够两次上限
    const provider = fakeProvider();
    const gw = gatewayWith(provider, budget);
    const r = await gw.generateStructured(
      { task: QUALIFY_TASK, prompt: 'p', schema: {} },
      { workspaceId: 'ws-1', runId: 'run-1' },
    );
    expect(r.data).toEqual({});
  });

  it('generateStructured 修复重试且无 usage → settle 按**两次**调用兜底（修复不被少记、硬上界不被绕过，#82 P2）', async () => {
    const budget = new BudgetLedger();
    budget.open('run-1', 40); // 恰两次上限
    const provider = fakeProvider();
    // 首次输出缺 x（schema 校验失败）→ 触发修复；修复补上 x（通过）。两次均**不报** usage。
    (provider.generateStructured as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        data: {} as never,
        provider: 'fake',
        model: 'm',
      })
      .mockResolvedValueOnce({
        data: { x: 1 } as never,
        provider: 'fake',
        model: 'm',
      });
    const gw = gatewayWith(provider, budget);
    await gw.generateStructured(
      { task: QUALIFY_TASK, prompt: 'p', schema: { required: ['x'] } },
      { workspaceId: 'ws-1', runId: 'run-1' },
    );
    // 两次调用各 20¢ → settle 40¢ → 账户见底（不再留 20¢ 给下次绕过硬顶）。
    expect(budget.remainingCents('run-1')).toBe(0);
    expect((provider.generateStructured as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('generateStructured 首次即通过（无修复）无 usage → settle 只按**一次**（不高估、退还预留另一半）', async () => {
    const budget = new BudgetLedger();
    budget.open('run-1', 40);
    const gw = gatewayWith(fakeProvider(), budget); // 默认 generateStructured 返回 {}，schema {} 通过 → 无修复
    await gw.generateStructured(
      { task: QUALIFY_TASK, prompt: 'p', schema: {} },
      { workspaceId: 'ws-1', runId: 'run-1' },
    );
    expect(budget.remainingCents('run-1')).toBe(20); // 预留 40、settle 20（1 次）→ 剩 20
  });

  it('provider 不上报 costUsd → 按声明上限记账（settle=est，保守上界）', async () => {
    const budget = new BudgetLedger();
    budget.open('run-1', 100);
    const gw = gatewayWith(fakeProvider(), budget);
    await gw.generateText({ task: QUALIFY_TASK, prompt: 'p' }, { workspaceId: 'ws-1', runId: 'run-1' });
    expect(budget.remainingCents('run-1')).toBe(80); // 100 - 20（上限记账）
  });

  it('上报 costUsd → 按实结算（退还预留差额）', async () => {
    const budget = new BudgetLedger();
    budget.open('run-1', 100);
    const gw = gatewayWith(
      fakeProvider(async () => ({
        data: 'ok',
        provider: 'fake',
        model: 'm',
        usage: { costUsd: 0.02 },
      })),
      budget,
    );
    await gw.generateText({ task: QUALIFY_TASK, prompt: 'p' }, { workspaceId: 'ws-1', runId: 'run-1' });
    expect(budget.remainingCents('run-1')).toBe(98); // ceil(0.02*100)=2¢
  });

  it('全链失败 → 不计费（预留全额退还），错误原样上抛', async () => {
    const budget = new BudgetLedger();
    budget.open('run-1', 100);
    const gw = gatewayWith(
      fakeProvider(async () => {
        throw new Error('model down');
      }),
      budget,
    );
    await expect(
      gw.generateText({ task: QUALIFY_TASK, prompt: 'p' }, { workspaceId: 'ws-1', runId: 'run-1' }),
    ).rejects.toThrow('model down');
    expect(budget.remainingCents('run-1')).toBe(100);
  });

  it('无 runId → 按 workspaceId 归账（sweep 场景）', async () => {
    const budget = new BudgetLedger();
    budget.open('ws-1', 100);
    const gw = gatewayWith(fakeProvider(), budget);
    await gw.generateText({ task: QUALIFY_TASK, prompt: 'p' }, { workspaceId: 'ws-1' });
    expect(budget.remainingCents('ws-1')).toBe(80);
  });

  it('Site Builder policy snapshot and fallback index are copied into the gateway trace', async () => {
    const budget = new BudgetLedger();
    const trace = { record: vi.fn() } as unknown as AiTraceSink;
    const router = { route: () => [fakeProvider()] } as unknown as ModelRouter;
    const gw = new RouterModelGateway(router, trace);
    gw.budget = budget;

    await gw.generateText(
      {
        task: 'site_builder.copy',
        prompt: 'p',
        maxCostCents: 40,
        model: 'selected-model',
      },
      {
        workspaceId: 'ws-1',
        modelPolicy: {
          policyVersion: 'site-builder-model-policy/v1',
          profile: 'copy.premium',
          routeState: 'currentRoute',
          lifecycle: 'active',
          source: 'registry',
          dataPolicy: {
            transport: 'new_api_only',
            region: 'gateway_controlled',
            personalData: 'forbidden',
            dataScope: 'company_facts_only',
          },
          maxCostCents: 40,
          route: { primary: 'selected-model', fallbacks: ['fallback-model'] },
          fallbackIndex: 1,
        },
      },
    );

    expect(trace.record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'OK',
        modelPolicy: expect.objectContaining({
          profile: 'copy.premium',
          fallbackIndex: 1,
          route: { primary: 'selected-model', fallbacks: ['fallback-model'] },
        }),
      }),
    );
  });
});

describe('RouterModelGateway — vision identity and closed output gate', () => {
  const exactResult = {
    data: { ok: true },
    provider: 'gateway',
    model: 'gemini-3.5-flash',
    reportedModel: 'gemini-3.5-flash',
    modelResolutionSource: 'upstream_response' as const,
    usage: { inputTokens: 10, outputTokens: 2 },
  };

  it('accepts only exact upstream provenance plus schema-valid output', async () => {
    const provider = {
      ...fakeProvider(),
      reviewVision: vi.fn(async () => exactResult),
    } as unknown as ModelProvider;
    const result = await gatewayWith(
      provider,
      new BudgetLedger(),
    ).reviewVision(visionInput(), { workspaceId: 'ws-1' });
    expect(result).toEqual(exactResult);
  });

  it('treats model identity mismatch as terminal and never tries another provider', async () => {
    const mismatched = {
      ...fakeProvider(),
      id: 'mismatched',
      reviewVision: vi.fn(async () => ({
        ...exactResult,
        provider: 'mismatched',
        model: 'provider-fallback',
        reportedModel: 'provider-fallback',
      })),
    } as unknown as ModelProvider;
    const fallback = {
      ...fakeProvider(),
      id: 'fallback',
      reviewVision: vi.fn(async () => exactResult),
    } as unknown as ModelProvider;
    const router = {
      route: () => [mismatched, fallback],
    } as unknown as ModelRouter;
    const gateway = new RouterModelGateway(router);

    await expect(
      gateway.reviewVision(visionInput(), { workspaceId: 'ws-1' }),
    ).rejects.toBeInstanceOf(ProviderIdentityError);
    expect(fallback.reviewVision).not.toHaveBeenCalled();
  });

  it('rejects schema-invalid vision output without calling it success', async () => {
    const provider = {
      ...fakeProvider(),
      reviewVision: vi.fn(async () => ({
        ...exactResult,
        data: { unexpected: true },
      })),
    } as unknown as ModelProvider;
    await expect(
      gatewayWith(provider, new BudgetLedger()).reviewVision(visionInput(), {
        workspaceId: 'ws-1',
      }),
    ).rejects.toThrow('VISION_REVIEW_SCHEMA_INVALID');
  });

  it('rejects a runtime screenshot bound to another workspace before routing', async () => {
    const provider = {
      ...fakeProvider(),
      reviewVision: vi.fn(async () => exactResult),
    } as unknown as ModelProvider;
    const input = visionInput();
    input.task = 'site_builder.aesthetic_review';
    input.images = [
      {
        ...input.images[0]!,
        materialClass: 'workspace_site_screenshot',
        workspaceId: 'workspace-b',
      },
    ];
    await expect(
      gatewayWith(provider, new BudgetLedger()).reviewVision(input, {
        workspaceId: 'workspace-a',
      }),
    ).rejects.toThrow('VISION_REVIEW_WORKSPACE_MISMATCH');
    expect(provider.reviewVision).not.toHaveBeenCalled();
  });

  it('compiles the vision schema before routing and fails closed on an invalid schema', async () => {
    const provider = {
      ...fakeProvider(),
      reviewVision: vi.fn(async () => exactResult),
    } as unknown as ModelProvider;
    await expect(
      gatewayWith(provider, new BudgetLedger()).reviewVision(
        {
          ...visionInput(),
          schema: { type: 'not-a-json-schema-type' },
        },
        { workspaceId: 'ws-1' },
      ),
    ).rejects.toThrow('MODEL_OUTPUT_SCHEMA_INVALID');
    expect(provider.reviewVision).not.toHaveBeenCalled();
  });

  it('rejects a cyclic schema with a controlled error before snapshot recursion or routing', async () => {
    const provider = {
      ...fakeProvider(),
      reviewVision: vi.fn(async () => exactResult),
    } as unknown as ModelProvider;
    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic.self = cyclic;
    await expect(
      gatewayWith(provider, new BudgetLedger()).reviewVision(
        { ...visionInput(), schema: cyclic },
        { workspaceId: 'ws-1' },
      ),
    ).rejects.toThrow('MODEL_OUTPUT_SCHEMA_INVALID');
    expect(provider.reviewVision).not.toHaveBeenCalled();
  });

  it('rejects a limit-sized sparse schema array before JSON serialization can expand its holes', async () => {
    const provider = {
      ...fakeProvider(),
      reviewVision: vi.fn(async () => exactResult),
    } as unknown as ModelProvider;
    const sparse: unknown[] = [];
    sparse.length = 10_000;
    await expect(
      gatewayWith(provider, new BudgetLedger()).reviewVision(
        {
          ...visionInput(),
          schema: { type: 'object', anyOf: sparse },
        },
        { workspaceId: 'ws-1' },
      ),
    ).rejects.toThrow('MODEL_OUTPUT_SCHEMA_INVALID');
    expect(provider.reviewVision).not.toHaveBeenCalled();
  });

  it('rejects an over-wide schema object without materializing Object.entries', async () => {
    const provider = {
      ...fakeProvider(),
      reviewVision: vi.fn(async () => exactResult),
    } as unknown as ModelProvider;
    const properties: Record<string, unknown> = {};
    for (let index = 0; index < 10_001; index += 1) {
      properties[`p${index}`] = { type: 'string' };
    }
    await expect(
      gatewayWith(provider, new BudgetLedger()).reviewVision(
        {
          ...visionInput(),
          schema: { type: 'object', properties },
        },
        { workspaceId: 'ws-1' },
      ),
    ).rejects.toThrow('MODEL_OUTPUT_SCHEMA_INVALID');
    expect(provider.reviewVision).not.toHaveBeenCalled();
  });

  it('rejects a hidden toJSON hook before serialization can invoke caller code', async () => {
    const provider = {
      ...fakeProvider(),
      reviewVision: vi.fn(async () => exactResult),
    } as unknown as ModelProvider;
    const schema = { type: 'object' };
    const toJSON = vi.fn(() => 'x'.repeat(100_000_000));
    Object.defineProperty(schema, 'toJSON', {
      value: toJSON,
      enumerable: false,
    });
    await expect(
      gatewayWith(provider, new BudgetLedger()).reviewVision(
        { ...visionInput(), schema },
        { workspaceId: 'ws-1' },
      ),
    ).rejects.toThrow('MODEL_OUTPUT_SCHEMA_INVALID');
    expect(toJSON).not.toHaveBeenCalled();
    expect(provider.reviewVision).not.toHaveBeenCalled();
  });

  it('binds the compiled schema before await so caller mutation cannot relax the result gate', async () => {
    let resolveReview!: (result: typeof exactResult) => void;
    const provider = {
      ...fakeProvider(),
      reviewVision: vi.fn(
        () =>
          new Promise<typeof exactResult>((resolve) => {
            resolveReview = resolve;
          }),
      ),
    } as unknown as ModelProvider;
    const input = visionInput();
    const pending = gatewayWith(
      provider,
      new BudgetLedger(),
    ).reviewVision(input, { workspaceId: 'ws-1' });
    expect(provider.reviewVision).toHaveBeenCalledTimes(1);
    input.schema = {};
    input.model = 'provider-fallback';
    resolveReview({
      ...exactResult,
      data: { unexpected: true } as never,
    });

    await expect(pending).rejects.toThrow('VISION_REVIEW_SCHEMA_INVALID');
  });
});

/**
 * M1-b fast-follow 改动 2：provider 消费 token 却结构化输出失败（空/截断/非 JSON）时抛
 * ProviderOutputError 携 usage——网关 catch 在 trace 前按 centsFromTokens 结算，否则「花了 token 却
 * 失败」的调用绕过硬预算上界（全链失败 finally settle(0) 会把真实消耗记 0¢）。单次 settle 语义不变。
 */
describe('RouterModelGateway — ProviderOutputError 结算真实 token（改动 2）', () => {
  it('provider 抛 ProviderOutputError{usage} 且账户已 open → 按 token 结算（非 0），错误上抛', async () => {
    const budget = new BudgetLedger();
    budget.open('run-1', 500);
    const gw = gatewayWith(
      fakeProvider(async () => {
        throw new ProviderOutputError('truncated', { outputTokens: 1_000_000 });
      }),
      budget,
    );
    await expect(
      gw.generateText({ task: QUALIFY_TASK, prompt: 'p' }, { workspaceId: 'ws-1', runId: 'run-1' }),
    ).rejects.toBeInstanceOf(ProviderOutputError);
    // 1e6 token × 100¢/Mtok（默认价）= 100¢ 结算 → 剩 400（旧行为 settle(0) 会剩 500 绕过硬顶）
    expect(budget.remainingCents('run-1')).toBe(400);
  });

  it('[real 抛 ProviderOutputError, stub 成功] → 只记 real 的真实消耗，stub 成功 settle no-op', async () => {
    const budget = new BudgetLedger();
    budget.open('run-1', 500);
    const real = fakeProvider(async () => {
      throw new ProviderOutputError('empty', { outputTokens: 1_000_000 });
    });
    const stub = fakeProvider(async () => ({
      data: 'ok',
      provider: 'stub',
      model: 'm',
      usage: { outputTokens: 1_000_000 },
    }));
    (stub as { id: string }).id = 'stub';
    const router = { route: () => [real, stub] } as unknown as ModelRouter;
    const gw = new RouterModelGateway(router);
    gw.budget = budget;
    const r = await gw.generateText({ task: QUALIFY_TASK, prompt: 'p' }, { workspaceId: 'ws-1', runId: 'run-1' });
    expect(r.data).toBe('ok'); // 回退到 stub
    // 单次 settle：只记 real 的 100¢，stub 的 100¢ 不叠加（settled 标志维持）
    expect(budget.remainingCents('run-1')).toBe(400);
  });

  it('ProviderOutputError 无 usage → 按 callCount × 声明上限保守结算', async () => {
    const budget = new BudgetLedger();
    budget.open('run-1', 500);
    const gw = gatewayWith(
      fakeProvider(async () => {
        throw new ProviderOutputError('empty no-usage');
      }),
      budget,
    );
    await expect(
      gw.generateText({ task: QUALIFY_TASK, prompt: 'p' }, { workspaceId: 'ws-1', runId: 'run-1' }),
    ).rejects.toBeInstanceOf(ProviderOutputError);
    expect(budget.remainingCents('run-1')).toBe(480); // usage 缺失仍已发生 1 次调用 → 兜底 20¢
  });

  it('普通 Error（非 ProviderOutputError）→ 维持旧行为不计费（全额退还）', async () => {
    const budget = new BudgetLedger();
    budget.open('run-1', 500);
    const gw = gatewayWith(
      fakeProvider(async () => {
        throw new Error('model down');
      }),
      budget,
    );
    await expect(
      gw.generateText({ task: QUALIFY_TASK, prompt: 'p' }, { workspaceId: 'ws-1', runId: 'run-1' }),
    ).rejects.toThrow('model down');
    expect(budget.remainingCents('run-1')).toBe(500);
  });
});

/**
 * FIX 1（复审 HIGH）：generateStructured 校验-修复路径失败时也要结算「首调+修复」合并 token。
 * 此前两条分支都少记：修复调用抛错只带修复 usage（漏首调），recheck 失败抛裸 Error（网关记 0¢）——
 * 都绕过改动 2 的硬预算上界「凡消耗 token 的调用都不该 settle 0¢」。
 */
describe('RouterModelGateway — generateStructured 修复路径结算合并 token（FIX 1）', () => {
  it('首调 schema 不过 + 修复调用抛错 → settle=(首调+修复)合并 token（非仅修复、非 0），错误上抛', async () => {
    const budget = new BudgetLedger();
    budget.open('run-1', 500);
    const provider = fakeProvider();
    (provider.generateStructured as ReturnType<typeof vi.fn>)
      // 首调缺 x（schema 校验失败）→ 触发修复；带 sizable usage（1e6 token）
      .mockResolvedValueOnce({
        data: {} as never,
        provider: 'fake',
        model: 'm',
        usage: { inputTokens: 1_000_000 },
      })
      // 修复调用抛错（只携修复自身的小 usage 5e4）
      .mockRejectedValueOnce(new ProviderOutputError('repair truncated', { inputTokens: 50_000 }));
    const gw = gatewayWith(provider, budget);
    const error = await gw.generateStructured(
      { task: QUALIFY_TASK, prompt: 'p', schema: { required: ['x'] } },
      { workspaceId: 'ws-1', runId: 'run-1' },
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProviderOutputError);
    expect((error as ProviderOutputError).callCount).toBe(2);
    // 合并 1_050_000 token × 100¢/Mtok = 105¢（仅修复=5¢会漏首调、0¢=全不记）→ 剩 395
    expect(budget.remainingCents('run-1')).toBe(395);
  });

  it('首调 + 修复均 schema 不过（recheck 失败）→ 抛 ProviderOutputError 且 settle=合并 token（非 0）', async () => {
    const budget = new BudgetLedger();
    budget.open('run-1', 500);
    const provider = fakeProvider();
    (provider.generateStructured as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        data: {} as never,
        provider: 'fake',
        model: 'm',
        usage: { inputTokens: 1_000_000 },
      })
      // 修复后仍缺 x → recheck 失败
      .mockResolvedValueOnce({
        data: {} as never,
        provider: 'fake',
        model: 'm',
        usage: { inputTokens: 50_000 },
      });
    const gw = gatewayWith(provider, budget);
    const error = await gw.generateStructured(
      { task: QUALIFY_TASK, prompt: 'p', schema: { required: ['x'] } },
      { workspaceId: 'ws-1', runId: 'run-1' },
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProviderOutputError);
    expect((error as ProviderOutputError).callCount).toBe(2);
    // 合并 1_050_000 token = 105¢（旧行为裸 Error → 网关记 0¢ 剩 500，两次调用白烧）→ 剩 395
    expect(budget.remainingCents('run-1')).toBe(395);
  });
});

describe('RouterModelGateway — task-level deterministic output gate', () => {
  it('repairs one schema-valid task-gate rejection when the task explicitly opts in', async () => {
    const budget = new BudgetLedger();
    const trace = { record: vi.fn() } as unknown as AiTraceSink;
    const provider = fakeProvider();
    (provider.generateStructured as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        data: { quote: 'flange program FL-88' } as never,
        provider: 'fake',
        model: 'm',
        usage: { inputTokens: 7, outputTokens: 3 },
      })
      .mockResolvedValueOnce({
        data: { quote: 'Flange program FL-88' } as never,
        provider: 'fake',
        model: 'm',
        usage: { inputTokens: 5, outputTokens: 2 },
      });
    const router = { route: () => [provider] } as unknown as ModelRouter;
    const gw = new RouterModelGateway(router, trace);
    gw.budget = budget;

    const result = await gw.generateStructured(
      {
        task: 'site_builder.brand_profile',
        prompt: 'p',
        schema: { required: ['quote'] },
        repairTaskOutput: true,
        validateOutput: (data) => {
          if ((data as { quote?: string }).quote !== 'Flange program FL-88') {
            throw new Error('products:unsupported_quote');
          }
        },
      },
      { workspaceId: 'ws-1' },
    );

    expect(result.data).toEqual({ quote: 'Flange program FL-88' });
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(result.callCount).toBe(2);
    expect(provider.generateStructured).toHaveBeenCalledTimes(2);
    expect(
      (provider.generateStructured as ReturnType<typeof vi.fn>).mock.calls[1][0]
        .prompt,
    ).toContain('products:unsupported_quote');
    expect(trace.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'OK', inputTokens: 12, outputTokens: 5 }),
    );
  });

  it('schema-valid output rejected by the task gate is traced as ERROR with usage', async () => {
    const budget = new BudgetLedger();
    const trace = { record: vi.fn() } as unknown as AiTraceSink;
    const provider = fakeProvider();
    (provider.generateStructured as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { x: 1 } as never,
      provider: 'fake',
      model: 'm',
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    const router = { route: () => [provider] } as unknown as ModelRouter;
    const gw = new RouterModelGateway(router, trace);
    gw.budget = budget;

    const error = await gw.generateStructured(
      {
        task: 'site_builder.brand_profile',
        prompt: 'p',
        schema: { required: ['x'] },
        validateOutput: () => {
          throw new Error('unsupported evidence');
        },
      },
      { workspaceId: 'ws-1' },
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ProviderOutputError);
    expect((error as ProviderOutputError).usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect((error as ProviderOutputError).callCount).toBe(1);
    expect(trace.record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ERROR',
        inputTokens: 7,
        outputTokens: 3,
        errorMessage: expect.stringContaining('unsupported evidence'),
      }),
    );
    expect(trace.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'OK' }),
    );
  });

  it('a task-gate rejection after schema repair preserves both calls and merged usage', async () => {
    const budget = new BudgetLedger();
    const trace = { record: vi.fn() } as unknown as AiTraceSink;
    const provider = fakeProvider();
    (provider.generateStructured as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        data: {} as never,
        provider: 'fake',
        model: 'm',
        usage: { inputTokens: 2, outputTokens: 1 },
      })
      .mockResolvedValueOnce({
        data: { x: 1 } as never,
        provider: 'fake',
        model: 'm',
        usage: { inputTokens: 5, outputTokens: 4 },
      });
    const router = { route: () => [provider] } as unknown as ModelRouter;
    const gw = new RouterModelGateway(router, trace);
    gw.budget = budget;

    const error = await gw.generateStructured(
      {
        task: 'site_builder.brand_profile',
        prompt: 'p',
        schema: { required: ['x'] },
        validateOutput: () => {
          throw new Error('unsupported evidence after repair');
        },
      },
      { workspaceId: 'ws-1' },
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ProviderOutputError);
    expect((error as ProviderOutputError).usage).toEqual({ inputTokens: 7, outputTokens: 5 });
    expect((error as ProviderOutputError).callCount).toBe(2);
    expect(trace.record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ERROR',
        inputTokens: 7,
        outputTokens: 5,
      }),
    );
    expect(trace.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'OK' }),
    );
  });

  it('a first-call task-gate rejection without usage settles one declared call ceiling', async () => {
    const budget = new BudgetLedger();
    budget.open('run-1', 200);
    const provider = fakeProvider();
    (provider.generateStructured as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { x: 1 } as never,
      provider: 'fake',
      model: 'm',
    });
    const gw = gatewayWith(provider, budget);

    await expect(
      gw.generateStructured(
        {
          task: 'site_builder.brand_profile',
          prompt: 'p',
          schema: { required: ['x'] },
          maxCostCents: 40,
          validateOutput: () => {
            throw new Error('unsupported evidence');
          },
        },
        { workspaceId: 'ws-1', runId: 'run-1' },
      ),
    ).rejects.toBeInstanceOf(ProviderOutputError);

    expect(budget.remainingCents('run-1')).toBe(160);
  });

  it('a post-repair task-gate rejection without usage settles two declared call ceilings', async () => {
    const budget = new BudgetLedger();
    budget.open('run-1', 200);
    const provider = fakeProvider();
    (provider.generateStructured as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        data: {} as never,
        provider: 'fake',
        model: 'm',
      })
      .mockResolvedValueOnce({
        data: { x: 1 } as never,
        provider: 'fake',
        model: 'm',
      });
    const gw = gatewayWith(provider, budget);

    const error = await gw.generateStructured(
      {
        task: 'site_builder.brand_profile',
        prompt: 'p',
        schema: { required: ['x'] },
        maxCostCents: 40,
        validateOutput: () => {
          throw new Error('unsupported evidence after repair');
        },
      },
      { workspaceId: 'ws-1', runId: 'run-1' },
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ProviderOutputError);
    expect((error as ProviderOutputError).callCount).toBe(2);
    expect(budget.remainingCents('run-1')).toBe(120);
  });

  it('returns a task-gate rejection directly instead of hiding it behind the dev stub', async () => {
    const budget = new BudgetLedger();
    const trace = { record: vi.fn() } as unknown as AiTraceSink;
    const real = fakeProvider();
    (real.generateStructured as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { x: 1 } as never,
      provider: 'fake',
      model: 'm',
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    const stub = fakeProvider();
    (stub as { id: string }).id = 'stub';
    const router = { route: () => [real, stub] } as unknown as ModelRouter;
    const gw = new RouterModelGateway(router, trace);
    gw.budget = budget;

    const error = await gw.generateStructured(
      {
        task: 'site_builder.brand_profile',
        prompt: 'p',
        schema: { required: ['x'] },
        validateOutput: () => {
          throw new Error('unsupported evidence');
        },
      },
      { workspaceId: 'ws-1' },
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(TaskOutputValidationError);
    expect((error as TaskOutputValidationError).usage).toEqual({
      inputTokens: 7,
      outputTokens: 3,
    });
    expect(stub.generateStructured).not.toHaveBeenCalled();
    expect(trace.record).toHaveBeenCalledTimes(1);
    expect(trace.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ERROR', provider: 'fake' }),
    );
  });
});
