import { describe, expect, it, vi } from 'vitest';
import { WikidataDiscoveryProvider } from './wikidata.provider';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';

/**
 * 收口②回归（Codex P2 on #51 tool-broker.ts:111）：受治理 required 工具的 DISCOVERY 调用必须传
 * `ctx.purpose='discovery'`——否则 Broker 用途门退回"工具声明集任一交集"，域策略仅允许 enrichment
 * 时 discovery 调用会被误放行。ted/openfda/companies-house/inpi 已传；此处锁 wikidata + osm。
 */
function capturingBroker(): { broker: ExecutionBroker; last(): ToolContext | undefined } {
  let lastCtx: ToolContext | undefined;
  const broker: ExecutionBroker = {
    checkSourcePolicy: async () => ({ allowed: true }),
    invoke: async (_toolId, _input, ctx) => {
      lastCtx = ctx;
      // 返回空产物即可（provider 只读 data.companies）
      return { data: { companies: [] } as never, costCents: 0 };
    },
  };
  return { broker, last: () => lastCtx };
}

describe('governed discovery providers 传本次调用用途（#51 tool-broker 用途门）', () => {
  it('wikidata.sparql 调用带 purpose=discovery', async () => {
    const { broker, last } = capturingBroker();
    const p = new WikidataDiscoveryProvider({ broker });
    await p.discoverCompanies(
      { keywords: ['pumps'], filters: { _industryQids: ['Q1'] }, limit: 10, sourceClass: 'industry_data' } as never,
      { workspaceId: 'w', runId: 'r', correlationId: 'c' },
    );
    expect(last()?.purpose).toBe('discovery');
  });

  it('wikidata 单源失败只记录不可逆诊断 token，不泄露 provider 响应正文', async () => {
    const sensitive = 'buyer@example.test bearer=provider-secret';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broker: ExecutionBroker = {
      checkSourcePolicy: async () => ({ allowed: true }),
      invoke: async () => {
        throw new Error(sensitive);
      },
    };

    await expect(
      new WikidataDiscoveryProvider({ broker }).discoverCompanies(
        { keywords: [], filters: { _industryQids: ['Q1'] }, limit: 10, sourceClass: 'industry_data' } as never,
        { workspaceId: 'w', runId: 'r' },
      ),
    ).resolves.toEqual({ records: [], costCents: 0 });

    const diagnostic = warn.mock.calls.flat().join(' ');
    expect(diagnostic).toMatch(/ERROR_TEXT_SHA256:[a-f0-9]{64}/);
    expect(diagnostic).not.toContain(sensitive);
    warn.mockRestore();
  });
});
