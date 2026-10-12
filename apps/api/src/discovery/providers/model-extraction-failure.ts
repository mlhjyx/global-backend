import { isExecutionControlError } from '../../execution-budget/execution-control-error';
import {
  ProviderTransportError,
  isRecoverableModelFailure,
} from '../../model-gateway/providers/provider-output-error';
import { MODEL_CALL_FAILED } from '../discovery-model-extractions';

/**
 * The reason code of an extraction call the gateway settled without a result,
 * or undefined when the error does not prove that. Two kinds qualify:
 * - an unusable answer: a recoverable ProviderOutputError (#638);
 * - a stream the upstream cut short: a plain ProviderTransportError with no
 *   control error behind it. The gateway settles it exactly like an unusable
 *   answer (one settle, no result projection, no durable receipt), so nothing
 *   can follow it.
 *
 * The gateway classes transport errors as control errors on purpose: an outage
 * hits every call of a run, and a caller that absorbed each failure would end
 * the run quietly empty. A discovery query does skip the one domain or listing,
 * but the run counts every skipped call, ends at least PARTIAL, and counts the
 * queries that lost every call (`discovery-model-extractions.ts`), so an
 * outage still shows.
 */
export function settledExtractionFailureReason(error: unknown): string | undefined {
  if (isRecoverableModelFailure(error)) return error.reasonCode;
  if (
    error instanceof ProviderTransportError &&
    Object.getPrototypeOf(error) === ProviderTransportError.prototype &&
    (error.cause === undefined || !isExecutionControlError(error.cause))
  ) {
    return error.reasonCode;
  }
  return undefined;
}

/** Why a provider skipped an extraction: a settled failure's reason code, else MODEL_CALL_FAILED. */
export function modelExtractionFailureReason(error: unknown): string {
  return settledExtractionFailureReason(error) ?? MODEL_CALL_FAILED;
}
