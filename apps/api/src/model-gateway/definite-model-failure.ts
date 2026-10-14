import {
  ProviderHttpError,
  ProviderTransportError,
} from "./providers/provider-output-error";

/**
 * D13: the stable codes of a model call that failed definitively before the
 * model produced any output. Such a call cost nothing at the gateway, so the
 * non-paid gateway releases its reservation instead of settling it, and a
 * retry of the same operation key may reserve it again (the ledger allows at
 * most three attempts per key).
 *
 * Every failure that may already have produced billable output stays a
 * settlement with no result: a timeout or abort, a stream cut after any
 * output delta or counted output token, a content filter, an unreadable body,
 * a structured-output repair (the first call already ran) and every
 * unclassified error.
 */
export type DefiniteModelFailureCode =
  | "MODEL_PROVIDER_HTTP_UNAVAILABLE"
  | "MODEL_PROVIDER_CONNECTION_NOT_ESTABLISHED"
  | "MODEL_PROVIDER_STREAM_FAILED_BEFORE_OUTPUT";

/**
 * Statuses the gateway answers before streaming anything: rate limiting and
 * server-side unavailability. A 4xx request error fails the same way on every
 * retry, so it keeps the settle rule and stops the operation.
 */
function isUnavailableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Socket errors raised before a TCP connection exists, so no request byte was
 * written. A reset, a closed socket or a headers timeout may follow a sent
 * request and are not listed.
 */
const CONNECT_PHASE_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Stream failures the parser can prove happened before any output. */
const STREAM_FAILURES_BEFORE_OUTPUT: ReadonlySet<string> = new Set([
  "CHAT_COMPLETIONS_STREAM_UPSTREAM_ERROR",
  "CHAT_COMPLETIONS_STREAM_TRUNCATED",
  "CHAT_COMPLETIONS_STREAM_EMPTY",
]);

function errorCode(value: unknown): unknown {
  return value && typeof value === "object"
    ? (value as { code?: unknown }).code
    : undefined;
}

function isConnectPhaseCause(cause: unknown): boolean {
  if (cause instanceof AggregateError) {
    // Dual-stack connect: every address must have failed before connecting.
    return (
      cause.errors.length > 0 &&
      cause.errors.every((inner) => isConnectPhaseCause(inner))
    );
  }
  const code = errorCode(cause);
  return typeof code === "string" && CONNECT_PHASE_CODES.has(code);
}

/** The definite-failure code of `error`, or undefined when it is not one. */
export function definiteModelFailureCode(
  error: unknown,
): DefiniteModelFailureCode | undefined {
  if (error instanceof ProviderHttpError) {
    return isUnavailableStatus(error.status)
      ? "MODEL_PROVIDER_HTTP_UNAVAILABLE"
      : undefined;
  }
  if (error instanceof TypeError && isConnectPhaseCause(error.cause)) {
    return "MODEL_PROVIDER_CONNECTION_NOT_ESTABLISHED";
  }
  if (
    error instanceof ProviderTransportError &&
    Object.getPrototypeOf(error) === ProviderTransportError.prototype &&
    STREAM_FAILURES_BEFORE_OUTPUT.has(error.reasonCode) &&
    error.outputStarted === false &&
    error.callCount === 1 &&
    error.cause === undefined &&
    !((error.usage?.outputTokens ?? 0) > 0) &&
    !((error.usage?.costUsd ?? 0) > 0)
  ) {
    return "MODEL_PROVIDER_STREAM_FAILED_BEFORE_OUTPUT";
  }
  return undefined;
}
