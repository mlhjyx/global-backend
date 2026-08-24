import {
  continueAsNew,
  proxyActivities,
  rootCause,
  sleep,
} from '@temporalio/workflow';
import type { PersonalArtifactCleanupActivities } from './personal-artifact-cleanup.activities';

const activities = proxyActivities<PersonalArtifactCleanupActivities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    maximumAttempts: 1,
  },
});

const COMMANDS_PER_HISTORY = 50;

export async function personalArtifactCleanupWorkflow(input: Readonly<{
  workspaceId: string;
  deletionRequestId: string;
  retryDelaySeconds?: number;
}>): Promise<unknown> {
  const delay =
    Number.isSafeInteger(input.retryDelaySeconds) &&
    Number(input.retryDelaySeconds) >= 30 &&
    Number(input.retryDelaySeconds) <= 3_600
      ? Number(input.retryDelaySeconds)
      : 30;
  const retry = async (): Promise<never> => {
    await sleep(`${delay} seconds`);
    return continueAsNew<typeof personalArtifactCleanupWorkflow>({
      workspaceId: input.workspaceId,
      deletionRequestId: input.deletionRequestId,
      retryDelaySeconds: Math.min(delay * 2, 3_600),
    });
  };
  for (let processed = 0; processed < COMMANDS_PER_HISTORY; processed += 1) {
    try {
      const result = await activities.cleanupPersonalArtifact({
        workspaceId: input.workspaceId,
        deletionRequestId: input.deletionRequestId,
      });
      if (result.status === 'HOLD') return retry();
      if (result.status !== 'COMPLETED' || result.replay) return result;
    } catch (error) {
      if (
        rootCause(error) === 'PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE'
      ) return retry();
      throw error;
    }
  }
  return continueAsNew<typeof personalArtifactCleanupWorkflow>(input);
}
