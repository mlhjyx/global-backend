import {
  ApplicationFailure,
  CancelledFailure,
  CompleteAsyncError,
} from '@temporalio/activity';
import type { ActivityInterceptorsFactory } from '@temporalio/worker';
import type { WorkerDomain } from './worker-topology';
import {
  safeTemporalErrorCode,
  type SafeTemporalErrorCode,
} from './safe-error-code';

const SAFE_ACTIVITY_FAILURE = 'ACQUISITION_ACTIVITY_FAILED';
const SAFE_CANCELLATION_MESSAGE = 'ACTIVITY_CANCELLED';

export interface AcquisitionActivityFailureInterceptorOptions {
  /** Exact activity names to protect on the mixed legacy drain worker. */
  activityTypes?: ReadonlySet<string>;
}

function isCompleteAsyncError(error: unknown): error is CompleteAsyncError {
  try {
    return error instanceof CompleteAsyncError;
  } catch {
    return false;
  }
}

function isCancelledFailure(error: unknown): error is CancelledFailure {
  try {
    return error instanceof CancelledFailure;
  } catch {
    return false;
  }
}

function wasNonRetryable(error: unknown): boolean {
  try {
    return (
      error instanceof ApplicationFailure && error.nonRetryable === true
    );
  } catch {
    return false;
  }
}

/**
 * Construct a fresh failure rather than mutating or wrapping the original.
 * This guarantees that message, details, cause and the original stack cannot
 * be serialized into ActivityTaskFailed history.
 */
export function toSafeAcquisitionActivityFailure(
  error: unknown,
): ApplicationFailure | CancelledFailure | CompleteAsyncError {
  // Temporal control-flow sentinels are not application failures. Async
  // completion must retain object identity; cancellation retains its failure
  // class but gets a fresh fixed message and empty details.
  if (isCompleteAsyncError(error)) return error;
  if (isCancelledFailure(error)) {
    return new CancelledFailure(SAFE_CANCELLATION_MESSAGE, []);
  }

  const code: SafeTemporalErrorCode = safeTemporalErrorCode(
    error,
    SAFE_ACTIVITY_FAILURE,
  );
  return ApplicationFailure.create({
    message: code,
    type: code,
    nonRetryable: wasNonRetryable(error),
  });
}

/**
 * Inbound boundary for acquisition activities. On the dedicated acquisition
 * worker every registered activity is protected. The mixed legacy drain
 * worker passes an exact allowlist so Site Builder and maintenance activity
 * contracts are untouched.
 */
export function createAcquisitionActivityFailureInterceptor(
  options: AcquisitionActivityFailureInterceptorOptions = {},
): ActivityInterceptorsFactory {
  return (context) => ({
    inbound: {
      async execute(input, next): Promise<unknown> {
        if (
          options.activityTypes &&
          !options.activityTypes.has(context.info.activityType)
        ) {
          return next(input);
        }
        try {
          return await next(input);
        } catch (error) {
          throw toSafeAcquisitionActivityFailure(error);
        }
      },
    },
  });
}

export function acquisitionActivityFailureInterceptorsForDomain(
  domain: WorkerDomain,
  legacyActivityTypes: ReadonlySet<string>,
): readonly ActivityInterceptorsFactory[] {
  if (domain === 'acquisition') {
    return Object.freeze([createAcquisitionActivityFailureInterceptor()]);
  }
  if (domain === 'legacy') {
    return Object.freeze([
      createAcquisitionActivityFailureInterceptor({
        activityTypes: legacyActivityTypes,
      }),
    ]);
  }
  return Object.freeze([]);
}
