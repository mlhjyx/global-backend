import { isExecutionControlError } from '../execution-budget/execution-control-error';
import {
  ExternalActionDeniedError,
  ProviderHttpError,
  ProviderOutputError,
  ProviderSettlementError,
} from './providers/provider-output-error';

const MAX_CAUSE_DEPTH = 8;

function isDirectModelCallItemFailure(error: unknown): boolean {
  if (
    error instanceof ProviderSettlementError ||
    error instanceof ExternalActionDeniedError
  ) {
    return false;
  }
  if (error instanceof ProviderOutputError || error instanceof ProviderHttpError) {
    return true;
  }
  return error instanceof DOMException && error.name === 'TimeoutError';
}

/**
 * True when one model call failed for this item only: the provider answered
 * with an unusable, untrusted or rejected result, returned an HTTP error
 * status, or the request timed out. Paid settlement failures, external-action
 * denials, in-flight wires, cancellations and every budget, authority or
 * replay error are not matched, and neither is a model failure whose cause
 * chain carries one of those.
 *
 * isExecutionControlError fails closed on error shapes it does not know, and
 * every model failure carries provenance fields, so without this distinction
 * a single truncated output, 429 or timeout stopped an entire discovery run.
 */
export function isModelCallItemFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (!isDirectModelCallItemFailure(current)) return false;
    const cause: unknown = (current as { cause?: unknown }).cause;
    if (cause === undefined || cause === null) return true;
    if (!isDirectModelCallItemFailure(cause)) return !isExecutionControlError(cause);
    current = cause;
  }
  return false;
}

/**
 * Whether a failure raised around a model call must stop the surrounding run.
 * Pipelines that judge many independent items skip the item on any other
 * failure, as they already did for ordinary errors.
 */
export function isControlStopAfterModelCall(error: unknown): boolean {
  return !isModelCallItemFailure(error) && isExecutionControlError(error);
}
