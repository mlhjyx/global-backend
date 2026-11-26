import { describe, expect, it, vi } from 'vitest';
import type { ExecutionBroker } from '../tools/tool-contract';
import type { ModelGateway } from '../model-gateway/model-gateway';
import type { DiscoveryProviderRegistry } from '../discovery/provider.registry';
import type { PrismaService } from '../prisma/prisma.service';
import type { BudgetStore } from '../tools/budget-store';
import { createStreamingDiscoveryActivities } from './discovery.streaming.activities';
import {
  DomainCooldownService,
  InMemoryDomainCooldownBackend,
  InMemorySharedFactRepository,
  SharedGreenFactStore,
} from '../shared-facts';
import { SharedFactsStreamingHook } from '../discovery/streaming/shared-facts-hook';
import { createInitialStreamingProgress } from '../discovery/streaming/streaming-progress';
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

  it('reuses a committed zero-contact L2 result when the activity is retried', async () => {
    const createdAt = new Date('2026-11-27T00:00:00Z');
    const progress = createInitialStreamingProgress(RUN_ID, { now: createdAt.toISOString() });
    const run = {
      id: RUN_ID, status: 'RUNNING', createdAt, completedAt: null, stats: { streaming: progress },
    };
    let savedContacts: number | null = null;
    const findCompany = vi.fn(async () => ({
      id: COMPANY_ID, name: 'Fixture company', domain: 'example.test', status: 'ACTIVE', attributes: {},
    }));
    const writeProgress = vi.fn(async ({ data }: { data: { stats: typeof run.stats } }) => {
      run.stats = data.stats;
    });
    const writeResult = vi.fn(async ({ data }: { data: { streamingL2ContactsCreated: number } }) => {
      savedContacts = data.streamingL2ContactsCreated;
    });
    const tx = {
      discoveryCompanyJob: {
        findUnique: vi.fn(async () => ({
          streamingL2ContactsCreated: savedContacts, run: { status: 'RUNNING' },
        })),
        update: writeResult,
      },
      canonicalCompany: { findUnique: findCompany },
      suppressionRecord: { findMany: vi.fn(async () => []) },
      discoveryRun: { findUnique: vi.fn(async () => run), update: writeProgress },
      $queryRaw: vi.fn(async (sql: TemplateStringsArray) => sql.join('').includes('discovery_company_job')
        ? [{ id: COMPANY_ID, contactsCreated: savedContacts }]
        : []),
    };
    const findPolicy = vi.fn(async () => null);
    const prisma = {
      withWorkspace: vi.fn(async (_ws: string, fn: (t: typeof tx) => unknown) => fn(tx)),
      dataProvider: { findUnique: findPolicy },
    } as unknown as PrismaService;
    const activities = createStreamingDiscoveryActivities({
      prisma,
      providers: {} as DiscoveryProviderRegistry,
      gateway: {} as ModelGateway,
      broker: {} as ExecutionBroker,
      budgetStore: { attestAuthorized: vi.fn(async () => undefined) } as unknown as BudgetStore,
    });
    vi.stubEnv('CONTACT_DISCOVERY_RUN_LAWFUL_BASIS', '');
    try {
      const args = { ...AUTHORITY, runId: RUN_ID, icpId: ICP_ID, companyId: COMPANY_ID };
      await expect(activities.enrichStreamingTopKCompany(args)).resolves.toEqual({
        companyId: COMPANY_ID, contactsCreated: 0,
      });
      await expect(activities.enrichStreamingTopKCompany(args)).resolves.toEqual({
        companyId: COMPANY_ID, contactsCreated: 0,
      });
      expect(run.stats.streaming.stages.l2TopKEnrich.enriched).toBe(1);
      expect(writeProgress).toHaveBeenCalledTimes(1);
      expect(writeResult).toHaveBeenCalledTimes(1);
      expect(findCompany).toHaveBeenCalledTimes(1);
      expect(findPolicy).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('finalizeStreamingRun marks unfinished jobs skipped and emits QualifyRequested even on CANCELLED', async () => {
    const outboxCreate = vi.fn(async () => ({ id: 'ev-1' }));
    const runUpdate = vi.fn(async () => ({}));
    const jobUpdateMany = vi.fn(async () => ({ count: 2 }));
    const runEventCreate = vi.fn(async () => ({}));
    const queryRaw = vi.fn(async (strings: TemplateStringsArray, ..._parameters: unknown[]) =>
      strings.join('').includes('usage_ledger') ? [{ cost_usd: 0 }] : [{ locked: 'ok' }],
    );
    let currentStatus = 'RUNNING';
    const tx = {
      discoveryCompanyJob: {
        updateMany: jobUpdateMany,
        groupBy: vi.fn(async () => []),
      },
      discoveryRun: {
        findUnique: vi.fn(async () => ({
          id: RUN_ID,
          status: currentStatus,
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
      $queryRaw: queryRaw,
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

    const finalizeArgs = {
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      planId: PLAN_ID,
      icpId: ICP_ID,
      status: 'CANCELLED' as const,
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
    };
    await activities.finalizeStreamingRun(finalizeArgs);

    expect(jobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ stage: 'skipped', lastErrorCode: 'STREAMING_STOPPED' }),
      }),
    );
    expect(runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'CANCELLED',
          stats: expect.objectContaining({
            streaming: expect.objectContaining({
              stages: expect.objectContaining({
                l1ExtractFit: expect.objectContaining({ processed: 3 }),
              }),
            }),
          }),
        }),
      }),
    );
    const costRead = queryRaw.mock.calls.find(([sql]) => sql.join('').includes('usage_ledger'));
    expect(costRead?.slice(1)).toEqual([WORKSPACE_ID, RUN_ID]);
    expect(tx.discoveryQueryPlan.updateMany).not.toHaveBeenCalled();
    expect(outboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'DiscoveryRunCompleted',
          aggregateType: 'DiscoveryRun',
          aggregateId: RUN_ID,
          payload: expect.objectContaining({
            planId: PLAN_ID,
            status: 'CANCELLED',
            cost: 0,
            costBasis: 'usage_ledger-runid/v1',
          }),
        }),
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
    currentStatus = 'CANCELLED';
    await activities.finalizeStreamingRun(finalizeArgs);
    expect(runUpdate).toHaveBeenCalledTimes(1);
    expect(runEventCreate).toHaveBeenCalledTimes(1);
    expect(outboxCreate).toHaveBeenCalledTimes(2);
  });

  it.each(['FAILED', 'DONE', 'PARTIAL'] as const)(
    'finalizeStreamingRun reports %s with taskRef, cost and distinct fit results once',
    async (status) => {
      const outboxCreate = vi.fn(async (_args: { data: { payload: { stats?: unknown } } }) => ({
        id: 'ev-completed',
      }));
      const runUpdate = vi.fn(async () => ({}));
      const taskRef = {
        taskId: '70000000-0000-4000-8000-000000000007',
        taskRunId: '80000000-0000-4000-8000-000000000008',
      };
      const createdAt = new Date('2026-11-26T00:00:00Z');
      const progress = createInitialStreamingProgress(RUN_ID, { now: createdAt.toISOString() });
      const failure =
        status === 'FAILED'
          ? { stage: 'query' as const, errorType: 'ExecutionBudgetGrantError', control: true }
          : undefined;
      const groupByVerdict = vi.fn(async () => [
        { verdictDeep: 'match', _count: { _all: 2 } },
        { verdictDeep: 'weak', _count: { _all: 1 } },
      ]);
      const queryRaw = vi.fn(async (strings: TemplateStringsArray, ..._parameters: unknown[]) => {
        if (strings.join('').includes('usage_ledger')) return [{ cost_usd: 0.042 }];
        return [{ locked: 'ok' }];
      });
      let currentStatus: string = 'RUNNING';
      const tx = {
        discoveryCompanyJob: { groupBy: groupByVerdict },
        discoveryRun: {
          findUnique: vi.fn(async () => ({
            id: RUN_ID,
            status: currentStatus,
            stats: {
              queryDiagnostics: { trace: 'internal-only' },
              streaming: {
                ...progress,
                stages: {
                  ...progress.stages,
                  // An L1 activity can retry after committing and increment progress again.
                  l1ExtractFit: { ...progress.stages.l1ExtractFit, processed: 7, fitMatch: 4, fitWeak: 1, fitMismatch: 2 },
                  l2TopKEnrich: { ...progress.stages.l2TopKEnrich, selected: 1, enriched: 2, contactsFound: 4 },
                },
              },
            },
            phases: {},
            taskRef,
            createdAt,
            completedAt: null,
          })),
          update: runUpdate,
        },
        discoveryQueryPlan: { updateMany: vi.fn(async () => ({ count: 0 })) },
        outboxEvent: { create: outboxCreate },
        runEvent: {
          aggregate: vi.fn(async () => ({ _max: { seq: 1n } })),
          create: vi.fn(async () => ({})),
        },
        $queryRaw: queryRaw,
      };
      const prisma = {
        withWorkspace: vi.fn(async (_ws: string, fn: (t: typeof tx) => unknown) => fn(tx)),
      } as unknown as PrismaService;
      const activities = createStreamingDiscoveryActivities({
        prisma,
        providers: {} as DiscoveryProviderRegistry,
        gateway: {} as ModelGateway,
        broker: {} as ExecutionBroker,
        budgetStore: { attestAuthorized: vi.fn(async () => undefined) } as unknown as BudgetStore,
      });

      const finalizeArgs = {
        ...AUTHORITY,
        runId: RUN_ID,
        planId: PLAN_ID,
        icpId: ICP_ID,
        status,
        ...(failure ? { failure } : {}),
        summary: {
          queriesTotal: 2,
          queriesCompleted: 0,
          queriesFailed: 2,
          rawCount: 0,
          canonicalCount: 0,
          l1Processed: 0,
          l1Failed: 0,
          l2Selected: 1,
          l2Enriched: 1,
          l2ContactsFound: 2,
          l2Failed: 0,
          watchesRegistered: 0,
        },
      };

      await activities.finalizeStreamingRun(finalizeArgs);
      expect(outboxCreate).toHaveBeenCalledTimes(1);
      expect(outboxCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: WORKSPACE_ID,
          eventType: 'DiscoveryRunCompleted',
          aggregateType: 'DiscoveryRun',
          aggregateId: RUN_ID,
          payload: expect.objectContaining({
            planId: PLAN_ID,
            status,
            cost: 0.042,
            costBasis: 'usage_ledger-runid/v1',
            taskRef,
            stats: expect.objectContaining({
              fit: { evaluated: 3, match: 2, weak: 1, mismatch: 0 },
              contactsEnriched: 1,
              streaming: expect.objectContaining({
                stages: expect.objectContaining({
                  l2TopKEnrich: expect.objectContaining({
                    enriched: status === 'DONE' ? 1 : 2,
                    contactsFound: status === 'DONE' ? 2 : 4,
                  }),
                }),
              }),
              ...(failure ? { failure } : {}),
            }),
          }),
        }),
      });
      expect(groupByVerdict).toHaveBeenCalledWith({
        by: ['verdictDeep'],
        where: {
          workspaceId: WORKSPACE_ID,
          runId: RUN_ID,
          verdictDeep: { in: ['match', 'weak', 'mismatch'] },
        },
        _count: { _all: true },
      });
      const costRead = queryRaw.mock.calls.find(([sql]) => sql.join('').includes('usage_ledger'));
      expect(costRead?.slice(1)).toEqual([WORKSPACE_ID, AUTHORITY.executionBudget.accountKey]);
      expect(tx.discoveryQueryPlan.updateMany).toHaveBeenCalledTimes(status === 'FAILED' ? 0 : 1);
      expect(outboxCreate.mock.calls[0]?.[0].data.payload.stats).not.toHaveProperty('queryDiagnostics');

      currentStatus = status;
      await activities.finalizeStreamingRun(finalizeArgs);
      expect(runUpdate).toHaveBeenCalledTimes(1);
      expect(tx.runEvent.create).toHaveBeenCalledTimes(1);
      expect(outboxCreate).toHaveBeenCalledTimes(1);
    },
  );

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

  it('reuses ADR-003 shared green facts on L1 hit with zero HTTP calls, flags 30d cooldown, and blocks imported_buyer write-back', async () => {
    const factRepo = new InMemorySharedFactRepository();
    const factStore = new SharedGreenFactStore(factRepo);
    const cooldownBackend = new InMemoryDomainCooldownBackend();
    const cooldownService = new DomainCooldownService({
      pepper: 'streaming-activities-test-pepper-32chars',
      backend: cooldownBackend,
      fallbackBackend: cooldownBackend,
      maxDistinctWorkspaces30d: 1,
    });
    const sharedFactsHook = new SharedFactsStreamingHook({
      mode: 'on',
      factStore,
      cooldownService,
    });

    // Pre-populate Layer 1 green fact + 1 prior workspace touch from another tenant
    await factStore.putFromRaw({
      domain: 'memodo.de',
      legalName: 'Memodo GmbH',
      country: 'DE',
      tradeRole: 'distributor',
      websiteSummary: 'German PV and battery storage wholesale distributor.',
      emails: ['sales@memodo.de'],
      phones: ['+498990410150'],
      inquiryFormUrl: 'https://memodo.de/kontakt',
      linkedinCompanyUrl: 'https://www.linkedin.com/company/memodo-gmbh',
      productCategories: ['PV Modules', 'Battery Storage'],
    });
    await cooldownService.recordTouch('memodo.de', '90000000-0000-4000-8000-000000000099');

    const runUpdate = vi.fn(async () => ({}));
    const brokerInvoke = vi.fn(async () => {
      throw new Error('BROKER_SHOULD_NOT_BE_CALLED_ON_SHARED_FACT_HIT');
    });
    const tx = {
      suppressionRecord: { findMany: vi.fn(async () => []) },
      importedBuyer: { findFirst: vi.fn(async () => null) },
      companyChannelSighting: { findFirst: vi.fn(async () => null) },
      canonicalCompany: {
        findUnique: vi.fn(async () => ({
          id: COMPANY_ID,
          workspaceId: WORKSPACE_ID,
          name: 'Memodo GmbH',
          domain: 'memodo.de',
          country: 'DE',
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
          name: '德国光伏分销商',
          targetMarkets: ['DE'],
          exclusions: [],
          companyAttributes: { trade_side: 'distributor', product: 'PV modules' },
        })),
      },
      discoveryCompanyJob: { updateMany: vi.fn(async () => ({ count: 1 })) },
      companyContactPoint: {
        findMany: vi.fn(async () => []),
        createMany: vi.fn(async () => ({ count: 1 })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      companySignal: { createMany: vi.fn(async () => ({ count: 0 })) },
      lead: { upsert: vi.fn(async () => ({ id: 'lead-hit' })) },
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
    const gateway = {
      generateStructured: vi.fn(async () => ({
        data: {
          verdict: 'match',
          material_gate: 'pass: PV modules',
          role_gate: 'pass: distributor',
          process_gate: 'not_applicable',
          business_model_gate: 'pass: B2B wholesale',
          reasons: ['命中共享绿色事实层的德国光伏分销商'],
        },
        usage: { inputTokens: 120, outputTokens: 50, costCents: 0 },
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
      broker: { invoke: brokerInvoke } as unknown as ExecutionBroker,
      budgetStore,
      sharedFactsHook,
    });

    const hitResult = await activities.processStreamingL1Company({
      ...AUTHORITY,
      runId: RUN_ID,
      icpId: ICP_ID,
      companyId: COMPANY_ID,
    });

    expect(hitResult.sharedFactHit).toBe(true);
    expect(hitResult.cooldownFlagged).toBe(true);
    expect(hitResult.fetchMethod).toBe('skipped');
    expect(brokerInvoke).not.toHaveBeenCalled();
    expect(runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stats: expect.objectContaining({
            streaming: expect.objectContaining({
              stages: expect.objectContaining({
                l1ExtractFit: expect.objectContaining({
                  sharedFactHits: 1,
                  cooldownFlagged: 1,
                }),
              }),
            }),
          }),
        }),
      }),
    );

    // Imported buyer must NEVER write back into Layer 1 even after a live scrape
    const importedBroker = {
      invoke: vi.fn(async (_toolId: string, input: { url: string }) => {
        if (input.url.endsWith('/robots.txt')) {
          return { data: { status: 404, ok: false, mediaType: 'text/plain', text: '' }, costCents: 0, durationMs: 5, degraded: false };
        }
        return {
          data: {
            status: 200,
            ok: true,
            mediaType: 'text/plain',
            finalUrl: input.url,
            text: `<html><head><title>Secret Imported Buyer</title></head><body><main><p>Private wholesale distributor of industrial solar components imported directly by tenant sales team for internal account review.</p><a href="mailto:sales@secret-imported.de">sales@secret-imported.de</a></main></body></html>`,
          },
          costCents: 0,
          durationMs: 10,
          degraded: false,
        };
      }),
    } as unknown as ExecutionBroker;
    tx.importedBuyer.findFirst = vi.fn(async () => ({ id: 'imp-1' }));
    tx.canonicalCompany.findUnique = vi.fn(async () => ({
      id: COMPANY_ID,
      workspaceId: WORKSPACE_ID,
      name: 'Secret Imported Buyer',
      domain: 'secret-imported.de',
      country: 'DE',
      industry: 'Solar',
      status: 'NEW',
      attributes: {},
      version: 1,
    }));

    const importedActivities = createStreamingDiscoveryActivities({
      prisma,
      providers: {} as DiscoveryProviderRegistry,
      gateway,
      broker: importedBroker,
      budgetStore,
      sharedFactsHook,
    });
    const importedResult = await importedActivities.processStreamingL1Company({
      ...AUTHORITY,
      runId: RUN_ID,
      icpId: ICP_ID,
      companyId: COMPANY_ID,
    });
    expect(importedResult.sharedFactHit).toBe(false);
    expect(await factStore.get('secret-imported.de')).toBeNull();
    expect((await cooldownService.checkCooldown('secret-imported.de')).distinctWorkspaces30d).toBe(0);
  });

  it('writes back sanitized green facts on L1 miss and annotates L0 candidates with 30d cooldown advisory', async () => {
    const factRepo = new InMemorySharedFactRepository();
    const factStore = new SharedGreenFactStore(factRepo);
    const cooldownBackend = new InMemoryDomainCooldownBackend();
    const cooldownService = new DomainCooldownService({
      pepper: 'streaming-activities-l0-l1-pepper-32chars',
      backend: cooldownBackend,
      fallbackBackend: cooldownBackend,
      maxDistinctWorkspaces30d: 1,
    });
    const sharedFactsHook = new SharedFactsStreamingHook({
      mode: 'on',
      factStore,
      cooldownService,
    });

    const l0RunUpdate = vi.fn(async () => ({}));
    const tx = {
      suppressionRecord: { findMany: vi.fn(async () => []) },
      importedBuyer: { findFirst: vi.fn(async () => null) },
      companyChannelSighting: { findFirst: vi.fn(async () => null) },
      rawSourceRecord: { findMany: vi.fn(async () => [{ id: 'raw-1' }]) },
      identityLink: { findMany: vi.fn(async () => [{ canonicalId: COMPANY_ID }]) },
      canonicalCompany: {
        findMany: vi.fn(async () => [
          { id: COMPANY_ID, name: 'Rexel Italia S.p.A.', domain: 'rexel-italia.it', country: 'IT' },
        ]),
        findUnique: vi.fn(async () => ({
          id: COMPANY_ID,
          workspaceId: WORKSPACE_ID,
          name: 'Rexel Italia S.p.A.',
          domain: 'rexel-italia.it',
          country: 'IT',
          industry: 'Electrical Wholesale',
          status: 'NEW',
          attributes: {},
          version: 1,
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      icpDefinition: {
        findUnique: vi.fn(async () => ({
          id: ICP_ID,
          name: '意大利光伏批发商',
          targetMarkets: ['IT'],
          exclusions: [],
          companyAttributes: { trade_side: 'distributor', product: 'PV modules' },
        })),
      },
      discoveryCompanyJob: {
        createMany: vi.fn(async () => ({ count: 1 })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      companyContactPoint: {
        findMany: vi.fn(async () => []),
        createMany: vi.fn(async () => ({ count: 1 })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      companySignal: { createMany: vi.fn(async () => ({ count: 0 })) },
      lead: { upsert: vi.fn(async () => ({ id: 'lead-miss' })) },
      discoveryRun: {
        findUnique: vi.fn(async () => ({
          id: RUN_ID,
          status: 'RUNNING',
          stats: {},
          phases: {},
          createdAt: new Date('2026-11-26T00:00:00Z'),
          completedAt: null,
        })),
        update: l0RunUpdate,
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
          return { data: { status: 404, ok: false, mediaType: 'text/plain', text: '' }, costCents: 0, durationMs: 5, degraded: false };
        }
        return {
          data: {
            status: 200,
            ok: true,
            mediaType: 'text/plain',
            finalUrl: input.url,
            text: `<!doctype html><html><head><title>Rexel Italia</title><meta name="description" content="B2B electrical and solar distributor across Italy."></head><body><main><p>Distributore B2B di materiale elettrico e fotovoltaico per installatori e aziende EPC in tutta Italia con consegna rapida dai centri logistici regionali.</p><a href="mailto:sales@rexel-italia.it">sales@rexel-italia.it</a><a href="mailto:marco.rossi@rexel-italia.it">marco.rossi@rexel-italia.it</a><a href="https://www.linkedin.com/in/marco-rossi">Marco</a><a href="https://www.linkedin.com/company/rexel-italia/">LinkedIn</a></main></body></html>`,
          },
          costCents: 0,
          durationMs: 15,
          degraded: false,
        };
      }),
    } as unknown as ExecutionBroker;
    const gateway = {
      generateStructured: vi.fn(async () => ({
        data: {
          verdict: 'match',
          material_gate: 'pass: PV modules',
          role_gate: 'pass: distributor',
          process_gate: 'not_applicable',
          business_model_gate: 'pass: B2B wholesale',
          reasons: ['意大利光伏分销商'],
        },
        usage: { inputTokens: 180, outputTokens: 60, costCents: 0 },
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
      sharedFactsHook,
    });

    // 1. L1 miss -> live scrape -> writes back zero-PII green fact & records touch
    const missRes = await activities.processStreamingL1Company({
      ...AUTHORITY,
      runId: RUN_ID,
      icpId: ICP_ID,
      companyId: COMPANY_ID,
    });
    expect(missRes.sharedFactHit).toBe(false);
    const written = await factStore.get('rexel-italia.it');
    expect(written).not.toBeNull();
    expect(written?.roleEmails).toEqual(['sales@rexel-italia.it']);
    expect(written?.linkedinCompanyUrl).toBe('https://www.linkedin.com/company/rexel-italia');
    expect(JSON.stringify(written)).not.toContain('marco.rossi');
    expect(JSON.stringify(written)).not.toContain(WORKSPACE_ID);

    // 2. Subsequent L0 run sees cooldown advisory without leaking tenant identity
    await activities.recordStreamingL0Complete({
      ...AUTHORITY,
      runId: RUN_ID,
      icpId: ICP_ID,
      queriesTotal: 1,
      queriesCompleted: 1,
      candidatesRecalled: 1,
      canonicalUpserted: 1,
    });
    expect(l0RunUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stats: expect.objectContaining({
            streaming: expect.objectContaining({
              recentCandidates: [
                expect.objectContaining({
                  domain: 'rexel-italia.it',
                  cooldownFlagged: true,
                  cooldownRetryAfterDays: 30,
                }),
              ],
            }),
          }),
        }),
      }),
    );
  });
});
