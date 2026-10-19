import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApplicationFailure, Context } from '@temporalio/activity';
import {
  ActivityFailure,
  DefaultFailureConverter,
  defaultPayloadConverter,
  ensureApplicationFailure,
} from '@temporalio/common';
import { temporal } from '@temporalio/proto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { failureConverter } from './diagnostic-failure-converter';
import { describeDiscoveryRunFailure } from './discovery.run-failure';
import { ExecutionControlError } from '../execution-budget/execution-control-error';
import { BudgetOperationReplayError } from '../tools/budget-store';
import {
  ProviderHttpError,
  ProviderTransportError,
} from '../model-gateway/providers/provider-output-error';
import {
  discoveryActivityMaximumAttempts,
  timeoutMilliseconds,
} from './testing/discovery-activity-timeouts';
import {
  upstreamUnavailableRetryDelay,
  withUpstreamUnavailableRetryDelay,
} from './upstream-unavailable-retry';

const http = (status: number) =>
  new ProviderHttpError({ status, provider: 'gateway', model: 'deepseek-v4-pro' });
const notConnected = () =>
  new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
const FIRST_OF_THREE = { attempt: 1, maximumAttempts: 3 };

// Discovery run admission lease (ADR-024, 2026-10-09): admission + 3 hours.
const DISCOVERY_ADMISSION_LEASE_MS = 3 * 60 * 60_000;

describe('withUpstreamUnavailableRetryDelay', () => {
  // Run 097593b7 (xin, 2026-10-19 12:03 UTC): openox answered 521, then 523, for about 28
  // minutes. The query activity's three attempts used the default 1 s / 2 s backoff, all
  // fell inside 6 seconds, and the run failed with 45 accepted records never materialized.
  it.each([
    ['HTTP 429', http(429)],
    ['HTTP 500', http(500)],
    ['HTTP 502', http(502)],
    ['HTTP 503', http(503)],
    ['HTTP 521', http(521)],
    ['HTTP 523', http(523)],
    ['a connection that was never established', notConnected()],
  ])('turns %s into a retryable failure that waits before the next attempt', (_label, error) => {
    const failure = withUpstreamUnavailableRetryDelay(error, FIRST_OF_THREE);

    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure).toMatchObject({
      type: error.name,
      message: error.message,
      nonRetryable: false,
      nextRetryDelay: '5 minutes',
    });
  });

  it('waits 25 minutes before the last retry and 5 minutes before any earlier one', () => {
    expect(upstreamUnavailableRetryDelay(1, 3)).toBe('5 minutes');
    expect(upstreamUnavailableRetryDelay(2, 3)).toBe('25 minutes');
    // A two-attempt activity (the website profile) has only the last retry.
    expect(upstreamUnavailableRetryDelay(1, 2)).toBe('25 minutes');
    expect(
      withUpstreamUnavailableRetryDelay(http(521), { attempt: 2, maximumAttempts: 3 }),
    ).toMatchObject({ nextRetryDelay: '25 minutes' });
  });

  it.each([
    // Timeouts: the upstream may have generated and billed the answer (D13).
    ['HTTP 504', http(504)],
    ['HTTP 524', http(524)],
    ['HTTP 400', http(400)],
    ['HTTP 401', http(401)],
    ['a cut stream', new ProviderTransportError('CHAT_COMPLETIONS_STREAM_TRUNCATED', { inputTokens: 520 })],
    ['a revoked authority', new ExecutionControlError('EXECUTION_BUDGET_AUTHORITY_REVOKED')],
    ['an operation that cannot be replayed', new BudgetOperationReplayError('op-1')],
    ['an ordinary error', new Error('boom')],
  ])('returns %s unchanged', (_label, error) => {
    expect(withUpstreamUnavailableRetryDelay(error, FIRST_OF_THREE)).toBe(error);
  });

  it('leaves the original error untouched', () => {
    const error = http(521);
    const before = { ...error, message: error.message, name: error.name };

    withUpstreamUnavailableRetryDelay(error, FIRST_OF_THREE);

    expect(error).not.toBeInstanceOf(ApplicationFailure);
    expect({ ...error, message: error.message, name: error.name }).toEqual(before);
  });

  it('counts a call outside an Activity as the first of three attempts', () => {
    expect(withUpstreamUnavailableRetryDelay(http(503))).toMatchObject({ nextRetryDelay: '5 minutes' });
  });
});

describe('withUpstreamUnavailableRetryDelay inside an Activity', () => {
  const inActivity = (info: { attempt: number; retryPolicy?: { maximumAttempts?: number } }) =>
    vi.spyOn(Context, 'current').mockReturnValue({ info } as unknown as Context);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['the first of three attempts', { attempt: 1, retryPolicy: { maximumAttempts: 3 } }, '5 minutes'],
    ['the second of three attempts', { attempt: 2, retryPolicy: { maximumAttempts: 3 } }, '25 minutes'],
    ['the first of two attempts (the website profile)', { attempt: 1, retryPolicy: { maximumAttempts: 2 } }, '25 minutes'],
    // More attempts than the ledger allows one key are capped at its three.
    ['the second of five attempts', { attempt: 2, retryPolicy: { maximumAttempts: 5 } }, '25 minutes'],
    // No maximum (unlimited, or not reported by the server): the ledger caps it at three.
    ['the first attempt of an unlimited policy', { attempt: 1, retryPolicy: { maximumAttempts: 0 } }, '5 minutes'],
    ['the second attempt with no policy reported', { attempt: 2 }, '25 minutes'],
  ])('reads the attempt and the retry policy of %s', (_label, info, delay) => {
    inActivity(info);

    expect(withUpstreamUnavailableRetryDelay(http(503))).toMatchObject({ nextRetryDelay: delay });
  });
});

describe('upstream-unavailable failure on the wire', () => {
  const wire = (error: unknown) =>
    temporal.api.failure.v1.Failure.decode(
      temporal.api.failure.v1.Failure.encode(failureConverter.errorToFailure(error, defaultPayloadConverter)).finish(),
    );
  const withoutDelay = (failure: ReturnType<typeof wire>) => {
    const json = failure.toJSON() as { applicationFailureInfo?: Record<string, unknown> };
    return { ...json, applicationFailureInfo: { ...json.applicationFailureInfo, nextRetryDelay: undefined } };
  };

  it('keeps the wait through the repository failure converter and changes nothing else', () => {
    // The server only waits if nextRetryDelay survives the worker's failure converter.
    const error = http(521);

    const delayed = wire(withUpstreamUnavailableRetryDelay(error, FIRST_OF_THREE));
    const plain = wire(ensureApplicationFailure(error));

    expect(Number(delayed.applicationFailureInfo?.nextRetryDelay?.seconds)).toBe(300);
    expect(plain.applicationFailureInfo?.nextRetryDelay).toBeFalsy();
    expect(withoutDelay(delayed)).toEqual(withoutDelay(plain));
  });

  it('still reads as the same query-stage run failure once the attempts are used up', () => {
    const decoded = new DefaultFailureConverter().failureToError(
      wire(withUpstreamUnavailableRetryDelay(http(521), { attempt: 3, maximumAttempts: 3 })),
      defaultPayloadConverter,
    );
    const exhausted = new ActivityFailure(
      'Activity task failed',
      'executeQuery',
      '11',
      'MAXIMUM_ATTEMPTS_REACHED',
      'worker',
      decoded,
    );

    expect(describeDiscoveryRunFailure('query', exhausted)).toEqual({
      stage: 'query',
      errorType: 'ProviderHttpError',
      control: false,
    });
  });
});

describe('upstream-unavailable retry window', () => {
  // The ledger lets one operation key reserve again after a definite failure, at most this many
  // times in all (D13); an Activity attempt beyond it would meet a replay, not a fresh call.
  const { resultDisposition } = JSON.parse(
    readFileSync(join(import.meta.dirname, '../../../../docs/governance/durable-result-strategies.json'), 'utf8'),
  ) as { resultDisposition: { maxReservationAttempts: number } };

  const totalWait = (attempts: number) =>
    Array.from({ length: attempts - 1 }, (_, index) =>
      timeoutMilliseconds(upstreamUnavailableRetryDelay(index + 1, attempts) as string),
    ).reduce((sum, wait) => sum + wait, 0);

  it('retries the waiting activities no more often than the ledger re-reserves one operation key', () => {
    const attempts = discoveryActivityMaximumAttempts();
    const cap = resultDisposition.maxReservationAttempts;
    expect(attempts.get('executeQuery')).toEqual([cap]);
    expect(attempts.get('qualifyFitForRun')).toEqual([cap]);
    expect(attempts.get('profileWebsitesForRun')![0]!).toBeLessThanOrEqual(cap);
  });

  it('rides out about half an hour in query and fit, 25 minutes in the website profile, well inside the admission lease', () => {
    const attempts = discoveryActivityMaximumAttempts();
    expect(totalWait(attempts.get('executeQuery')![0]!)).toBe(30 * 60_000);
    expect(totalWait(attempts.get('qualifyFitForRun')![0]!)).toBe(30 * 60_000);
    expect(totalWait(attempts.get('profileWebsitesForRun')![0]!)).toBe(25 * 60_000);
    // Profile then fit, both waiting in full, still leave most of the lease for the run.
    expect(
      totalWait(attempts.get('profileWebsitesForRun')![0]!) + totalWait(attempts.get('qualifyFitForRun')![0]!),
    ).toBeLessThan(DISCOVERY_ADMISSION_LEASE_MS / 3);
  });
});
