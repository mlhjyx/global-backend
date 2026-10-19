import { ApplicationFailure, Context } from '@temporalio/activity';
import type { Duration } from '@temporalio/common';
import { definiteModelFailureCode } from '../model-gateway/definite-model-failure';

/**
 * How long the next attempt of a discovery model activity waits after the model upstream was
 * unavailable. Without it the proxies' default backoff (1 s, then 2 s) spends all three attempts
 * within seconds: run 097593b7 (xin, 2026-10-19) failed that way while openox answered 521/523
 * for 28 minutes. 5 minutes, then 25, rides out about half an hour of outage with the same three
 * attempts the ledger allows one operation key (D13), well inside the 3-hour discovery admission
 * lease. A longer outage still fails the run at the stage it reached (#653).
 */
export function upstreamUnavailableRetryDelay(attempt: number): Duration {
  return attempt <= 1 ? '5 minutes' : '25 minutes';
}

/**
 * The failure an Activity rethrows for `error`. Only a definite model failure before any output
 * (HTTP 429 or 5xx other than the 504/524 timeouts, or a connection that was never established)
 * waits before the next attempt: the router has already released that call's reservation, so the
 * wait spends nothing. Every other error is returned unchanged.
 */
export function withUpstreamUnavailableRetryDelay(error: unknown, attempt?: number): unknown {
  if (definiteModelFailureCode(error) === undefined) return error;
  return ApplicationFailure.fromError(error, {
    nextRetryDelay: upstreamUnavailableRetryDelay(attempt ?? currentActivityAttempt()),
  });
}

function currentActivityAttempt(): number {
  try {
    return Context.current().info.attempt;
  } catch {
    // Outside an Activity (unit tests) there is no attempt: count it as the first.
    return 1;
  }
}
