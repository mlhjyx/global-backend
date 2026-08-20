import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const activitiesUrl = new URL('./backlog.activities.ts', import.meta.url);
const workflowUrl = new URL('./backlog.workflow.ts', import.meta.url);

describe('backlog durable budget wiring', () => {
  it('threads the stable workflow scope through every provider stage', async () => {
    const workflow = await readFile(workflowUrl, 'utf8');
    expect(workflow).toMatch(/enrichBacklog\(\{[^}]*budgetScopeId/);
    expect(workflow).toMatch(/registerWatchesBacklog\(\{[^}]*budgetScopeId/);
    expect(workflow).toMatch(/guessEmailsBacklog\(\{[^}]*budgetScopeId/);
  });

  it('opens explicit replay accounts and binds every external context to that account', async () => {
    const activities = await readFile(activitiesUrl, 'utf8');
    expect(activities).toContain("openStageBudget('enrich'");
    expect(activities).toContain("openStageBudget('watch'");
    expect(activities).toContain("openStageBudget('email-guess'");
    expect(activities).toMatch(/correlationId: 'backlog-enrich',[\s\S]*?runId: budget\.key/);
    expect(activities).toMatch(/registerWatch\([\s\S]*?budgetKey: budget\.key/);
    expect(activities).toMatch(/workspaceId: args\.workspaceId,[\s\S]*?runId: budget\.key/);
    expect(activities).toContain('err instanceof BudgetOperationReplayError');
  });
});
