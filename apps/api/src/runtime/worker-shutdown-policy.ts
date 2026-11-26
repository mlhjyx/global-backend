/**
 * Bounded shutdown for the managed workers.
 *
 * A drained worker must stop polling and then actually go away: the Temporal
 * Worker instance is single-use, and only a fresh process re-enters the
 * startup admission gates. 2026-11-05: a drained platform-worker wrote
 * STOPPED to its lease and then kept running for an hour without polling —
 * the container was never restarted and platform work stopped until an
 * operator recreated it by hand.
 */
export const WORKER_SHUTDOWN_GRACE = '30s' as const;
const WORKER_SHUTDOWN_FORCE_SECONDS = 60;
export const WORKER_SHUTDOWN_FORCE = `${WORKER_SHUTDOWN_FORCE_SECONDS}s` as const;

/** Passed to every managed Worker.create so both workers share one bound. */
export const WORKER_SHUTDOWN_OPTIONS = Object.freeze({
  shutdownGraceTime: WORKER_SHUTDOWN_GRACE,
  shutdownForceTime: WORKER_SHUTDOWN_FORCE,
});

/** How long shutdown cleanup may take before the process exits on its own. */
export const WORKER_EXIT_DEADLINE_MS = 15_000;
/** How long a worker may stay in startup not-ready hold before exiting non-zero for container restart. */
export const WORKER_NOT_READY_MAX_HOLD_MS = 5 * 60_000;

export interface WorkerExitDeadlineHandle {
  clear(): void;
}

/**
 * Arm a single forced exit for the shutdown path. The timer is unref'd so a
 * clean process exit is never delayed; it only fires when something else is
 * still holding the event loop after the worker has stopped polling.
 */
export function armWorkerExitDeadline(
  deadlineMs: number = WORKER_EXIT_DEADLINE_MS,
  exit: (code: number) => void = (code) => process.exit(code),
  exitCode = 0,
): WorkerExitDeadlineHandle {
  const timer = setTimeout(() => exit(exitCode), deadlineMs);
  timer.unref?.();
  let cleared = false;
  return Object.freeze({
    clear(): void {
      if (cleared) return;
      cleared = true;
      clearTimeout(timer);
    },
  });
}

export function armWorkerLeaseLossDeadline(exit?: (code: number) => void): WorkerExitDeadlineHandle {
  // Leave Temporal's full drain window plus time for the completed drain callback.
  return armWorkerExitDeadline((WORKER_SHUTDOWN_FORCE_SECONDS + 5) * 1_000, exit, 1);
}

export function holdWorkerNotReadyBounded(input: {
  code: string;
  logIntervalMs?: number;
  maxHoldMs?: number;
  onTick?: () => void;
  exit?: (code: number) => void;
}): Promise<never> {
  const logIntervalMs = input.logIntervalMs ?? 30_000;
  const maxHoldMs = Math.max(1, input.maxHoldMs ?? WORKER_NOT_READY_MAX_HOLD_MS);
  const exit = input.exit ?? ((code) => process.exit(code));
  console.error(
    `[worker] not ready: ${input.code}; Temporal polling remains disabled`,
  );
  return new Promise<never>(() => {
    const interval = setInterval(() => {
      console.error(`[worker] still not ready: ${input.code}`);
      input.onTick?.();
    }, logIntervalMs);
    const deadline = setTimeout(() => {
      clearInterval(interval);
      console.error(
        `[worker] readiness hold expired (${maxHoldMs}ms) for ${input.code}; exiting non-zero`,
      );
      exit(1);
    }, maxHoldMs);
    deadline.unref?.();
  });
}
