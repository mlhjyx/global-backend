import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@temporalio/activity';
import { createRun2PipelineActivities } from './discovery.run2.pipeline.activities';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const ICP_ID = '33333333-3333-4333-8333-333333333333';
const COMPANY_ID = '44444444-4444-4444-8444-444444444444';
const EXECUTION_BUDGET = {
  authorityId: '55555555-5555-4555-8555-555555555555',
  replay: false,
  scopeKey: WORKSPACE_ID,
  accountKey: `discovery.run:discovery_run:request:${'c'.repeat(64)}:${'c'.repeat(64)}`,
  purpose: 'discovery.run',
  subjectType: 'discovery_run',
  subjectId: `request:${'c'.repeat(64)}`,
  requestSha256: 'c'.repeat(64),
};
const ARGS = {
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  icpId: ICP_ID,
  companyId: COMPANY_ID,
  executionContractVersion: 2 as const,
  executionBudget: EXECUTION_BUDGET,
};

describe('Run 2.0 deep pipeline activities — heartbeat & cancellationSignal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('aborts profileCompanyOnce with CancelledFailure before calling websiteProfile when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const heartbeat = vi.fn();
    vi.spyOn(Context, 'current').mockReturnValue({
      heartbeat,
      cancellationSignal: controller.signal,
    } as never);

    const profileSpy = vi.fn();
    const attestAuthorized = vi.fn(async () => undefined);
    const activities = createRun2PipelineActivities({
      prisma: { withWorkspace: vi.fn() } as never,
      providers: {} as never,
      gateway: {} as never,
      websiteProfile: { profile: profileSpy },
      budgetStore: { attestAuthorized } as never,
    });

    await expect(activities.profileCompanyOnce(ARGS)).rejects.toMatchObject({
      name: 'CancelledFailure',
    });
    expect(profileSpy).not.toHaveBeenCalled();
    expect(attestAuthorized).not.toHaveBeenCalled();
  });

  it('emits heartbeats and aborts signalsCompanyOnce between enrichers on cancellation', async () => {
    const controller = new AbortController();
    const heartbeat = vi.fn();
    vi.spyOn(Context, 'current').mockReturnValue({
      heartbeat,
      cancellationSignal: controller.signal,
    } as never);

    const firstEnricher = {
      key: 'digital_footprint',
      enrichCompany: vi.fn(async () => {
        controller.abort();
        return { matched: false, confidence: 0, attributes: {}, costCents: 0 };
      }),
    };
    const secondEnricher = {
      key: 'structured_harvest',
      enrichCompany: vi.fn(async () => ({
        matched: false,
        confidence: 0,
        attributes: {},
        costCents: 0,
      })),
    };
    const tx = {
      $queryRaw: vi.fn(async () => []),
      canonicalCompany: {
        findUnique: vi.fn(async () => ({
          id: COMPANY_ID,
          name: 'Acme Solar S.r.l.',
          domain: 'acme-solar.it',
          country: 'IT',
          region: null,
          status: 'NEW',
          attributes: {},
        })),
      },
      suppressionRecord: { findMany: vi.fn(async () => []) },
      dataProvider: { findMany: vi.fn(async () => []) },
    };
    const activities = createRun2PipelineActivities({
      prisma: {
        withWorkspace: vi.fn(async (_ws: string, cb: (client: typeof tx) => Promise<unknown>) => cb(tx)),
        sourcePolicy: { findMany: vi.fn(async () => []) },
      } as never,
      providers: {
        routeSignalEnrichment: vi.fn(async () => [firstEnricher, secondEnricher]),
      } as never,
      gateway: {} as never,
      budgetStore: { attestAuthorized: vi.fn(async () => undefined) } as never,
    });

    await expect(activities.signalsCompanyOnce(ARGS)).rejects.toMatchObject({
      name: 'CancelledFailure',
    });
    expect(heartbeat).toHaveBeenCalled();
    expect(firstEnricher.enrichCompany).toHaveBeenCalledTimes(1);
    expect(secondEnricher.enrichCompany).not.toHaveBeenCalled();
  });

  it('aborts contactsCompanyOnce before discoverContactsCore when cancellationSignal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.spyOn(Context, 'current').mockReturnValue({
      heartbeat: vi.fn(),
      cancellationSignal: controller.signal,
    } as never);

    const findUnique = vi.fn();
    const activities = createRun2PipelineActivities({
      prisma: {
        withWorkspace: vi.fn(),
        dataProvider: { findUnique },
      } as never,
      providers: {} as never,
      gateway: {} as never,
      budgetStore: { attestAuthorized: vi.fn(async () => undefined) } as never,
    });

    await expect(activities.contactsCompanyOnce(ARGS)).rejects.toMatchObject({
      name: 'CancelledFailure',
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('rejects provisional weak lead when fitCompanyOnce L0 gate blocks in enforce mode', async () => {
    vi.stubEnv('JUDGE_CONTRACT_MODE', 'enforce');
    const leadUpdateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      $queryRaw: vi.fn(async () => []),
      canonicalCompany: {
        findUnique: vi.fn(async () => ({
          id: COMPANY_ID,
          name: 'Sonnedix NL',
          domain: 'sonnedix.com',
          country: 'NL',
          industry: 'solar',
          employeeCount: 100,
          revenueUsd: null,
          status: 'NEW',
          attributes: {},
        })),
        findFirst: vi.fn(async () => ({
          id: COMPANY_ID,
          name: 'Sonnedix NL',
          domain: 'sonnedix.com',
          country: 'NL',
          industry: 'solar',
          employeeCount: 100,
          revenueUsd: null,
          status: 'NEW',
          attributes: {},
        })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      icpDefinition: {
        findUnique: vi.fn(async () => ({
          id: ICP_ID,
          name: 'Italy Solar',
          company: { name: 'Seller Co', summary: 'Solar manufacturer' },
          companyAttributes: {},
          exclusions: [],
          targetMarkets: ['IT'],
          rules: [],
        })),
        findFirst: vi.fn(async () => ({ companyAttributes: {}, targetMarkets: ['IT'] })),
      },
      discoveryRun: { findFirst: vi.fn(async () => null) },
      discoveryQueryPlan: { findFirst: vi.fn(async () => null) },
      qualificationRule: { findMany: vi.fn(async () => []) },
      sanctionsScreeningResult: {
        findUnique: vi.fn(async () => ({
          status: 'potential_match',
          reviewState: 'open',
          listVersions: {},
        })),
      },
      sanctionsSource: { findMany: vi.fn(async () => []) },
      suppressionRecord: { findMany: vi.fn(async () => []) },
      hardGateResult: { createMany: vi.fn(async () => ({ count: 0 })) },
      gateEnrichmentTask: { createMany: vi.fn(async () => ({ count: 0 })) },
      outboxEvent: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({})) },
      lead: { updateMany: leadUpdateMany },
    };

    const activities = createRun2PipelineActivities({
      prisma: {
        withWorkspace: vi.fn(async (_ws: string, cb: (client: typeof tx) => Promise<unknown>) => cb(tx)),
      } as never,
      providers: {} as never,
      gateway: {} as never,
      budgetStore: { attestAuthorized: vi.fn(async () => undefined) } as never,
    });

    await expect(activities.fitCompanyOnce(ARGS)).resolves.toMatchObject({
      judged: false,
      verdict: 'mismatch',
      skipped: true,
    });
    expect(leadUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: WORKSPACE_ID,
          icpId: ICP_ID,
          canonicalCompanyId: COMPANY_ID,
        }),
        data: expect.objectContaining({
          fitVerdict: 'mismatch',
          queue: 'rejected',
          status: 'REJECTED',
        }),
      }),
    );
  });
});
