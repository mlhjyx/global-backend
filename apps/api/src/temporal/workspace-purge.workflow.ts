import { proxyActivities } from '@temporalio/workflow';
import type { WorkspacePurgeActivities } from './workspace-purge.activities';
import type {
  WorkspacePurgeReceiptRecord,
  WorkspacePurgeWorkflowInput,
} from '../workspace/workspace-purge.types';

const acts = proxyActivities<WorkspacePurgeActivities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 5 },
});

function errorCodeFrom(error: unknown): string {
  if (error && typeof error === 'object') {
    const type = (error as { type?: unknown }).type;
    if (typeof type === 'string' && type.trim().length > 0) {
      return type.trim().slice(0, 120);
    }
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim().length > 0 && name !== 'Error') {
      return name.trim().slice(0, 120);
    }
  }
  return 'WORKSPACE_PURGE_FAILED';
}

export async function workspacePurgeWorkflow(
  input: WorkspacePurgeWorkflowInput,
): Promise<WorkspacePurgeReceiptRecord> {
  try {
    const shouldRun = await acts.markWorkspacePurgeRunning({
      workspaceId: input.workspaceId,
      campaignPlanJobIds: input.campaignPlanJobIds ?? [],
    });
    if (!shouldRun) {
      return await acts.getWorkspacePurgeReceipt({
        workspaceId: input.workspaceId,
      });
    }

    const targets = await acts.snapshotWorkspacePurgeTargets({
      workspaceId: input.workspaceId,
      campaignPlanJobIds: input.campaignPlanJobIds ?? [],
    });

    const temporalWorkflowsCancelled = await acts.cancelWorkspaceWorkflows({
      workspaceId: input.workspaceId,
      workflowIds: targets.workflowIds,
    });

    const dbResult = await acts.purgeWorkspaceDatabase({
      workspaceId: input.workspaceId,
    });

    const minioObjectsDeleted = await acts.purgeWorkspaceStorage({
      workspaceId: input.workspaceId,
      siteIds: targets.siteIds,
      legacyReleasePrefixes: targets.legacyReleasePrefixes,
      exportObjectKeys: targets.exportObjectKeys,
      personalObjects: dbResult.personalObjectsToErase,
    });

    const redisKeysDeleted = await acts.purgeWorkspaceRedis({
      workspaceId: input.workspaceId,
    });

    return await acts.completeWorkspacePurge({
      workspaceId: input.workspaceId,
      dbRowsDeleted: dbResult.dbRowsDeleted,
      minioObjectsDeleted,
      redisKeysDeleted,
      temporalWorkflowsCancelled,
    });
  } catch (error) {
    await acts
      .failWorkspacePurge({
        workspaceId: input.workspaceId,
        errorCode: errorCodeFrom(error),
      })
      .catch(() => undefined);
    throw error;
  }
}
