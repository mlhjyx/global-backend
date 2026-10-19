import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApplicationFailure } from '@temporalio/activity';
import {
  ActivityFailure,
  DefaultFailureConverter,
  defaultPayloadConverter,
  ensureApplicationFailure,
} from '@temporalio/common';
import { temporal } from '@temporalio/proto';
import { describe, expect, it } from 'vitest';
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
    const failure = withUpstreamUnavailableRetryDelay(error, 1);

    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure).toMatchObject({
      type: error.name,
      message: error.message,
      nonRetryable: false,
      nextRetryDelay: upstreamUnavailableRetryDelay(1),
    });
  });

  it('waits 5 minutes after the first attempt and 25 minutes after the second', () => {
    expect(upstreamUnavailableRetryDelay(1)).toBe('5 minutes');
    expect(upstreamUnavailableRetryDelay(2)).toBe('25 minutes');
    expect(withUpstreamUnavailableRetryDelay(http(521), 2)).toMatchObject({ nextRetryDelay: '25 minutes' });
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
    expect(withUpstreamUnavailableRetryDelay(error, 1)).toBe(error);
  });

  it('leaves the original error untouched', () => {
    const error = http(521);
    const before = { ...error, message: error.message, name: error.name };

    withUpstreamUnavailableRetryDelay(error, 1);

    expect(error).not.toBeInstanceOf(ApplicationFailure);
    expect({ ...error, message: error.message, name: error.name }).toEqual(before);
  });

  it('counts a call outside an Activity as the first attempt', () => {
    expect(withUpstreamUnavailableRetryDelay(http(503))).toMatchObject({ nextRetryDelay: '5 minutes' });
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

    const delayed = wire(withUpstreamUnavailableRetryDelay(error, 1));
    const plain = wire(ensureApplicationFailure(error));

    expect(Number(delayed.applicationFailureInfo?.nextRetryDelay?.seconds)).toBe(300);
    expect(plain.applicationFailureInfo?.nextRetryDelay).toBeFalsy();
    expect(withoutDelay(delayed)).toEqual(withoutDelay(plain));
  });

  it('still reads as the same query-stage run failure once the attempts are used up', () => {
    const decoded = new DefaultFailureConverter().failureToError(
      wire(withUpstreamUnavailableRetryDelay(http(521), 3)),
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

  it('retries query execution and the fit pass no more often than the ledger re-reserves one operation key', () => {
    const attempts = discoveryActivityMaximumAttempts();
    const cap = resultDisposition.maxReservationAttempts;
    expect(attempts.get('executeQuery')).toEqual([cap]);
    expect(attempts.get('qualifyFitForRun')).toEqual([cap]);
  });

  it('rides out about half an hour and stays well inside the discovery admission lease', () => {
    const attempts = discoveryActivityMaximumAttempts().get('executeQuery')![0]!;
    const waits = Array.from({ length: attempts - 1 }, (_, index) =>
      timeoutMilliseconds(upstreamUnavailableRetryDelay(index + 1)),
    );
    const total = waits.reduce((sum, wait) => sum + wait, 0);
    expect(total).toBe(30 * 60_000);
    expect(total).toBeLessThan(DISCOVERY_ADMISSION_LEASE_MS / 4);
  });
});
