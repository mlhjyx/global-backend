import { continueAsNew, patched, proxyActivities } from '@temporalio/workflow';
import type { DiscoveryActivities } from './discovery.activities';

const acts = proxyActivities<DiscoveryActivities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3 },
});

const MAX_BATCHES_PER_WORKSPACE = 20;
const DEFAULT_WORKSPACE_PAGES_PER_RUN = 2;
const MAX_WORKSPACE_PAGES_PER_RUN = 5;
const FAIR_PAGINATION_PATCH = 'raw-retention-fair-pagination-v1';

interface RawRetentionSweepInput {
  workspaceLimit?: number;
  batchSize?: number;
  /** Internal stable cursor carried across continue-as-new runs. */
  afterWorkspaceId?: string;
  /** Bounds one Temporal run's history; primarily configurable for deterministic tests. */
  workspacePagesPerRun?: number;
  /** Internal aggregate carried across continue-as-new runs. */
  accumulated?: {
    workspaces: number;
    expired: number;
    deferredForConflict: number;
  };
}

interface RawRetentionSweepResult {
  workspaces: number;
  expired: number;
  deferredForConflict: number;
}

/** Daily bounded Raw Source retention; no provider or network calls. */
export async function rawRetentionSweepWorkflow(input?: RawRetentionSweepInput): Promise<RawRetentionSweepResult> {
  const workspaceLimit = Math.max(1, Math.min(input?.workspaceLimit ?? 100, 500));
  const batchSize = Math.max(1, Math.min(input?.batchSize ?? 500, 500));

  // Preserve the command sequence of workflow histories started before fair
  // pagination was deployed. New executions and continue-as-new runs use the
  // cursor path below.
  if (!patched(FAIR_PAGINATION_PATCH)) {
    const { workspaceIds } = await acts.listRawRetentionWorkspaces({ limit: workspaceLimit });
    let expired = 0;
    let deferredForConflict = 0;
    const failures: string[] = [];
    for (const workspaceId of workspaceIds) {
      try {
        let workspaceDeferredForConflict = 0;
        for (let batch = 0; batch < MAX_BATCHES_PER_WORKSPACE; batch += 1) {
          const result = await acts.expireRawSourceRecords({ workspaceId, limit: batchSize });
          expired += result.expired;
          workspaceDeferredForConflict = Math.max(workspaceDeferredForConflict, result.deferredForConflict);
          if (result.expired < batchSize) break;
        }
        deferredForConflict += workspaceDeferredForConflict;
      } catch {
        failures.push(workspaceId);
      }
    }
    if (failures.length) throw new Error(`RAW_RETENTION_WORKSPACE_FAILURE:${failures.length}`);
    return { workspaces: workspaceIds.length, expired, deferredForConflict };
  }

  const workspacePagesPerRun = Math.max(
    1,
    Math.min(input?.workspacePagesPerRun ?? DEFAULT_WORKSPACE_PAGES_PER_RUN, MAX_WORKSPACE_PAGES_PER_RUN),
  );
  let cursor = input?.afterWorkspaceId;
  let workspaces = input?.accumulated?.workspaces ?? 0;
  let expired = input?.accumulated?.expired ?? 0;
  let deferredForConflict = input?.accumulated?.deferredForConflict ?? 0;
  const failures: string[] = [];

  for (let pageNumber = 0; pageNumber < workspacePagesPerRun; pageNumber += 1) {
    const page = await acts.listRawRetentionWorkspaces({
      limit: workspaceLimit,
      ...(cursor ? { afterWorkspaceId: cursor } : {}),
    });

    for (const workspaceId of page.workspaceIds) {
      workspaces += 1;
      try {
        let workspaceDeferredForConflict = 0;
        for (let batch = 0; batch < MAX_BATCHES_PER_WORKSPACE; batch += 1) {
          const result = await acts.expireRawSourceRecords({
            workspaceId,
            limit: batchSize,
          });
          expired += result.expired;
          workspaceDeferredForConflict = Math.max(workspaceDeferredForConflict, result.deferredForConflict);
          if (result.expired < batchSize) break;
        }
        deferredForConflict += workspaceDeferredForConflict;
      } catch {
        failures.push(workspaceId);
      }
    }

    if (failures.length) throw new Error(`RAW_RETENTION_WORKSPACE_FAILURE:${failures.length}`);
    if (!page.nextCursor) return { workspaces, expired, deferredForConflict };
    cursor = page.nextCursor;
  }

  return continueAsNew<typeof rawRetentionSweepWorkflow>({
    workspaceLimit,
    batchSize,
    workspacePagesPerRun,
    afterWorkspaceId: cursor,
    accumulated: { workspaces, expired, deferredForConflict },
  });
}
