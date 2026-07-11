import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError } from '../../tools/budget';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import type { ModelGateway } from '../../model-gateway/model-gateway';
import type { CompanyDiscoveryQuery, ExecutionContext } from '../provider-contract';

/**
 * 预算耗尽透传单测（Codex PR #51 P1）：run 预算打穿时，PublicWebDiscoveryProvider 绝不能把
 * BudgetExceededError 吞成「站点不可达/空结果」——那会让 discovery 活动假 DONE、悄悄丢候选、
 * 污染 run 完整性。预算异常必须冒泡出 discoverCompanies，交由活动显性上报截断（PARTIAL）。
 *
 * robots 是模块级出网闸门（真 fetch robots.txt）——测试里放行首页，让管线走到 crawl/gateway。
 */
vi.mock('../../adapters/robots', () => ({ isAllowedByRobots: async () => true }));

import { PublicWebDiscoveryProvider } from './public-web.provider';

const QUERY: CompanyDiscoveryQuery = {
  sourceClass: 'public_intelligence',
  filters: { industry: 'pumps' },
  keywords: ['centrifugal'],
  limit: 25,
};
const CTX: ExecutionContext = { workspaceId: 'ws-1', runId: 'run-1', correlationId: 'run-1' };

/** 假 Broker：searxng 返回候选、crawl4ai 返回文本或抛错（Error 实例 → throw）。 */
function makeBroker(opts: {
  searchResults?: { url: string; title: string }[];
  crawl?: () => unknown;
}): ExecutionBroker {
  return {
    checkSourcePolicy: async () => ({ allowed: true }),
    invoke: async <I, O>(toolId: string, _input: I, _ctx: ToolContext) => {
      if (toolId === 'searxng.search') {
        return { ok: true, data: { results: opts.searchResults ?? [] }, meta: {} } as never;
      }
      if (toolId === 'crawl4ai.fetch') {
        const out = opts.crawl ? opts.crawl() : { text: 'x'.repeat(500) };
        if (out instanceof Error) throw out;
        return { ok: true, data: out, meta: {} } as never;
      }
      throw new Error(`unexpected tool ${toolId}`);
    },
  } as never;
}

const SEARCH = [{ url: 'https://acme-pumps.de/', title: 'Acme Pumps' }];
const RICH_TEXT = { text: 'Acme Pumps GmbH manufactures centrifugal pumps for industry. '.repeat(20) };

describe('PublicWebDiscoveryProvider —— 预算耗尽透传（不吞成假成功）', () => {
  it('gateway 抽取阶段预算耗尽 → discoverCompanies 抛 BudgetExceededError（allSettled 不吞）', async () => {
    const broker = makeBroker({ searchResults: SEARCH, crawl: () => RICH_TEXT });
    const gateway = {
      generateStructured: async () => {
        throw new BudgetExceededError('run-1', 20, 0);
      },
    } as unknown as ModelGateway;
    const provider = new PublicWebDiscoveryProvider({ gateway, broker });
    await expect(provider.discoverCompanies(QUERY, CTX)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('crawl 抓取阶段预算耗尽 → discoverCompanies 抛 BudgetExceededError（mineDomain 抓取 catch 不吞预算）', async () => {
    const broker = makeBroker({ searchResults: SEARCH, crawl: () => new BudgetExceededError('run-1', 20, 0) });
    const gateway = {
      generateStructured: async () => {
        throw new Error('gateway should not be reached when crawl budget-fails');
      },
    } as unknown as ModelGateway;
    const provider = new PublicWebDiscoveryProvider({ gateway, broker });
    await expect(provider.discoverCompanies(QUERY, CTX)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('非预算抓取失败 → 跳过该候选、不抛（保留 fail-safe）', async () => {
    const broker = makeBroker({ searchResults: SEARCH, crawl: () => new Error('ECONNRESET') });
    const gateway = {
      generateStructured: async () => {
        throw new Error('gateway should not be reached');
      },
    } as unknown as ModelGateway;
    const provider = new PublicWebDiscoveryProvider({ gateway, broker });
    const r = await provider.discoverCompanies(QUERY, CTX);
    expect(r.records).toEqual([]);
  });
});
