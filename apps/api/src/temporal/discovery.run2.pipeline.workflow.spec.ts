import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityFailure, ApplicationFailure } from '@temporalio/common';

vi.mock('@temporalio/workflow', async () => await import('./testing/temporal-workflow.mock'));

import { acts, resetActivities } from './testing/temporal-workflow.mock';
import { companyPipelineWorkflow } from './discovery.run2.pipeline.workflow';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const ICP_ID = '33333333-3333-4333-8333-333333333333';
const COMPANY_ID = '44444444-4444-4444-8444-444444444444';

const INPUT = {
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  icpId: ICP_ID,
  companyId: COMPANY_ID,
  executionContractVersion: 2 as const,
  executionBudget: {
    authorityId: '55555555-5555-4555-8555-555555555555',
    replay: false,
    scopeKey: WORKSPACE_ID,
    accountKey: `discovery.run:discovery_run:request:${'c'.repeat(64)}:${'c'.repeat(64)}`,
    purpose: 'discovery.run',
    subjectType: 'discovery_run',
    subjectId: `request:${'c'.repeat(64)}`,
    requestSha256: 'c'.repeat(64),
  },
};

function markedStages(): string[] {
  return acts.updateCompanyJobStage.mock.calls.map(
    (call) => (call[0] as { stage: string }).stage,
  );
}

beforeEach(() => {
  resetActivities();
  acts.updateCompanyJobStage.mockResolvedValue(undefined);
  acts.profileCompanyOnce.mockResolvedValue({ profiled: true, matched: true, unclassified: false });
  acts.fitCompanyOnce.mockResolvedValue({ judged: true, verdict: 'match' });
  acts.signalsCompanyOnce.mockResolvedValue({ matched: 1, provider: 'digital_footprint' });
  acts.contactsCompanyOnce.mockResolvedValue({ skipped: false, people: 2, emails: 1, phones: 0 });
});

describe('M0④ 公司级深挖子工作流', () => {
  it('runs profiling → fitting → signals → contacts and records every stage on the job', async () => {
    await expect(companyPipelineWorkflow(INPUT)).resolves.toEqual({ stage: 'done' });

    expect(markedStages()).toEqual(['profiling', 'fitting', 'signals', 'contacts', 'done']);
    expect(acts.profileCompanyOnce).toHaveBeenCalledTimes(1);
    expect(acts.signalsCompanyOnce).toHaveBeenCalledTimes(1);
    expect(acts.contactsCompanyOnce).toHaveBeenCalledTimes(1);
    expect(acts.updateCompanyJobStage).toHaveBeenLastCalledWith(
      expect.objectContaining({ stage: 'done', verdictDeep: 'match', companyId: COMPANY_ID }),
    );
  });

  it('stops after the fit when the company is a mismatch', async () => {
    acts.fitCompanyOnce.mockResolvedValue({ judged: true, verdict: 'mismatch' });

    await expect(companyPipelineWorkflow(INPUT)).resolves.toEqual({ stage: 'done' });

    expect(markedStages()).toEqual(['profiling', 'fitting', 'done']);
    expect(acts.signalsCompanyOnce).not.toHaveBeenCalled();
    expect(acts.contactsCompanyOnce).not.toHaveBeenCalled();
    expect(acts.updateCompanyJobStage).toHaveBeenLastCalledWith(
      expect.objectContaining({ stage: 'done', verdictDeep: 'mismatch' }),
    );
  });

  it('isolates a company failure: marks it failed with a classified code, not the aggregate', async () => {
    acts.contactsCompanyOnce.mockRejectedValue(new Error('adapter exploded'));

    await expect(companyPipelineWorkflow(INPUT)).resolves.toEqual({ stage: 'failed' });

    expect(acts.updateCompanyJobStage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stage: 'failed',
        errorCode: 'UNKNOWN_UPSTREAM',
        failureStage: 'provider',
      }),
    );
    expect(acts.updateCompanyJobStage).not.toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'COMPANY_PIPELINE_FAILED' }),
    );
  });

  it('P3 J02 W1: a typed activity failure keeps its specific failure code and stage', async () => {
    acts.fitCompanyOnce.mockRejectedValue(
      new ActivityFailure(
        'Activity task failed',
        'fitCompanyOnce',
        '1',
        undefined,
        'worker-1',
        ApplicationFailure.create({ message: 'Temporal execution failed', type: 'PROVIDER_HTTP_429' }),
      ),
    );

    await expect(companyPipelineWorkflow(INPUT)).resolves.toEqual({ stage: 'failed' });

    expect(markedStages()).toEqual(['profiling', 'fitting', 'failed']);
    expect(acts.updateCompanyJobStage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stage: 'failed',
        errorCode: 'PROVIDER_HTTP_429',
        failureStage: 'provider',
      }),
    );
  });

  it('P3 J02 W1: control-plane failures are attributed outside provider', async () => {
    acts.profileCompanyOnce.mockRejectedValue(
      ApplicationFailure.create({ message: 'BUDGET_STORE_UNAVAILABLE', type: '' }),
    );

    await expect(companyPipelineWorkflow(INPUT)).resolves.toEqual({ stage: 'failed' });

    expect(acts.updateCompanyJobStage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stage: 'failed',
        errorCode: 'BUDGET_AUTHORITY_NOT_READY',
        failureStage: 'budget',
      }),
    );
  });

  it('marks the job skipped(DEEP_STOPPED) and rethrows when the parent cancels the child', async () => {
    acts.signalsCompanyOnce.mockRejectedValue(
      Object.assign(new Error('cancelled'), { name: 'CancelledFailure' }),
    );

    await expect(companyPipelineWorkflow(INPUT)).rejects.toMatchObject({ name: 'CancelledFailure' });
    expect(acts.updateCompanyJobStage).toHaveBeenLastCalledWith(
      expect.objectContaining({ stage: 'skipped', errorCode: 'DEEP_STOPPED' }),
    );
  });
});
