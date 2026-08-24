import { proxyActivities } from '@temporalio/workflow';
import type { createSiteBuilderActivities } from './site-builder.activities';

type SiteBuilderActivities = ReturnType<typeof createSiteBuilderActivities>;

const activities = proxyActivities<SiteBuilderActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3 },
});

/**
 * Periodic, bounded sweep for calls that produced valid output while their
 * exact provider cost was temporarily unavailable. The activity only reads
 * provider accounting facts and appends observations; it never re-dispatches
 * a physical model request.
 */
export async function siteBuildCostReconciliationSweepWorkflow(
  input: { limit?: number } = {},
) {
  const requested = input.limit ?? 50;
  const limit = Math.max(
    1,
    Math.min(10, Number.isFinite(requested) ? Math.floor(requested) : 10),
  );
  // One Schedule tick owns one time-bounded fair page. The owner-side query
  // orders by least-recently-attempted workspace, so the next tick naturally
  // advances without an unbounded Workflow history or activity timeout loop.
  const page = await activities.sweepSiteBuildCostReconciliation({ limit });
  return {
    workspaces: page.workspaces,
    attempted: page.attempted,
    resolved: page.resolved,
  };
}
