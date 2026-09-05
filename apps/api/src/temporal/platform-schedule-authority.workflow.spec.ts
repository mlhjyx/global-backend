import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));

import {
  acts,
  resetActivities,
  setPatched,
  setWorkflowInfo,
} from './testing/temporal-workflow.mock';
import { acquisitionSweepWorkflow } from './acquisition.workflow';
import { intentSweepWorkflow } from './intent.workflow';
import {
  PATENTS_INTENTIONALLY_DISABLED_NO_EGRESS_PATCH,
  patentsCacheRefreshWorkflow,
} from './patents-cache.workflow';
import { sanctionsRefreshWorkflow } from './sanctions-refresh.workflow';
import {
  PLATFORM_SCHEDULE_AUTHORITY_CONTRACT_VERSION,
  PLATFORM_SCHEDULE_AUTHORITY_PATCH,
  PLATFORM_SCHEDULE_AUTHORITY_SCOPES,
  type PlatformExecutionBudgetBinding,
  type PlatformScheduleId,
} from './platform-schedule-authority';

function binding(scheduleId: PlatformScheduleId): PlatformExecutionBudgetBinding {
  const scope = PLATFORM_SCHEDULE_AUTHORITY_SCOPES[scheduleId];
  return {
    authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
    scopeKey: 'platform',
    accountKey: `platform:${scope.requestSha256}:workflow-run-1`,
    ...scope,
    workflowRunId: 'workflow-run-1',
    admissionReplay: false,
  };
}

beforeEach(() => {
  resetActivities();
  setWorkflowInfo({ runId: 'workflow-run-1' });
});

describe('platform schedule workflow authority matrix', () => {
  it.each([
    ['acq-sweep', acquisitionSweepWorkflow, 'listDueSources'],
    ['intent-sweep', intentSweepWorkflow, 'purgeStaleIntentEvents'],
    ['sanctions-refresh', sanctionsRefreshWorkflow, 'refreshSanctionsLists'],
  ] as const)('admits %s before its first domain activity and propagates the exact binding', async (
    scheduleId,
    workflow,
    firstDomainActivity,
  ) => {
    const admitted = binding(scheduleId);
    acts.admitPlatformSchedule.mockResolvedValue(admitted);
    acts.listDueSources.mockResolvedValue({ sourceIds: [] });
    acts.purgeStaleIntentEvents.mockResolvedValue({ deleted: 0 });
    acts.listDueWatches.mockResolvedValue({ sourceIds: [] });
    acts.projectIntentAllWorkspaces.mockResolvedValue({ workspaces: 0, companiesTouched: 0, eventsProjected: 0 });
    acts.refreshSanctionsLists.mockResolvedValue({ sources: 0, summaries: [] });

    await workflow({
      executionContractVersion: PLATFORM_SCHEDULE_AUTHORITY_CONTRACT_VERSION,
      executionScope: PLATFORM_SCHEDULE_AUTHORITY_SCOPES[scheduleId],
    } as never);

    expect(acts.admitPlatformSchedule).toHaveBeenCalledWith({
      executionContractVersion: PLATFORM_SCHEDULE_AUTHORITY_CONTRACT_VERSION,
      executionScope: PLATFORM_SCHEDULE_AUTHORITY_SCOPES[scheduleId],
      workflowRunId: 'workflow-run-1',
    });
    expect(acts[firstDomainActivity]).toHaveBeenCalledWith(expect.objectContaining({
      executionContractVersion: PLATFORM_SCHEDULE_AUTHORITY_CONTRACT_VERSION,
      executionBudget: admitted,
    }));
    expect(acts.admitPlatformSchedule.mock.invocationCallOrder[0]).toBeLessThan(
      acts[firstDomainActivity].mock.invocationCallOrder[0]!,
    );
  });

  it('keeps new patents histories deterministically disabled without grant admission or domain activity', async () => {
    await expect(
      patentsCacheRefreshWorkflow({
        executionContractVersion: PLATFORM_SCHEDULE_AUTHORITY_CONTRACT_VERSION,
        executionScope: PLATFORM_SCHEDULE_AUTHORITY_SCOPES['patents-cache-refresh'],
        maxAnchors: 11,
      }),
    ).resolves.toEqual({
      status: 'DISABLED',
      anchorCount: 0,
      rowCount: 0,
      bytesScanned: null,
      purged: 0,
      cached: 0,
      empty: 0,
      detail: 'INTENTIONALLY_DISABLED_NO_EGRESS',
    });
    expect(acts.admitPlatformSchedule).not.toHaveBeenCalled();
    expect(acts.refreshPatentCacheActivity).not.toHaveBeenCalled();
  });

  it('replays patents histories created after authority admission but before the no-egress patch', async () => {
    setPatched(
      (patchId) =>
        patchId === PLATFORM_SCHEDULE_AUTHORITY_PATCH &&
        patchId !== PATENTS_INTENTIONALLY_DISABLED_NO_EGRESS_PATCH,
    );
    const admitted = binding('patents-cache-refresh');
    acts.admitPlatformSchedule.mockResolvedValue(admitted);
    acts.refreshPatentCacheActivity.mockResolvedValue({
      status: 'SKIPPED_EMPTY', anchorCount: 0, rowCount: 0, bytesScanned: null,
      purged: 0, cached: 0, empty: 0,
    });

    await patentsCacheRefreshWorkflow({
      executionContractVersion: PLATFORM_SCHEDULE_AUTHORITY_CONTRACT_VERSION,
      executionScope: PLATFORM_SCHEDULE_AUTHORITY_SCOPES['patents-cache-refresh'],
      maxAnchors: 11,
    });

    expect(acts.admitPlatformSchedule).toHaveBeenCalledOnce();
    expect(acts.refreshPatentCacheActivity).toHaveBeenCalledWith({
      maxAnchors: 11,
      executionContractVersion: PLATFORM_SCHEDULE_AUTHORITY_CONTRACT_VERSION,
      executionBudget: admitted,
    });
  });

  it('does not convert a wrapped authority failure into a successful intent sweep', async () => {
    acts.admitPlatformSchedule.mockResolvedValue(binding('intent-sweep'));
    acts.purgeStaleIntentEvents.mockResolvedValue({ deleted: 0 });
    acts.listDueWatches.mockResolvedValue({ sourceIds: ['source-1'] });
    acts.watchSource.mockRejectedValue({
      name: 'ActivityFailure',
      cause: { type: 'EXECUTION_BUDGET_AUTHORITY_REVOKED' },
    });

    await expect(intentSweepWorkflow({
      executionContractVersion: 1,
      executionScope: PLATFORM_SCHEDULE_AUTHORITY_SCOPES['intent-sweep'],
    })).rejects.toMatchObject({
      cause: { type: 'EXECUTION_BUDGET_AUTHORITY_REVOKED' },
    });
    expect(acts.projectIntentAllWorkspaces).not.toHaveBeenCalled();
  });

  it('replays old schedule histories on the legacy command branch without adding admission commands', async () => {
    setPatched(() => false);
    acts.listDueSources.mockResolvedValue({ sourceIds: [] });

    await acquisitionSweepWorkflow({ limit: 7 });

    expect(acts.admitPlatformSchedule).not.toHaveBeenCalled();
    expect(acts.listDueSources).toHaveBeenCalledWith({ limit: 7 });
  });
});
