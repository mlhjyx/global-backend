/**
 * Closed set of platform execution scopes in which a declared artifact-producing
 * tool may run with a transient result: the physical result is used inside the
 * call and discarded, and no artifact row is persisted.
 *
 * The set is code, never config: adding a scope is a reviewed change made
 * together with the platform workflow that declares it. Tenant calls and any
 * scope/tool combination outside this list keep the G3 subject-binding hold.
 */
export const TRANSIENT_RESULT_SCOPES = ['platform_channel_crawl'] as const;

export type TransientResultScope = (typeof TRANSIENT_RESULT_SCOPES)[number];

const TRANSIENT_RESULT_SCOPE_SET: ReadonlySet<string> = new Set(
  TRANSIENT_RESULT_SCOPES,
);

export function isTransientResultScope(
  value: unknown,
): value is TransientResultScope {
  return typeof value === 'string' && TRANSIENT_RESULT_SCOPE_SET.has(value);
}
