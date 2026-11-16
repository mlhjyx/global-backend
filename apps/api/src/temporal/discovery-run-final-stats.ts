import { canonicalCompanyAttributesEqual } from '../discovery/canonical-company-attributes';
import { summarizeDiscoveryQueryReceipts } from '../discovery/discovery-query-receipt';

/**
 * S1: equivalent extraction of the discovery run final-stats computation, plus the
 * persisted `queryDiagnostics` authority rules.
 *
 * The receipt drift/missing checks and the FAILED receipt fill are byte-for-byte
 * the semantics that lived inline in `discovery.activities.ts`; the only addition
 * is that the diagnostics namespace always comes from the row-locked stored stats
 * and never from a workflow-supplied value.
 */
export function finalizeDiscoveryRunStats(
  storedStats: unknown,
  workflowStats: Record<string, unknown>,
  status: 'DONE' | 'PARTIAL' | 'FAILED' | 'CANCELLED',
): Record<string, unknown> {
  if (
    storedStats !== null &&
    (typeof storedStats !== 'object' || Array.isArray(storedStats))
  ) {
    throw new Error('DISCOVERY_QUERY_RECEIPT_STORE_INVALID');
  }
  const stored = (storedStats ?? {}) as Record<string, unknown>;
  const storedDerived = summarizeDiscoveryQueryReceipts(stored);
  let finalStats: Record<string, unknown> = workflowStats;
  if (status === 'FAILED') {
    // 失败的 run 以库内已落盘的收据为准：查询活动可能在落收据之后才失败（429/超时后
    // 重试耗尽），工作流侧的 perQuery 因此必然可能不完整甚至为空；此时核对必「漂移」，
    // 而拒绝写入会让 run 永远停在 RUNNING（2026-11-03 实踩）。用派生值补齐并记录。
    if (Object.keys(storedDerived.perQuery).length) {
      finalStats = {
        ...stored,
        ...workflowStats,
        ...storedDerived,
      };
    }
  } else if (Object.prototype.hasOwnProperty.call(workflowStats, 'perQuery')) {
    if (
      !canonicalCompanyAttributesEqual(
        {
          perQuery: workflowStats.perQuery,
          perSource: workflowStats.perSource,
          rawGovernance: workflowStats.rawGovernance,
        },
        storedDerived,
      )
    ) {
      throw new Error('DISCOVERY_QUERY_RECEIPT_FINALIZE_DRIFT');
    }
    finalStats = {
      ...stored,
      ...workflowStats,
      ...storedDerived,
    };
  } else if (Object.keys(storedDerived.perQuery).length) {
    throw new Error('DISCOVERY_QUERY_RECEIPT_FINALIZE_MISSING');
  }
  // The locked row is the only authority for the diagnostics namespace: keep it
  // when committed (even if it cannot be re-parsed), and never adopt a
  // workflow-injected field of the same name.
  if (Object.prototype.hasOwnProperty.call(stored, 'queryDiagnostics')) {
    finalStats = { ...finalStats, queryDiagnostics: stored.queryDiagnostics };
  } else if (Object.prototype.hasOwnProperty.call(finalStats, 'queryDiagnostics')) {
    const { queryDiagnostics: _excluded, ...rest } = finalStats;
    finalStats = rest;
  }
  return finalStats;
}

/**
 * S1: the DiscoveryRunCompleted event, memory consumers and SaaS never receive the
 * diagnostics namespace; every other stats value is unchanged.
 */
export function projectDiscoveryCompletedStats(
  stats: Record<string, unknown>,
): Record<string, unknown> {
  const { queryDiagnostics: _excluded, ...rest } = stats;
  return rest;
}
