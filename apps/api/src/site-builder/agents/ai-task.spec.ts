import { describe, expect, it, vi } from 'vitest';
import type { ModelGateway } from '../../model-gateway/model-gateway';
import type { ModelProvider } from '../../model-gateway/model-provider';
import { ModelRouter } from '../../model-gateway/model-router';
import { RouterModelGateway } from '../../model-gateway/router-model-gateway';
import type { AiContext, GenerateStructuredInput, ModelResult } from '../../model-gateway/types';
import { ProviderOutputError } from '../../model-gateway/providers/provider-output-error';
import { PaidOperationUnknownError } from '../site-build-cost-ledger';
import { AiTaskError, runAiTask, SiteBuilderTaskDefinition } from './ai-task';
import type { TaskRoute } from './task-routes';

/**
 * L2 AiTask 基类（09 §2.4 统一契约）：输入 JSON Schema fail-fast →
 * 固化 prompt（用户数据只进模板变量位）→ 网关调用（模型回退链/超时/stub 拒绝）。
 * 输出 schema 校验+修复重试在网关内（PRD 9.6），基类不重复造轮。
 */

interface EchoIn {
  name: string;
}
interface EchoOut {
  headline: string;
}

const DEF: SiteBuilderTaskDefinition<EchoIn, EchoOut> = {
  id: 'site_builder.brand_profile',
  inputSchema: {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['headline'],
    properties: { headline: { type: 'string' } },
  },
  buildPrompt: (input) => `Company: ${input.name}`,
};

const ROUTE: TaskRoute = {
  profile: 'structured.default',
  primary: 'model-a',
  fallbacks: ['model-b'],
  maxTokens: 1000,
  timeoutMs: 200,
  maxCostCents: 40,
  dataPolicy: {
    transport: 'new_api_only',
    region: 'gateway_controlled',
    personalData: 'forbidden',
    dataScope: 'company_facts_only',
  },
  policy: {
    policyVersion: 'test-policy/v1',
    profile: 'structured.default',
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
    route: { primary: 'model-a', fallbacks: ['model-b'] },
  },
};

function gatewayReturning(impl: (input: GenerateStructuredInput, ctx: AiContext) => Promise<ModelResult<EchoOut>>): {
  gateway: ModelGateway;
  calls: GenerateStructuredInput[];
  contexts: AiContext[];
} {
  const calls: GenerateStructuredInput[] = [];
  const contexts: AiContext[] = [];
  const gateway = {
    generateStructured: vi.fn(async (input: GenerateStructuredInput, ctx: AiContext) => {
      calls.push(input);
      contexts.push(ctx);
      const result = await impl(input, ctx);
      try {
        input.validateOutput?.(result.data);
      } catch (err) {
        throw new ProviderOutputError(
          `task output hard gate rejected: ${err instanceof Error ? err.message : String(err)}`,
          result.usage,
          { cause: err, callCount: result.callCount ?? 1 },
        );
      }
      return result;
    }),
  } as unknown as ModelGateway;
  return { gateway, calls, contexts };
}

const okResult = (model: string): ModelResult<EchoOut> => ({
  data: { headline: 'Precision pumps' },
  provider: 'gateway',
  model,
  reportedModel: `upstream/${model}`,
  modelResolutionSource: 'upstream_response',
  usage: { inputTokens: 10, outputTokens: 5 },
});

const CTX = { workspaceId: 'ws-1', runId: 'run-1' };

describe('runAiTask — 输入 fail-fast 与 prompt 固化', () => {
  it('输入不合 schema → 立即抛错，绝不调模型', async () => {
    const { gateway } = gatewayReturning(async () => okResult('model-a'));
    await expect(
      runAiTask(DEF, { name: '' } as EchoIn, {
        gateway,
        ctx: CTX,
        route: ROUTE,
      }),
    ).rejects.toThrow(/input invalid/);
    expect(gateway.generateStructured).not.toHaveBeenCalled();
  });

  it('happy path：prompt 来自模板槽位，task/model/maxTokens/schema 透传网关', async () => {
    const { gateway, calls, contexts } = gatewayReturning(async (i) => okResult(i.model ?? '?'));
    const out = await runAiTask(DEF, { name: 'Acme GmbH' }, { gateway, ctx: CTX, route: ROUTE });

    expect(out.data.headline).toBe('Precision pumps');
    expect(out.model).toBe('model-a');
    expect(out.provider).toBe('gateway');
    expect(out).toMatchObject({
      reportedModel: 'upstream/model-a',
      modelResolutionSource: 'upstream_response',
    });
    expect(calls[0]).toMatchObject({
      task: 'site_builder.brand_profile',
      prompt: 'Company: Acme GmbH',
      model: 'model-a',
      maxTokens: 1000,
      maxCostCents: 40,
    });
    expect(calls[0].schema).toBe(DEF.outputSchema);
    expect(out).toMatchObject({
      fallbackIndex: 0,
      routePolicy: {
        policyVersion: 'test-policy/v1',
        profile: 'structured.default',
        maxCostCents: 40,
      },
      modelSnapshot: { primary: 'model-a', fallbacks: ['model-b'] },
    });
    expect(contexts[0].modelPolicy).toMatchObject({
      profile: 'structured.default',
      route: { primary: 'model-a', fallbacks: ['model-b'] },
      fallbackIndex: 0,
    });
  });

  it('route.reasoningEffort 透传（copy 的 🔴 low 护栏经此生效）', async () => {
    const { gateway, calls } = gatewayReturning(async (i) => okResult(i.model ?? '?'));
    await runAiTask(
      DEF,
      { name: 'Acme' },
      {
        gateway,
        ctx: CTX,
        route: { ...ROUTE, reasoningEffort: 'low' },
      },
    );
    expect(calls[0].reasoningEffort).toBe('low');
  });
});

describe('runAiTask — 回退链与显式失败', () => {
  it('主选失败 → 按回退链换模型重试，成功即返回', async () => {
    const { gateway, calls, contexts } = gatewayReturning(async (i) => {
      if (i.model === 'model-a') throw new Error('503 upstream');
      return okResult(i.model ?? '?');
    });
    const out = await runAiTask(DEF, { name: 'Acme' }, { gateway, ctx: CTX, route: ROUTE });
    expect(out.model).toBe('model-b');
    expect(out.fallbackIndex).toBe(1);
    expect(calls.map((c) => c.model)).toEqual(['model-a', 'model-b']);
    expect(contexts.map((ctx) => ctx.modelPolicy?.fallbackIndex)).toEqual([0, 1]);
  });

  it('任务级确定性输出门拒绝主选 → 计入已花 usage 后换回退模型', async () => {
    const guardedDef: SiteBuilderTaskDefinition<EchoIn, EchoOut> = {
      ...DEF,
      validateOutput: (_input, output) => {
        if (output.headline === 'unsupported claim') {
          throw new Error('task output hard gate rejected');
        }
      },
    };
    const { gateway, calls, contexts } = gatewayReturning(async (input) => ({
      ...okResult(input.model ?? '?'),
      data: {
        headline:
          input.model === 'model-a'
            ? 'unsupported claim'
            : 'Precision pumps',
      },
    }));

    const out = await runAiTask(guardedDef, { name: 'Acme' }, {
      gateway,
      ctx: CTX,
      route: ROUTE,
    });
    expect(calls.map((call) => call.model)).toEqual(['model-a', 'model-b']);
    expect(contexts.map((ctx) => ctx.modelPolicy?.fallbackIndex)).toEqual([0, 1]);
    expect(out.model).toBe('model-b');
    expect(out.usage).toEqual({ inputTokens: 20, outputTokens: 10, calls: 2 });
  });

  it('dev real+stub 链把硬门错误直接交回 AiTask，保留 real usage 后切模型', async () => {
    const guardedDef: SiteBuilderTaskDefinition<EchoIn, EchoOut> = {
      ...DEF,
      validateOutput: (_input, output) => {
        if (output.headline === 'unsupported claim') {
          throw new Error('task output hard gate rejected');
        }
      },
    };
    const real = {
      id: 'gateway',
      generateStructured: vi.fn(async (input: GenerateStructuredInput) => ({
        data: {
          headline:
            input.model === 'model-a'
              ? 'unsupported claim'
              : 'Precision pumps',
        },
        provider: 'gateway',
        model: input.model ?? 'unknown',
        usage: { inputTokens: 10, outputTokens: 5 },
      })),
    } as unknown as ModelProvider;
    const stub = {
      id: 'stub',
      generateStructured: vi.fn(async () => ({
        data: { headline: 'stub junk' },
        provider: 'stub',
        model: 'stub-v0',
      })),
    } as unknown as ModelProvider;
    const router = { route: () => [real, stub] } as unknown as ModelRouter;
    const gateway = new RouterModelGateway(router);

    const out = await runAiTask(guardedDef, { name: 'Acme' }, {
      gateway,
      ctx: CTX,
      route: ROUTE,
    });

    expect(real.generateStructured).toHaveBeenCalledTimes(2);
    expect(stub.generateStructured).not.toHaveBeenCalled();
    expect(out.model).toBe('model-b');
    expect(out.fallbackIndex).toBe(1);
    expect(out.usage).toEqual({ inputTokens: 20, outputTokens: 10, calls: 2 });
  });

  it('保留主选不可用输出已消耗的 token，再由回退返回', async () => {
    const { gateway } = gatewayReturning(async (input) => {
      if (input.model === 'model-a') {
        throw new ProviderOutputError('model-a returned truncated JSON', { inputTokens: 7, outputTokens: 3 });
      }
      return okResult(input.model ?? '?');
    });

    const out = await runAiTask(DEF, { name: 'Acme' }, { gateway, ctx: CTX, route: ROUTE });
    expect(out.usage).toEqual({ inputTokens: 17, outputTokens: 8, calls: 2 });
  });

  it('🔴 stub 兜底拒绝：provider=stub 视为失败换下一模型（假数据绝不充真，fit-judge 先例）', async () => {
    const { gateway } = gatewayReturning(async (i) => {
      if (i.model === 'model-a') {
        return {
          data: { headline: 'stub junk' },
          provider: 'stub',
          model: 'stub-v0',
        };
      }
      return okResult(i.model ?? '?');
    });
    const out = await runAiTask(DEF, { name: 'Acme' }, { gateway, ctx: CTX, route: ROUTE });
    expect(out.model).toBe('model-b');
  });

  it('全链失败 → AiTaskError 聚合每个模型的失败原因（可诊断，不吞错）', async () => {
    const { gateway } = gatewayReturning(async (i) => {
      throw new Error(`${i.model} down`);
    });
    const err = await runAiTask(DEF, { name: 'Acme' }, { gateway, ctx: CTX, route: ROUTE }).catch((e) => e);
    expect(err).toBeInstanceOf(AiTaskError);
    expect(err.message).toContain('model-a');
    expect(err.message).toContain('model-b');
  });

  it('全链失败也把 provider 已报告的 token 使用量交给调用者', async () => {
    const { gateway } = gatewayReturning(async (input) => {
      throw new ProviderOutputError(
        `${input.model} invalid JSON`,
        { inputTokens: 7, outputTokens: 3 },
        {
          provider: 'new-api-eval',
          model: input.model,
          reportedModel: input.model,
          modelResolutionSource: 'upstream_response',
        },
      );
    });
    const err = await runAiTask(DEF, { name: 'Acme' }, { gateway, ctx: CTX, route: ROUTE }).catch((e) => e);

    expect(err).toBeInstanceOf(AiTaskError);
    expect((err as AiTaskError).usage).toEqual({ inputTokens: 14, outputTokens: 6, calls: 2 });
    expect((err as AiTaskError).attempts).toEqual([
      expect.objectContaining({
        model: 'model-a',
        provider: 'new-api-eval',
        resolvedModel: 'model-a',
        reportedModel: 'model-a',
        modelResolutionSource: 'upstream_response',
      }),
      expect.objectContaining({
        model: 'model-b',
        provider: 'new-api-eval',
        resolvedModel: 'model-b',
        reportedModel: 'model-b',
        modelResolutionSource: 'upstream_response',
      }),
    ]);
  });

  it('全链失败时保留 schema-repair 代表的每一次 provider 调用', async () => {
    const route = { ...ROUTE, fallbacks: [] };
    const { gateway } = gatewayReturning(async () => {
      throw new ProviderOutputError('repair failed after two provider calls', { inputTokens: 7, outputTokens: 3 }, { callCount: 2 });
    });
    const err = await runAiTask(DEF, { name: 'Acme' }, { gateway, ctx: CTX, route }).catch((e) => e);

    expect(err).toBeInstanceOf(AiTaskError);
    expect((err as AiTaskError).usage).toEqual({ inputTokens: 7, outputTokens: 3, calls: 2 });
  });

  it('单模型超时（route.timeoutMs）→ 换下一模型', async () => {
    const { gateway } = gatewayReturning(async (i) => {
      if (i.model === 'model-a') return new Promise(() => undefined) as never; // 永不返回
      return okResult(i.model ?? '?');
    });
    const out = await runAiTask(DEF, { name: 'Acme' }, { gateway, ctx: CTX, route: ROUTE });
    expect(out.model).toBe('model-b');
  });

  it('ctx（workspaceId/runId）透传网关 → 预算按 run 归账', async () => {
    const seen: unknown[] = [];
    const gateway = {
      generateStructured: vi.fn(async (_i: GenerateStructuredInput, ctx: unknown) => {
        seen.push(ctx);
        return okResult('model-a');
      }),
    } as unknown as ModelGateway;
    await runAiTask(DEF, { name: 'Acme' }, { gateway, ctx: CTX, route: ROUTE });
    expect(seen[0]).toMatchObject({ workspaceId: 'ws-1', runId: 'run-1' });
  });

  it('R4-B: each task fallback gets a distinct durable paid-operation scope', async () => {
    const { gateway, contexts } = gatewayReturning(async (input) => {
      if (input.model === 'model-a') throw new Error('primary down');
      return okResult(input.model ?? '?');
    });

    await runAiTask(DEF, { name: 'Acme' }, {
      gateway,
      route: ROUTE,
      ctx: {
        ...CTX,
        paidCost: {
          siteId: 'site-1',
          taskAttemptId: 'attempt-1',
          fenceToken: 'fence-1',
          scopeKey: 'brand-profile-attempt-1',
        },
      },
    });

    expect(contexts.map((ctx) => ctx.paidCost)).toEqual([
      {
        siteId: 'site-1',
        taskAttemptId: 'attempt-1',
        fenceToken: 'fence-1',
        scopeKey: 'brand-profile-attempt-1:model:0:model-a',
      },
      {
        siteId: 'site-1',
        taskAttemptId: 'attempt-1',
        fenceToken: 'fence-1',
        scopeKey: 'brand-profile-attempt-1:model:1:model-b',
      },
    ]);
  });

  it('R4-B: settlement acknowledgement unknown never advances to another paid model', async () => {
    const { gateway, calls } = gatewayReturning(async (input) => {
      if (input.model === 'model-a') {
        throw new PaidOperationUnknownError('a'.repeat(64), 'SETTLEMENT_ACK_UNKNOWN');
      }
      return okResult(input.model ?? '?');
    });

    await expect(
      runAiTask(DEF, { name: 'Acme' }, {
        gateway,
        route: ROUTE,
        ctx: {
          ...CTX,
          paidCost: {
            siteId: 'site-1',
            scopeKey: 'attempt-1',
          },
        },
      }),
    ).rejects.toBeInstanceOf(PaidOperationUnknownError);
    expect(calls.map((call) => call.model)).toEqual(['model-a']);
  });
});
