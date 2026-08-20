import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { ExecutionBroker } from '../tools/tool-contract';
import type { BudgetStore } from '../tools/budget-store';
import { sweepBudgetCents } from '../tools/budget';
import { createSanctionsRefreshActivities } from './sanctions-refresh.activities';

function budgetStoreSpies() {
  const open = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  return { open, close, store: { open, close } as unknown as BudgetStore };
}

describe('sanctions-refresh.activities — durable platform budget lifecycle', () => {
  it('opens an explicit replay scope derived from the workflow run and closes it', async () => {
    const budget = budgetStoreSpies();
    const ownerDb = {
      sanctionsSource: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;
    const acts = createSanctionsRefreshActivities({
      ownerDb,
      broker: {} as ExecutionBroker,
      budgetStore: budget.store,
      activityRunId: () => 'sanctions-workflow-run',
    });

    await expect(acts.refreshSanctionsLists()).resolves.toEqual({ sources: 0, summaries: [] });
    expect(budget.open).toHaveBeenCalledWith({
      workspaceId: 'platform',
      accountKey: 'sanctions-refresh:sanctions-workflow-run',
      capCents: sweepBudgetCents(),
      replayScope: true,
    });
    expect(budget.close).toHaveBeenCalledWith({
      workspaceId: 'platform',
      accountKey: 'sanctions-refresh:sanctions-workflow-run',
    });
  });

  it('closes the platform budget account when the refresh fails before a source is processed', async () => {
    const budget = budgetStoreSpies();
    const ownerDb = {
      sanctionsSource: { findMany: vi.fn(async () => Promise.reject(new Error('owner db failed'))) },
    } as unknown as PrismaClient;
    const acts = createSanctionsRefreshActivities({
      ownerDb,
      broker: {} as ExecutionBroker,
      budgetStore: budget.store,
      activityRunId: () => 'sanctions-workflow-run',
    });

    await expect(acts.refreshSanctionsLists()).rejects.toThrow('owner db failed');
    expect(budget.close).toHaveBeenCalledTimes(1);
  });
});
