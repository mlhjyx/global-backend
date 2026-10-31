/**
 * Why a discovery plan query ran on no provider (BI-30). A confirmed plan can
 * name a source that was switched off (data_provider DISABLED) after planning,
 * a source whose provider has no governed company lineage (never routed, even
 * while ENABLED), or, in plans written before BI-30, a source class no provider
 * serves. The query is skipped, the run goes on, and the run's stats count the
 * skips by reason; nothing about the query itself is recorded.
 *
 * Dependency-free: the discovery workflow imports it.
 */
export const DISCOVERY_QUERY_SKIP_REASONS = Object.freeze([
  /** A registered provider serves the query's source, but none is ENABLED. */
  'SOURCE_DISABLED',
  /**
   * The registered providers that serve the query's source do not declare the
   * governed company lineage that materialization requires, so they never run,
   * ENABLED or not (lineage gate).
   */
  'SOURCE_LINEAGE_UNAVAILABLE',
  /** No registered provider serves the query's source class and hint. */
  'SOURCE_UNKNOWN',
] as const);

export type DiscoveryQuerySkipReason = (typeof DISCOVERY_QUERY_SKIP_REASONS)[number];

export function isDiscoveryQuerySkipReason(value: unknown): value is DiscoveryQuerySkipReason {
  return (
    typeof value === 'string' &&
    (DISCOVERY_QUERY_SKIP_REASONS as readonly string[]).includes(value)
  );
}
