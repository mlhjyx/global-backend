import { describe, expect, it, vi } from 'vitest';
import { RouterModelGateway } from './router-model-gateway';
import { ModelRouter } from './model-router';
import { ModelProvider } from './model-provider';
import { BudgetLedger, BudgetExceededError } from '../tools/budget';
import { ModelResult } from './types';

/**
 * 收口② D：LLM 网关预算门——task.maxCostCents 从纯声明变 reserve-then-settle 真闸。
 * 账户键 = ctx.runId ?? ctx.workspaceId；未开账户 = 不限（与 ToolBroker 同语义）。
 */

const QUALIFY_TASK = 'discovery.qualify_fit'; // task-registry 里 maxCostCents=20 的真实契约

function fakeProvider(impl?: () => Promise<ModelResult<string>>): ModelProvider {
  return {
    id: 'fake',
    generateText: vi.fn(impl ?? (async () => ({ data: 'ok', provider: 'fake', model: 'm' }))),
    generateStructured: vi.fn(async () => ({ data: {} as never, provider: 'fake', model: 'm' })),
    embed: vi.fn(async () => ({ data: [], provider: 'fake', model: 'm' })),
    health: vi.fn(async () => ({ healthy: true })),
  } as unknown as ModelProvider;
}

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
      fakeProvider(async () => ({ data: 'ok', provider: 'fake', model: 'm', usage: { costUsd: 0.02 } })),
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
    await expect(gw.generateText({ task: QUALIFY_TASK, prompt: 'p' }, { workspaceId: 'ws-1', runId: 'run-1' })).rejects.toThrow(
      'model down',
    );
    expect(budget.remainingCents('run-1')).toBe(100);
  });

  it('无 runId → 按 workspaceId 归账（sweep 场景）', async () => {
    const budget = new BudgetLedger();
    budget.open('ws-1', 100);
    const gw = gatewayWith(fakeProvider(), budget);
    await gw.generateText({ task: QUALIFY_TASK, prompt: 'p' }, { workspaceId: 'ws-1' });
    expect(budget.remainingCents('ws-1')).toBe(80);
  });
});
