/**
 * Task-queue topology for newly started workflows.
 *
 * `understanding` is retained as a drain-only legacy queue so executions that
 * were already scheduled before this split are never force-migrated. All new
 * starts must use `taskQueueForWorkflow`; unknown workflow types fail closed.
 */
export const LEGACY_TASK_QUEUE = 'understanding';
export const ACQUISITION_TASK_QUEUE = 'acquisition';
export const SITE_BUILDER_TASK_QUEUE = 'site-builder';
export const MAINTENANCE_TASK_QUEUE = 'maintenance';

export type WorkerDomain = 'legacy' | 'acquisition' | 'site-builder' | 'maintenance';

export interface WorkerDomainContract {
  domain: WorkerDomain;
  taskQueue: string;
  concurrencyEnv: string;
  defaultConcurrency: number;
}

export const WORKER_DOMAINS: readonly WorkerDomainContract[] = Object.freeze([
  {
    domain: 'legacy',
    taskQueue: LEGACY_TASK_QUEUE,
    concurrencyEnv: 'LEGACY_WORKER_CONCURRENCY',
    defaultConcurrency: 2,
  },
  {
    domain: 'acquisition',
    taskQueue: ACQUISITION_TASK_QUEUE,
    concurrencyEnv: 'ACQUISITION_WORKER_CONCURRENCY',
    defaultConcurrency: 8,
  },
  {
    domain: 'site-builder',
    taskQueue: SITE_BUILDER_TASK_QUEUE,
    concurrencyEnv: 'SITE_BUILDER_WORKER_CONCURRENCY',
    defaultConcurrency: 4,
  },
  {
    domain: 'maintenance',
    taskQueue: MAINTENANCE_TASK_QUEUE,
    concurrencyEnv: 'MAINTENANCE_WORKER_CONCURRENCY',
    defaultConcurrency: 2,
  },
]);

const WORKFLOW_TASK_QUEUES = new Map<string, string>([
  ['understandingWorkflow', ACQUISITION_TASK_QUEUE],
  ['discoveryWorkflow', ACQUISITION_TASK_QUEUE],
  ['qualifyWorkflow', ACQUISITION_TASK_QUEUE],
  ['acquisitionSweepWorkflow', ACQUISITION_TASK_QUEUE],
  ['intentSweepWorkflow', ACQUISITION_TASK_QUEUE],
  ['backlogSweepWorkflow', ACQUISITION_TASK_QUEUE],
  ['externalIntentSweepWorkflow', ACQUISITION_TASK_QUEUE],
  ['demoV0Workflow', SITE_BUILDER_TASK_QUEUE],
  ['refurbishWorkflow', SITE_BUILDER_TASK_QUEUE],
  ['kbIngestWorkflow', SITE_BUILDER_TASK_QUEUE],
  ['kbRecoverySweepWorkflow', SITE_BUILDER_TASK_QUEUE],
  ['deletionWorkflow', MAINTENANCE_TASK_QUEUE],
  ['patentsCacheRefreshWorkflow', MAINTENANCE_TASK_QUEUE],
  ['sanctionsRefreshWorkflow', MAINTENANCE_TASK_QUEUE],
  ['assetObjectCleanupWorkflow', MAINTENANCE_TASK_QUEUE],
  ['siteReleaseMaintenanceSweepWorkflow', MAINTENANCE_TASK_QUEUE],
]);

export function taskQueueForWorkflow(workflowType: string): string {
  const taskQueue = WORKFLOW_TASK_QUEUES.get(workflowType);
  if (!taskQueue) {
    throw new Error(`UNREGISTERED_WORKFLOW_TASK_QUEUE:${workflowType}`);
  }
  return taskQueue;
}

export function parseWorkerConcurrency(
  raw: string | undefined,
  name: string,
  fallback: number,
): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (
    (raw !== undefined && raw !== String(value)) ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 64
  ) {
    throw new Error(`INVALID_WORKER_CONCURRENCY:${name}`);
  }
  return value;
}

export function parseBoundedIntervalMs(
  raw: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (
    (raw !== undefined && raw !== String(value)) ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`INVALID_WORKER_INTERVAL:${name}`);
  }
  return value;
}

export interface WorkerLifecycle {
  run(): Promise<void>;
  shutdown(): void;
}

/**
 * Run every queue poller as one failure domain. A fatal exit from any poller
 * first asks every peer to stop, then drains their run promises before the
 * original failure is rethrown. This prevents a partially alive worker process.
 */
export async function runWorkerFleet(
  workers: readonly WorkerLifecycle[],
): Promise<void> {
  const runs = workers.map((worker) => Promise.resolve().then(() => worker.run()));
  let runFailure: unknown;
  try {
    await Promise.all(runs);
  } catch (error) {
    runFailure = error;
  }

  const shutdowns = workers.map((worker) =>
    Promise.resolve().then(() => worker.shutdown()),
  );
  const shutdownResults = await Promise.allSettled(shutdowns);
  await Promise.allSettled(runs);

  if (runFailure !== undefined) throw runFailure;
  const shutdownFailure = shutdownResults.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (shutdownFailure) throw shutdownFailure.reason;
}

export interface ResolvedWorkerDomain extends WorkerDomainContract {
  activityConcurrency: number;
  workflowConcurrency: number;
}

export function resolveWorkerDomains(
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly ResolvedWorkerDomain[] {
  return WORKER_DOMAINS.map((domain) => {
    const concurrency = parseWorkerConcurrency(
      env[domain.concurrencyEnv],
      domain.concurrencyEnv,
      domain.defaultConcurrency,
    );
    return {
      ...domain,
      activityConcurrency: concurrency,
      workflowConcurrency: concurrency,
    };
  });
}
