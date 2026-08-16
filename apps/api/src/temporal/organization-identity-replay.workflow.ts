import { proxyActivities } from '@temporalio/workflow';
import type { OrganizationIdentityReplayActivities, OrganizationIdentityReplayInput } from './organization-identity-replay.activities';

const activities = proxyActivities<OrganizationIdentityReplayActivities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 5 },
});

export async function organizationIdentityReplayWorkflow(input: OrganizationIdentityReplayInput) {
  return activities.processOrganizationIdentityReplay(input);
}
