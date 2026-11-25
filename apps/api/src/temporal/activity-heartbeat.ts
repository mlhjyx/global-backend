import { Context } from '@temporalio/activity';
import { CancelledFailure } from '@temporalio/common';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Returns the current Temporal activity Context, or null outside a worker
 * (e.g. unit tests calling activity factory functions directly).
 */
export function currentActivityContext(): Context | null {
  try {
    return Context.current();
  } catch {
    return null;
  }
}

export function isActivityCancelledError(error: unknown): boolean {
  return (
    error instanceof CancelledFailure ||
    (error instanceof Error && error.name === 'CancelledFailure')
  );
}

/** Throws CancelledFailure immediately when the Temporal activity cancellationSignal is aborted. */
export function throwIfActivityCancelled(context: Context | null, reason = 'ACTIVITY_CANCELLED'): void {
  if (context?.cancellationSignal.aborted) {
    throw new CancelledFailure(reason);
  }
}

/**
 * Wraps a long-running Temporal activity with periodic heartbeats and explicit
 * checkpoint cancellation checks so parent workflow cancellation reaches the
 * worker promptly instead of letting child activities leak RESERVED budget rows.
 */
export async function withActivityHeartbeat<T>(
  details: Readonly<Record<string, unknown>>,
  fn: (context: Context | null, checkpoint: (step: string) => void) => Promise<T>,
  intervalMs: number = DEFAULT_HEARTBEAT_INTERVAL_MS,
): Promise<T> {
  const context = currentActivityContext();
  let lastStep = 'start';
  const checkpoint = (step: string): void => {
    lastStep = step;
    throwIfActivityCancelled(context, `DEEP_ACTIVITY_CANCELLED:${step}`);
    context?.heartbeat({ ...details, step });
  };
  checkpoint('start');
  const timer =
    context && intervalMs > 0
      ? setInterval(() => {
          if (!context.cancellationSignal.aborted) {
            context.heartbeat({ ...details, step: lastStep });
          }
        }, intervalMs)
      : null;
  timer?.unref?.();
  try {
    return await fn(context, checkpoint);
  } finally {
    if (timer) clearInterval(timer);
  }
}
