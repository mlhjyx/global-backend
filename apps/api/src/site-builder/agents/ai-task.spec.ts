import { describe, expect, it, vi } from 'vitest';
import type { ModelGateway } from '../../model-gateway/model-gateway';
import type { GenerateStructuredInput, ModelResult } from '../../model-gateway/types';
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
  primary: 'model-a',
  fallbacks: ['model-b'],
  maxTokens: 1000,
  timeoutMs: 200,
};

function gatewayReturning(
  impl: (input: GenerateStructuredInput) => Promise<ModelResult<EchoOut>>,
): { gateway: ModelGateway; calls: GenerateStructuredInput[] } {
  const calls: GenerateStructuredInput[] = [];
  const gateway = {
    generateStructured: vi.fn(async (input: GenerateStructuredInput) => {
      calls.push(input);
      return impl(input);
    }),
  } as unknown as ModelGateway;
  return { gateway, calls };
}

const okResult = (model: string): ModelResult<EchoOut> => ({
  data: { headline: 'Precision pumps' },
  provider: 'gateway',
  model,
  usage: { inputTokens: 10, outputTokens: 5 },
});

const CTX = { workspaceId: 'ws-1', runId: 'run-1' };

describe('runAiTask — 输入 fail-fast 与 prompt 固化', () => {
  it('输入不合 schema → 立即抛错，绝不调模型', async () => {
    const { gateway } = gatewayReturning(async () => okResult('model-a'));
    await expect(
      runAiTask(DEF, { name: '' } as EchoIn, { gateway, ctx: CTX, route: ROUTE }),
    ).rejects.toThrow(/input invalid/);
    expect(gateway.generateStructured).not.toHaveBeenCalled();
  });

  it('happy path：prompt 来自模板槽位，task/model/maxTokens/schema 透传网关', async () => {
    const { gateway, calls } = gatewayReturning(async (i) => okResult(i.model ?? '?'));
    const out = await runAiTask(DEF, { name: 'Acme GmbH' }, { gateway, ctx: CTX, route: ROUTE });

    expect(out.data.headline).toBe('Precision pumps');
    expect(out.model).toBe('model-a');
    expect(calls[0]).toMatchObject({
      task: 'site_builder.brand_profile',
      prompt: 'Company: Acme GmbH',
      model: 'model-a',
      maxTokens: 1000,
    });
    expect(calls[0].schema).toBe(DEF.outputSchema);
  });

  it('route.reasoningEffort 透传（copy 的 🔴 low 护栏经此生效）', async () => {
    const { gateway, calls } = gatewayReturning(async (i) => okResult(i.model ?? '?'));
    await runAiTask(DEF, { name: 'Acme' }, {
      gateway,
      ctx: CTX,
      route: { ...ROUTE, reasoningEffort: 'low' },
    });
    expect(calls[0].reasoningEffort).toBe('low');
  });
});

describe('runAiTask — 回退链与显式失败', () => {
  it('主选失败 → 按回退链换模型重试，成功即返回', async () => {
    const { gateway, calls } = gatewayReturning(async (i) => {
      if (i.model === 'model-a') throw new Error('503 upstream');
      return okResult(i.model ?? '?');
    });
    const out = await runAiTask(DEF, { name: 'Acme' }, { gateway, ctx: CTX, route: ROUTE });
    expect(out.model).toBe('model-b');
    expect(calls.map((c) => c.model)).toEqual(['model-a', 'model-b']);
  });

  it('🔴 stub 兜底拒绝：provider=stub 视为失败换下一模型（假数据绝不充真，fit-judge 先例）', async () => {
    const { gateway } = gatewayReturning(async (i) => {
      if (i.model === 'model-a') {
        return { data: { headline: 'stub junk' }, provider: 'stub', model: 'stub-v0' };
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
    const err = await runAiTask(DEF, { name: 'Acme' }, { gateway, ctx: CTX, route: ROUTE }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(AiTaskError);
    expect(err.message).toContain('model-a');
    expect(err.message).toContain('model-b');
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
});
