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
      prisma: prisma as never, fetcher: { fetch } as never, budgetStore: budgetStore as never,
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
});
