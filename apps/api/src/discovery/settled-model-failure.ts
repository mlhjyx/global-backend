import { isExecutionControlError } from '../execution-budget/execution-control-error';
import {
  ProviderTransportError,
  isRecoverableModelFailure,
} from '../model-gateway/providers/provider-output-error';

/**
 * The one transport failure discovery treats as a single call's failure: the
 * upstream cut a chat-completions stream short. It was seen once in 159 and
 * once in 112 extractions on xin (2026-10-11/12), each time alone.
 */
const ABSORBED_TRANSPORT_FAILURES: ReadonlySet<string> = new Set([
  'CHAT_COMPLETIONS_STREAM_TRUNCATED',
]);

/**
 * The reason code of a discovery model call the gateway settled without a
 * result, or undefined when the error does not prove that. Two kinds qualify:
 * - an unusable answer: a recoverable ProviderOutputError (#638);
 * - a cut stream: an exact ProviderTransportError with reason code
 *   CHAT_COMPLETIONS_STREAM_TRUNCATED and no control error behind it. Once
 *   output had started (every cut seen on xin so far carried 8 to 11086
 *   output tokens) the gateway settles it exactly like an unusable answer (one
 *   settle, no result projection, no durable receipt), so nothing can follow
 *   it, and a retry could only replay into BUDGET_OPERATION_REPLAY_UNAVAILABLE.
 *   A cut before the first output token is a definite failure the gateway
 *   releases instead (D13); absorbing it here still costs only that company.
 *
 * The gateway classes transport errors as control errors on purpose: an outage
 * hits every call of a run. Every other transport failure (timeouts, unreadable
 * or non-JSON bodies, upstream error events, an invalid finish reason such as
 * insufficient_system_resource, a failed Responses status) still fails closed.
 * A cut stream is absorbed per company, never quietly: the run counts every
 * skip and ends at least PARTIAL, a run whose every extraction failed with
 * nothing accepted ends FAILED, and the fit pass stops on two cuts in a row.
 */
export function settledModelFailureReason(error: unknown): string | undefined {
  if (isRecoverableModelFailure(error)) return error.reasonCode;
  if (
    error instanceof ProviderTransportError &&
    Object.getPrototypeOf(error) === ProviderTransportError.prototype &&
    ABSORBED_TRANSPORT_FAILURES.has(error.reasonCode) &&
    (error.cause === undefined || !isExecutionControlError(error.cause))
  ) {
    return error.reasonCode;
  }
  return undefined;
}
