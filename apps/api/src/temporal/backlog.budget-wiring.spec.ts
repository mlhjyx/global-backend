import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createBacklogActivities } from './backlog.activities';
import { BudgetAccountUnavailableError } from '../tools/budget-store';

const activitiesUrl = new URL('./backlog.activities.ts', import.meta.url);
const workflowUrl = new URL('./backlog.workflow.ts', import.meta.url);

describe('backlog durable budget wiring', () => {
  it('threads the stable workflow scope through every provider stage', async () => {
    const workflow = await readFile(workflowUrl, 'utf8');
    expect(workflow.match(/if \(isBacklogAuthorityHold\(err\)\) throw err;/g)).toHaveLength(6);
    expect(workflow).not.toContain('isExecutionControlError');
    expect(workflow).toMatch(/enrichBacklog\(\{[^}]*budgetScopeId/);
    expect(workflow).toMatch(/registerWatchesBacklog\(\{[^}]*budgetScopeId/);
    expect(workflow).toMatch(/guessEmailsBacklog\(\{[^}]*budgetScopeId/);
  });

  it('contains one unconditional pre-query authority HOLD and no legacy account construction', async () => {
    const activities = await readFile(activitiesUrl, 'utf8');
    expect(activities).toContain('EXECUTION_BUDGET_PLATFORM_AUTHORITY_REQUIRED');
    expect(activities).toContain('return authorityHold()');
    expect(activities).not.toContain('openStageBudget');
    expect(activities).not.toContain('.status(');
    expect(activities).not.toContain('.open(');
    expect(activities).not.toContain('IntentProjectionService');
  });

  it('parks a legacy stage before reading candidates or advancing a watermark', async () => {
    const withWorkspace = vi.fn();
    const activities = createBacklogActivities({
      prisma: { withWorkspace } as never,
      providers: {} as never,
      gateway: {} as never,
      ownerDb: {} as never,
      activityRunId: () => 'workflow-run-1',
      budgetStore: {
        status: vi.fn(async () => {
          throw new BudgetAccountUnavailableError('sweep:workflow-run-1:enrich:workspace-1');
        }),
      } as never,
    });

    await expect(activities.enrichBacklog({
      workspaceId: 'workspace-1',
      budgetScopeId: 'workflow-run-1',
    })).rejects.toMatchObject({
      type: 'EXECUTION_BUDGET_PLATFORM_AUTHORITY_REQUIRED',
      nonRetryable: true,
    });
    expect(withWorkspace).not.toHaveBeenCalled();
  });
});
