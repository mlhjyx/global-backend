import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `qualifyWorkflow` 编排单测。复用 PR #73 hermetic proxyActivities-mock harness。
 * 守：input 原样传给 scoreCandidates；无 fail-safe 吞（活动抛错向上传播）。
 */
vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));

import { acts, resetActivities } from './testing/temporal-workflow.mock';
import { qualifyWorkflow } from './qualify.workflow';

const input = { workspaceId: 'ws-1', icpId: 'icp-1' };

beforeEach(() => resetActivities());

describe('qualifyWorkflow', () => {
  it('把 input 原样传给 scoreCandidates（确定性评分单活动编排）', async () => {
    acts.scoreCandidates.mockResolvedValue({ scored: 42 });

    await qualifyWorkflow(input as never);

    expect(acts.scoreCandidates).toHaveBeenCalledTimes(1);
    expect(acts.scoreCandidates).toHaveBeenCalledWith(input);
  });

  it('scoreCandidates 抛错 → 向上传播（无 fail-safe 吞）', async () => {
    acts.scoreCandidates.mockRejectedValue(new Error('score boom'));

    await expect(qualifyWorkflow(input as never)).rejects.toThrow('score boom');
  });
});
