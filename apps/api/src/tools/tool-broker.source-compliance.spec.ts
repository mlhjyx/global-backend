import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from './tool-registry';
import { ToolBroker, ToolPolicyDenied } from './tool-broker';
import { InMemoryBudgetStoreAdapter } from '@global/test-support';
import { RateLimiter } from './rate-limiter';
import type { Tool } from './tool-contract';

/**
 * 源合规矩阵闸门（获客 vNext W4）：声明了 compliance.sourceKey 的新源工具在
 * SOURCE_COMPLIANCE_GATE=enforce 时要求 source_compliance_matrix 有已批准行；
 * 默认 off 时行为不变；未声明 sourceKey 的旧源不受影响。
 */

function sourceTool(id: string, sourceKey?: string): Tool {
  return {
    id,
    version: '1.0.0',
    category: 'structured_source',
    sourceClass: 'company_registry',
    cost: { unit: 'call', estimatedCents: 0, external: false },
    rateLimit: { rps: 100, concurrency: 10 },
    compliance: {
      sourcePolicy: 'none',
      respectsRobots: false,
      personalData: false,
      allowedPurpose: ['discovery'],
      reversible: true,
      authRequired: false,
      risk: 'low',
      ...(sourceKey ? { sourceKey } : {}),
    },
    capabilities: { produces: ['company'], accepts: ['keywords'] },
    idempotencyKey: () => `${id}:k`,
    durableResultStrategy: { kind: 'no_physical_call' },
    healthCheck: async () => ({ healthy: true }),
    execute: async () => ({ data: { ok: true }, costCents: 0 }),
  } as Tool;
}

function brokerFor(
  tool: Tool,
  options: {
    mode?: 'off' | 'enforce';
    reader?: (sourceKey: string) => Promise<{ approved: boolean } | null>;
  } = {},
) {
  const registry = new ToolRegistry();
  registry.register(tool);
  return new ToolBroker({
    registry,
    budgetStore: new InMemoryBudgetStoreAdapter(),
    limiter: new RateLimiter(),
    now: () => 1_000_000,
    sourceComplianceMode: options.mode,
    sourceComplianceReader: options.reader,
  });
}

const CTX = { workspaceId: '00000000-0000-4000-8000-000000000001' };

describe('ToolBroker 源合规矩阵闸门（SOURCE_COMPLIANCE_GATE）', () => {
  it('默认 off：声明了 sourceKey 的工具照常执行，reader 不被查询', async () => {
    const reader = vi.fn(async () => null);
    const broker = brokerFor(sourceTool('opencorporates.search', 'opencorporates'), { reader });
    const result = await broker.invoke('opencorporates.search', {}, CTX);
    expect(result.data).toEqual({ ok: true });
    expect(reader).not.toHaveBeenCalled();
  });

  it('enforce + 矩阵行未登记 → fail-closed 拒绝', async () => {
    const broker = brokerFor(sourceTool('opencorporates.search', 'opencorporates'), {
      mode: 'enforce',
      reader: async () => null,
    });
    await expect(broker.invoke('opencorporates.search', {}, CTX)).rejects.toThrow(
      /source compliance unregistered: opencorporates/,
    );
  });

  it('enforce + 行存在但 approved_at 为空（未批准）→ fail-closed 拒绝', async () => {
    const broker = brokerFor(sourceTool('opencorporates.search', 'opencorporates'), {
      mode: 'enforce',
      reader: async () => ({ approved: false }),
    });
    await expect(broker.invoke('opencorporates.search', {}, CTX)).rejects.toBeInstanceOf(
      ToolPolicyDenied,
    );
    await expect(broker.invoke('opencorporates.search', {}, CTX)).rejects.toThrow(
      /source compliance not approved/,
    );
  });

  it('enforce + 无 reader → fail-closed 拒绝（部署缺陷不当放行）', async () => {
    const broker = brokerFor(sourceTool('opencorporates.search', 'opencorporates'), {
      mode: 'enforce',
    });
    await expect(broker.invoke('opencorporates.search', {}, CTX)).rejects.toThrow(
      /source compliance reader unavailable/,
    );
  });

  it('enforce + 已批准行 → 放行执行', async () => {
    const reader = vi.fn(async (key: string) => (key === 'opencorporates' ? { approved: true } : null));
    const broker = brokerFor(sourceTool('opencorporates.search', 'opencorporates'), {
      mode: 'enforce',
      reader,
    });
    const result = await broker.invoke('opencorporates.search', {}, CTX);
    expect(result.data).toEqual({ ok: true });
    expect(reader).toHaveBeenCalledWith('opencorporates');
  });

  it('enforce 下未声明 sourceKey 的旧源不受影响（行为不变，reader 不被查询）', async () => {
    const reader = vi.fn(async () => null);
    const broker = brokerFor(sourceTool('ted.search'), { mode: 'enforce', reader });
    const result = await broker.invoke('ted.search', {}, CTX);
    expect(result.data).toEqual({ ok: true });
    expect(reader).not.toHaveBeenCalled();
  });

  it('env SOURCE_COMPLIANCE_GATE=enforce 在未显式注入模式时生效（默认 off 之外的另一入口）', async () => {
    const previous = process.env.SOURCE_COMPLIANCE_GATE;
    process.env.SOURCE_COMPLIANCE_GATE = 'enforce';
    try {
      const broker = brokerFor(sourceTool('opencorporates.search', 'opencorporates'), {
        reader: async () => null,
      });
      await expect(broker.invoke('opencorporates.search', {}, CTX)).rejects.toThrow(
        /source compliance unregistered/,
      );
    } finally {
      if (previous === undefined) delete process.env.SOURCE_COMPLIANCE_GATE;
      else process.env.SOURCE_COMPLIANCE_GATE = previous;
    }
  });
});
