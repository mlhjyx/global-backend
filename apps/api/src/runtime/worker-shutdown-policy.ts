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
export const WORKER_SHUTDOWN_FORCE = '60s' as const;

/** Passed to every managed Worker.create so both workers share one bound. */
export const WORKER_SHUTDOWN_OPTIONS = Object.freeze({
  shutdownGraceTime: WORKER_SHUTDOWN_GRACE,
  shutdownForceTime: WORKER_SHUTDOWN_FORCE,
});

/** How long shutdown cleanup may take before the process exits on its own. */
export const WORKER_EXIT_DEADLINE_MS = 15_000;

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
): WorkerExitDeadlineHandle {
  const timer = setTimeout(() => exit(0), deadlineMs);
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
