import type { RuntimeProcessLeaseService } from "./runtime-process-lease";

export interface WorkerLeaseHeartbeatHandle {
  stop(): void;
}

interface WorkerSignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

const DEFAULT_DRAIN_HEARTBEAT_TIMEOUT_MS = 5_000;

async function settlesWithin(
  operation: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([
      operation.then(
        () => true,
        () => false,
      ),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface IdempotentWorkerShutdown {
  markRunning(): void;
  shutdown(): void;
}

export function createIdempotentWorkerShutdown(
  worker: { shutdown(): void },
  onShutdownFailure?: () => void,
): IdempotentWorkerShutdown {
  let running = false;
  let requested = false;
  let invoked = false;
  const invoke = (): void => {
    if (!running || !requested || invoked) return;
    invoked = true;
    try {
      worker.shutdown();
    } catch {
      onShutdownFailure?.();
    }
  };
  return Object.freeze({
    markRunning(): void {
      running = true;
      invoke();
    },
    shutdown(): void {
      requested = true;
      invoke();
    },
  });
}

export interface WorkerProcessSignalCoordinator {
  readonly registered: Promise<void>;
  attach(input: AttachedWorkerShutdown): void;
  stop(): Promise<void>;
}

interface AttachedWorkerShutdown {
  shutdown: Pick<IdempotentWorkerShutdown, "shutdown">;
  stopHeartbeats(): void;
}

export function startWorkerProcessSignalCoordinator(input: {
  leases: Pick<RuntimeProcessLeaseService, "heartbeat">;
  taskQueue: string;
  signals?: WorkerSignalSource;
  drainTimeoutMs?: number;
  onEarlyCleanup?: () => Promise<void>;
  onEarlyExit(signal: NodeJS.Signals): void;
  onDrainLeaseFailure?: () => void;
}): WorkerProcessSignalCoordinator {
  const signals = input.signals ?? process;
  const drainTimeoutMs = Math.max(
    1,
    input.drainTimeoutMs ?? DEFAULT_DRAIN_HEARTBEAT_TIMEOUT_MS,
  );
  const handledSignals = Object.freeze<NodeJS.Signals[]>(["SIGTERM", "SIGINT"]);
  const registered = input.leases.heartbeat(
    "WORKER",
    "STARTING",
    input.taskQueue,
  );
  let attached: AttachedWorkerShutdown | undefined;
  let drainPromise: Promise<void> | undefined;
  const signalSubscriptions = new Map<NodeJS.Signals, () => void>();

  const removeSignalHandlers = (): void => {
    for (const [signal, listener] of signalSubscriptions) {
      signals.off(signal, listener);
    }
    signalSubscriptions.clear();
  };
  const drain = (signal: NodeJS.Signals): Promise<void> => {
    drainPromise ??= (async () => {
      attached?.stopHeartbeats();
      const leaseRegistered = await settlesWithin(registered, drainTimeoutMs);
      if (leaseRegistered) {
        const drainingPublished = await settlesWithin(
          input.leases.heartbeat("WORKER", "DRAINING", input.taskQueue),
          drainTimeoutMs,
        );
        if (!drainingPublished) input.onDrainLeaseFailure?.();
      }
      if (attached) {
        attached.shutdown.shutdown();
        return;
      }
      if (leaseRegistered) {
        const stoppedPublished = await settlesWithin(
          input.leases.heartbeat("WORKER", "STOPPED", input.taskQueue),
          drainTimeoutMs,
        );
        if (!stoppedPublished) input.onDrainLeaseFailure?.();
      }
      removeSignalHandlers();
      try {
        if (input.onEarlyCleanup) {
          const cleanupCompleted = await settlesWithin(
            input.onEarlyCleanup(),
            drainTimeoutMs,
          );
          if (!cleanupCompleted) input.onDrainLeaseFailure?.();
        }
      } catch {
        input.onDrainLeaseFailure?.();
      } finally {
        input.onEarlyExit(signal);
      }
    })();
    return drainPromise;
  };
  for (const signal of handledSignals) {
    const listener = (): void => {
      void drain(signal).catch(() => undefined);
    };
    signalSubscriptions.set(signal, listener);
    signals.on(signal, listener);
  }

  return Object.freeze({
    registered,
    attach(value: AttachedWorkerShutdown): void {
      attached = value;
    },
    async stop(): Promise<void> {
      removeSignalHandlers();
      await drainPromise?.catch(() => undefined);
    },
  });
}

export async function startWorkerLeaseHeartbeat(input: {
  leases: Pick<RuntimeProcessLeaseService, "heartbeat">;
  worker: { shutdown(): void };
  taskQueue: string;
  intervalMs?: number;
  onLeaseLost?: () => void;
}): Promise<WorkerLeaseHeartbeatHandle> {
  const intervalMs = input.intervalMs ?? 10_000;
  await input.leases.heartbeat("WORKER", "READY", input.taskQueue);
  let stopped = false;
  const timer = setInterval(() => {
    void input.leases
      .heartbeat("WORKER", "READY", input.taskQueue)
      .catch(async () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        input.onLeaseLost?.();
        await input.leases
          .heartbeat("WORKER", "DRAINING", input.taskQueue)
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
