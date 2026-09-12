import { ApplicationFailure, log, proxyActivities, sleep } from '@temporalio/workflow';
import type { createAssetCleanupActivities } from './asset-cleanup.activities';
import { AssetCleanupCommand, parseAssetCleanupCommand } from './asset-cleanup.contract';

type AssetCleanupActivities = ReturnType<typeof createAssetCleanupActivities>;

/**
 * A signed PUT may be authorised before expiry while its request body is still in flight.
 * These code-owned production constants cover the supported maximum in-flight upload window;
 * neither the client nor the Outbox payload can shorten them. The second durable checkpoint
 * closes the narrower race where such a PUT completes concurrently with the first DeleteObject.
 * URL expiry alone is not treated as proof that no authorised request remains in flight.
 */
export const ASSET_CLEANUP_IN_FLIGHT_GRACE_MS = 15 * 60 * 1000;
export const ASSET_CLEANUP_SETTLE_MS = 5 * 60 * 1000;

const activities = proxyActivities<AssetCleanupActivities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
    maximumInterval: '1 minute',
    maximumAttempts: 5,
  },
});

interface AssetCleanupTiming {
  inFlightGraceMs: number;
  settleMs: number;
}

/** Internal workflow runner. Timing is supplied only by code-owned workflow entrypoints. */
export async function runAssetObjectCleanup(input: AssetCleanupCommand, timing: AssetCleanupTiming) {
  let command: AssetCleanupCommand;
  try {
    command = parseAssetCleanupCommand(input);
  } catch {
    throw ApplicationFailure.nonRetryable(
      'invalid asset cleanup payload',
      'ASSET_CLEANUP_PAYLOAD_INVALID',
    );
  }
  try {
    if (command.objectClass === 'staging') {
      const waitMs = Date.parse(command.notBefore) + timing.inFlightGraceMs - Date.now();
      if (waitMs > 0) await sleep(waitMs);
      await activities.cleanupStagingAssetObject(command);
      await sleep(timing.settleMs);
      return await activities.cleanupStagingAssetObject(command);
    }
    const first = await activities.cleanupCanonicalAssetObjects(command);
    if (!first.alreadySettled) {
      await sleep(timing.settleMs);
      await activities.cleanupCanonicalAssetObjects(command);
    }
    return await activities.settleCanonicalAssetCleanup(command);
  } catch (error) {
    // Failure properties may contain dependency text or throwing accessors.
    // Do not inspect them for logging; rethrow unchanged to preserve failure semantics.
    log.error('asset object cleanup failed', {
      eventId: command.eventId,
      workspaceId: command.workspaceId,
      objectClass: command.objectClass,
      errorCode: 'ASSET_CLEANUP_FAILED',
    });
    throw error;
  }
}

export async function assetObjectCleanupWorkflow(input: AssetCleanupCommand) {
  return runAssetObjectCleanup(input, {
    inFlightGraceMs: ASSET_CLEANUP_IN_FLIGHT_GRACE_MS,
    settleMs: ASSET_CLEANUP_SETTLE_MS,
  });
}
