import { describe, expect, it, vi } from 'vitest';
import type { ExecutionBroker } from '../tools/tool-contract';
import type { ModelGateway } from '../model-gateway/model-gateway';
import type { DiscoveryProviderRegistry } from '../discovery/provider.registry';
import type { PrismaService } from '../prisma/prisma.service';
import type { BudgetStore } from '../tools/budget-store';
import { createStreamingDiscoveryActivities } from './discovery.streaming.activities';
import { resolveDiscoveryWorkflowType } from '../relay/discovery-run-command';
import {
  DISCOVERY_STREAMING_WORKFLOW,
  DISCOVERY_WORKFLOW,
} from './understanding.constants';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const RUN_ID = '20000000-0000-4000-8000-000000000002';
const PLAN_ID = '30000000-0000-4000-8000-000000000003';
const ICP_ID = '40000000-0000-4000-8000-000000000004';
const COMPANY_ID = '50000000-0000-4000-8000-000000000005';
const REQUEST_SHA = 'b'.repeat(64);

const AUTHORITY = {
  workspaceId: WORKSPACE_ID,
  executionContractVersion: 2 as const,
  executionBudget: {
    authorityId: '60000000-0000-4000-8000-000000000006',
    replay: false,
    scopeKey: WORKSPACE_ID,
    accountKey: `discovery.run:discovery_run:${RUN_ID}:${REQUEST_SHA}`,
    purpose: 'discovery.run',
    subjectType: 'discovery_run',
    subjectId: RUN_ID,
    requestSha256: REQUEST_SHA,
  },
};

describe('streaming discovery activities & rollout switch', () => {
  it('routes to discoveryWorkflow by default and discoveryStreamingWorkflow when DISCOVERY_STREAMING_WORKFLOW=on', () => {
    expect(resolveDiscoveryWorkflowType({})).toBe(DISCOVERY_WORKFLOW);
    expect(resolveDiscoveryWorkflowType({ DISCOVERY_STREAMING_WORKFLOW: 'off' })).toBe(DISCOVERY_WORKFLOW);
    expect(resolveDiscoveryWorkflowType({ DISCOVERY_STREAMING_WORKFLOW: 'on' })).toBe(
      DISCOVERY_STREAMING_WORKFLOW,
    );
  });

  it('finalizeStreamingRun marks unfinished jobs skipped and emits QualifyRequested even on CANCELLED', async () => {
    const outboxCreate = vi.fn(async () => ({ id: 'ev-1' }));
    const runUpdate = vi.fn(async () => ({}));
    const jobUpdateMany = vi.fn(async () => ({ count: 2 }));
    const runEventCreate = vi.fn(async () => ({}));
    const tx = {
      discoveryCompanyJob: { updateMany: jobUpdateMany },
      discoveryRun: {
        findUnique: vi.fn(async () => ({
          id: RUN_ID,
          status: 'RUNNING',
          stats: {},
          phases: {},
          createdAt: new Date('2026-11-26T00:00:00Z'),
          completedAt: null,
        })),
        update: runUpdate,
      },
      discoveryQueryPlan: { updateMany: vi.fn(async () => ({ count: 1 })) },
      outboxEvent: { create: outboxCreate },
      runEvent: {
        aggregate: vi.fn(async () => ({ _max: { seq: 5n } })),
        create: runEventCreate,
      },
      $queryRaw: vi.fn(async () => [{ locked: 'ok' }]),
    };
    const prisma = {
      withWorkspace: vi.fn(async (_ws: string, fn: (t: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const budgetStore = {
      attestAuthorized: vi.fn(async () => undefined),
    } as unknown as BudgetStore;

    const activities = createStreamingDiscoveryActivities({
      prisma,
      providers: {} as DiscoveryProviderRegistry,
      gateway: {} as ModelGateway,
      broker: {} as ExecutionBroker,
      budgetStore,
    });

    await activities.finalizeStreamingRun({
      ...AUTHORITY,
      runId: RUN_ID,
      planId: PLAN_ID,
      icpId: ICP_ID,
      status: 'CANCELLED',
      summary: {
        queriesTotal: 2,
        queriesCompleted: 2,
        queriesFailed: 0,
        rawCount: 10,
        canonicalCount: 5,
        l1Processed: 3,
        l1Failed: 0,
        l2Selected: 0,
        l2Enriched: 0,
        l2ContactsFound: 0,
        l2Failed: 0,
        watchesRegistered: 0,
      },
    });

    expect(jobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ stage: 'skipped', lastErrorCode: 'STREAMING_STOPPED' }),
      }),
    );
    expect(runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'CANCELLED' }),
      }),
    );
    expect(outboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'QualifyRequested',
          aggregateId: ICP_ID,
          payload: expect.objectContaining({ runId: RUN_ID, source: 'discovery_streaming' }),
        }),
      }),
    );
  });

  it('processStreamingL1Company persists streaming extraction, company_signal, Lead fit, and live progress', async () => {
    const signalCreateMany = vi.fn(async () => ({ count: 1 }));
    const leadUpsert = vi.fn(async () => ({ id: 'lead-1' }));
    const runUpdate = vi.fn(async () => ({}));
    const tx = {
      suppressionRecord: { findMany: vi.fn(async () => []) },
      canonicalCompany: {
        findUnique: vi.fn(async () => ({
          id: COMPANY_ID,
          workspaceId: WORKSPACE_ID,
          name: 'Solare Italia S.r.l.',
          domain: 'solare-italia.it',
          country: 'IT',
          industry: 'Solar',
          status: 'NEW',
          attributes: {},
          version: 1,
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      icpDefinition: {
        findUnique: vi.fn(async () => ({
          id: ICP_ID,
          name: '意大利光伏分销商',
          targetMarkets: ['IT'],
          exclusions: ['光伏组件制造同行'],
          companyAttributes: { trade_side: 'distributor', product: 'photovoltaic modules' },
        })),
      },
      discoveryCompanyJob: { updateMany: vi.fn(async () => ({ count: 1 })) },
      companyContactPoint: {
        findMany: vi.fn(async () => []),
        createMany: vi.fn(async () => ({ count: 1 })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      companySignal: { createMany: signalCreateMany },
      lead: { upsert: leadUpsert },
      discoveryRun: {
        findUnique: vi.fn(async () => ({
          id: RUN_ID,
          status: 'RUNNING',
          stats: {},
          phases: {},
          createdAt: new Date('2026-11-26T00:00:00Z'),
          completedAt: null,
        })),
        update: runUpdate,
      },
      runEvent: {
        aggregate: vi.fn(async () => ({ _max: { seq: 1n } })),
        create: vi.fn(async () => ({})),
      },
      $queryRaw: vi.fn(async () => [{ locked: 'ok' }]),
    };
    const prisma = {
      withWorkspace: vi.fn(async (_ws: string, fn: (t: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const broker = {
      invoke: vi.fn(async (_toolId: string, input: { url: string }) => {
        if (input.url.endsWith('/robots.txt')) {
          return { data: { status: 404, ok: false, mediaType: 'text/plain', text: '' }, costCents: 0, durationMs: 10, degraded: false };
        }
        return {
          data: {
            status: 200,
            ok: true,
            mediaType: 'text/plain',
            finalUrl: input.url,
            text: `<!doctype html><html><head><title>Solare Italia</title></head><body><main><p>Distributore all ingrosso di moduli fotovoltaici e inverter per installatori e aziende EPC in tutta Italia. Ordina ora il listino B2B con spedizione dai magazzini di Milano e Bologna.</p><a href="mailto:sales@solare-italia.it">sales@solare-italia.it</a><a href="/careers">Careers</a></main></body></html>`,
          },
          costCents: 0,
          durationMs: 25,
          degraded: false,
        };
      }),
    } as unknown as ExecutionBroker;
    const gateway = {
      generateStructured: vi.fn(async () => ({
        data: {
          verdict: 'match',
          material_gate: 'pass: photovoltaic modules',
          role_gate: 'pass: distributor',
          process_gate: 'not_applicable',
          business_model_gate: 'pass: B2B wholesale',
          reasons: ['意大利正牌光伏分销商'],
        },
        usage: { inputTokens: 300, outputTokens: 80, costCents: 0 },
        model: 'test-model',
        provider: 'test',
      })),
    } as unknown as ModelGateway;
    const budgetStore = {
      attestAuthorized: vi.fn(async () => undefined),
    } as unknown as BudgetStore;

    const activities = createStreamingDiscoveryActivities({
      prisma,
      providers: {} as DiscoveryProviderRegistry,
      gateway,
      broker,
      budgetStore,
    });

    const result = await activities.processStreamingL1Company({
      ...AUTHORITY,
      runId: RUN_ID,
      icpId: ICP_ID,
      companyId: COMPANY_ID,
    });

    expect(result.verdict).toBe('match');
    expect(result.fetchMethod).toBe('raw_http');
    expect(result.usedCrawl4aiFallback).toBe(false);
    expect(signalCreateMany).toHaveBeenCalledTimes(1);
    expect(leadUpsert).toHaveBeenCalledTimes(1);
    expect(runUpdate).toHaveBeenCalledTimes(1);
  });
});
