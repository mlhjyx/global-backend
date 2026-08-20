import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import type { ModelGateway } from '../model-gateway/model-gateway';
import type { ExecutionBroker } from '../tools/tool-contract';
import type { RuntimeTelemetry } from '../model-runtime/types';
import type { BudgetStore } from '../tools/budget-store';
import { runBudgetCents } from '../tools/budget';
import { createUnderstandingActivities } from './understanding.activities';

function budgetStoreSpies() {
  const open = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  return {
    open,
    close,
    store: { open, close } as unknown as BudgetStore,
  };
}

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
    const budget = budgetStoreSpies();
    const acts = createUnderstandingActivities({
      prisma: {} as PrismaService,
      gateway: {} as ModelGateway,
      broker,
      budgetStore: budget.store,
      activityRunId: () => 'understanding-run-1',
    });
    await acts.crawlWebsite({ workspaceId: 'ws-1', website: 'https://acme.example/' });
    expect(invoke).toHaveBeenCalledTimes(1);
    const [toolId, , ctx] = invoke.mock.calls[0] as [string, unknown, { purpose?: string[] }];
    expect(toolId).toBe('crawl4ai.fetch');
    expect(ctx.purpose).toEqual(['discovery', 'enrichment']);
  });
});

describe('understanding.activities — unified runtime telemetry', () => {
  it('propagates the worker telemetry lifecycle into structured model calls', async () => {
    const emit = vi.fn();
    const generateStructured = vi.fn(async () => ({
      data: { claims: [] },
      provider: 'gateway',
      model: 'deepseek-v4-pro',
      usage: { inputTokens: 4, outputTokens: 2 },
    }));
    const budget = budgetStoreSpies();
    const acts = createUnderstandingActivities({
      prisma: {} as PrismaService,
      gateway: { generateStructured } as unknown as ModelGateway,
      runtimeTelemetry: { emit } as RuntimeTelemetry,
      budgetStore: budget.store,
      activityRunId: () => 'understanding-run-1',
    });

    await acts.extractClaims({ workspaceId: 'ws-1', text: 'Acme makes pumps.' });

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'company_understanding.extract_claims',
      workspaceId: 'ws-1',
      reasoning: expect.any(String),
      fallbackIndex: 0,
    }));
  });
});

describe('understanding.activities — durable workflow budget lifecycle', () => {
  it('opens every egress/model activity on the stable workflow account and passes the same key to execution context', async () => {
    const budget = budgetStoreSpies();
    const invoke = vi.fn(async () => ({ data: { text: 'Acme makes pumps.' }, costCents: 0 }));
    const generateStructured = vi.fn(async (input: { task: string }) => ({
      data: input.task.endsWith('extract_claims')
        ? { claims: [] }
        : input.task.endsWith('extract_offerings')
          ? { offerings: [] }
          : { industry: 'Industrial machinery', summary: 'Pump maker' },
      provider: 'gateway',
      model: 'model',
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const update = vi.fn(async () => undefined);
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({ companyProfile: { update } }),
      ),
    } as unknown as PrismaService;
    const acts = createUnderstandingActivities({
      prisma,
      gateway: { generateStructured } as unknown as ModelGateway,
      broker: { invoke } as unknown as ExecutionBroker,
      budgetStore: budget.store,
      activityRunId: () => 'understanding-workflow-run',
    });

    await acts.crawlWebsite({ workspaceId: 'ws-1', website: 'https://acme.example/' });
    await acts.crawlPages({ workspaceId: 'ws-1', urls: ['https://acme.example/about'] });
    await acts.extractClaims({ workspaceId: 'ws-1', text: 'claims' });
    await acts.extractOfferings({ workspaceId: 'ws-1', text: 'offerings' });
    await acts.extractAndPersistProfile({
      workspaceId: 'ws-1',
      companyId: 'company-1',
      website: 'https://acme.example/',
      text: 'profile',
    });

    const accountKey = 'understanding:understanding-workflow-run';
    expect(budget.open).toHaveBeenCalledTimes(5);
    for (const [input] of budget.open.mock.calls) {
      expect(input).toEqual({
        workspaceId: 'ws-1',
        accountKey,
        capCents: runBudgetCents(),
        replayScope: true,
      });
    }
    expect(budget.close).toHaveBeenCalledTimes(5);
    expect(invoke).toHaveBeenCalledTimes(2);
    for (const call of invoke.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ runId: accountKey }));
    }
    expect(generateStructured).toHaveBeenCalledTimes(3);
    for (const call of generateStructured.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({ runId: accountKey }));
    }
  });

  it('closes the workflow budget account when egress fails', async () => {
    const budget = budgetStoreSpies();
    const acts = createUnderstandingActivities({
      prisma: {} as PrismaService,
      gateway: {} as ModelGateway,
      broker: { invoke: vi.fn(async () => Promise.reject(new Error('wire failed'))) } as unknown as ExecutionBroker,
      budgetStore: budget.store,
      activityRunId: () => 'understanding-workflow-run',
    });

    await expect(
      acts.crawlWebsite({ workspaceId: 'ws-1', website: 'https://acme.example/' }),
    ).rejects.toThrow('wire failed');
    expect(budget.close).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      accountKey: 'understanding:understanding-workflow-run',
    });
  });
});
