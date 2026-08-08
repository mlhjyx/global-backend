import {
  ApplicationFailure,
  CancelledFailure,
  CompleteAsyncError,
} from '@temporalio/activity';
import type {
  ActivityExecuteInput,
  ActivityInterceptorsFactory,
} from '@temporalio/worker';
import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError } from '../tools/budget';
import {
  acquisitionActivityFailureInterceptorsForDomain,
  createAcquisitionActivityFailureInterceptor,
} from './acquisition-activity-failure.interceptor';

const SENSITIVE_ERROR =
  'contact Eva Pump eva@example.de https://buyer.example/rfq token=pilot-secret';
const EMPTY_INPUT = { args: [], headers: {} } as ActivityExecuteInput;

async function captureFailure(
  factory: ActivityInterceptorsFactory,
  error: unknown,
  activityType = 'executeQuery',
): Promise<unknown> {
  const interceptor = factory({
    info: { activityType, taskQueue: 'acquisition' },
  } as never).inbound;
  if (!interceptor?.execute) throw new Error('missing activity execute interceptor');
  const next = vi.fn().mockRejectedValue(error);
  try {
    await interceptor.execute(EMPTY_INPUT, next);
  } catch (caught) {
    return caught;
  }
  throw new Error('expected activity failure');
}

function expectNoSensitiveFailureEvidence(error: unknown): void {
  const failure = error as Error & {
    type?: string;
    details?: unknown[];
    cause?: unknown;
  };
  const evidence = JSON.stringify({
    message: failure.message,
    type: failure.type,
    details: failure.details,
    cause: failure.cause,
    stack: failure.stack,
  });
  expect(evidence).not.toContain(SENSITIVE_ERROR);
  expect(evidence).not.toContain('eva@example.de');
  expect(evidence).not.toContain('pilot-secret');
}

describe('acquisition ActivityTaskFailed evidence boundary', () => {
  it('converts an arbitrary thrown Error to a retryable closed ApplicationFailure', async () => {
    const original = new Error(SENSITIVE_ERROR);
    original.stack = `Error: ${SENSITIVE_ERROR}\n at provider (${SENSITIVE_ERROR})`;

    const failure = await captureFailure(
      createAcquisitionActivityFailureInterceptor(),
      original,
    );

    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure).toMatchObject({
      message: 'ACQUISITION_ACTIVITY_FAILED',
      type: 'ACQUISITION_ACTIVITY_FAILED',
      nonRetryable: false,
    });
    expect((failure as ApplicationFailure).details).toBeUndefined();
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
    expectNoSensitiveFailureEvidence(failure);
  });

  it('preserves the closed budget marker without copying the budget error payload', async () => {
    const failure = await captureFailure(
      createAcquisitionActivityFailureInterceptor(),
      new BudgetExceededError(SENSITIVE_ERROR, 10, 0),
    );

    expect(failure).toMatchObject({
      message: 'BUDGET_EXCEEDED',
      type: 'BUDGET_EXCEEDED',
      nonRetryable: false,
    });
    expectNoSensitiveFailureEvidence(failure);
  });

  it('preserves non-retryable semantics and an allowlisted type, but removes details and cause', async () => {
    const original = ApplicationFailure.nonRetryable(
      SENSITIVE_ERROR,
      'DISCOVERY_QUERY_FAILED',
      { contact: SENSITIVE_ERROR },
    );
    original.stack = `ApplicationFailure: ${SENSITIVE_ERROR}`;

    const failure = await captureFailure(
      createAcquisitionActivityFailureInterceptor(),
      original,
    );

    expect(failure).toMatchObject({
      message: 'DISCOVERY_QUERY_FAILED',
      type: 'DISCOVERY_QUERY_FAILED',
      nonRetryable: true,
    });
    expect((failure as ApplicationFailure).details).toBeUndefined();
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
    expectNoSensitiveFailureEvidence(failure);
  });

  it('preserves cancellation control flow with a fixed message and empty details', async () => {
    const failure = await captureFailure(
      createAcquisitionActivityFailureInterceptor(),
      new CancelledFailure(SENSITIVE_ERROR, [SENSITIVE_ERROR]),
    );

    expect(failure).toBeInstanceOf(CancelledFailure);
    expect(failure).toMatchObject({ message: 'ACTIVITY_CANCELLED', details: [] });
    expectNoSensitiveFailureEvidence(failure);
  });

  it('does not convert the CompleteAsyncError control-flow sentinel', async () => {
    const sentinel = new CompleteAsyncError();
    const failure = await captureFailure(
      createAcquisitionActivityFailureInterceptor(),
      sentinel,
    );

    expect(failure).toBe(sentinel);
  });

  it('can protect an exact legacy acquisition activity allowlist without touching other activity contracts', async () => {
    const factory = createAcquisitionActivityFailureInterceptor({
      activityTypes: new Set(['executeQuery']),
    });
    const raw = new Error(SENSITIVE_ERROR);

    const protectedFailure = await captureFailure(factory, raw, 'executeQuery');
    const untouchedFailure = await captureFailure(factory, raw, 'buildSite');

    expect(protectedFailure).toBeInstanceOf(ApplicationFailure);
    expect(untouchedFailure).toBe(raw);
  });

  it('installs the boundary only for the acquisition worker and the allowlisted legacy drain worker', () => {
    const legacyActivityTypes = new Set(['executeQuery']);

    expect(
      acquisitionActivityFailureInterceptorsForDomain(
        'acquisition',
        legacyActivityTypes,
      ),
    ).toHaveLength(1);
    expect(
      acquisitionActivityFailureInterceptorsForDomain(
        'legacy',
        legacyActivityTypes,
      ),
    ).toHaveLength(1);
    expect(
      acquisitionActivityFailureInterceptorsForDomain(
        'site-builder',
        legacyActivityTypes,
      ),
    ).toEqual([]);
    expect(
      acquisitionActivityFailureInterceptorsForDomain(
        'maintenance',
        legacyActivityTypes,
      ),
    ).toEqual([]);
  });
});
