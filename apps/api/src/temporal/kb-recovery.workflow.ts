import { log, proxyActivities } from '@temporalio/workflow';
import type { createSiteBuilderActivities } from './site-builder.activities';

type SiteBuilderActivities = ReturnType<typeof createSiteBuilderActivities>;

const MAX_CANDIDATES = 10;
const MAX_CONCURRENCY = 5;

const scanActivities = proxyActivities<SiteBuilderActivities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 1 },
});

const processingActivities = proxyActivities<SiteBuilderActivities>({
  // 两个至多 5 条的 wave，各自被 10 分钟 activity timeout 硬界定；持久重试由 Asset 状态机负责。
  startToCloseTimeout: '10 minutes',
  heartbeatTimeout: '20 seconds',
  retry: { maximumAttempts: 1 },
});

export interface KbRecoverySweepResult {
  scanned: number;
  ready: number;
  retryScheduled: number;
  terminal: number;
  skipped: number;
  errors: string[];
}

/**
 * Bounded KB recovery sweep. Cross-tenant enumeration is owner-read-only in the activity;
 * each write re-enters PrismaService.withWorkspace and is fenced on the Asset row.
 */
export async function kbRecoverySweepWorkflow(input?: {
  limit?: number;
}): Promise<KbRecoverySweepResult> {
  const requestedLimit = input?.limit ?? MAX_CANDIDATES;
  const limit = Math.min(
    MAX_CANDIDATES,
    Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : MAX_CANDIDATES),
  );
  const candidates = await scanActivities.listKbRecoveryCandidates({ limit });
  const out: KbRecoverySweepResult = {
    scanned: candidates.length,
    ready: 0,
    retryScheduled: 0,
    terminal: 0,
    skipped: 0,
    errors: [],
  };

  for (let offset = 0; offset < candidates.length; offset += MAX_CONCURRENCY) {
    const batch = candidates.slice(offset, offset + MAX_CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async (candidate) => {
        try {
          return { candidate, result: await processingActivities.processKbAsset(candidate) };
        } catch (err) {
          return { candidate, error: String(err).slice(0, 300) };
        }
      }),
    );

    // 聚合按候选输入顺序执行，不依赖 activity 的完成先后。
    for (const item of settled) {
      if ('error' in item) {
        out.errors.push(`${item.candidate.assetId}: ${item.error}`);
        log.warn('KB recovery candidate failed', {
          assetId: item.candidate.assetId,
          error: item.error,
        });
        continue;
      }
      if (item.result.outcome === 'ready') out.ready += 1;
      else if (item.result.outcome === 'retry_scheduled') out.retryScheduled += 1;
      else if (item.result.outcome === 'failed_terminal') out.terminal += 1;
      else out.skipped += 1;
    }
  }
  return out;
}
