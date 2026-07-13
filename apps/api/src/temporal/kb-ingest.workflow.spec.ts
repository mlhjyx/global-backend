import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `kbIngestWorkflow` 编排单测（M1-a：KB 摄入 Temporal 化，assets.controller.ts M0 挂账）。
 * 单 activity 透传：重试语义交 Temporal retry policy；失败=文档留 queued 可重触发（语义不变）。
 */

vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));

import { acts, resetActivities } from './testing/temporal-workflow.mock';
import { kbIngestWorkflow } from './kb-ingest.workflow';

beforeEach(() => resetActivities());

describe('kbIngestWorkflow（M1-a）', () => {
  it('入参透传 processQueuedKbDocs，返回其结果', async () => {
    acts.processQueuedKbDocs.mockResolvedValue({ processed: 3, failed: 1 });

    const out = await kbIngestWorkflow({ workspaceId: 'ws-1', siteId: 'site-1' });

    expect(acts.processQueuedKbDocs).toHaveBeenCalledTimes(1);
    expect(acts.processQueuedKbDocs).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      siteId: 'site-1',
    });
    expect(out).toEqual({ processed: 3, failed: 1 });
  });

  it('activity 失败原样上抛（不吞——Temporal retry 拥有重试权，文档留 queued）', async () => {
    acts.processQueuedKbDocs.mockRejectedValue(new Error('embeddings down'));
    await expect(kbIngestWorkflow({ workspaceId: 'ws-1', siteId: 'site-1' })).rejects.toThrow(
      'embeddings down',
    );
  });
});
