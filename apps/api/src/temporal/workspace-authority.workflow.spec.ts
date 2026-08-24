import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));

import { acts, resetActivities, setPatched } from './testing/temporal-workflow.mock';
import { discoveryWorkflow } from './discovery.workflow';
import { understandingWorkflow } from './understanding.workflow';

const WS = '10000000-0000-4000-8000-000000000001';
const SHA = 'a'.repeat(64);
const DISCOVERY_BUDGET = Object.freeze({
  authorityId: '20000000-0000-4000-8000-000000000002',
  replay: false,
  scopeKey: WS,
  accountKey: `discovery.run:discovery_run:request:${SHA}:${SHA}`,
  purpose: 'discovery.run' as const,
  subjectType: 'discovery_run',
  subjectId: `request:${SHA}`,
  requestSha256: SHA,
});
const UNDERSTANDING_BUDGET = Object.freeze({
  ...DISCOVERY_BUDGET,
  accountKey: `understanding.run:company:request:${SHA}:${SHA}`,
  purpose: 'understanding.run' as const,
  subjectType: 'company',
});

function primeDiscovery() {
  acts.loadPlanQueries.mockResolvedValue({
    queries: [{ source_class: 'official_registry', filters: {}, keywords: [], priority: 1 }],
  });
  acts.executeQuery.mockResolvedValue({ rawCount: 1, provider: 'gleif', budgetTruncated: false });
  acts.canonicalizeRun.mockResolvedValue({ companies: 1, suppressed: 0 });
  acts.qualifyFitForRun.mockResolvedValue({ verdicts: { match: 1 }, skippedForBudget: 0 });
  acts.enrichRun.mockResolvedValue({ matched: 1, enriched: 1, provider: 'gleif', budgetTruncated: false });
  acts.enrichSignalsRun.mockResolvedValue({ matched: 1, enriched: 1, provider: 'public_web', budgetTruncated: false });
  acts.registerWatchesForRun.mockResolvedValue({ candidates: 1, registered: 1 });
  acts.enqueuePatentLookupsForRun.mockResolvedValue({ candidates: 1, enqueued: 1 });
  acts.finalizeRun.mockResolvedValue(undefined);
  acts.resetRunBudget.mockResolvedValue(undefined);
}

function discoveryInput() {
  return {
    workspaceId: WS,
    runId: 'run-1',
    planId: 'plan-1',
    icpId: 'icp-1',
    executionContractVersion: 2 as const,
    executionBudget: DISCOVERY_BUDGET,
  };
}

function wrappedControl(code: string) {
  return {
    name: 'ActivityFailure',
    message: 'Activity task failed',
    cause: { type: 'ApplicationFailure', cause: { code } },
  };
}

beforeEach(() => resetActivities());

describe('discoveryWorkflow execution-control propagation', () => {
  it.each([
    'executeQuery',
    'enrichSignalsRun',
    'registerWatchesForRun',
    'enqueuePatentLookupsForRun',
  ])('rethrows wrapped controls from %s instead of finalizing EXECUTED/PARTIAL', async (activityName) => {
    primeDiscovery();
    const failure = wrappedControl(
      activityName === 'executeQuery'
        ? 'BUDGET_OPERATION_REPLAY_UNAVAILABLE'
        : 'EXECUTION_BUDGET_AUTHORITY_REVOKED',
    );
    acts[activityName].mockRejectedValue(failure);

    await expect(discoveryWorkflow(discoveryInput())).rejects.toBe(failure);
    expect(acts.finalizeRun).not.toHaveBeenCalled();
  });

  it('keeps an ordinary query failure in the normal status path while still finalizing', async () => {
    primeDiscovery();
    acts.executeQuery.mockRejectedValue(new Error('provider unavailable'));

    await discoveryWorkflow(discoveryInput());

    expect(acts.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({
      status: 'FAILED',
      stats: expect.objectContaining({ failures: 1 }),
    }));
  });

  it.each([
    { ...discoveryInput(), executionContractVersion: undefined },
    { ...discoveryInput(), executionBudget: undefined },
  ])('fails a malformed v2 workflow input non-retryably', async (input) => {
    await expect(discoveryWorkflow(input as never)).rejects.toMatchObject({
      type: 'EXECUTION_BUDGET_WORKFLOW_INPUT_INVALID',
      nonRetryable: true,
    });
    expect(acts.loadPlanQueries).not.toHaveBeenCalled();
  });
});

describe('workspace authority Temporal compatibility', () => {
  it('replays a pre-authority discovery history with its exact legacy activity argument shapes', async () => {
    setPatched(() => false);
    primeDiscovery();

    await discoveryWorkflow({
      workspaceId: WS,
      runId: 'run-1',
      planId: 'plan-1',
      icpId: 'icp-1',
    } as never);

    expect(acts.resetRunBudget).toHaveBeenCalledWith({ workspaceId: WS, runId: 'run-1' });
    expect(acts.loadPlanQueries).toHaveBeenCalledWith({ workspaceId: WS, planId: 'plan-1' });
    expect(acts.executeQuery).toHaveBeenCalledWith(expect.not.objectContaining({ executionBudget: expect.anything() }));
    expect(acts.finalizeRun).toHaveBeenCalledWith(expect.not.objectContaining({ executionBudget: expect.anything() }));
    for (const activityName of [
      'loadPlanQueries', 'executeQuery', 'canonicalizeRun', 'qualifyFitForRun',
      'enrichRun', 'enrichSignalsRun', 'registerWatchesForRun',
      'enqueuePatentLookupsForRun', 'finalizeRun',
    ]) {
      for (const [args] of acts[activityName].mock.calls) {
        expect(args).not.toHaveProperty('executionContractVersion');
        expect(args).not.toHaveProperty('executionBudget');
      }
    }
  });

  it('replays a pre-authority understanding history with its exact legacy activity argument shapes', async () => {
    setPatched(() => false);
    acts.setStatus.mockResolvedValue(undefined);
    acts.crawlWebsite.mockResolvedValue({ url: 'https://acme.example/', text: 'home' });
    acts.selectSubpages.mockResolvedValue([]);
    acts.crawlPages.mockResolvedValue({ pages: [] });
    acts.extractClaims.mockResolvedValue({ claims: [] });
    acts.extractOfferings.mockResolvedValue({ offerings: [] });
    acts.persistClaims.mockResolvedValue(undefined);
    acts.persistOfferings.mockResolvedValue(undefined);
    acts.persistPublicContacts.mockResolvedValue(undefined);
    acts.extractAndPersistProfile.mockResolvedValue(undefined);

    await understandingWorkflow({
      workspaceId: WS,
      companyId: 'company-1',
      website: 'https://acme.example/',
    } as never);

    expect(acts.setStatus).toHaveBeenNthCalledWith(1, {
      companyId: 'company-1', workspaceId: WS, status: 'ENRICHING',
    });
    expect(acts.selectSubpages).toHaveBeenCalledWith({
      markdown: 'home', website: 'https://acme.example/',
    });
    expect(acts.extractClaims).toHaveBeenCalledWith({ workspaceId: WS, text: 'home' });
    expect(acts.setStatus).toHaveBeenNthCalledWith(2, {
      companyId: 'company-1', workspaceId: WS, status: 'REVIEW',
    });
    for (const activityName of [
      'setStatus', 'crawlWebsite', 'selectSubpages', 'crawlPages', 'extractClaims',
      'extractOfferings', 'persistClaims', 'persistOfferings',
      'persistPublicContacts', 'extractAndPersistProfile',
    ]) {
      for (const [args] of acts[activityName].mock.calls) {
        expect(args).not.toHaveProperty('executionContractVersion');
        expect(args).not.toHaveProperty('executionBudget');
      }
    }
  });

  it('uses explicit v2 workflow and activity inputs for new histories', async () => {
    primeDiscovery();

    await discoveryWorkflow(discoveryInput());

    expect(acts.resetRunBudget).not.toHaveBeenCalled();
    expect(acts.loadPlanQueries).toHaveBeenCalledWith(expect.objectContaining({
      executionContractVersion: 2,
      executionBudget: DISCOVERY_BUDGET,
    }));
  });

  it('uses explicit v2 inputs across a new understanding history', async () => {
    acts.setStatus.mockResolvedValue(undefined);
    acts.crawlWebsite.mockResolvedValue({ url: 'https://acme.example/', text: 'home' });
    acts.selectSubpages.mockResolvedValue([]);
    acts.crawlPages.mockResolvedValue({ pages: [] });
    acts.extractClaims.mockResolvedValue({ claims: [] });
    acts.extractOfferings.mockResolvedValue({ offerings: [] });
    acts.persistClaims.mockResolvedValue(undefined);
    acts.persistOfferings.mockResolvedValue(undefined);
    acts.persistPublicContacts.mockResolvedValue(undefined);
    acts.extractAndPersistProfile.mockResolvedValue(undefined);

    await understandingWorkflow({
      workspaceId: WS,
      companyId: 'company-1',
      website: 'https://acme.example/',
      executionContractVersion: 2,
      executionBudget: UNDERSTANDING_BUDGET,
    });

    expect(acts.setStatus).toHaveBeenNthCalledWith(1, expect.objectContaining({
      executionContractVersion: 2,
      executionBudget: UNDERSTANDING_BUDGET,
    }));
    expect(acts.selectSubpages).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WS,
      executionContractVersion: 2,
      executionBudget: UNDERSTANDING_BUDGET,
    }));
  });

  it.each([
    {
      workspaceId: WS, companyId: 'company-1', website: 'https://acme.example/',
      executionBudget: UNDERSTANDING_BUDGET,
    },
    {
      workspaceId: WS, companyId: 'company-1', website: 'https://acme.example/',
      executionContractVersion: 2 as const,
    },
  ])('fails a malformed understanding v2 input non-retryably', async (input) => {
    await expect(understandingWorkflow(input)).rejects.toMatchObject({
      type: 'EXECUTION_BUDGET_WORKFLOW_INPUT_INVALID',
      nonRetryable: true,
    });
    expect(acts.setStatus).not.toHaveBeenCalled();
  });
});
