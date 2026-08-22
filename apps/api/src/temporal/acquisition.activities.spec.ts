import { describe, expect, it, vi } from 'vitest';
import { createAcquisitionActivities } from './acquisition.activities';
import { SourceAdapterRegistry } from '../acquisition/source-adapter';
import { PLATFORM_SCHEDULE_AUTHORITY_SCOPES } from './platform-schedule-authority';

const scope = PLATFORM_SCHEDULE_AUTHORITY_SCOPES['acq-sweep'];
const executionBudget = {
  authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
  scopeKey: 'platform' as const,
  accountKey: `platform:${scope.requestSha256}:workflow-run-1`,
  ...scope,
  workflowRunId: 'workflow-run-1',
  admissionReplay: false,
};

describe('acquisition activities — platform authority lifecycle', () => {
  it('read-only attests before the adapter call and never reopens or closes the admitted account', async () => {
    const order: string[] = [];
    const fetch = vi.fn(async (_config, _limit, context) => {
      order.push('wire');
      expect(context).toEqual({
        workspaceId: 'platform',
        runId: executionBudget.accountKey,
        correlationId: executionBudget.accountKey,
      });
      throw new Error('wire failed');
    });
    const registry = new SourceAdapterRegistry().register({ providerKey: 'test-source', fetch });
    const prisma = {
      monitoredSource: {
        findUnique: vi.fn(async () => ({
          id: 'source-1', providerKey: 'test-source', sourceKey: 'source', status: 'ACTIVE', config: {},
        })),
      },
      sourceFetch: {
        create: vi.fn(async () => ({ id: 'fetch-1' })),
        update: vi.fn(async () => ({})),
      },
    };
    const budgetStore = {
      attestAuthorized: vi.fn(async () => { order.push('attest'); }),
      openAuthorized: vi.fn(),
      open: vi.fn(),
      close: vi.fn(),
    };
    const activities = createAcquisitionActivities({
      prisma: prisma as never, registry, budgetStore: budgetStore as never,
      activityRunId: () => 'workflow-run-1',
    });

    await expect(activities.acquireSource({
      sourceId: 'source-1', executionContractVersion: 1, executionBudget,
    })).resolves.toMatchObject({ status: 'FAILED' });
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
});
