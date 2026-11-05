import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/workflow', async () => ({
  ...(await import('./testing/temporal-workflow.mock')),
}));

import { ApplicationFailure, acts, resetActivities } from './testing/temporal-workflow.mock';
import { channelCrawlWorkflow } from './channel-crawl.workflow';

const INPUT = {
  executionContractVersion: 1 as const,
  channelId: '55555555-5555-4555-8555-555555555555',
  crawlRunId: '66666666-6666-4666-8666-666666666666',
  mode: 'run' as const,
  pageCap: 10,
  requestSha256: 'a'.repeat(64),
  technicalPolicyRevision: 'b'.repeat(64),
  capPerRunMicrousd: '5000000',
  campaignCapMicrousd: '5000000',
};
const BINDING = {
  authorityId: '77777777-7777-4777-8777-777777777777',
  accountKey: `platform:${'a'.repeat(64)}:66666666-6666-4666-8666-666666666666`,
  channelId: INPUT.channelId,
  crawlRunId: INPUT.crawlRunId,
  requestSha256: INPUT.requestSha256,
  technicalPolicyRevision: INPUT.technicalPolicyRevision,
};

beforeEach(() => {
  resetActivities();
  acts.admitChannelCrawl.mockResolvedValue({ binding: BINDING });
  acts.finalizeChannelCrawl.mockResolvedValue({ runId: 'run-1', autoDisabled: false });
});

describe('channelCrawlWorkflow（P4-P4c）', () => {
  it('admits, runs and finalizes a successful crawl', async () => {
    acts.runChannelCrawl.mockResolvedValue({
      status: 'SUCCEEDED',
      pagesFetched: 10,
      recordsFound: 4,
      failures: 1,
      truncated: false,
    });
    await expect(channelCrawlWorkflow(INPUT)).resolves.toEqual({
      status: 'SUCCEEDED',
      pagesFetched: 10,
    });
    expect(acts.admitChannelCrawl).toHaveBeenCalledWith(INPUT);
    expect(acts.finalizeChannelCrawl).toHaveBeenCalledWith({
      input: INPUT,
      outcome: expect.objectContaining({ status: 'SUCCEEDED', pagesFetched: 10, recordsFound: 4 }),
    });
  });

  it('finalizes FAILED with the bounded failure code when the run fails', async () => {
    acts.runChannelCrawl.mockRejectedValue(
      ApplicationFailure.nonRetryable('CHANNEL_NOT_APPROVED', 'CHANNEL_NOT_APPROVED'),
    );
    await expect(channelCrawlWorkflow(INPUT)).resolves.toEqual({ status: 'FAILED', pagesFetched: 0 });
    expect(acts.finalizeChannelCrawl).toHaveBeenCalledWith({
      input: INPUT,
      outcome: expect.objectContaining({ status: 'FAILED', errorCode: 'CHANNEL_NOT_APPROVED' }),
    });
  });

  it('records a cancelled run before ending', async () => {
    acts.runChannelCrawl.mockRejectedValue(Object.assign(new Error('cancelled'), { name: 'CancelledFailure' }));
    await expect(channelCrawlWorkflow(INPUT)).resolves.toEqual({ status: 'CANCELLED', pagesFetched: 0 });
    expect(acts.finalizeChannelCrawl).toHaveBeenCalledWith({
      input: INPUT,
      outcome: expect.objectContaining({ status: 'FAILED', errorCode: 'CHANNEL_CRAWL_CANCELLED' }),
    });
  });
});
