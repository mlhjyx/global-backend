import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import type { ModelGateway } from '../model-gateway/model-gateway';
import type { ExecutionBroker } from '../tools/tool-contract';
import { createUnderstandingActivities } from './understanding.activities';

/**
 * FIX C（Codex P1）：crawl4ai.fetch 的 allowedPurpose 追加 site_builder 后，**不带 purpose** 的调用者
 * 会 fallback 到被扩宽的全集（含 site_builder），令仅授权 site_builder 的域策略连带放行发现/富集抓取。
 * 关闭方式=让这些调用者显式声明 purpose:['discovery','enrichment']（精确复现变更前的有效用途集，
 * 对任何域策略行为不变，只是不再被 site_builder 扩宽）。understanding 抓取即其一。
 */
describe('understanding.activities — crawl4ai.fetch 显式声明 discovery/enrichment 用途（FIX C）', () => {
  it('crawlWebsite 经 broker 调 crawl4ai.fetch 时 ctx.purpose=[discovery,enrichment]', async () => {
    const invoke = vi.fn(async () => ({ data: { text: 'hello world' }, costCents: 0 }));
    const broker = { invoke } as unknown as ExecutionBroker;
    const acts = createUnderstandingActivities({
      prisma: {} as PrismaService,
      gateway: {} as ModelGateway,
      broker,
    });
    await acts.crawlWebsite({ workspaceId: 'ws-1', website: 'https://acme.example/' });
    expect(invoke).toHaveBeenCalledTimes(1);
    const [toolId, , ctx] = invoke.mock.calls[0] as [string, unknown, { purpose?: string[] }];
    expect(toolId).toBe('crawl4ai.fetch');
    expect(ctx.purpose).toEqual(['discovery', 'enrichment']);
  });
});
