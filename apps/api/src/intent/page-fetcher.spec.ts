import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetOperationReplayError } from '../tools/budget-store';

vi.mock('../adapters/robots', () => ({ isAllowedByRobots: vi.fn(async () => true) }));

import { Crawl4aiPageFetcher } from './page-fetcher';

describe('Crawl4aiPageFetcher — durable budget binding', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes the activity-opened account into the broker', async () => {
    const invoke = vi.fn(async () => ({ data: { html: '<main>' + 'x'.repeat(220) + '</main>' }, costCents: 0 }));
    const fetcher = new Crawl4aiPageFetcher({ invoke } as never);
    const context = { workspaceId: 'platform', runId: 'intent-watch:source-1', correlationId: 'intent-watch:source-1' };

    await expect(fetcher.fetch('https://example.com/', context)).resolves.toMatchObject({ url: 'https://example.com/' });
    expect(invoke).toHaveBeenCalledWith('crawl4ai.render', { url: 'https://example.com/' }, context);
  });

  it('does not downgrade replay loss to an ordinary page miss', async () => {
    const replayError = new BudgetOperationReplayError('crawl-op');
    const fetcher = new Crawl4aiPageFetcher({ invoke: vi.fn(async () => { throw replayError; }) } as never);

    await expect(fetcher.fetch('https://example.com/', {
      workspaceId: 'platform', runId: 'intent-watch:source-1', correlationId: 'intent-watch:source-1',
    })).rejects.toBe(replayError);
  });
});
