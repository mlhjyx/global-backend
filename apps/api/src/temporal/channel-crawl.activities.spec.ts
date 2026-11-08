import { describe, expect, it, vi } from 'vitest';
import { createChannelCrawlActivities } from './channel-crawl.activities';
import type { ChannelCrawlWorkflowInput } from './platform-channel-crawl';

const INPUT: ChannelCrawlWorkflowInput = {
  executionContractVersion: 1,
  channelId: '55555555-5555-4555-8555-555555555555',
  crawlRunId: '66666666-6666-4666-8666-666666666666',
  mode: 'run',
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
const CRAWL_CONFIG = {
  list: {
    url: 'https://expo.example/exhibitors?page={page}',
    maxPages: 5,
    itemSelector: '.card',
    itemUrlSelector: 'a',
  },
};
const PAGE_HTML =
  '<html><body><div class="card"><a href="https://acme.example">Acme Pumpen</a></div></body></html>';

function makeActivities(overrides: {
  used?: bigint;
  channel?: Record<string, unknown> | null;
  grantError?: Error;
  fence?: unknown;
  materializeError?: Error;
} = {}) {
  const fenceBindings: unknown[] = [];
  const authorizeAndDispatch = vi.fn(
    async (binding: unknown, _operation: unknown, execute: () => Promise<unknown>) => {
      fenceBindings.push(binding);
      return execute();
    },
  );
  const fetchPage = vi.fn(
    async (
      url: string,
      context: { platformEgress: { authorizeAndDispatch: (op: unknown, exec: () => Promise<unknown>) => Promise<unknown> } },
    ) =>
      (await context.platformEgress.authorizeAndDispatch({}, async () => ({
        url,
        html: PAGE_HTML,
      }))) as { url: string; html: string },
  );
  const recordRun = vi.fn(async () => ({ runId: 'run-1', autoDisabled: false }));
  const materializeRecords = overrides.materializeError
    ? vi.fn(async () => {
        throw overrides.materializeError;
      })
    : vi.fn(async (input: { records: unknown[] }) => input.records.length);
  const attestAuthorized = vi.fn(async () => ({}));
  const requestChannelCrawlGrant = overrides.grantError
    ? vi.fn(async () => {
        throw overrides.grantError;
      })
    : vi.fn(async () => ({ token: 'grant.jws.token', expiresAt: 1 }));
  const ingestChannelCrawlAndAdmit = vi.fn(async () => ({
    authorityId: BINDING.authorityId,
    replay: false,
    accountId: '88888888-8888-4888-8888-888888888888',
    generation: 1,
    authorizedCapMicrousd: 5_000_000n,
  }));
  const runRows: Array<Record<string, unknown>> = [];
  const progressUpdates: number[] = [];
  const activities = createChannelCrawlActivities({
    prisma: {
      sourceChannel: {
        findUnique: vi.fn(async () =>
          overrides.channel === undefined
            ? {
                id: INPUT.channelId,
                mode: 'crawl',
                status: 'ENABLED',
                config: CRAWL_CONFIG,
              }
            : overrides.channel,
        ),
      },
      sourceChannelRun: {
        aggregate: vi.fn(async () => ({ _sum: { pagesFetched: overrides.used ?? 0n } })),
        createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
          runRows.push(...data);
          return { count: data.length };
        }),
        findUnique: vi.fn(async ({ where }: { where: { crawlRunId: string } }) =>
          runRows.find((row) => row.crawlRunId === where.crawlRunId) ?? null,
        ),
      },
      $executeRaw: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        progressUpdates.push(Number(values[0]));
        const row = runRows.find((entry) => entry.crawlRunId === INPUT.crawlRunId);
        if (row) {
          row.pagesFetched = Math.max(Number(row.pagesFetched ?? 0), Number(values[0]));
          row.requests = Math.max(Number(row.requests ?? 0), Number(values[0]));
        }
        return 1;
      }),
    } as never,
    recordRun,
    grantClient: { requestChannelCrawlGrant } as never,
    ingestion: { ingestChannelCrawlAndAdmit } as never,
    budgetStore: { attestAuthorized } as never,
    fence: (overrides.fence ?? {
      authorizeAndDispatchPlatformEgress: (binding: unknown, operation: unknown, execute: () => Promise<unknown>) =>
        authorizeAndDispatch(binding, operation, execute),
    }) as never,
    fetchPage,
    materializeRecords,
    now: () => Date.UTC(2026, 10, 5, 8, 0, 0),
  });
  return {
    activities,
    requestChannelCrawlGrant,
    ingestChannelCrawlAndAdmit,
    attestAuthorized,
    authorizeAndDispatch,
    fetchPage,
    recordRun,
    materializeRecords,
    fenceBindings,
    runRows,
    progressUpdates,
  };
}

describe('channelCrawlActivities（P4-P4c）', () => {
  it('admits through the mTLS grant, ingestion and read-only attest', async () => {
    const { activities, requestChannelCrawlGrant, ingestChannelCrawlAndAdmit, attestAuthorized } =
      makeActivities();
    await expect(activities.admitChannelCrawl(INPUT)).resolves.toEqual({ binding: BINDING });
    expect(requestChannelCrawlGrant).toHaveBeenCalledWith({
      channelId: INPUT.channelId,
      mode: 'run',
      pageCap: '10',
      crawlRunId: INPUT.crawlRunId,
      requestSha256: INPUT.requestSha256,
      technicalPolicyRevision: INPUT.technicalPolicyRevision,
      capPerRunMicrousd: '5000000',
      campaignCapMicrousd: '5000000',
    });
    expect(ingestChannelCrawlAndAdmit).toHaveBeenCalledWith({
      compactJws: 'grant.jws.token',
      expected: {
        purpose: 'platform.channel_crawl',
        subjectType: 'source_channel',
        subjectId: INPUT.channelId,
        requestSha256: INPUT.requestSha256,
        crawlRunId: INPUT.crawlRunId,
        technicalPolicyRevision: INPUT.technicalPolicyRevision,
      },
    });
    expect(attestAuthorized).toHaveBeenCalledWith({
      authorityId: BINDING.authorityId,
      scopeKey: 'platform',
      accountKey: BINDING.accountKey,
    });
  });

  it('maps authority rejection to a bounded non-retryable failure', async () => {
    const error = Object.assign(new Error('rejected'), { code: 'PLATFORM_GRANT_REJECTED' });
    const { activities } = makeActivities({ grantError: error });
    await expect(activities.admitChannelCrawl(INPUT)).rejects.toMatchObject({
      message: 'PLATFORM_GRANT_REJECTED',
    });
  });

  it('truncates the run to the remaining UTC-day page quota and drives every page through the fence', async () => {
    const { activities, authorizeAndDispatch, fetchPage, fenceBindings } = makeActivities({ used: 498n });
    const outcome = await activities.runChannelCrawl({ input: INPUT, binding: BINDING });
    expect(outcome).toMatchObject({
      // CH-6：日配额截断但有产出 → PARTIAL（不当坏轮），维度随结局返回。
      status: 'PARTIAL',
      pagesFetched: 2,
      truncated: true,
      mode: 'run',
      requests: 2,
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(authorizeAndDispatch).toHaveBeenCalledTimes(2);
    expect(fenceBindings[0]).toMatchObject({
      subjectKind: 'source_channel',
      channelId: INPUT.channelId,
      crawlRunId: INPUT.crawlRunId,
      accountKey: BINDING.accountKey,
    });
    expect(fetchPage.mock.calls[0]![1]).toMatchObject({
      workspaceId: 'platform',
      runId: BINDING.accountKey,
      platformEgress: expect.objectContaining({ authorizeAndDispatch: expect.any(Function) }),
      // Declared platform scope: page HTML is parsed transiently, never stored
      // as a subjectless PERSONAL_DATA artifact (design 2026-11-06 §4.1).
      transientResultScope: 'platform_channel_crawl',
    });
  });

  it('returns a truncated outcome without any fetch when the daily quota is exhausted', async () => {
    const { activities, fetchPage, authorizeAndDispatch } = makeActivities({ used: 500n });
    await expect(activities.runChannelCrawl({ input: INPUT, binding: BINDING })).resolves.toEqual({
      status: 'SUCCEEDED',
      pagesFetched: 0,
      recordsFound: 0,
      recordsMaterialized: 0,
      failures: 0,
      truncated: true,
      mode: 'run',
      requests: 0,
    });
    expect(fetchPage).not.toHaveBeenCalled();
    expect(authorizeAndDispatch).not.toHaveBeenCalled();
  });

  it('rejects a channel that is no longer approved', async () => {
    const { activities } = makeActivities({
      channel: { id: INPUT.channelId, mode: 'crawl', status: 'DISABLED', config: CRAWL_CONFIG },
    });
    await expect(activities.runChannelCrawl({ input: INPUT, binding: BINDING })).rejects.toMatchObject({
      message: 'CHANNEL_NOT_APPROVED',
    });
  });

  it('materializes crawled records inside the run activity and reports the count', async () => {
    const { activities, materializeRecords } = makeActivities({ used: 498n });
    const outcome = await activities.runChannelCrawl({ input: INPUT, binding: BINDING });
    expect(outcome.recordsFound).toBe(2);
    expect(outcome.recordsMaterialized).toBe(2);
    expect(materializeRecords).toHaveBeenCalledWith({
      channelId: INPUT.channelId,
      crawlRunId: INPUT.crawlRunId,
      records: expect.arrayContaining([
        expect.objectContaining({ name: 'Acme Pumpen' }),
      ]),
    });
  });

  it('fails non-retryably when materialization throws (never masks records as success)', async () => {
    const { activities } = makeActivities({ used: 498n, materializeError: new Error('db down') });
    await expect(activities.runChannelCrawl({ input: INPUT, binding: BINDING })).rejects.toMatchObject({
      message: 'CHANNEL_MATERIALIZATION_FAILED',
    });
  });

  it('writes a RUNNING row up front and persists per-page progress (CP-G7 two-phase)', async () => {
    const { activities, runRows, progressUpdates } = makeActivities({ used: 498n });
    await activities.runChannelCrawl({ input: INPUT, binding: BINDING });
    expect(runRows[0]).toMatchObject({
      channelId: INPUT.channelId,
      crawlRunId: INPUT.crawlRunId,
      status: 'RUNNING',
      mode: 'run',
    });
    expect(progressUpdates).toEqual([1, 2]);
  });

  it('failure finalize preserves the actual pages from the RUNNING row instead of writing 0', async () => {
    const { activities, recordRun, runRows } = makeActivities();
    runRows.push({ crawlRunId: INPUT.crawlRunId, status: 'RUNNING', pagesFetched: 10, requests: 10 });
    await activities.finalizeChannelCrawl({
      input: INPUT,
      outcome: {
        status: 'FAILED',
        pagesFetched: 0,
        recordsFound: 0,
        recordsMaterialized: 0,
        failures: 0,
        truncated: false,
        errorCode: 'CHANNEL_CRAWL_FAILED',
      },
    });
    expect(recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'FAILED',
        pagesFetched: 10,
        requests: 10,
        mode: 'run',
        errorCode: 'CHANNEL_CRAWL_FAILED',
      }),
    );
  });

  it('records the run in the platform context with the truncation marker and materialized count', async () => {
    const { activities, recordRun } = makeActivities();
    await activities.finalizeChannelCrawl({
      input: INPUT,
      outcome: {
        status: 'SUCCEEDED',
        pagesFetched: 3,
        recordsFound: 1,
        recordsMaterialized: 1,
        failures: 0,
        truncated: true,
      },
    });
    expect(recordRun).toHaveBeenCalledWith({
      channelId: INPUT.channelId,
      // finalize 幂等键：同一工作流重试收敛到同一行（设计 2026-11-06 §4.2）。
      crawlRunId: INPUT.crawlRunId,
      status: 'SUCCEEDED',
      pagesFetched: 3,
      recordsFound: 1,
      recordsMaterialized: 1,
      failures: 0,
      truncated: true,
    });
  });
});
