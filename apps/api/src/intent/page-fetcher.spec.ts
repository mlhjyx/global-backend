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

  it('does not downgrade a wrapped artifact/receipt control to an ordinary page miss', async () => {
    const control = Object.assign(new Error('activity failed'), {
      cause: { code: 'GENERIC_OPERATION_ARTIFACT_INVALID' },
    });
    const fetcher = new Crawl4aiPageFetcher({
      invoke: vi.fn(async () => { throw control; }),
    } as never);

    await expect(fetcher.fetch('https://example.com/', {
      workspaceId: 'platform',
      runId: 'intent-watch:source-1',
      correlationId: 'intent-watch:source-1',
    })).rejects.toBe(control);
  });

  it('forwards a ledger receipt exactly once and fails closed without a consumer callback', async () => {
    const receipt = {
      schemaVersion: 'durable-execution-receipt/v1',
      scopeKey: 'platform',
      authorityId: '20000000-0000-4000-8000-000000000001',
      accountId: '30000000-0000-4000-8000-000000000001',
      operationId: '40000000-0000-4000-8000-000000000001',
      operationKey: 'render',
      resultStrategy: 'artifact_reference',
      resultSchema: 'crawl4ai-render/v1',
      resultDigest: 'a'.repeat(64),
      artifactId: '50000000-0000-4000-8000-000000000001',
      usage: { currency: 'USD', unit: 'microusd', callCount: 1, upperBoundMicrousd: '10000' },
      costBasis: 'estimated_upper_bound',
    } as const;
    const fetcher = new Crawl4aiPageFetcher({
      invoke: vi.fn(async () => ({
        data: { html: '<main>' + 'x'.repeat(220) + '</main>' },
        durableReceipt: receipt,
      })),
    } as never);
    const context = {
      workspaceId: 'platform', runId: 'intent-watch:source-1',
      correlationId: 'intent-watch:source-1',
    };
    await expect(fetcher.fetch('https://example.com/', context))
      .rejects.toThrow('DOMAIN_ACK_CONSUMER_BINDING_MISSING');

    const onDurableReceipt = vi.fn();
    await expect(fetcher.fetch('https://example.com/', {
      ...context, onDurableReceipt,
    })).resolves.toMatchObject({ url: 'https://example.com/' });
    expect(onDurableReceipt).toHaveBeenCalledWith('crawl4ai.render', receipt);
  });
});
