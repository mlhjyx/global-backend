/**
 * Model extractions behind a discovery query: how many model calls the
 * company providers made, and how many of them failed so that the provider
 * skipped a domain or listing and the query went on without it (#638). The
 * dropped calls are absent from the query receipt and the company lineage, so
 * these counts are the only place a run shows them besides ai_trace.
 *
 * Reasons are the gateway's reason codes (`ProviderOutputError.reasonCode`,
 * which never carry model text); any other failure counts as MODEL_CALL_FAILED.
 *
 * Dependency-free: the discovery workflow imports it.
 */

/** Reason for a dropped call whose error carries no gateway reason code. */
export const MODEL_CALL_FAILED = 'MODEL_CALL_FAILED';

/** Same shape as the gateway's reason codes; anything else is not trusted as a key. */
const REASON_CODE = /^[A-Z][A-Z0-9_]{2,63}$/u;

export type DiscoveryModelExtractions = Readonly<{
  /** Model calls the providers made for one query. */
  invoked: number;
  /** Of those, the calls whose failure made a provider skip a domain or listing, by reason. */
  failedByReason: Readonly<Record<string, number>>;
}>;

export type DiscoveryRunModelExtractions = Readonly<{
  invoked: number;
  failed: number;
  failedByReason: Readonly<Record<string, number>>;
  /** Queries that lost every model call they made: the clearest sign of a model outage. */
  queriesAllFailed: number;
}>;

export const EMPTY_RUN_MODEL_EXTRACTIONS: DiscoveryRunModelExtractions = Object.freeze({
  invoked: 0,
  failed: 0,
  failedByReason: Object.freeze({}),
  queriesAllFailed: 0,
});

function reasonKey(reason: string): string {
  return REASON_CODE.test(reason) ? reason : MODEL_CALL_FAILED;
}

function addCounts(
  into: Record<string, number>,
  from: Readonly<Record<string, number>>,
): void {
  for (const [reason, count] of Object.entries(from)) {
    into[reason] = (Object.hasOwn(into, reason) ? into[reason]! : 0) + count;
  }
}

function count(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

/**
 * A query's counts as an activity result carries them, or undefined when they
 * are absent (histories recorded before the counter existed) or malformed.
 */
function parseModelExtractions(value: unknown): DiscoveryModelExtractions | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { invoked, failedByReason } = value as Record<string, unknown>;
  const calls = count(invoked);
  if (calls === undefined) return undefined;
  if (!failedByReason || typeof failedByReason !== 'object' || Array.isArray(failedByReason)) {
    return undefined;
  }
  const reasons: Record<string, number> = {};
  let failed = 0;
  for (const [reason, n] of Object.entries(failedByReason)) {
    const dropped = count(n);
    if (dropped === undefined || !REASON_CODE.test(reason)) return undefined;
    reasons[reason] = dropped;
    failed += dropped;
  }
  if (failed > calls) return undefined;
  return Object.freeze({ invoked: calls, failedByReason: Object.freeze(reasons) });
}

function failedTotal(value: DiscoveryModelExtractions): number {
  return Object.values(value.failedByReason).reduce((sum, n) => sum + n, 0);
}

/** One provider's tally for a query: every model call once, every dropped call by its reason. */
export function tallyModelExtractions(
  calls: readonly Readonly<{ failureReason?: string }>[],
): DiscoveryModelExtractions {
  const failedByReason: Record<string, number> = {};
  for (const call of calls) {
    if (call.failureReason === undefined) continue;
    addCounts(failedByReason, { [reasonKey(call.failureReason)]: 1 });
  }
  return Object.freeze({
    invoked: calls.length,
    failedByReason: Object.freeze(failedByReason),
  });
}

/** The providers of one query together; undefined when none of them made a model call. */
export function sumModelExtractions(
  providers: readonly (DiscoveryModelExtractions | undefined)[],
): DiscoveryModelExtractions | undefined {
  let invoked = 0;
  const failedByReason: Record<string, number> = {};
  for (const provider of providers) {
    const parsed = parseModelExtractions(provider);
    if (!parsed) continue;
    invoked += parsed.invoked;
    addCounts(failedByReason, parsed.failedByReason);
  }
  return invoked === 0
    ? undefined
    : Object.freeze({ invoked, failedByReason: Object.freeze(failedByReason) });
}

/**
 * The run total after one more query. The previous total is never changed; a
 * query without model calls, or without valid counts, returns it as is.
 */
export function addQueryModelExtractions(
  run: DiscoveryRunModelExtractions,
  query: unknown,
): DiscoveryRunModelExtractions {
  const parsed = parseModelExtractions(query);
  if (!parsed || parsed.invoked === 0) return run;
  const failed = failedTotal(parsed);
  const failedByReason: Record<string, number> = { ...run.failedByReason };
  addCounts(failedByReason, parsed.failedByReason);
  return Object.freeze({
    invoked: run.invoked + parsed.invoked,
    failed: run.failed + failed,
    failedByReason: Object.freeze(failedByReason),
    queriesAllFailed: run.queriesAllFailed + (failed === parsed.invoked ? 1 : 0),
  });
}
