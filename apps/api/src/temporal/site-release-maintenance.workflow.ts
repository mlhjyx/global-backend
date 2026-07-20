import { proxyActivities } from '@temporalio/workflow';
import type { createSiteReleaseMaintenanceActivities } from './site-release-maintenance.activities';

const activities = proxyActivities<
  ReturnType<typeof createSiteReleaseMaintenanceActivities>
>({
  startToCloseTimeout: '30 minutes',
  retry: { maximumAttempts: 5 },
});

export async function siteReleaseMaintenanceSweepWorkflow(
  input: { limit?: number } = {},
) {
  return activities.sweepSiteReleases(input);
}
