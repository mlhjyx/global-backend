import { describe, expect, it, vi } from 'vitest';
import { BudgetOperationReplayError } from '../tools/budget-store';
import { createIntentActivities } from './intent.activities';

describe('intent activities — durable budget lifecycle', () => {
  it('opens and closes a stable replay scope around a website watch', async () => {
    const order: string[] = [];
    const fetch = vi.fn(async (_url, context) => {
      order.push('wire');
      expect(context).toEqual({
        workspaceId: 'platform', runId: 'intent-watch:source-1', correlationId: 'intent-watch:source-1',
      });
      throw new BudgetOperationReplayError('crawl-op');
    });
    const prisma = {
      monitoredSource: { findUnique: vi.fn(async () => ({
        id: 'source-1', providerKey: 'web_watch', sourceKey: 'web_watch:example.com', label: 'Example',
        status: 'ACTIVE', region: null,
        config: { company: { name: 'Example', domain: 'example.com' }, pages: [{ url: 'https://example.com/' }] },
      })) },
      sourcePolicy: { findFirst: vi.fn(async () => null) },
      sourceFetch: { create: vi.fn(async () => ({ id: 'fetch-1' })) },
      sourceEntity: { findMany: vi.fn(async () => []) },
    };
    const budgetStore = {
      open: vi.fn(async () => { order.push('open'); }),
      close: vi.fn(async () => { order.push('close'); }),
    };
    const activities = createIntentActivities({
      prisma: prisma as never, fetcher: { fetch } as never, budgetStore: budgetStore as never,
    });

    await expect(activities.watchSource({ sourceId: 'source-1' })).rejects.toBeInstanceOf(BudgetOperationReplayError);
    expect(budgetStore.open).toHaveBeenCalledWith({
      workspaceId: 'platform', accountKey: 'intent-watch:source-1', capCents: expect.any(Number), replayScope: true,
    });
    expect(budgetStore.close).toHaveBeenCalledWith({ workspaceId: 'platform', accountKey: 'intent-watch:source-1' });
    expect(order).toEqual(['open', 'wire', 'close']);
  });
});
