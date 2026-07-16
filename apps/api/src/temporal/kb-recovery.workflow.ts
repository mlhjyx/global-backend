import { log, proxyActivities } from '@temporalio/workflow';
import type { createSiteBuilderActivities } from './site-builder.activities';

type SiteBuilderActivities = ReturnType<typeof createSiteBuilderActivities>;

const activities = proxyActivities<SiteBuilderActivities>({
  startToCloseTimeout: '25 minutes',
  retry: { maximumAttempts: 2 },
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
  const candidates = await activities.listKbRecoveryCandidates({ limit: input?.limit ?? 100 });
  const out: KbRecoverySweepResult = {
    scanned: candidates.length,
    ready: 0,
    retryScheduled: 0,
    terminal: 0,
    skipped: 0,
    errors: [],
  };
  for (const candidate of candidates) {
    try {
      const result = await activities.processKbAsset(candidate);
      if (result.outcome === 'ready') out.ready += 1;
      else if (result.outcome === 'retry_scheduled') out.retryScheduled += 1;
      else if (result.outcome === 'failed_terminal') out.terminal += 1;
      else out.skipped += 1;
    } catch (err) {
      const message = String(err).slice(0, 300);
      out.errors.push(`${candidate.assetId}: ${message}`);
      log.warn('KB recovery candidate failed', { assetId: candidate.assetId, error: message });
    }
  }
  return out;
}
