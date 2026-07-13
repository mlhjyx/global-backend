import { describe, expect, it } from 'vitest';
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
});
