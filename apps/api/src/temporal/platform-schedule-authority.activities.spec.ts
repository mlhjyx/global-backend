import { ApplicationFailure } from '@temporalio/activity';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionBudgetGrantError } from '../execution-budget/execution-budget-authority.types';
import type { BudgetStore } from '../tools/budget-store';
import {
  PLATFORM_SCHEDULE_AUTHORITY_CONTRACT_VERSION,
  PLATFORM_SCHEDULE_AUTHORITY_SCOPES,
} from './platform-schedule-authority';
import { createPlatformScheduleAuthorityActivities } from './platform-schedule-authority.activities';

const AUTHORITY_ID = '42c863b9-7c7e-4d28-8678-60ef9a20219b';

describe('platform schedule authority admission activity', () => {
  it('opens one exact platform run without accepting a caller cap or workspace', async () => {
    const scope = PLATFORM_SCHEDULE_AUTHORITY_SCOPES['acq-sweep'];
    const admitPlatformRun = vi.fn(async () => ({
      accountId: '89528818-13ab-4a46-9dfd-6fbcdba6943e',
      authorityId: AUTHORITY_ID,
      authorizedCapMicrousd: 2_000_000n,
      generation: 1,
      replay: false,
    }));
    const activities = createPlatformScheduleAuthorityActivities({
      budgetStore: { admitPlatformRun } as unknown as BudgetStore,
    });

    const binding = await activities.admitPlatformSchedule({
      executionContractVersion: PLATFORM_SCHEDULE_AUTHORITY_CONTRACT_VERSION,
      executionScope: scope,
      workflowRunId: 'workflow-run-1',
    });

    expect(admitPlatformRun).toHaveBeenCalledWith({
      ...scope,
      workflowRunId: 'workflow-run-1',
      accountKey: `platform:${scope.requestSha256}:workflow-run-1`,
    });
    expect(binding).toMatchObject({
      authorityId: AUTHORITY_ID,
      scopeKey: 'platform',
      purpose: 'platform.acquisition',
      scheduleId: 'acq-sweep',
      workflowRunId: 'workflow-run-1',
      admissionReplay: false,
    });
    expect(JSON.stringify(binding)).not.toMatch(/jws|token|cap|workspace/i);
  });

  it.each([
    'EXECUTION_BUDGET_GRANT_INVALID',
    'EXECUTION_BUDGET_GRANT_EXPIRED',
    'EXECUTION_BUDGET_AUTHORITY_REVOKED',
    'EXECUTION_BUDGET_AUTHORITY_EXHAUSTED',
    'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
  ] as const)('parks %s nonretryably without leaking persistence details', async (code) => {
    const admitPlatformRun = vi.fn(async () => {
      throw new ExecutionBudgetGrantError(code);
    });
    const activities = createPlatformScheduleAuthorityActivities({
      budgetStore: { admitPlatformRun } as unknown as BudgetStore,
    });

    await expect(activities.admitPlatformSchedule({
      executionContractVersion: PLATFORM_SCHEDULE_AUTHORITY_CONTRACT_VERSION,
      executionScope: PLATFORM_SCHEDULE_AUTHORITY_SCOPES['intent-sweep'],
      workflowRunId: 'workflow-run-1',
    })).rejects.toEqual(ApplicationFailure.nonRetryable(code, code));
    expect(admitPlatformRun).toHaveBeenCalledOnce();
  });
});
