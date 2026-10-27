import type { RuntimeProcessLeaseService } from "./runtime-process-lease";
import type { RuntimeComponentStatus } from "./runtime-readiness-registry";

export interface WorkerDependencyHeartbeatHandle {
  readonly admitted: boolean;
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 10_000;
/**
 * A single failed probe drains the worker for good: nothing polls again until the
 * container is recreated, and an activity killed in that window can leave a budget
 * operation without a durable result, which fails the whole run on retry
 * (2026-10-27, run 659f2320). One two-second timeout under load must therefore not
 * count as "the dependency is gone": only this many consecutive failures do, and
 * any recovery resets the count.
 */
const DEFAULT_FAILURES_BEFORE_DRAIN = 3;
/** Startup probes retry at this spacing before refusing admission. */
const DEFAULT_STARTUP_RETRY_DELAY_MS = 1_000;

export async function startWorkerDependencyHeartbeat(input: {
  role?: "WORKER" | "PLATFORM_WORKER";
  check: () => Promise<RuntimeComponentStatus>;
  leases: Pick<RuntimeProcessLeaseService, "heartbeat">;
  worker: { shutdown(): void };
  taskQueue: string;
  intervalMs?: number;
  failuresBeforeDrain?: number;
  startupRetryDelayMs?: number;
  onBlocked: (code: string) => void;
}): Promise<WorkerDependencyHeartbeatHandle> {
  const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
  const failuresBeforeDrain =
    input.failuresBeforeDrain ?? DEFAULT_FAILURES_BEFORE_DRAIN;
  const startupRetryDelayMs =
    input.startupRetryDelayMs ?? DEFAULT_STARTUP_RETRY_DELAY_MS;
  let stopped = false;
  let consecutiveFailures = 0;
  const timer = { current: undefined as NodeJS.Timeout | undefined };

  const probe = async (): Promise<RuntimeComponentStatus> => {
    try {
      return await input.check();
    } catch {
      return { status: "failed", code: "WORKER_DEPENDENCY_UNAVAILABLE" };
    }
  };

  const drain = async (code: string): Promise<void> => {
    stopped = true;
    if (timer.current) clearInterval(timer.current);
    input.onBlocked(code);
    await input.leases
      .heartbeat(input.role ?? "WORKER", "DRAINING", input.taskQueue)
      .catch(() => undefined);
    input.worker.shutdown();
  };

  for (let attempt = 1; ; attempt += 1) {
    const result = await probe();
    if (result.status === "ok") {
      consecutiveFailures = 0;
      break;
    }
    consecutiveFailures += 1;
    if (attempt >= failuresBeforeDrain) {
      await drain(result.code);
      return Object.freeze({ admitted: false, stop: () => undefined });
    }
    await new Promise((resolve) => setTimeout(resolve, startupRetryDelayMs));
  }

  timer.current = setInterval(() => {
    void (async () => {
      if (stopped) return;
      const result = await probe();
      if (result.status === "ok") {
        consecutiveFailures = 0;
        return;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures < failuresBeforeDrain || stopped) return;
      await drain(result.code);
    })();
  }, intervalMs);
  timer.current.unref();
  return Object.freeze({
    admitted: true,
    stop(): void {
      stopped = true;
      if (timer.current) clearInterval(timer.current);
    },
  });
}
