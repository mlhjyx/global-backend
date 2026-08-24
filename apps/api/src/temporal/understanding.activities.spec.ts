import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import type { ModelGateway } from '../model-gateway/model-gateway';
import type { ExecutionBroker } from '../tools/tool-contract';
import type { RuntimeTelemetry } from '../model-runtime/types';
import type { BudgetStore } from '../tools/budget-store';
import { createUnderstandingActivities } from './understanding.activities';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';
import { Context } from '@temporalio/activity';

const MODEL_RECEIPT: DurableExecutionReceipt = Object.freeze({
  schemaVersion: 'durable-execution-receipt/v1',
  scopeKey: '10000000-0000-4000-8000-000000000001',
  authorityId: '20000000-0000-4000-8000-000000000002',
  accountId: '30000000-0000-4000-8000-000000000001',
  operationId: '40000000-0000-4000-8000-000000000001',
  operationKey: 'understanding-model',
  resultStrategy: 'typed_projection',
  resultSchema: 'understanding-claims/v1',
  resultDigest: 'a'.repeat(64),
  artifactId: null,
  usage: { currency: 'USD', unit: 'microusd', callCount: 1, upperBoundMicrousd: '10000' },
  costBasis: 'estimated_upper_bound',
});

function budgetStoreSpies() {
  const open = vi.fn(async () => undefined);
  const attestAuthorized = vi.fn(async () => ({
    accountId: '40000000-0000-4000-8000-000000000004',
    authorityId: '20000000-0000-4000-8000-000000000002',
    authorizedCapMicrousd: 1_000_000n,
    generation: 1,
  }));
  const close = vi.fn(async () => undefined);
  return {
    open,
    attestAuthorized,
    close,
    store: { open, attestAuthorized, close } as unknown as BudgetStore,
  };
}

const UNDERSTANDING_BINDING = Object.freeze({
  authorityId: '20000000-0000-4000-8000-000000000002',
  replay: false,
  scopeKey: '10000000-0000-4000-8000-000000000001',
  accountKey: `understanding.run:company:request:${'a'.repeat(64)}:${'a'.repeat(64)}`,
  purpose: 'understanding.run' as const,
  subjectType: 'company',
  subjectId: `request:${'a'.repeat(64)}`,
  requestSha256: 'a'.repeat(64),
});
const AUTHORITY_ARGS = Object.freeze({
  workspaceId: UNDERSTANDING_BINDING.scopeKey,
  executionContractVersion: 2 as const,
  executionBudget: UNDERSTANDING_BINDING,
});

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
    await acts.crawlWebsite({ ...AUTHORITY_ARGS, website: 'https://acme.example/' });
    expect(invoke).toHaveBeenCalledTimes(1);
    const [toolId, , ctx] = invoke.mock.calls[0] as [string, unknown, { purpose?: string[] }];
    expect(toolId).toBe('crawl4ai.fetch');
    expect(ctx.purpose).toEqual(['discovery', 'enrichment']);
  });
});

describe('understanding.activities — unified runtime telemetry', () => {
  it('propagates closed model receipts to the actual persistence activity payload', async () => {
    const generateStructured = vi.fn(async (input: { task: string }) => ({
      data: input.task.endsWith('extract_claims') ? { claims: [] } : { offerings: [] },
      provider: 'gateway', model: 'model', durableReceipt: MODEL_RECEIPT,
    }));
    const budget = budgetStoreSpies();
    const acts = createUnderstandingActivities({
      prisma: {} as PrismaService,
      gateway: { generateStructured } as unknown as ModelGateway,
      budgetStore: budget.store,
    });
    await expect(acts.extractClaims({ ...AUTHORITY_ARGS, text: 'claims' }))
      .resolves.toMatchObject({ claims: [], durableReceipt: MODEL_RECEIPT });
    await expect(acts.extractOfferings({ ...AUTHORITY_ARGS, text: 'offerings' }))
      .resolves.toMatchObject({ offerings: [], durableReceipt: MODEL_RECEIPT });
  });

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

    await acts.extractClaims({ ...AUTHORITY_ARGS, text: 'Acme makes pumps.' });

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'company_understanding.extract_claims',
      workspaceId: UNDERSTANDING_BINDING.scopeKey,
      reasoning: expect.any(String),
      fallbackIndex: 0,
    }));
  });
});

describe('understanding.activities — durable workflow budget lifecycle', () => {
  it('runs claims and offerings domain writes through the same unreceipted transaction before Task 6', async () => {
    const current = vi.spyOn(Context, 'current').mockReturnValue({
      info: {
        workflowExecution: { runId: 'workflow-run-1' },
        activityId: 'activity-1',
      },
    } as never);
    const claimCreate = vi.fn(async () => ({ id: 'claim-1' }));
    const evidenceCreate = vi.fn(async () => ({}));
    const offeringUpsert = vi.fn(async () => ({}));
    const tx = {
      claim: { findMany: vi.fn(async () => []), create: claimCreate },
      knowledgeSource: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async () => ({ id: 'source-1' })),
      },
      knowledgeConflict: { create: vi.fn(async () => ({})) },
      outboxEvent: { create: vi.fn(async () => ({})) },
      evidence: { create: evidenceCreate },
      offering: { upsert: offeringUpsert },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, callback: (value: typeof tx) => unknown) =>
        callback(tx)),
    } as unknown as PrismaService;
    const acts = createUnderstandingActivities({
      prisma,
      gateway: {} as ModelGateway,
      budgetStore: budgetStoreSpies().store,
    });

    await expect(acts.persistClaims({
      ...AUTHORITY_ARGS,
      companyId: 'company-1',
      website: 'https://acme.example',
      pages: [{
        url: 'https://acme.example/about',
        claims: [{ type: 'product', statement: 'Makes pumps', confidence: 0.9 }],
      }],
    })).resolves.toEqual({ claimCount: 1 });
    await expect(acts.persistOfferings({
      ...AUTHORITY_ARGS,
      companyId: 'company-1',
      website: 'https://acme.example',
      pages: [{
        url: 'https://acme.example/products',
        offerings: [{ name: 'Pump', confidence: 0.8 }],
      }],
    })).resolves.toEqual({ offeringCount: 1 });
    expect(claimCreate).toHaveBeenCalledOnce();
    expect(evidenceCreate).toHaveBeenCalledOnce();
    expect(offeringUpsert).toHaveBeenCalledOnce();
    current.mockRestore();
  });

  it('requires the relayed authority binding and never self-opens an environment cap account', async () => {
    const budget = budgetStoreSpies();
    const invoke = vi.fn(async () => ({ data: { text: 'Acme makes pumps.' }, costCents: 0 }));
    const acts = createUnderstandingActivities({
      prisma: {} as PrismaService,
      gateway: {} as ModelGateway,
      broker: { invoke } as unknown as ExecutionBroker,
      budgetStore: budget.store,
    });

    await acts.crawlWebsite({
      workspaceId: UNDERSTANDING_BINDING.scopeKey,
      website: 'https://acme.example/',
      executionContractVersion: 2,
      executionBudget: UNDERSTANDING_BINDING,
    });

    expect(budget.attestAuthorized).toHaveBeenCalledWith({
      authorityId: UNDERSTANDING_BINDING.authorityId,
      scopeKey: UNDERSTANDING_BINDING.scopeKey,
      accountKey: UNDERSTANDING_BINDING.accountKey,
    });
    expect(budget.open).not.toHaveBeenCalled();
    expect(budget.close).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith(
      'crawl4ai.fetch',
      expect.any(Object),
      expect.objectContaining({
        workspaceId: UNDERSTANDING_BINDING.scopeKey,
        runId: UNDERSTANDING_BINDING.accountKey,
      }),
    );
  });

  it('fails missing authority closed before the broker wire', async () => {
    const budget = budgetStoreSpies();
    const invoke = vi.fn(async () => ({ data: { text: 'must not run' }, costCents: 0 }));
    const acts = createUnderstandingActivities({
      prisma: {} as PrismaService,
      gateway: {} as ModelGateway,
      broker: { invoke } as unknown as ExecutionBroker,
      budgetStore: budget.store,
    });

    await expect(
      acts.crawlWebsite({
        workspaceId: UNDERSTANDING_BINDING.scopeKey,
        website: 'https://acme.example/',
      } as never),
    ).rejects.toMatchObject({
      type: 'EXECUTION_BUDGET_LEGACY_HISTORY_PARKED',
      nonRetryable: true,
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(budget.open).not.toHaveBeenCalled();
  });

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

    await acts.crawlWebsite({ ...AUTHORITY_ARGS, website: 'https://acme.example/' });
    await acts.crawlPages({ ...AUTHORITY_ARGS, urls: ['https://acme.example/about'] });
    await acts.extractClaims({ ...AUTHORITY_ARGS, text: 'claims' });
    await acts.extractOfferings({ ...AUTHORITY_ARGS, text: 'offerings' });
    await acts.extractAndPersistProfile({
      ...AUTHORITY_ARGS,
      companyId: 'company-1',
      website: 'https://acme.example/',
      text: 'profile',
    });

    const accountKey = UNDERSTANDING_BINDING.accountKey;
    expect(budget.attestAuthorized).toHaveBeenCalledTimes(5);
    for (const [input] of budget.attestAuthorized.mock.calls) {
      expect(input).toEqual({
        authorityId: UNDERSTANDING_BINDING.authorityId,
        scopeKey: UNDERSTANDING_BINDING.scopeKey,
        accountKey,
      });
    }
    expect(budget.open).not.toHaveBeenCalled();
    expect(budget.close).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(2);
    for (const call of invoke.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ runId: accountKey }));
    }
    expect(generateStructured).toHaveBeenCalledTimes(3);
    for (const call of generateStructured.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({
        runId: accountKey,
        durableResultSchema: expect.stringMatching(/^understanding-/),
      }));
    }
  });

  it('rejects missing model claims instead of synthesizing a Stub product fact', async () => {
    const budget = budgetStoreSpies();
    const acts = createUnderstandingActivities({
      prisma: {} as PrismaService,
      gateway: { generateStructured: vi.fn(async () => ({
        data: { claims: null }, provider: 'gateway', model: 'model',
      })) } as unknown as ModelGateway,
      budgetStore: budget.store,
      activityRunId: () => 'understanding-workflow-run',
    });

    await expect(acts.extractClaims({ ...AUTHORITY_ARGS, text: 'claims' }))
      .rejects.toThrow();
  });

  it('preserves the authority account holder when egress fails', async () => {
    const budget = budgetStoreSpies();
    const acts = createUnderstandingActivities({
      prisma: {} as PrismaService,
      gateway: {} as ModelGateway,
      broker: { invoke: vi.fn(async () => Promise.reject(new Error('wire failed'))) } as unknown as ExecutionBroker,
      budgetStore: budget.store,
      activityRunId: () => 'understanding-workflow-run',
    });

    await expect(
      acts.crawlWebsite({ ...AUTHORITY_ARGS, website: 'https://acme.example/' }),
    ).rejects.toThrow('wire failed');
    expect(budget.close).not.toHaveBeenCalled();
  });

  it('does not downgrade a subpage durable replay failure into a successful partial page list', async () => {
    const budget = budgetStoreSpies();
    const replayError = Object.assign(new Error('durable result unavailable'), {
      code: 'BUDGET_OPERATION_REPLAY_UNAVAILABLE',
    });
    const acts = createUnderstandingActivities({
      prisma: {} as PrismaService,
      gateway: {} as ModelGateway,
      broker: { invoke: vi.fn(async () => { throw replayError; }) } as unknown as ExecutionBroker,
      budgetStore: budget.store,
      activityRunId: () => 'understanding-workflow-run',
    });

    await expect(acts.crawlPages({ ...AUTHORITY_ARGS, urls: ['https://acme.example/about'] }))
      .rejects.toBe(replayError);
  });
});
