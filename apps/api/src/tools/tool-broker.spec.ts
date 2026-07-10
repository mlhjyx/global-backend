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
    compliance: { sourcePolicy: 'none', respectsRobots: false, personalData: false, allowedPurpose: ['discovery'], reversible: true, authRequired: false, risk: 'low' },
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
    tool.compliance.sourcePolicy = 'advisory';
    const { broker } = makeBroker(tool, {
      sourcePolicyReader: async (d) => ({ suspended: d === 'blocked.com' }),
    });
    await expect(
      broker.invoke('crawl4ai.fetch', { url: 'https://blocked.com/x' }, { workspaceId: 'w' }),
    ).rejects.toThrow(/SUSPENDED/);
  });

  it('预算超限也要留 DENIED trace（审计可见）', async () => {
    const traces: { status: string; reason?: string }[] = [];
    const budget = new BudgetLedger();
    const { broker } = makeBroker(fakeTool('t.pricy', 30), { budget, traceRecorder: (t) => traces.push(t) });
    budget.open('run1', 10);
    await expect(broker.invoke('t.pricy', {}, { workspaceId: 'w', runId: 'run1' })).rejects.toThrow(BudgetExceededError);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ status: 'DENIED' });
    expect(traces[0].reason).toMatch(/budget/i);
  });
});

describe('ToolBroker — source_policy fail-closed（收口②：未登记不放行）', () => {
  function requiredTool(policyDomain?: string): Tool {
    const t = fakeTool('gov.source');
    t.compliance.sourcePolicy = 'required';
    if (policyDomain) t.compliance.policyDomain = policyDomain;
    return t;
  }

  it('required + 未登记域（reader 返 null）→ denied(unregistered)，工具不执行', async () => {
    const exec = vi.fn(async () => ({ ok: true }));
    const t = requiredTool();
    t.execute = async () => ({ data: await exec(), costCents: 0 });
    const { broker } = makeBroker(t, { sourcePolicyReader: async () => null });
    await expect(
      broker.invoke('gov.source', { domain: 'unknown.example' }, { workspaceId: 'w' }),
    ).rejects.toThrow(/unregistered/);
    expect(exec).not.toHaveBeenCalled();
    const chk = await broker.checkSourcePolicy('gov.source', 'unknown.example');
    expect(chk).toEqual({ allowed: false, reason: 'unregistered' });
  });

  it('required + 无 sourcePolicyReader → denied(policy_unavailable)（忘注入即拒，非放行）', async () => {
    const { broker } = makeBroker(requiredTool());
    await expect(
      broker.invoke('gov.source', { domain: 'api.example' }, { workspaceId: 'w' }),
    ).rejects.toThrow(/policy_unavailable|source_policy/);
    const chk = await broker.checkSourcePolicy('gov.source', 'api.example');
    expect(chk).toEqual({ allowed: false, reason: 'policy_unavailable' });
  });

  it('required + input 提不出域名且无 policyDomain → denied（不静默跳过合规门）', async () => {
    const { broker } = makeBroker(requiredTool(), { sourcePolicyReader: async () => ({ suspended: false }) });
    await expect(broker.invoke('gov.source', { q: 'no-domain-here' }, { workspaceId: 'w' })).rejects.toThrow(ToolPolicyDenied);
  });

  it('required + policyDomain 固定治理域：input 无 url 也按 policyDomain 查策略并放行', async () => {
    const seen: string[] = [];
    const { broker } = makeBroker(requiredTool('api.ted.europa.eu'), {
      sourcePolicyReader: async (d) => {
        seen.push(d);
        return { suspended: false, allowedPurpose: ['discovery'] };
      },
    });
    const r = await broker.invoke('gov.source', { q: 'pumps' }, { workspaceId: 'w' });
    expect(r.data).toEqual({ ok: true });
    expect(seen).toEqual(['api.ted.europa.eu']);
  });

  it('required + 用途不允许 → denied(purpose_not_allowed)', async () => {
    const { broker } = makeBroker(requiredTool('api.example'), {
      sourcePolicyReader: async () => ({ suspended: false, allowedPurpose: ['outreach'] }),
    });
    await expect(broker.invoke('gov.source', {}, { workspaceId: 'w' })).rejects.toThrow(/purpose/);
  });

  it('advisory + 未登记域 → 放行（标的公司站点由 robots/DAT-011 兜底）', async () => {
    const t = fakeTool('crawl.subject');
    t.compliance.sourcePolicy = 'advisory';
    const { broker } = makeBroker(t, { sourcePolicyReader: async () => null });
    const r = await broker.invoke('crawl.subject', { url: 'https://some-company.example/' }, { workspaceId: 'w' });
    expect(r.data).toEqual({ ok: true });
  });

  it('advisory + 已登记 SUSPENDED → denied（登记则强制）', async () => {
    const t = fakeTool('crawl.subject');
    t.compliance.sourcePolicy = 'advisory';
    const { broker } = makeBroker(t, { sourcePolicyReader: async () => ({ suspended: true }) });
    await expect(
      broker.invoke('crawl.subject', { url: 'https://blocked.example/' }, { workspaceId: 'w' }),
    ).rejects.toThrow(/SUSPENDED/);
  });

  it('sourcePolicy=none → 不查策略（自托管基座）', async () => {
    const reader = vi.fn(async () => null);
    const { broker } = makeBroker(fakeTool('searxng.search'), { sourcePolicyReader: reader });
    await broker.invoke('searxng.search', { q: 'x' }, { workspaceId: 'w' });
    expect(reader).not.toHaveBeenCalled();
  });

  it('ctx.purpose：用途门按**本次调用用途**判——域策略只允许 enrichment 时，discovery 调用被拒（TED E2E 抓到的回归）', async () => {
    const t = requiredTool('api.example');
    t.compliance.allowedPurpose = ['discovery', 'enrichment']; // 工具声明多用途
    const { broker } = makeBroker(t, {
      sourcePolicyReader: async () => ({ suspended: false, allowedPurpose: ['enrichment'] }),
    });
    // 不传 purpose → 工具声明集任一交集（enrichment 命中）→ 放行（多用途工具既有语义）
    await expect(broker.invoke('gov.source', {}, { workspaceId: 'w' })).resolves.toBeDefined();
    // 传 purpose='discovery' → 域策略不允许该用途 → 拒
    await expect(broker.invoke('gov.source', {}, { workspaceId: 'w', purpose: 'discovery' })).rejects.toThrow(/purpose/);
    // 传 purpose='enrichment' → 放行
    await expect(broker.invoke('gov.source', {}, { workspaceId: 'w', purpose: 'enrichment' })).resolves.toBeDefined();
  });

  it('ctx.purpose 不在工具声明集内 → 拒（工具不得被用于未声明用途）', async () => {
    const t = requiredTool('api.example');
    const { broker } = makeBroker(t, { sourcePolicyReader: async () => ({ suspended: false }) });
    await expect(broker.invoke('gov.source', {}, { workspaceId: 'w', purpose: 'outreach' })).rejects.toThrow(/purpose/);
  });
});
