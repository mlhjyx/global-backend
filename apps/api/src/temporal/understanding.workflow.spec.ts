import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityFailure, ApplicationFailure } from '@temporalio/common';

/**
 * `understandingWorkflow` 编排单测（hermetic proxyActivities-mock harness，无 Temporal 运行时）。
 * 守：抓取活动带着卖方 company_profile 的 id（活动据此把 G3 产物主体交给 broker）；任一阶段
 * 重试用尽时先把失败回写到 company_profile 再让工作流失败；工作流代码自身的缺陷、旧历史、
 * 收尾本身失败都不回写。设计见 docs/implementation-records/temporal-workflow-testing.md。
 */
vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));

import { acts, resetActivities, setPatched } from './testing/temporal-workflow.mock';
import {
  UNDERSTANDING_FAILURE_RECORD_PATCH,
  understandingWorkflow,
} from './understanding.workflow';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const COMPANY_ID = '50000000-0000-4000-8000-000000000005';
const WEBSITE = 'https://acme.example/';
const BINDING = Object.freeze({
  authorityId: '20000000-0000-4000-8000-000000000002',
  replay: false,
  scopeKey: WORKSPACE_ID,
  accountKey: `understanding.run:company:request:${'a'.repeat(64)}:${'a'.repeat(64)}`,
  purpose: 'understanding.run' as const,
  subjectType: 'company',
  subjectId: `request:${'a'.repeat(64)}`,
  requestSha256: 'a'.repeat(64),
});
const INPUT = Object.freeze({
  workspaceId: WORKSPACE_ID,
  companyId: COMPANY_ID,
  website: WEBSITE,
  executionContractVersion: 2 as const,
  executionBudget: BINDING,
});
const AUTHORITY = Object.freeze({
  executionContractVersion: 2,
  executionBudget: BINDING,
});

/** The failure Temporal hands the workflow after an activity's last attempt. */
function activityFailure(activityType: string, cause: Error): ActivityFailure {
  return new ActivityFailure('Activity task failed', activityType, '7', 'MAXIMUM_ATTEMPTS_REACHED', 'worker-1', cause);
}

function primeHappyPath(): void {
  acts.setStatus.mockResolvedValue(undefined);
  acts.crawlWebsite.mockResolvedValue({ url: WEBSITE, text: '# Acme\n[About](/about)' });
  acts.selectSubpages.mockResolvedValue([`${WEBSITE}about`]);
  acts.crawlPages.mockResolvedValue({ pages: [{ url: `${WEBSITE}about`, text: 'About Acme' }] });
  acts.extractClaims.mockResolvedValue({ claims: [] });
  acts.extractOfferings.mockResolvedValue({ offerings: [] });
  acts.persistClaims.mockResolvedValue({ claimCount: 0 });
  acts.persistOfferings.mockResolvedValue({ offeringCount: 0 });
  acts.persistPublicContacts.mockResolvedValue({ contactCount: 0 });
  acts.extractAndPersistProfile.mockResolvedValue(undefined);
  acts.recordUnderstandingFailure.mockResolvedValue(undefined);
}

beforeEach(() => resetActivities());

describe('understandingWorkflow — the seller profile is the subject of its crawls', () => {
  it('hands the company id to the homepage and subpage crawls', async () => {
    primeHappyPath();

    await understandingWorkflow({ ...INPUT });

    expect(acts.crawlWebsite).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID, companyId: COMPANY_ID, website: WEBSITE, ...AUTHORITY }),
    );
    expect(acts.crawlPages).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID, companyId: COMPANY_ID, urls: [`${WEBSITE}about`], ...AUTHORITY }),
    );
    expect(acts.setStatus.mock.calls.map(([args]) => (args as { status: string }).status)).toEqual(['ENRICHING', 'REVIEW']);
    expect(acts.recordUnderstandingFailure).not.toHaveBeenCalled();
  });
});

describe('understandingWorkflow — a stage failure is written back before the workflow fails', () => {
  it('records the denied homepage crawl on the company row, then fails with the same error', async () => {
    primeHappyPath();
    const denied = activityFailure(
      'crawlWebsite',
      ApplicationFailure.create({ type: 'GENERIC_OPERATION_ARTIFACT_SUBJECT_BINDING_INVALID', nonRetryable: true }),
    );
    acts.crawlWebsite.mockRejectedValue(denied);

    await expect(understandingWorkflow({ ...INPUT })).rejects.toBe(denied);

    expect(acts.recordUnderstandingFailure).toHaveBeenCalledTimes(1);
    expect(acts.recordUnderstandingFailure).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      ...AUTHORITY,
      failure: { stage: 'crawlWebsite', errorType: 'GENERIC_OPERATION_ARTIFACT_SUBJECT_BINDING_INVALID', control: true },
    });
    expect(acts.setStatus.mock.calls.map(([args]) => (args as { status: string }).status)).toEqual(['ENRICHING']);
    expect(acts.selectSubpages).not.toHaveBeenCalled();
  });

  it('names the stage that stopped a run further in', async () => {
    primeHappyPath();
    const lost = activityFailure(
      'extractClaims',
      ApplicationFailure.create({ type: 'ProviderOutputError', message: 'the model answered: Acme GmbH, Musterstraße 1' }),
    );
    acts.extractClaims.mockRejectedValue(lost);

    await expect(understandingWorkflow({ ...INPUT })).rejects.toBe(lost);

    const [args] = acts.recordUnderstandingFailure.mock.calls[0] as [{ failure: unknown }];
    expect(args.failure).toEqual({ stage: 'extract', errorType: 'ProviderOutputError', control: false });
    expect(JSON.stringify(args)).not.toMatch(/Acme|Muster|answered/u);
    expect(acts.persistClaims).not.toHaveBeenCalled();
  });

  it('does not record a defect of the workflow code itself', async () => {
    primeHappyPath();
    const defect = new TypeError('pages is not iterable');
    acts.crawlPages.mockRejectedValue(defect);

    await expect(understandingWorkflow({ ...INPUT })).rejects.toBe(defect);

    expect(acts.recordUnderstandingFailure).not.toHaveBeenCalled();
  });

  it('keeps the old command sequence for a history without the patch marker', async () => {
    primeHappyPath();
    setPatched((patchId) => patchId !== UNDERSTANDING_FAILURE_RECORD_PATCH);
    const denied = activityFailure('crawlWebsite', ApplicationFailure.create({ type: 'ToolPolicyDenied' }));
    acts.crawlWebsite.mockRejectedValue(denied);

    await expect(understandingWorkflow({ ...INPUT })).rejects.toBe(denied);

    expect(acts.recordUnderstandingFailure).not.toHaveBeenCalled();
  });

  it('reports the stage error even when the write-back itself fails', async () => {
    primeHappyPath();
    const denied = activityFailure('crawlWebsite', ApplicationFailure.create({ type: 'ToolPolicyDenied' }));
    acts.crawlWebsite.mockRejectedValue(denied);
    acts.recordUnderstandingFailure.mockRejectedValue(
      activityFailure('recordUnderstandingFailure', ApplicationFailure.create({ type: 'PrismaClientKnownRequestError' })),
    );

    await expect(understandingWorkflow({ ...INPUT })).rejects.toBe(denied);

    expect(acts.recordUnderstandingFailure).toHaveBeenCalledTimes(1);
  });

  it('does not rewrite a run whose only failure is the final REVIEW status write', async () => {
    primeHappyPath();
    const lateFailure = activityFailure('setStatus', ApplicationFailure.create({ type: 'PrismaClientKnownRequestError' }));
    acts.setStatus.mockImplementation(async (args: { status: string }) => {
      if (args.status === 'REVIEW') throw lateFailure;
    });

    await expect(understandingWorkflow({ ...INPUT })).rejects.toBe(lateFailure);

    expect(acts.persistClaims).toHaveBeenCalledTimes(1);
    expect(acts.recordUnderstandingFailure).not.toHaveBeenCalled();
  });
});
