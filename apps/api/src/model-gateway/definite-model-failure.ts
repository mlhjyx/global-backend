import { ProviderHttpError } from "./providers/provider-output-error";

/**
 * D13: the stable codes of a model call that failed definitively before the
 * gateway billed anything. The non-paid gateway releases its reservation
 * instead of settling it, and a retry of the same operation key may reserve
 * it again. The ledger allows at most three reservations per key; with the
 * gateway's own RetryTimes=1 that is up to six physical requests.
 *
 * Every failure that may already have been billed stays a settlement with no
 * result: a timeout or abort, an HTTP 504/524, a stream that failed at any
 * point, a content filter, an unreadable body, a structured-output repair
 * (the first call already ran) and every unclassified error.
 *
 * A stream that failed before its first output is deliberately not listed:
 * the live new-api fork answers it with HTTP 200 and bills the locally
 * estimated prompt tokens (xin new-api logs 5734-5738, 2026-10-13). It can be
 * added once the first-byte fix (mlhjyx/new-api#3) makes it an HTTP error.
 */
export type DefiniteModelFailureCode =
  | "MODEL_PROVIDER_HTTP_UNAVAILABLE"
  | "MODEL_PROVIDER_CONNECTION_NOT_ESTABLISHED";

/** Gateway timeouts: the request reached the upstream, which may have billed it. */
const UPSTREAM_TIMEOUT_STATUSES: ReadonlySet<number> = new Set([504, 524]);

/**
 * Statuses the gateway answers before streaming anything: rate limiting and
 * server-side unavailability, matching new-api's own retry statuses
 * (429, 500-503, 520-523, 525-599). A 4xx request error fails the same way on
 * every retry, so it keeps the settle rule and stops the operation.
 */
function isUnavailableStatus(status: number): boolean {
  return (
    status === 429 ||
    (status >= 500 &&
      status <= 599 &&
      !UPSTREAM_TIMEOUT_STATUSES.has(status))
  );
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
  return undefined;
}
