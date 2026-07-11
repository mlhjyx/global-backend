import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `intentSweepWorkflow` 编排单测。复用 PR #73 hermetic proxyActivities-mock harness。
 * 守：purge→逐源 watch→project 顺序；单源失败 fail-safe；purge/project 各自 try-catch 吞错；limit 透传。
 */
vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));

import { acts, resetActivities } from './testing/temporal-workflow.mock';
import { intentSweepWorkflow } from './intent.workflow';

function watchResult(sourceId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { sourceId, status: 'DONE', pagesFetched: 3, pagesMissed: 0, added: 1, changed: 2, intentEvents: 2, ...over };
}

function primeIntent(sourceIds: string[]): void {
  acts.purgeStaleIntentEvents.mockResolvedValue({ purged: 0 });
  acts.listDueWatches.mockResolvedValue({ sourceIds });
  acts.watchSource.mockImplementation(async ({ sourceId }: { sourceId: string }) => watchResult(sourceId));
  acts.projectIntentAllWorkspaces.mockResolvedValue({ workspaces: 2, companiesTouched: 5, eventsProjected: 9 });
}

beforeEach(() => resetActivities());

describe('intentSweepWorkflow', () => {
  it('happy：purge → 逐源 watch → project；swept + projected 正确', async () => {
    primeIntent(['s1', 's2']);

    const out = await intentSweepWorkflow({});

    expect(acts.purgeStaleIntentEvents).toHaveBeenCalledTimes(1);
    expect(acts.watchSource).toHaveBeenCalledTimes(2);
    expect(acts.projectIntentAllWorkspaces).toHaveBeenCalledTimes(1);
    expect(out.swept).toBe(2);
    expect(out.results).toHaveLength(2);
    expect(out.projected).toEqual({ workspaces: 2, companiesTouched: 5, eventsProjected: 9 });
  });

  it('单源 watch 抛错 → fail-safe FAILED 条目，其余仍处理', async () => {
    primeIntent(['s1', 's2']);
    acts.watchSource.mockReset();
    acts.watchSource
      .mockRejectedValueOnce(new Error('watch boom'))
      .mockImplementationOnce(async ({ sourceId }: { sourceId: string }) => watchResult(sourceId));

    const out = await intentSweepWorkflow({});

    expect(out.results[0]).toMatchObject({ sourceId: 's1', status: 'FAILED', intentEvents: 0 });
    expect(out.results[0].error).toContain('watch boom');
    expect(out.results[1].error).toBeUndefined();
    expect(out.swept).toBe(2);
  });

  it('purgeStaleIntentEvents 抛错 → 被 .catch 吞，workflow 继续', async () => {
    primeIntent(['s1']);
    acts.purgeStaleIntentEvents.mockRejectedValue(new Error('purge boom'));

    const out = await intentSweepWorkflow({});

    expect(acts.watchSource).toHaveBeenCalledTimes(1); // 保留期清理失败不阻断 sweep
    expect(out.swept).toBe(1);
  });

  it('projectIntentAllWorkspaces 抛错 → 被吞，projected 归零，results 仍返回', async () => {
    primeIntent(['s1']);
    acts.projectIntentAllWorkspaces.mockRejectedValue(new Error('project boom'));

    const out = await intentSweepWorkflow({});

    expect(out.projected).toEqual({ workspaces: 0, companiesTouched: 0, eventsProjected: 0 });
    expect(out.results).toHaveLength(1);
  });

  it('limit 透传（默认 50）', async () => {
    primeIntent([]);
    await intentSweepWorkflow({ limit: 9 });
    expect(acts.listDueWatches).toHaveBeenCalledWith({ limit: 9 });
    await intentSweepWorkflow({});
    expect(acts.listDueWatches).toHaveBeenLastCalledWith({ limit: 50 });
  });
});
