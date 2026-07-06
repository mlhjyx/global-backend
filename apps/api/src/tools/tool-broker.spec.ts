import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from './tool-registry';
import { ToolBroker, ToolPolicyDenied } from './tool-broker';
import { BudgetLedger, BudgetExceededError } from './budget';
import { RateLimiter } from './rate-limiter';
import { Tool } from './tool-contract';

function fakeTool(id: string, costCents = 5, exec?: () => Promise<unknown>): Tool {
  return {
    id,
    version: '1.0.0',
    category: 'search',
    cost: { unit: 'call', estimatedCents: costCents, external: false },
    rateLimit: { rps: 100, concurrency: 10 },
    compliance: { requiresSourcePolicy: false, respectsRobots: false, personalData: false, allowedPurpose: ['discovery'], reversible: true, authRequired: false, risk: 'low' },
    capabilities: { produces: ['domain'], accepts: ['keywords'] },
    idempotencyKey: () => `${id}:k`,
    healthCheck: async () => ({ healthy: true }),
    execute: async () => ({ data: (await exec?.()) ?? { ok: true }, costCents }),
  } as Tool;
}

function makeBroker(tool: Tool, extra?: Partial<ConstructorParameters<typeof ToolBroker>[0]>) {
  const registry = new ToolRegistry();
  registry.register(tool);
  return {
    registry,
    broker: new ToolBroker({ registry, budget: new BudgetLedger(), limiter: new RateLimiter(), now: () => 1_000_000, ...extra }),
  };
}

describe('ToolBroker — allowedTools 白名单（无超级 Agent 的代码强制）', () => {
  it('未注册工具 → denied', async () => {
    const { broker } = makeBroker(fakeTool('searxng.search'));
    await expect(broker.invoke('nope.tool', {}, { workspaceId: 'w' })).rejects.toThrow(ToolPolicyDenied);
  });

  it('无 taskContractId 时不做白名单限制（内部确定性调用）', async () => {
    const { broker } = makeBroker(fakeTool('searxng.search'));
    const r = await broker.invoke('searxng.search', {}, { workspaceId: 'w' });
    expect(r.data).toEqual({ ok: true });
  });

  it('声明了 taskContractId 但工具不在该任务 allowedTools → denied', async () => {
    // discovery.qualify_fit 的 allowedTools=[]，不允许任何工具
    const { broker } = makeBroker(fakeTool('searxng.search'));
    await expect(
      broker.invoke('searxng.search', {}, { workspaceId: 'w', taskContractId: 'discovery.qualify_fit' }),
    ).rejects.toThrow(/not in allowedTools/);
  });
});

describe('ToolBroker — 预算 reserve-then-settle', () => {
  it('超预算 → BudgetExceededError，工具不执行', async () => {
    const exec = vi.fn(async () => ({ ok: true }));
    const budget = new BudgetLedger();
    const { broker } = makeBroker(fakeTool('t.expensive', 30, exec), { budget });
    budget.open('run1', 20); // 预算 20¢，工具单价 30¢
    await expect(broker.invoke('t.expensive', {}, { workspaceId: 'w', runId: 'run1' })).rejects.toThrow(BudgetExceededError);
    expect(exec).not.toHaveBeenCalled();
  });

  it('并发调用各自预留，合计不超支', async () => {
    const budget = new BudgetLedger();
    const { broker } = makeBroker(fakeTool('t', 8), { budget });
    budget.open('run1', 20); // 20¢ / 8¢ = 最多 2 次
    const results = await Promise.allSettled([
      broker.invoke('t', {}, { workspaceId: 'w', runId: 'run1' }),
      broker.invoke('t', {}, { workspaceId: 'w', runId: 'run1' }),
      broker.invoke('t', {}, { workspaceId: 'w', runId: 'run1' }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;
    expect(ok).toBe(2);
    expect(rejected).toBe(1);
  });

  it('执行失败不计费（settle 0），预算退还', async () => {
    const budget = new BudgetLedger();
    const failing = fakeTool('t.fail', 10);
    failing.execute = async () => {
      throw new Error('boom');
    };
    const { broker } = makeBroker(failing, { budget });
    budget.open('run1', 10);
    await expect(broker.invoke('t.fail', {}, { workspaceId: 'w', runId: 'run1' })).rejects.toThrow('boom');
    expect(budget.remainingCents('run1')).toBe(10); // 全额退还
  });
});

describe('ToolBroker — Trace + source_policy', () => {
  it('每次调用产生一条 Trace', async () => {
    const traces: unknown[] = [];
    const { broker } = makeBroker(fakeTool('searxng.search'), { traceRecorder: (t) => traces.push(t) });
    await broker.invoke('searxng.search', {}, { workspaceId: 'w' });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ toolId: 'searxng.search', status: 'OK' });
  });

  it('SUSPENDED 域名 → denied（合规门）', async () => {
    const tool = fakeTool('crawl4ai.fetch');
    tool.compliance.requiresSourcePolicy = true;
    const { broker } = makeBroker(tool, {
      sourcePolicyReader: async (d) => ({ suspended: d === 'blocked.com' }),
    });
    await expect(
      broker.invoke('crawl4ai.fetch', { url: 'https://blocked.com/x' }, { workspaceId: 'w' }),
    ).rejects.toThrow(/SUSPENDED/);
  });
});
