import type { RuntimeProcessLeaseService } from './runtime-process-lease';

export interface WorkerLeaseHeartbeatHandle {
  stop(): void;
}

export async function startWorkerLeaseHeartbeat(input: {
  leases: Pick<RuntimeProcessLeaseService, 'heartbeat'>;
  worker: { shutdown(): void };
  taskQueue: string;
  intervalMs?: number;
  onLeaseLost?: () => void;
}): Promise<WorkerLeaseHeartbeatHandle> {
  const intervalMs = input.intervalMs ?? 10_000;
  await input.leases.heartbeat('WORKER', 'READY', input.taskQueue);
  let stopped = false;
  const timer = setInterval(() => {
    void input.leases
      .heartbeat('WORKER', 'READY', input.taskQueue)
      .catch(async () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        input.onLeaseLost?.();
        await input.leases
          .heartbeat('WORKER', 'DRAINING', input.taskQueue)
          .catch(() => undefined);
        input.worker.shutdown();
      });
  }, intervalMs);
  timer.unref();
  return Object.freeze({
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  });
}
