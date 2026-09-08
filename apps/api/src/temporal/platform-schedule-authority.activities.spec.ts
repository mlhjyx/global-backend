import { ApplicationFailure } from '@temporalio/activity';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionBudgetGrantError } from '../execution-budget/execution-budget-authority.types';
import type { BudgetStore } from '../tools/budget-store';
import {
  PLATFORM_SCHEDULE_AUTHORITY_CONTRACT_VERSION,
  PLATFORM_SCHEDULE_AUTHORITY_SCOPES,
} from './platform-schedule-authority';
import { createPlatformScheduleAuthorityActivities, platformEgressDispatcher } from './platform-schedule-authority.activities';
import { PlatformEgressFence } from '../platform-authority/platform-egress-fence.v1';

const AUTHORITY_ID = '42c863b9-7c7e-4d28-8678-60ef9a20219b';

describe('platform schedule authority admission activity', () => {
  it('binds a real operation carrier to the admitted run through both fence stages', async () => {
    const scope = PLATFORM_SCHEDULE_AUTHORITY_SCOPES['acq-sweep'];
    const run = '33333333-3333-4333-8333-333333333333';
    const binding = { ...scope, authorityId: AUTHORITY_ID, scopeKey: 'platform' as const,
      workflowRunId: run, accountKey: `platform:${scope.requestSha256}:${run}`, admissionReplay: false };
    const port = { authorize: vi.fn(async () => ({ attemptId: AUTHORITY_ID })),
      claimSend: vi.fn(async () => ({ attemptId: AUTHORITY_ID, dispatch: async <T>(wire: () => Promise<T>) => wire() })),
      acknowledged: vi.fn(async () => undefined), unknown: vi.fn(async () => undefined) };
    const dispatcher = platformEgressDispatcher({ fence: new PlatformEgressFence(port), binding, workflowId: 'real-workflow' });
    const operation = { operationKey: 'wire', budgetOperationId: '22222222-2222-4222-8222-222222222222',
      budgetOperationKey: 'a'.repeat(64), reservedMicrousd: 0n,
      execution: { kind: 'tool' as const, toolId: 'tool', toolVersion: '1' } };
    await expect(dispatcher.authorizeAndDispatch(operation, async () => 'ok')).resolves.toBe('ok');
    expect(port.authorize).toHaveBeenCalledWith(expect.objectContaining({ authorityId: AUTHORITY_ID,
      workflowId: 'real-workflow', workflowRunId: run, accountKey: binding.accountKey }), operation);
    expect(port.claimSend.mock.calls[0][2]).toBe(port.authorize.mock.calls[0][1]);
    const unavailable = platformEgressDispatcher({ fence: new PlatformEgressFence(port), binding });
    const wire = vi.fn(async () => 'not-permitted');
    await expect(unavailable.authorizeAndDispatch(operation, wire)).rejects.toThrow('PLATFORM_EGRESS_WORKFLOW_ID_UNAVAILABLE');
    expect(wire).not.toHaveBeenCalled();
  });
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
