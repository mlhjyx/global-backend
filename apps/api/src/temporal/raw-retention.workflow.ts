import { continueAsNew, patched, proxyActivities } from "@temporalio/workflow";
import type { RawSourceActivities } from "./raw-source.activities";

const activities = proxyActivities<RawSourceActivities>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 3 },
});
const PAGINATION_PATCH = "raw-retention-fair-pagination-v2";
const TRUTHFUL_LOCK_PATCH = "raw-retention-truthful-lock-conflicts-v3";
const MAX_BATCHES_PER_WORKSPACE = 20;
const DEFAULT_PAGES_PER_RUN = 2;
const MAX_PAGES_PER_RUN = 5;

export interface RawRetentionSweepInput {
  workspaceLimit?: number;
  batchSize?: number;
  afterWorkspaceId?: string;
  workspacePagesPerRun?: number;
  accumulated?: RawRetentionSweepResult;
}

export interface RawRetentionSweepResult {
  workspaces: number;
  expired: number;
  deferredForConflict: number;
}

async function expireWorkspace(
  workspaceId: string,
  batchSize: number,
  truthfulLocks: boolean,
): Promise<{ expired: number; deferredForConflict: number }> {
  let expired = 0;
  let deferredForConflict = 0;
  let complete = false;
  for (let batch = 0; batch < MAX_BATCHES_PER_WORKSPACE; batch += 1) {
    const result = await activities.expireRawSourceRecords({
      workspaceId,
      limit: batchSize,
    });
    expired += result.expired;
    deferredForConflict = Math.max(
      deferredForConflict,
      result.deferredForConflict,
    );
    const completeBatch = truthfulLocks
      ? !(
          result.hasMore ??
          (result.deferredForConflict > 0 || result.expired >= batchSize)
        ) && result.deferredForConflict === 0
      : result.expired < batchSize;
    if (completeBatch) {
      complete = true;
      break;
    }
  }
  if (!complete) throw new Error("RAW_RETENTION_WORKSPACE_INCOMPLETE");
  return { expired, deferredForConflict };
}

async function processPage(
  workspaceIds: readonly string[],
  batchSize: number,
  aggregate: RawRetentionSweepResult,
  truthfulLocks: boolean,
): Promise<{ aggregate: RawRetentionSweepResult; failures: number }> {
  let current = { ...aggregate };
  let failures = 0;
  for (const workspaceId of workspaceIds) {
    current = { ...current, workspaces: current.workspaces + 1 };
    try {
      const result = await expireWorkspace(
        workspaceId,
        batchSize,
        truthfulLocks,
      );
      current = {
        ...current,
        expired: current.expired + result.expired,
        deferredForConflict:
          current.deferredForConflict + result.deferredForConflict,
      };
    } catch {
      failures += 1;
    }
  }
  return { aggregate: current, failures };
}

/** Deterministic orchestration only; all database work stays in activities. */
export async function rawRetentionSweepWorkflow(
  input: RawRetentionSweepInput = {},
): Promise<RawRetentionSweepResult> {
  const workspaceLimit = Math.max(
    1,
    Math.min(input.workspaceLimit ?? 100, 500),
  );
  const batchSize = Math.max(1, Math.min(input.batchSize ?? 500, 500));
  const usesPagination = patched(PAGINATION_PATCH);
  const truthfulLocks = patched(TRUTHFUL_LOCK_PATCH);

  if (!usesPagination) {
    const page = await activities.listRawRetentionWorkspaces({
      limit: workspaceLimit,
    });
    const result = await processPage(
      page.workspaceIds,
      batchSize,
      {
        workspaces: 0,
        expired: 0,
        deferredForConflict: 0,
      },
      truthfulLocks,
    );
    if (result.failures) {
      throw new Error(`RAW_RETENTION_WORKSPACE_FAILURE:${result.failures}`);
    }
    return result.aggregate;
  }

  const pagesPerRun = Math.max(
    1,
    Math.min(
      input.workspacePagesPerRun ?? DEFAULT_PAGES_PER_RUN,
      MAX_PAGES_PER_RUN,
    ),
  );
  let cursor = input.afterWorkspaceId;
  let aggregate = input.accumulated ?? {
    workspaces: 0,
    expired: 0,
    deferredForConflict: 0,
  };
  for (let pageNumber = 0; pageNumber < pagesPerRun; pageNumber += 1) {
    const page = await activities.listRawRetentionWorkspaces({
      limit: workspaceLimit,
      ...(cursor ? { afterWorkspaceId: cursor } : {}),
    });
    const result = await processPage(
      page.workspaceIds,
      batchSize,
      aggregate,
      truthfulLocks,
    );
    aggregate = result.aggregate;
    if (result.failures) {
      throw new Error(`RAW_RETENTION_WORKSPACE_FAILURE:${result.failures}`);
    }
    if (!page.nextCursor) return aggregate;
    cursor = page.nextCursor;
  }
  return continueAsNew<typeof rawRetentionSweepWorkflow>({
    workspaceLimit,
    batchSize,
    workspacePagesPerRun: pagesPerRun,
    afterWorkspaceId: cursor,
    accumulated: aggregate,
  });
}
