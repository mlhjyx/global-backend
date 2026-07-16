import { ApplicationFailure, log, proxyActivities, sleep } from '@temporalio/workflow';
import type { createAssetCleanupActivities } from './asset-cleanup.activities';
import {
  AssetCleanupCommand,
  parseAssetCleanupCommand,
} from './asset-cleanup.contract';

type AssetCleanupActivities = ReturnType<typeof createAssetCleanupActivities>;

const activities = proxyActivities<AssetCleanupActivities>({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
    maximumInterval: '1 minute',
    maximumAttempts: 5,
  },
});

export async function assetObjectCleanupWorkflow(input: AssetCleanupCommand) {
  let command: AssetCleanupCommand;
  try {
    command = parseAssetCleanupCommand(input);
  } catch (error) {
    throw ApplicationFailure.nonRetryable(
      error instanceof Error ? error.message : String(error),
      'ASSET_CLEANUP_PAYLOAD_INVALID',
    );
  }
  const waitMs = Date.parse(command.notBefore) - Date.now();
  if (waitMs > 0) await sleep(waitMs);
  try {
    return await activities.cleanupStagingAssetObject(command);
  } catch (error) {
    const candidate = error as {
      type?: unknown;
      name?: unknown;
      cause?: { type?: unknown };
    };
    const errorCode =
      (typeof candidate.cause?.type === 'string' && candidate.cause.type) ||
      (typeof candidate.type === 'string' && candidate.type) ||
      (typeof candidate.name === 'string' && candidate.name) ||
      'ASSET_CLEANUP_FAILED';
    log.error('asset staging cleanup failed', {
      eventId: command.eventId,
      workspaceId: command.workspaceId,
      objectClass: command.objectClass,
      errorCode,
    });
    throw error;
  }
}
