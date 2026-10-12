import { isExecutionControlError } from '../execution-budget/execution-control-error';
import {
  ProviderTransportError,
  isRecoverableModelFailure,
} from '../model-gateway/providers/provider-output-error';

/**
 * The reason code of a discovery model call the gateway settled without a
 * result, or undefined when the error does not prove that. Two kinds qualify:
 * - an unusable answer: a recoverable ProviderOutputError (#638);
 * - a stream the upstream cut short: a plain ProviderTransportError with no
 *   control error behind it. The gateway settles it exactly like an unusable
 *   answer (one settle, no result projection, no durable receipt), so nothing
 *   can follow it, and a retry could only replay into
 *   BUDGET_OPERATION_REPLAY_UNAVAILABLE.
 *
 * The gateway classes transport errors as control errors on purpose: an outage
 * hits every call of a run, and a caller that absorbed each failure would end
 * the run quietly empty. Discovery absorbs this one per company (an extraction
 * skips its domain or listing, a fit judgment leaves the company unjudged), but
 * never quietly: the run counts every skip and ends at least PARTIAL, and it
 * counts the queries that lost every extraction (`discovery-model-extractions.ts`).
 */
export function settledModelFailureReason(error: unknown): string | undefined {
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
