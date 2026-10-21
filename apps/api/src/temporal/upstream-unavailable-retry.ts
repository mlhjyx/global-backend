import { ApplicationFailure, Context } from '@temporalio/activity';
import type { Duration } from '@temporalio/common';
import { definiteModelFailureCode } from '../model-gateway/definite-model-failure';

/** The ledger re-reserves one operation key at most this many times in all (D13). */
const LEDGER_MAX_RESERVATION_ATTEMPTS = 3;

const RETRY_DELAY_MS = Object.freeze({ '5 minutes': 5 * 60_000, '25 minutes': 25 * 60_000 });

/**
 * How long the next attempt of a discovery model activity waits after the model upstream was
 * unavailable. Without it the proxies' default backoff (1 s, then 2 s) spends every attempt within
 * seconds: run 097593b7 (xin, 2026-10-19) failed that way while openox answered 521/523 for 28
 * minutes. The last retry waits 25 minutes and any earlier one 5, so the three-attempt query and
 * fit activities ride out about half an hour (5 + 25) and the two-attempt website profile 25
 * minutes, with no more attempts than the ledger allows one operation key and well inside the
 * 3-hour discovery admission lease. A longer outage still stops the run where it was (#653).
 */
export function upstreamUnavailableRetryDelay(
  attempt: number,
  maximumAttempts: number,
): keyof typeof RETRY_DELAY_MS & Duration {
  return attempt >= maximumAttempts - 1 ? '25 minutes' : '5 minutes';
}

/**
 * How long the attempt after `error` waits under withUpstreamUnavailableRetryDelay, in
 * milliseconds; undefined when `error` makes no wait or no attempt follows. A discovery stage that
 * stops for its admission lease asks whether this wait still fits (discovery-run-lease.ts).
 */
export function upstreamUnavailableRetryDelayMs(
  error: unknown,
  activityAttempt: ActivityAttempt = currentActivityAttempt(),
): number | undefined {
  if (definiteModelFailureCode(error) === undefined) return undefined;
  if (activityAttempt.attempt >= activityAttempt.maximumAttempts) return undefined;
  return RETRY_DELAY_MS[upstreamUnavailableRetryDelay(activityAttempt.attempt, activityAttempt.maximumAttempts)];
}

/** The attempt that failed and how many the activity's retry policy allows. */
export interface ActivityAttempt {
  attempt: number;
  maximumAttempts: number;
}

/**
 * The failure an Activity rethrows for `error`. Only a definite model failure before any output
 * (HTTP 429 or 5xx other than the 504/524 timeouts, or a connection that was never established)
 * waits before the next attempt: the router has already released that call's reservation, so the
 * wait spends nothing. Every other error is returned unchanged.
 */
export function withUpstreamUnavailableRetryDelay(
  error: unknown,
  activityAttempt: ActivityAttempt = currentActivityAttempt(),
): unknown {
  if (definiteModelFailureCode(error) === undefined) return error;
  return ApplicationFailure.fromError(error, {
    nextRetryDelay: upstreamUnavailableRetryDelay(activityAttempt.attempt, activityAttempt.maximumAttempts),
  });
}

function currentActivityAttempt(): ActivityAttempt {
  let info: { attempt: number; retryPolicy?: { maximumAttempts?: number } };
  try {
    info = Context.current().info;
  } catch {
    // Outside an Activity (unit tests) there is no attempt: count it as the first of the most
    // the ledger allows.
    return { attempt: 1, maximumAttempts: LEDGER_MAX_RESERVATION_ATTEMPTS };
  }
  // A policy without a positive maximum (unlimited, or not reported by an old server) is capped by
  // the ledger anyway.
  const maximumAttempts = info.retryPolicy?.maximumAttempts;
  return {
    attempt: info.attempt,
    maximumAttempts:
      maximumAttempts && maximumAttempts > 0
        ? Math.min(maximumAttempts, LEDGER_MAX_RESERVATION_ATTEMPTS)
        : LEDGER_MAX_RESERVATION_ATTEMPTS,
  };
}
