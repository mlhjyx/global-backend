import { describe, expect, it, vi } from "vitest";
import { executeContactEnrichmentSafetyActivity } from "./contact-enrichment-safety.activity";
const W = '00000000-0000-4000-8000-000000000001', C = '00000000-0000-4000-8000-000000000002', R = '00000000-0000-4000-8000-000000000003', A = '00000000-0000-4000-8000-000000000004';
const binding = { authorityId: A, replay: false, scopeKey: W, accountKey: ['discovery.run','discovery_run','request:' + 'a'.repeat(64),'a'.repeat(64)].join(':'), purpose: 'discovery.run', subjectType: 'discovery_run', subjectId: 'request:' + 'a'.repeat(64), requestSha256: 'a'.repeat(64) } as const;
const input = { workspaceId: W, companyId: C, runId: R, binding, lawfulBasis: { basis: 'legitimate_interest' as const }, remainingMicrousd: 250000n };
const legacy = { companyId: C, tier: 'A' as const, attempted: 3, costMicrousd: 3480, deadlineHit: false, results: [], admission: 'ADMITTED' as const, operationRef: 'd'.repeat(64), qualityCoverage: 'PREREQUISITE_ONLY' as const };
describe('ordinary Temporal in-activity safety helper, no workflow/client/connection', () => {
  it('preserves actual business run and returned account binding and uses the shared service once', async () => {
    const executeRun = vi.fn(async () => legacy); expect(await executeContactEnrichmentSafetyActivity({ executeRun }, input)).toEqual({ skipped: false, tier: 'A', attempted: 3, costMicrousd: 3480, operationRef: 'd'.repeat(64) });
    expect(executeRun).toHaveBeenCalledExactlyOnceWith({ workspaceId: W, companyId: C, businessRunId: R, binding, lawfulBasis: input.lawfulBasis, remainingMicrousd: '250000', actorId: 'discovery-run:' + R });
  });
  it.each([['GOVERNANCE_PENDING','governance_pending'],['NO_CONFIGURED_FINDER','no_configured_finder'],['NO_ENABLED_FINDER','no_enabled_finder'],['NO_LAWFUL_BASIS','no_lawful_basis_configured']])('preserves explicit not-admitted result %s without inventing an operation', async (reasonCode, reason) => {
    const executeRun = vi.fn(async () => ({ ...legacy, admission: 'NOT_ADMITTED' as const, operationRef: undefined, reasonCode, attempted: 0, costMicrousd: 0 })); const result = await executeContactEnrichmentSafetyActivity({ executeRun }, input); expect(result).toEqual({ skipped: true, reason }); expect(result.operationRef).toBeUndefined();
  });
  it('passes an authoritative zero remaining budget exactly rather than manufacturing spend room', async () => { const executeRun = vi.fn(async () => ({ ...legacy, admission: 'NOT_ADMITTED' as const, operationRef: undefined, reasonCode: 'BUDGET_CAP' })); await executeContactEnrichmentSafetyActivity({ executeRun }, { ...input, remainingMicrousd: 0n }); expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({ remainingMicrousd: '0' })); });
  it('does not accept a foreign workspace or a binding from another scope', async () => {
    const executeRun = vi.fn(async () => legacy);
    await expect(executeContactEnrichmentSafetyActivity({ executeRun }, { ...input, workspaceId: C })).rejects.toThrow();
    await expect(executeContactEnrichmentSafetyActivity({ executeRun }, { ...input, binding: { ...binding, scopeKey: C } })).rejects.toThrow();
    expect(executeRun).not.toHaveBeenCalled();
  });
  it('keeps the business runId distinct from the grant request-scope subject', async () => {
    const executeRun = vi.fn(async () => legacy); const result = await executeContactEnrichmentSafetyActivity({ executeRun }, input);
    expect(result).toMatchObject({ skipped: false }); expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({ businessRunId: R, binding }));
  });
  it('propagates original execution-control failure instead of replaying or invoking a fallback', async () => { const error = new Error('original_control_hold'); const executeRun = vi.fn(async () => { throw error; }); await expect(executeContactEnrichmentSafetyActivity({ executeRun }, input)).rejects.toBe(error); expect(executeRun).toHaveBeenCalledTimes(1); });
});
