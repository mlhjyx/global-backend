import type {
  ActivityExecuteInput,
  ActivityInboundCallsInterceptor,
  ActivityInterceptorsFactory,
  Next,
} from '@temporalio/worker';
import { UNDERSTANDING_TASK_QUEUE } from './understanding.constants';
import { TenantConcurrencySemaphore } from '../runtime/tenant-concurrency-semaphore';

/** Interactive onboarding / user-facing workflows (low latency priority queue). */
export const INTERACTIVE_ONBOARDING_TASK_QUEUE = 'interactive-onboarding' as const;
/** Batch discovery / background scan / cleanup workflows (bulk throughput queue). */
export const BATCH_DISCOVERY_TASK_QUEUE = 'batch-discovery' as const;

export type CustomerWorkflowQueueClass = 'interactive' | 'batch';
export type TemporalDualQueueMode = 'legacy' | 'split';

export const DEFAULT_WORKER_PER_TENANT_MAX_CONCURRENT_ACTIVITIES = 4;

export function resolveTemporalDualQueueMode(
  env: NodeJS.ProcessEnv = process.env,
): TemporalDualQueueMode {
  return env.TEMPORAL_DUAL_QUEUE_MODE?.trim().toLowerCase() === 'split'
    ? 'split'
    : 'legacy';
}

/**
 * Resolves the customer Temporal task queue for a workflow class:
 * - `TEMPORAL_DUAL_QUEUE_MODE=split`: routes interactive onboarding workflows to
 *   `interactive-onboarding` and bulk discovery/sweeps to `batch-discovery`.
 * - default (`legacy`): preserves single-queue `understanding` compatibility.
 */
export function resolveCustomerTaskQueue(
  kind: CustomerWorkflowQueueClass,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (resolveTemporalDualQueueMode(env) !== 'split') {
    return UNDERSTANDING_TASK_QUEUE;
  }
  return kind === 'interactive'
    ? INTERACTIVE_ONBOARDING_TASK_QUEUE
    : BATCH_DISCOVERY_TASK_QUEUE;
}

/**
 * Resolves the list of customer task queues a worker process should poll.
 * - `legacy` (default): `[UNDERSTANDING_TASK_QUEUE]`
 * - `split`: `[UNDERSTANDING_TASK_QUEUE, INTERACTIVE_ONBOARDING_TASK_QUEUE, BATCH_DISCOVERY_TASK_QUEUE]`
 *   (or explicit `TEMPORAL_WORKER_TASK_QUEUES` comma list when operators isolate worker pods per queue).
 */
export function resolveWorkerCustomerTaskQueues(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const explicit = env.TEMPORAL_WORKER_TASK_QUEUES?.trim();
  if (explicit) {
    const parsed = explicit
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (parsed.length > 0) {
      return Object.freeze([...new Set(parsed)]);
    }
  }
  if (resolveTemporalDualQueueMode(env) === 'split') {
    return Object.freeze([
      UNDERSTANDING_TASK_QUEUE,
      INTERACTIVE_ONBOARDING_TASK_QUEUE,
      BATCH_DISCOVERY_TASK_QUEUE,
    ]);
  }
  return Object.freeze([UNDERSTANDING_TASK_QUEUE]);
}

export function resolveWorkerPerTenantActivityConcurrency(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.WORKER_PER_TENANT_MAX_CONCURRENT_ACTIVITIES;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_WORKER_PER_TENANT_MAX_CONCURRENT_ACTIVITIES;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error('WORKER_CONCURRENCY_INVALID:WORKER_PER_TENANT_MAX_CONCURRENT_ACTIVITIES');
  }
  return value;
}

function extractWorkspaceIdFromActivityArgs(args: readonly unknown[]): string | undefined {
  const first = args[0];
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const ws = (first as Record<string, unknown>).workspaceId;
    if (typeof ws === 'string' && ws.trim().length > 0 && ws !== 'platform') {
      return ws.trim();
    }
  }
  return undefined;
}

/**
 * Temporal worker activity inbound interceptor that caps in-flight activities
 * per tenant workspace so one noisy tenant cannot monopolize all worker slots.
 */
export function createTenantConcurrencyActivityInterceptor(options?: {
  readonly maxPerTenant?: number;
  readonly acquireTimeoutMs?: number;
  readonly semaphore?: TenantConcurrencySemaphore;
}): ActivityInterceptorsFactory {
  let sharedSemaphore = options?.semaphore;
  const resolveSemaphore = (): TenantConcurrencySemaphore => {
    sharedSemaphore ??= new TenantConcurrencySemaphore({
      name: 'temporal-worker-activity',
      perTenantLimit: options?.maxPerTenant ?? resolveWorkerPerTenantActivityConcurrency(),
      acquireTimeoutMs: options?.acquireTimeoutMs ?? 300_000,
    });
    return sharedSemaphore;
  };

  return () => ({
    inbound: {
      async execute(
        input: ActivityExecuteInput,
        next: Next<ActivityInboundCallsInterceptor, 'execute'>,
      ): Promise<unknown> {
        const workspaceId = extractWorkspaceIdFromActivityArgs(input.args);
        if (!workspaceId) {
          return next(input);
        }
        return resolveSemaphore().withTenantSlot(workspaceId, () => next(input));
      },
    },
  });
}
