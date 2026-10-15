import {
  ActivityFailure,
  continueAsNew,
  proxyActivities,
  rootCause,
  sleep,
  TimeoutFailure,
} from '@temporalio/workflow';
import type { PersonalArtifactCleanupActivities } from './personal-artifact-cleanup.activities';

const activities = proxyActivities<PersonalArtifactCleanupActivities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    maximumAttempts: 1,
  },
});

const COMMANDS_PER_HISTORY = 50;

/**
 * Store unavailability, and an attempt that ran out of time (a worker that died
 * or stalled mid-erasure), both resume through the bounded backoff below. The
 * outbox starts this workflow once, so failing it would leave the command
 * CLAIMED with nobody to pick it up; the next claim takes a CLAIMED command
 * again and the erasure itself is idempotent.
 */
function resumable(error: unknown): boolean {
  if (rootCause(error) === 'PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE') return true;
  return (
    error instanceof ActivityFailure &&
    error.cause instanceof TimeoutFailure &&
    error.cause.timeoutType === 'START_TO_CLOSE'
  );
}

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
      if (resumable(error)) return retry();
      throw error;
    }
  }
  return continueAsNew<typeof personalArtifactCleanupWorkflow>(input);
}
