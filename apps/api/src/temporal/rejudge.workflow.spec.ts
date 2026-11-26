import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

const { rejudgeCompanyOnce, enqueueRejudgeQualify, proxyConfigs } = vi.hoisted(() => ({
  rejudgeCompanyOnce: vi.fn(),
  enqueueRejudgeQualify: vi.fn(),
  proxyConfigs: [] as unknown[],
}));

vi.mock('@temporalio/workflow', () => ({
  proxyActivities: (config: unknown) => {
    proxyConfigs.push(config);
    return {
      rejudgeCompanyOnce,
      enqueueRejudgeQualify,
    };
  },
}));

import { rejudgeWorkflow } from './rejudge.workflow';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const ICP_ID = '20000000-0000-4000-8000-000000000002';
const REJUDGE_ID = '30000000-0000-4000-8000-000000000003';
const COMPANY_1 = '40000000-0000-4000-8000-000000000004';
const COMPANY_2 = '50000000-0000-4000-8000-000000000005';
const COMPANY_3 = '60000000-0000-4000-8000-000000000006';

const BUDGET_BINDING = {
  authorityId: '70000000-0000-4000-8000-000000000007',
  replay: false as const,
  scopeKey: WORKSPACE_ID,
  accountKey: `icp.rejudge:icp:${ICP_ID}:${'a'.repeat(64)}`,
  purpose: 'icp.rejudge' as const,
  subjectType: 'icp',
  subjectId: ICP_ID,
  requestSha256: 'a'.repeat(64),
};

describe('rejudgeWorkflow', () => {
  it('configures retry.maximumAttempts = 1 and declares zero module-level numeric constants', async () => {
    expect(proxyConfigs).toContainEqual(
      expect.objectContaining({
        retry: { maximumAttempts: 1 },
      }),
    );
    const source = await readFile(new URL('./rejudge.workflow.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^(?:export\s+)?(?:const|let)\s+[A-Z0-9_]+\s*=\s*\d+/m);
  });

  it('processes batches serially, aggregates counters, and enqueues qualify without runId when any company was judged', async () => {
    rejudgeCompanyOnce.mockReset();
    enqueueRejudgeQualify.mockReset();
    rejudgeCompanyOnce
      .mockResolvedValueOnce({
        processed: true,
        judged: true,
        leadUpdated: true,
        verdict: 'match',
        refreshedProfile: true,
        viesMatched: true,
        failedSoft: false,
        fatalBudgetError: false,
      })
      .mockResolvedValueOnce({
        processed: true,
        judged: true,
        leadUpdated: true,
        verdict: 'mismatch',
        refreshedProfile: false,
        viesMatched: false,
        failedSoft: false,
        fatalBudgetError: false,
      })
      .mockResolvedValueOnce({
        processed: true,
        judged: false,
        leadUpdated: false,
        verdict: null,
        refreshedProfile: false,
        viesMatched: false,
        failedSoft: true,
        fatalBudgetError: false,
      });

    const summary = await rejudgeWorkflow({
      rejudgeId: REJUDGE_ID,
      workspaceId: WORKSPACE_ID,
      icpId: ICP_ID,
      executionContractVersion: 2,
      budgetBinding: BUDGET_BINDING,
      batches: [
        { index: 0, companyIds: [COMPANY_1, COMPANY_2] },
        { index: 1, companyIds: [COMPANY_3] },
      ],
      refreshCorroboration: true,
      refreshWebsiteProfile: true,
    });

    expect(summary).toEqual({
      rejudgeId: REJUDGE_ID,
      processed: 3,
      refreshedProfiles: 1,
      viesMatched: 1,
      fitCount: 1,
      notFitCount: 1,
      unknownCount: 0,
      failedSoft: 1,
      stoppedByBudget: false,
    });
    expect(enqueueRejudgeQualify).toHaveBeenCalledTimes(1);
    expect(enqueueRejudgeQualify).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      icpId: ICP_ID,
      rejudgeId: REJUDGE_ID,
    });
  });

  it('halts remaining batches immediately on fatalBudgetError while keeping prior commits and enqueueing qualify for updated leads', async () => {
    rejudgeCompanyOnce.mockReset();
    enqueueRejudgeQualify.mockReset();
    rejudgeCompanyOnce
      .mockResolvedValueOnce({
        processed: true,
        judged: true,
        leadUpdated: true,
        verdict: 'weak',
        refreshedProfile: false,
        viesMatched: false,
        failedSoft: false,
        fatalBudgetError: false,
      })
      .mockResolvedValueOnce({
        processed: false,
        judged: false,
        leadUpdated: false,
        verdict: null,
        refreshedProfile: false,
        viesMatched: false,
        failedSoft: false,
        fatalBudgetError: true,
      });

    const summary = await rejudgeWorkflow({
      rejudgeId: REJUDGE_ID,
      workspaceId: WORKSPACE_ID,
      icpId: ICP_ID,
      executionContractVersion: 2,
      budgetBinding: BUDGET_BINDING,
      batches: [
        { index: 0, companyIds: [COMPANY_1, COMPANY_2] },
        { index: 1, companyIds: [COMPANY_3] },
      ],
      refreshCorroboration: true,
      refreshWebsiteProfile: false,
    });

    expect(rejudgeCompanyOnce).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({
      processed: 1,
      unknownCount: 1,
      stoppedByBudget: true,
    });
    expect(enqueueRejudgeQualify).toHaveBeenCalledTimes(1);
  });

  it('skips enqueueRejudgeQualify when zero companies were judged', async () => {
    rejudgeCompanyOnce.mockReset();
    enqueueRejudgeQualify.mockReset();
    rejudgeCompanyOnce.mockResolvedValueOnce({
      processed: false,
      judged: false,
      leadUpdated: false,
      verdict: null,
      refreshedProfile: false,
      viesMatched: false,
      failedSoft: false,
      fatalBudgetError: false,
    });

    await rejudgeWorkflow({
      rejudgeId: REJUDGE_ID,
      workspaceId: WORKSPACE_ID,
      icpId: ICP_ID,
      executionContractVersion: 2,
      budgetBinding: BUDGET_BINDING,
      batches: [{ index: 0, companyIds: [COMPANY_1] }],
      refreshCorroboration: true,
      refreshWebsiteProfile: false,
    });

    expect(enqueueRejudgeQualify).not.toHaveBeenCalled();
  });

  it('enqueues qualify and counts notFit when L0 gate updates a non-human lead without running LLM judge', async () => {
    rejudgeCompanyOnce.mockReset();
    enqueueRejudgeQualify.mockReset();
    rejudgeCompanyOnce.mockResolvedValueOnce({
      processed: true,
      judged: false,
      leadUpdated: true,
      verdict: 'mismatch',
      refreshedProfile: false,
      viesMatched: false,
      failedSoft: false,
      fatalBudgetError: false,
    });

    const summary = await rejudgeWorkflow({
      rejudgeId: REJUDGE_ID,
      workspaceId: WORKSPACE_ID,
      icpId: ICP_ID,
      executionContractVersion: 2,
      budgetBinding: BUDGET_BINDING,
      batches: [{ index: 0, companyIds: [COMPANY_1] }],
      refreshCorroboration: false,
      refreshWebsiteProfile: false,
    });

    expect(summary).toMatchObject({
      processed: 1,
      notFitCount: 1,
      failedSoft: 0,
      stoppedByBudget: false,
    });
    expect(enqueueRejudgeQualify).toHaveBeenCalledTimes(1);
    expect(enqueueRejudgeQualify).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      icpId: ICP_ID,
      rejudgeId: REJUDGE_ID,
    });
  });
});
