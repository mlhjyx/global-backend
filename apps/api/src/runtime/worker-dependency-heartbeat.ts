import type { RuntimeProcessLeaseService } from './runtime-process-lease';
import type { RuntimeComponentStatus } from './runtime-readiness-registry';

export interface WorkerDependencyHeartbeatHandle {
  readonly admitted: boolean;
  stop(): void;
}

export async function startWorkerDependencyHeartbeat(input: {
  check: () => Promise<RuntimeComponentStatus>;
  leases: Pick<RuntimeProcessLeaseService, 'heartbeat'>;
  worker: { shutdown(): void };
  taskQueue: string;
  intervalMs?: number;
  onBlocked: (code: string) => void;
}): Promise<WorkerDependencyHeartbeatHandle> {
  const intervalMs = input.intervalMs ?? 10_000;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const checkOnce = async (): Promise<boolean> => {
    let result: RuntimeComponentStatus;
    try {
      result = await input.check();
    } catch {
      result = { status: 'failed', code: 'WORKER_DEPENDENCY_UNAVAILABLE' };
    }
    if (result.status === 'ok') return true;
    if (stopped) return false;
    stopped = true;
    if (timer) clearInterval(timer);
    input.onBlocked(result.code);
    await input.leases.heartbeat('WORKER', 'DRAINING', input.taskQueue).catch(() => undefined);
    input.worker.shutdown();
    return false;
  };

  if (!(await checkOnce())) return Object.freeze({ admitted: false, stop: () => undefined });
  timer = setInterval(() => void checkOnce(), intervalMs);
  timer.unref();
  return Object.freeze({
    admitted: true,
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  });
}
