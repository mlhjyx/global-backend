import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import type { ModelGateway } from '../model-gateway/model-gateway';
import type { ExecutionBroker } from '../tools/tool-contract';
import type { RuntimeTelemetry } from '../model-runtime/types';
vi.mock('@temporalio/activity', () => ({
  Context: {
    current: () => ({
      info: {
        workflowExecution: { runId: 'run-understanding-1' },
        activityId: 'activity-understanding-1',
      },
    }),
  },
}));

import { createUnderstandingActivities } from './understanding.activities';

afterEach(() => {
  vi.restoreAllMocks();
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

describe('understanding.activities — unified runtime telemetry', () => {
  it('propagates the worker telemetry lifecycle into structured model calls', async () => {
    const emit = vi.fn();
    const generateStructured = vi.fn(async () => ({
      data: { claims: [] },
      provider: 'gateway',
      model: 'deepseek-v4-pro',
      usage: { inputTokens: 4, outputTokens: 2 },
    }));
    const acts = createUnderstandingActivities({
      prisma: {} as PrismaService,
      gateway: { generateStructured } as unknown as ModelGateway,
      runtimeTelemetry: { emit } as RuntimeTelemetry,
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

describe('understanding.activities — untrusted diagnostics and model output', () => {
  it('does not synthesize a business claim from a stub or malformed model result', async () => {
    const generateStructured = vi.fn(async () => ({
      data: { claims: null },
      provider: 'stub',
      model: 'test',
      usage: {},
    }));
    const acts = createUnderstandingActivities({
      prisma: {} as PrismaService,
      gateway: { generateStructured } as unknown as ModelGateway,
    });

    await expect(acts.extractClaims({ workspaceId: 'ws-1', text: 'catalog' })).resolves.toEqual({ claims: [] });
  });

  it('hashes a failed subpage diagnostic instead of logging its URL or response text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sensitive = 'Fiona <fiona@example.com> password=secret';
    const broker = {
      invoke: vi.fn(async () => {
        throw new Error(sensitive);
      }),
    } as unknown as ExecutionBroker;
    const acts = createUnderstandingActivities({ prisma: {} as PrismaService, gateway: {} as ModelGateway, broker });

    await expect(
      acts.crawlPages({ workspaceId: 'ws-1', urls: ['https://private.example/contact'] }),
    ).resolves.toEqual({ pages: [] });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ERROR_TEXT_SHA256:[a-f0-9]{64}$/));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Fiona');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private.example');
    warn.mockRestore();
  });
});

describe('understanding.activities — bounded crawling and fail-safe subpages', () => {
  it('fails closed when the broker is unavailable', async () => {
    const acts = createUnderstandingActivities({ prisma: {} as PrismaService, gateway: {} as ModelGateway });

    await expect(acts.crawlWebsite({ workspaceId: 'ws-1', website: 'https://acme.example/' })).rejects.toThrow(
      'broker unavailable',
    );
  });

  it('bounds the root payload and keeps the source URL', async () => {
    const invoke = vi.fn().mockResolvedValue({ data: { text: 'x'.repeat(40_100) }, costCents: 0 });
    const acts = createUnderstandingActivities({
      prisma: {} as PrismaService,
      gateway: {} as ModelGateway,
      broker: { invoke } as unknown as ExecutionBroker,
    });

    const result = await acts.crawlWebsite({ workspaceId: 'ws-1', website: 'https://acme.example/' });

    expect(result.url).toBe('https://acme.example/');
    expect(result.text).toHaveLength(40_000);
  });

  it('keeps nonblank successful subpages, drops blanks, and tolerates individual failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const invoke = vi.fn(async (_toolId: string, input: { url: string }) => {
      if (input.url.endsWith('/broken')) throw new Error('private upstream detail');
      if (input.url.endsWith('/blank')) return { data: { text: '   ' }, costCents: 0 };
      return { data: { text: 'products and certifications' }, costCents: 0 };
    });
    const acts = createUnderstandingActivities({
      prisma: {} as PrismaService,
      gateway: {} as ModelGateway,
      broker: { invoke } as unknown as ExecutionBroker,
    });

    const result = await acts.crawlPages({
      workspaceId: 'ws-1',
      urls: ['https://acme.example/products', 'https://acme.example/blank', 'https://acme.example/broken'],
    });

    expect(result.pages).toEqual([
      { url: 'https://acme.example/products', text: 'products and certifications' },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    const warning = String(warn.mock.calls[0]?.[0]);
    expect(warning).toMatch(/ERROR_TEXT_SHA256:[0-9a-f]{64}$/);
    expect(warning).not.toContain('private upstream detail');
  });

  it('selects only bounded same-site key subpages', async () => {
    const acts = createUnderstandingActivities({ prisma: {} as PrismaService, gateway: {} as ModelGateway });
    const markdown = [
      '[Products](/products)',
      '[About](/about)',
      '[Contact](/contact)',
      '[Cases](/cases)',
      '[Quality](/quality)',
      '[Certifications](/certifications)',
      '[Services](/services)',
      '[External](https://other.example/products)',
    ].join(' ');

    const result = await acts.selectSubpages({ markdown, website: 'https://acme.example/' });

    expect(result).toHaveLength(6);
    expect(result.every((url) => url.startsWith('https://acme.example/'))).toBe(true);
  });
});

describe('understanding.activities — extraction and profile persistence', () => {
  it('updates status inside the workspace boundary', async () => {
    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({ companyProfile: { update } }),
      ),
    } as unknown as PrismaService;
    const acts = createUnderstandingActivities({ prisma, gateway: {} as ModelGateway });

    await acts.setStatus({ workspaceId: 'ws-1', companyId: 'company-1', status: 'ACTIVE' });

    expect(update).toHaveBeenCalledWith({ where: { id: 'company-1' }, data: { status: 'ACTIVE' } });
  });

  it('does not write an empty profile, then writes only model-provided fields', async () => {
    const update = vi.fn().mockResolvedValue({});
    const withWorkspace = vi.fn(async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ companyProfile: { update } }),
    );
    const generateStructured = vi
      .fn()
      .mockResolvedValueOnce({ data: {}, provider: 'stub', model: 'test', usage: {} })
      .mockResolvedValueOnce({
        data: { industry: 'Industrial equipment', summary: 'Builds metering pumps.' },
        provider: 'gateway',
        model: 'test',
        usage: {},
      });
    const acts = createUnderstandingActivities({
      prisma: { withWorkspace } as unknown as PrismaService,
      gateway: { generateStructured } as unknown as ModelGateway,
    });
    const input = {
      workspaceId: 'ws-1',
      companyId: 'company-1',
      website: 'https://acme.example/',
      text: 'Acme makes pumps.',
    };

    await acts.extractAndPersistProfile(input);
    expect(withWorkspace).not.toHaveBeenCalled();
    await acts.extractAndPersistProfile(input);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'company-1' },
      data: { industry: 'Industrial equipment', summary: 'Builds metering pumps.' },
    });
  });

  it('returns model offerings and converts a non-array output to an empty list', async () => {
    const offering = {
      name: 'Pump X',
      description: 'Metering pump',
      evidence: 'Public catalog states Pump X is a metering pump.',
      confidence: 0.9,
    };
    const generateStructured = vi
      .fn()
      .mockResolvedValueOnce({ data: { offerings: [offering] }, provider: 'gateway', model: 'test', usage: {} })
      .mockResolvedValueOnce({ data: { offerings: null }, provider: 'stub', model: 'test', usage: {} });
    const acts = createUnderstandingActivities({
      prisma: {} as PrismaService,
      gateway: { generateStructured } as unknown as ModelGateway,
    });

    await expect(acts.extractOfferings({ workspaceId: 'ws-1', text: 'catalog' })).resolves.toEqual({
      offerings: [offering],
    });
    await expect(acts.extractOfferings({ workspaceId: 'ws-1', text: 'catalog' })).resolves.toEqual({ offerings: [] });
  });
});

describe('understanding.activities — idempotent persistence', () => {
  it('deduplicates claims across pages, creates evidence per page, and records a bounded conflict', async () => {
    const sourceCreate = vi
      .fn()
      .mockResolvedValueOnce({ id: 'source-1' })
      .mockResolvedValueOnce({ id: 'source-2' });
    const claimCreate = vi.fn().mockResolvedValue({ id: 'claim-new' });
    const evidenceCreate = vi.fn().mockResolvedValue({});
    const conflictCreate = vi.fn().mockResolvedValue({});
    const outboxCreate = vi.fn().mockResolvedValue({});
    const tx = {
      claim: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'claim-prior', type: 'capability', statement: 'Acme builds industrial pumps for chemical plants' },
        ]),
        create: claimCreate,
      },
      knowledgeSource: { findFirst: vi.fn().mockResolvedValue(null), create: sourceCreate },
      evidence: { create: evidenceCreate },
      knowledgeConflict: { create: conflictCreate },
      outboxEvent: { create: outboxCreate },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, fn: (value: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaService;
    const acts = createUnderstandingActivities({ prisma, gateway: {} as ModelGateway });
    const duplicate = {
      type: 'capability',
      statement: 'Acme builds industrial pumps for food plants',
      evidence: 'catalog excerpt',
      confidence: 0.9,
    };

    const result = await acts.persistClaims({
      workspaceId: 'ws-1',
      companyId: 'company-1',
      website: 'https://acme.example/',
      pages: [
        { url: 'https://acme.example/products', claims: [duplicate] },
        { url: 'https://acme.example/about', claims: [{ ...duplicate, statement: duplicate.statement.toUpperCase() }] },
        { url: 'https://acme.example/empty', claims: [] },
      ],
    });

    expect(result).toEqual({ claimCount: 1 });
    expect(sourceCreate).toHaveBeenCalledTimes(2);
    expect(sourceCreate.mock.calls[0]?.[0]?.data.ingestKey).toBe('run-understanding-1:https://acme.example/products');
    expect(claimCreate).toHaveBeenCalledTimes(1);
    expect(evidenceCreate).toHaveBeenCalledTimes(2);
    expect(evidenceCreate.mock.calls.map((call) => call[0].data.claimId)).toEqual(['claim-new', 'claim-new']);
    expect(conflictCreate).toHaveBeenCalledTimes(1);
    expect(outboxCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: 'KnowledgeConflictDetected', aggregateId: 'company-1' }),
    });
  });

  it('skips a page already ingested by the same Temporal run', async () => {
    const sourceCreate = vi.fn();
    const tx = {
      claim: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
      knowledgeSource: { findFirst: vi.fn().mockResolvedValue({ id: 'existing-source' }), create: sourceCreate },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, fn: (value: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaService;
    const acts = createUnderstandingActivities({ prisma, gateway: {} as ModelGateway });

    await expect(
      acts.persistClaims({
        workspaceId: 'ws-1',
        companyId: 'company-1',
        website: 'https://acme.example/',
        pages: [
          {
            url: 'https://acme.example/products',
            claims: [{ type: 'capability', statement: 'Makes pumps', confidence: 0.8 }],
          },
        ],
      }),
    ).resolves.toEqual({ claimCount: 0 });
    expect(sourceCreate).not.toHaveBeenCalled();
  });

  it('merges offerings case-insensitively, keeps the highest-confidence source, and skips blank names', async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, fn: (value: unknown) => Promise<unknown>) =>
        fn({ offering: { upsert } }),
      ),
    } as unknown as PrismaService;
    const acts = createUnderstandingActivities({ prisma, gateway: {} as ModelGateway });

    const result = await acts.persistOfferings({
      workspaceId: 'ws-1',
      companyId: 'company-1',
      website: 'https://acme.example/',
      pages: [
        {
          url: 'https://acme.example/a',
          offerings: [
            { name: 'Pump X', description: 'old', confidence: 0.4 },
            { name: '   ', confidence: 1 },
          ],
        },
        {
          url: 'https://acme.example/b',
          offerings: [
            { name: 'pump x', description: 'new', attributes: { pressure: 'high' }, confidence: 0.9 },
            { name: 'Service Y', confidence: 0.7 },
          ],
        },
      ],
    });

    expect(result).toEqual({ offeringCount: 2 });
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[0]?.[0]).toMatchObject({
      update: { description: 'new', sourceUrl: 'https://acme.example/b', confidence: 0.9 },
      create: { name: 'pump x', sourceUrl: 'https://acme.example/b', confidence: 0.9 },
    });
  });

  it('extracts public contacts deterministically and persists the bounded result', async () => {
    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, fn: (value: unknown) => Promise<unknown>) =>
        fn({ companyProfile: { update } }),
      ),
    } as unknown as PrismaService;
    const acts = createUnderstandingActivities({ prisma, gateway: {} as ModelGateway });

    const result = await acts.persistPublicContacts({
      workspaceId: 'ws-1',
      companyId: 'company-1',
      website: 'https://acme.example/',
      pages: [{ url: 'https://acme.example/contact', text: 'Email sales@acme.example' }],
    });

    expect(result).toEqual({ contactCount: 1 });
    expect(update.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'company-1' },
      data: {
        publicContacts: [
          { type: 'email', value: 'sales@acme.example', sourceUrl: 'https://acme.example/contact' },
        ],
      },
    });
  });
});
