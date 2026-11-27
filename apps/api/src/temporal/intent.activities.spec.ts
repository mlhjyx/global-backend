import { describe, expect, it, vi } from 'vitest';
import { BudgetOperationReplayError } from '../tools/budget-store';
import { createIntentActivities } from './intent.activities';
import { PLATFORM_SCHEDULE_AUTHORITY_SCOPES } from './platform-schedule-authority';

const scope = PLATFORM_SCHEDULE_AUTHORITY_SCOPES['intent-sweep'];
const executionBudget = {
  authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
  scopeKey: 'platform' as const,
  accountKey: `platform:${scope.requestSha256}:workflow-run-1`,
  ...scope,
  workflowRunId: 'workflow-run-1',
  admissionReplay: false,
};

describe('intent activities — platform authority lifecycle', () => {
  it('parks a pending pre-cutover activity before retention mutation', async () => {
    const findMany = vi.fn();
    const activities = createIntentActivities({
      prisma: { monitoredSource: { findMany } } as never,
      fetcher: {} as never,
      budgetStore: { attestAuthorized: vi.fn() } as never,
      activityRunId: () => 'workflow-run-1',
    });
    await expect(activities.purgeStaleIntentEvents({})).rejects.toMatchObject({ type: 'EXECUTION_BUDGET_LEGACY_HISTORY_PARKED', nonRetryable: true });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('enforces the 50-source due-query bound when invoked outside the workflow wrapper', async () => {
    const findMany = vi.fn(async () => []);
    const activities = createIntentActivities({
      prisma: {
        dataProvider: { findUnique: vi.fn(async () => null) },
        monitoredSource: { findMany },
      } as never,
      fetcher: {} as never,
      budgetStore: {
        attestAuthorized: vi.fn(async () => undefined),
      } as never,
      activityRunId: () => 'workflow-run-1',
    });

    await expect(activities.listDueWatches({
      limit: 5_000,
      executionContractVersion: 1,
      executionBudget,
    })).resolves.toEqual({ sourceIds: [] });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );
  });

  it('read-only attests a stable workflow account around a website watch', async () => {
    const order: string[] = [];
    const fetch = vi.fn(async (_url, context) => {
      order.push('wire');
      expect(context).toEqual(expect.objectContaining({
        workspaceId: 'platform', runId: executionBudget.accountKey, correlationId: executionBudget.accountKey,
        onDurableReceipt: expect.any(Function),
      }));
      throw new BudgetOperationReplayError('crawl-op');
    });
    const prisma = {
      monitoredSource: { findUnique: vi.fn(async () => ({
        id: 'source-1', providerKey: 'web_watch', sourceKey: 'web_watch:example.com', label: 'Example',
        status: 'ACTIVE', region: null,
        config: { company: { name: 'Example', domain: 'example.com' }, pages: [{ url: 'https://example.com/' }] },
      })) },
      sourcePolicy: { findFirst: vi.fn(async () => null) },
      sourceFetch: { create: vi.fn(async () => ({ id: 'fetch-1' })) },
      sourceEntity: { findMany: vi.fn(async () => []) },
    };
    const budgetStore = {
      attestAuthorized: vi.fn(async () => { order.push('attest'); }),
      openAuthorized: vi.fn(),
      open: vi.fn(),
      close: vi.fn(),
    };
    const activities = createIntentActivities({
      prisma: prisma as never,
      platformWriter: prisma as never,
      fetcher: { fetch } as never,
      budgetStore: budgetStore as never,
      activityRunId: () => 'workflow-run-1',
    });

    await expect(activities.watchSource({
      sourceId: 'source-1', executionContractVersion: 1, executionBudget,
    })).rejects.toBeInstanceOf(BudgetOperationReplayError);
    expect(budgetStore.attestAuthorized).toHaveBeenCalledWith({
      authorityId: executionBudget.authorityId,
      scopeKey: 'platform',
      accountKey: executionBudget.accountKey,
    });
    expect(budgetStore.open).not.toHaveBeenCalled();
    expect(budgetStore.openAuthorized).not.toHaveBeenCalled();
    expect(budgetStore.close).not.toHaveBeenCalled();
    expect(order).toEqual(['attest', 'wire']);
  });

  it('rejects an unexpected page receipt producer before website-watch persistence', async () => {
    const sourceFetchCreate = vi.fn(async () => ({ id: 'fetch-1' }));
    const activities = createIntentActivities({
      prisma: {
        monitoredSource: { findUnique: vi.fn(async () => ({
          id: 'source-1', providerKey: 'web_watch', sourceKey: 'web_watch:example.com',
          label: 'Example', status: 'ACTIVE', region: null,
          config: {
            company: { name: 'Example', domain: 'example.com' },
            pages: [{ url: 'https://example.com/' }],
          },
        })) },
        sourcePolicy: { findFirst: vi.fn(async () => null) },
        sourceFetch: { create: sourceFetchCreate },
        sourceEntity: { findMany: vi.fn(async () => []) },
      } as never,
      platformWriter: {
        sourceFetch: { create: sourceFetchCreate },
      } as never,
      fetcher: {
        fetch: vi.fn(async (_url, context) => {
          context.onDurableReceipt?.('unexpected.tool', {} as never);
          return null;
        }),
      } as never,
      budgetStore: { attestAuthorized: vi.fn(async () => undefined) } as never,
      activityRunId: () => 'workflow-run-1',
    });

    await expect(activities.watchSource({
      sourceId: 'source-1', executionContractVersion: 1, executionBudget,
    })).rejects.toThrow('DOMAIN_ACK_CONSUMER_BINDING_MISSING');
    expect(sourceFetchCreate).toHaveBeenCalledOnce();
  });

  it('syncQualifiedWatchesFromWorkspaces registers new matched domains via platformWriter and skips watched ones', async () => {
    const monitoredCreate = vi.fn(async ({ data }: { data: { sourceKey: string } }) => ({
      id: `src-${data.sourceKey}`,
    }));
    const prisma = {
      dataProvider: { findUnique: vi.fn(async () => ({ status: 'ENABLED' })) },
      monitoredSource: {
        findMany: vi.fn(async () => [{ sourceKey: 'web_watch:already.example' }]),
      },
      withWorkspace: vi.fn(async (_ws: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          canonicalCompany: {
            findMany: vi.fn(async () => [
              { id: 'c1', domain: 'already.example' },
              { id: 'c2', domain: 'newbuyer.example' },
            ]),
            findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
              where.id === 'c2'
                ? { id: 'c2', name: 'New Buyer GmbH', domain: 'newbuyer.example', region: 'DE' }
                : null,
            ),
          },
          fieldEvidence: { findMany: vi.fn(async () => []) },
        }),
      ),
    };
    const platformWriter = {
      $queryRaw: vi.fn(async () => [{ id: '10000000-0000-4000-8000-000000000001' }]),
      monitoredSource: {
        findUnique: vi.fn(async () => null),
        create: monitoredCreate,
      },
    };
    const activities = createIntentActivities({
      prisma: prisma as never,
      platformWriter: platformWriter as never,
      fetcher: {} as never,
      budgetStore: { attestAuthorized: vi.fn(async () => undefined) } as never,
      activityRunId: () => 'workflow-run-1',
    });

    const out = await activities.syncQualifiedWatchesFromWorkspaces({
      limit: 10,
      executionContractVersion: 1,
      executionBudget,
    });
    expect(out).toEqual({ workspaces: 1, registered: 1, skipped: 0 });
    expect(monitoredCreate).toHaveBeenCalledTimes(1);
    expect(monitoredCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          providerKey: 'web_watch',
          sourceKey: 'web_watch:newbuyer.example',
          status: 'ACTIVE',
        }),
      }),
    );
  });
});
