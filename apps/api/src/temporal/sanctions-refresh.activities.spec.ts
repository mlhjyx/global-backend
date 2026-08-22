import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { ExecutionBroker } from '../tools/tool-contract';
import type { BudgetStore } from '../tools/budget-store';
import { createSanctionsRefreshActivities } from './sanctions-refresh.activities';
import { PLATFORM_SCHEDULE_AUTHORITY_SCOPES } from './platform-schedule-authority';

const scope = PLATFORM_SCHEDULE_AUTHORITY_SCOPES['sanctions-refresh'];
const executionBudget = {
  authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
  scopeKey: 'platform' as const,
  accountKey: `platform:${scope.requestSha256}:workflow-run-1`,
  ...scope,
  workflowRunId: 'workflow-run-1',
  admissionReplay: false,
};

function budgetStoreSpies() {
  const attestAuthorized = vi.fn(async () => undefined);
  const open = vi.fn();
  const openAuthorized = vi.fn();
  const close = vi.fn();
  return {
    attestAuthorized, open, openAuthorized, close,
    store: { attestAuthorized, open, openAuthorized, close } as unknown as BudgetStore,
  };
}

describe('sanctions-refresh.activities — durable platform authority lifecycle', () => {
  it('parks a pending pre-cutover activity before reading a sanctions source', async () => {
    const findMany = vi.fn();
    const activities = createSanctionsRefreshActivities({
      ownerDb: { sanctionsSource: { findMany } } as unknown as PrismaClient,
      broker: {} as ExecutionBroker,
      budgetStore: { attestAuthorized: vi.fn() } as unknown as BudgetStore,
      activityRunId: () => 'workflow-run-1',
    });
    await expect(activities.refreshSanctionsLists()).rejects.toMatchObject({ type: 'EXECUTION_BUDGET_LEGACY_HISTORY_PARKED', nonRetryable: true });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('attests the admitted workflow account without reopening or closing it', async () => {
    const budget = budgetStoreSpies();
    const ownerDb = {
      sanctionsSource: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;
    const acts = createSanctionsRefreshActivities({
      ownerDb,
      broker: {} as ExecutionBroker,
      budgetStore: budget.store,
      activityRunId: () => 'workflow-run-1',
    });

    await expect(acts.refreshSanctionsLists({
      executionContractVersion: 1,
      executionBudget,
    })).resolves.toEqual({ sources: 0, summaries: [] });
    expect(budget.attestAuthorized).toHaveBeenCalledWith({
      authorityId: executionBudget.authorityId,
      scopeKey: 'platform',
      accountKey: executionBudget.accountKey,
    });
    expect(budget.open).not.toHaveBeenCalled();
    expect(budget.openAuthorized).not.toHaveBeenCalled();
    expect(budget.close).not.toHaveBeenCalled();
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
      activityRunId: () => 'workflow-run-1',
    });

    await expect(acts.refreshSanctionsLists({
      executionContractVersion: 1,
      executionBudget,
    })).rejects.toThrow('owner db failed');
    expect(budget.attestAuthorized).toHaveBeenCalledTimes(1);
    expect(budget.close).not.toHaveBeenCalled();
  });
});
