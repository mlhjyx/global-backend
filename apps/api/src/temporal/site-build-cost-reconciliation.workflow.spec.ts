import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));

import { acts, resetActivities } from './testing/temporal-workflow.mock';
import { siteBuildCostReconciliationSweepWorkflow } from './site-build-cost-reconciliation.workflow';

beforeEach(() => resetActivities());

describe('siteBuildCostReconciliationSweepWorkflow', () => {
  it('runs one bounded reconciliation activity without dispatching another model call', async () => {
    acts.sweepSiteBuildCostReconciliation.mockResolvedValue({
      workspaces: 2,
      attempted: 3,
      resolved: 0,
      nextCursor: null,
    });

    const result = await siteBuildCostReconciliationSweepWorkflow({ limit: 500 });

    expect(acts.sweepSiteBuildCostReconciliation).toHaveBeenCalledWith({ limit: 10 });
    expect(result).toEqual({ workspaces: 2, attempted: 3, resolved: 0 });
  });

  it('runs one fair page per Schedule tick even when more workspaces remain', async () => {
    acts.sweepSiteBuildCostReconciliation.mockResolvedValue({
      workspaces: 2,
      attempted: 2,
      resolved: 1,
      nextCursor: {
        lastAttempt: null,
        workspaceId: '00000000-0000-4000-8000-000000000010',
      },
    });

    const result = await siteBuildCostReconciliationSweepWorkflow({ limit: 10 });

    expect(acts.sweepSiteBuildCostReconciliation).toHaveBeenCalledTimes(1);
    expect(acts.sweepSiteBuildCostReconciliation).toHaveBeenCalledWith({
      limit: 10,
    });
    expect(result).toEqual({ workspaces: 2, attempted: 2, resolved: 1 });
  });

  it.each([
    [undefined, 10],
    [{ limit: Number.NaN }, 10],
    [{ limit: 0.9 }, 1],
    [{ limit: 21.9 }, 10],
  ])('normalizes %o to a stable bounded activity limit', async (input, expected) => {
    acts.sweepSiteBuildCostReconciliation.mockResolvedValue({
      workspaces: 0,
      attempted: 0,
      resolved: 0,
      nextCursor: null,
    });

    await siteBuildCostReconciliationSweepWorkflow(input);

    expect(acts.sweepSiteBuildCostReconciliation).toHaveBeenCalledWith({
      limit: expected,
    });
  });
});
