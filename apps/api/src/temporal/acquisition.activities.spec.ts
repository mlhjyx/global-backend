import { describe, expect, it, vi } from 'vitest';
import { createAcquisitionActivities } from './acquisition.activities';
import { SourceAdapterRegistry } from '../acquisition/source-adapter';

describe('acquisition activities — durable budget lifecycle', () => {
  it('opens a replay scope before the adapter call, binds the same runId, and closes in finally', async () => {
    const order: string[] = [];
    const fetch = vi.fn(async (_config, _limit, context) => {
      order.push('wire');
      expect(context).toEqual({
        workspaceId: 'platform',
        runId: 'acquisition:source-1',
        correlationId: 'acquisition:source-1',
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
      open: vi.fn(async () => { order.push('open'); }),
      close: vi.fn(async () => { order.push('close'); }),
    };
    const activities = createAcquisitionActivities({ prisma: prisma as never, registry, budgetStore: budgetStore as never });

    await expect(activities.acquireSource({ sourceId: 'source-1' })).resolves.toMatchObject({ status: 'FAILED' });
    expect(budgetStore.open).toHaveBeenCalledWith({
      workspaceId: 'platform', accountKey: 'acquisition:source-1', capCents: expect.any(Number), replayScope: true,
    });
    expect(budgetStore.close).toHaveBeenCalledWith({ workspaceId: 'platform', accountKey: 'acquisition:source-1' });
    expect(order).toEqual(['open', 'wire', 'close']);
  });
});
