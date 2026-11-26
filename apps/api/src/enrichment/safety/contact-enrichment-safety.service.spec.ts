import { describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../../auth/request-context";
import type { VerifiedExecutionBudgetAuthority } from "../../execution-budget/execution-budget-authority.types";
import { enrichContactsExecutionBudgetRequestScope } from "../../execution-budget/execution-budget-request-scope";
import { buildFrozenEnrichmentPlan } from "./enrichment-call-plan";
import { ContactEnrichmentSafetyService, type ContactEnrichmentSafetyServiceDeps, type ExistingSafetyExecution } from "./contact-enrichment-safety.service";
const W = '00000000-0000-4000-8000-000000000001', C = '00000000-0000-4000-8000-000000000002', A = '00000000-0000-4000-8000-000000000003', ACCOUNT = '00000000-0000-4000-8000-000000000004', RUN = '00000000-0000-4000-8000-000000000005', CONTACT = '00000000-0000-4000-8000-000000000006';
const ctx: RequestContext = { workspaceId: W, userId: 'synthetic-actor', roles: ['synthetic'], scopes: ['acquisition:write', 'contact-discovery:read', 'compliance:manage'] };
const options = { lawfulBasis: { basis: 'legitimate_interest' as const }, attemptId: 'attempt-1' };
function world(config: { notAdmitted?: boolean; unsupported?: boolean; deniedRecovery?: boolean } = {}) {
  const events: string[] = []; const request = enrichContactsExecutionBudgetRequestScope(C, { attemptId: options.attemptId });
  const authority: VerifiedExecutionBudgetAuthority = { schemaVersion: 'execution-budget-grant/v1', authorityKind: 'WORKSPACE_GRANT', issuer: 'https://issuer.example.invalid', audience: 'global-backend:execution-budget', jti: 'fake-jti', purpose: 'contact.enrich', workspaceId: W, subjectType: 'company', subjectId: C, requestSha256: request.requestSha256, scheduleId: null, currency: 'USD', unit: 'microusd', capMicrousd: 250000n, capPerRunMicrousd: null, campaignCapMicrousd: null, maxRuns: null, tokenSha256: 'c'.repeat(64), issuedAt: 1, notBefore: 1, expiresAt: 9999999999 };
  const view = { executionId: RUN, operationRef: 'd'.repeat(64), planSha256: 'f'.repeat(64), status: 'PREPARED' as const, accountId: ACCOUNT, authorityId: A, generation: 1 };
  const result = { companyId: C, tier: 'B' as const, attempted: 1, costMicrousd: 1700, deadlineHit: false, results: [{ contactId: CONTACT, status: 'stored' as const }] };
  const deps: ContactEnrichmentSafetyServiceDeps = {
    authority: { verifyWorkspaceGrant: vi.fn(async () => { events.push('VERIFY_ONLY'); return authority; }) },
    prepare: vi.fn(async (input) => { events.push('PREFLIGHT'); if (config.notAdmitted) return { status: 'NOT_ADMITTED', reasonCode: 'GOVERNANCE_PENDING', tier: 'B' };
      const plan = buildFrozenEnrichmentPlan({ workspaceId: W, companyId: C, entrypoint: input.entrypoint, businessRunId: input.businessRunId, requestSha256: input.requestSha256, admittedAtMs: 1000, deadlineAtMs: 601000,
        targets: [{ contactId: CONTACT, contactOrdinal: 0, inputVersion: 'a'.repeat(64), beforeDigest: 'b'.repeat(64), pointRefs: [] }], slots: [{ slotKey: 'finder', contactId: CONTACT, contactOrdinal: 0, phase: 'FINDER', provider: config.unsupported ? 'findymail' : 'hunter', toolId: config.unsupported ? 'contact_email.find.findymail' : 'contact_email.find.hunter', toolVersion: '1.0.0', quoteMicrousd: '1700', pricingVersion: 'p1', dependsOnSlotKey: null }],
        limits: { authorityCapMicrousd: input.authorityCapMicrousd, companyCapMicrousd: input.authorityCapMicrousd, contactCapMicrousd: '150000', finderCompanyMax: 10, finderContactMax: 3, verifyAddressMax: 6, maxContacts: 10 } }); return { status: 'PREPARED', plan, tier: 'B' }; }),
    repository: { admitHttp: vi.fn(async () => { events.push('ATOMIC_ADMISSION'); return view; }), admitRun: vi.fn(async () => { events.push('RUN_ADMISSION_NO_GRANT'); return view; }) },
    execution: { findRun: vi.fn(async () => null), findByRef: vi.fn(async () => ({ view, workspaceId: W, companyId: C, businessRunId: null, accountKey: 'original-key', admissionRequestSha256: 'e'.repeat(64) })), execute: vi.fn(async () => { events.push('SAME_EXECUTION_RUNNER'); return result; }) },
    results: {
      listEnrichmentExecutions: vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false })),
      readEnrichmentExecution: vi.fn(async () => ({ opaqueMetadata: true })),
      listEnrichmentQualityFacts: vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false })),
      readEnrichmentQualityFacts: vi.fn(async () => ({ opaqueQuality: true })),
    }, authorizeRecovery: vi.fn(async () => !config.deniedRecovery),
  };
  const binding = { authorityId: A, replay: false, scopeKey: W, accountKey: ['discovery.run','discovery_run',RUN,'a'.repeat(64)].join(':'), purpose: 'discovery.run', subjectType: 'discovery_run', subjectId: RUN, requestSha256: 'a'.repeat(64) };
  const run = { workspaceId: W, companyId: C, businessRunId: RUN, binding, lawfulBasis: options.lawfulBasis, remainingMicrousd: '250000', actorId: 'discovery-run:' + RUN };
  return { service: new ContactEnrichmentSafetyService(deps), deps, events, authority, view, result, run };
}
describe('shared safe service admission and read/recovery orchestration, pure ports only', () => {
  it('verifies HTTP without consumption, preflights, atomically admits, then calls the single execution runner', async () => {
    const x = world(); expect(await x.service.executeHttp(ctx, C, options, 'fake-jws')).toMatchObject({ admission: 'ADMITTED', operationRef: x.view.operationRef, attempted: 1, qualityCoverage: 'PREREQUISITE_ONLY' });
    expect(x.events).toEqual(['VERIFY_ONLY','PREFLIGHT','ATOMIC_ADMISSION','SAME_EXECUTION_RUNNER']);
    expect(x.deps.repository.admitHttp).toHaveBeenCalledWith(expect.objectContaining({ authority: x.authority, executionOptions: { lawfulBasisKind: 'legitimate_interest', tier: 'B' } }));
    expect(x.deps.authority.verifyWorkspaceGrant).toHaveBeenCalledWith(expect.objectContaining({ compactJws: 'fake-jws', scope: enrichContactsExecutionBudgetRequestScope(C, { attemptId: 'attempt-1' }) }));
  });
  it('refuses missing lawful basis before verification, preflight or any admission', async () => {
    const x = world(); await expect(x.service.executeHttp(ctx, C, {}, 'fake-jws')).rejects.toThrow(); expect(x.deps.authority.verifyWorkspaceGrant).not.toHaveBeenCalled(); expect(x.deps.prepare).not.toHaveBeenCalled(); expect(x.deps.repository.admitHttp).not.toHaveBeenCalled();
  });
  it.each([{ notAdmitted: true }, { unsupported: true }])('reports unsupported/preflight refusal with no created operation, consume, reserve or runner %#', async (config) => {
    const x = world(config); const result = await x.service.executeHttp(ctx, C, options, 'fake-jws'); expect(result).toMatchObject({ admission: 'NOT_ADMITTED', reasonCode: 'GOVERNANCE_PENDING', attempted: 0, costMicrousd: 0 }); expect(result.operationRef).toBeUndefined(); expect(x.deps.repository.admitHttp).not.toHaveBeenCalled(); expect(x.deps.execution.execute).not.toHaveBeenCalled();
  });
  it('keeps the actual run binding/account key without another Grant and uses that same runner', async () => {
    const x = world(); expect(await x.service.executeRun(x.run as never)).toMatchObject({ admission: 'ADMITTED', operationRef: x.view.operationRef });
    expect(x.deps.authority.verifyWorkspaceGrant).not.toHaveBeenCalled(); expect(x.deps.repository.admitRun).toHaveBeenCalledWith(expect.objectContaining({ binding: x.run.binding })); expect(x.deps.execution.execute).toHaveBeenCalledWith(expect.objectContaining({ view: x.view, mode: 'EXECUTE', actorId: x.run.actorId }));
  });
  it('reads the old admitted run before preflight and never reselects targets or refreshes its plan on retry', async () => {
    const x = world(); await x.service.executeRun(x.run as never); const args = vi.mocked(x.deps.repository.admitRun).mock.calls[0]![0];
    vi.mocked(x.deps.execution.findRun).mockResolvedValue({ view: x.view, workspaceId: W, companyId: C, businessRunId: RUN, accountKey: x.run.binding.accountKey, admissionRequestSha256: args.admissionRequestSha256 } as ExistingSafetyExecution);
    await x.service.executeRun(x.run as never); expect(x.deps.prepare).toHaveBeenCalledTimes(1); expect(x.deps.repository.admitRun).toHaveBeenCalledTimes(1); expect(x.deps.execution.execute).toHaveBeenCalledTimes(2);
  });
  it('delegates GET only to persisted scoped metadata without verification/admission/execution/recovery', async () => {
    const x = world(); expect(await x.service.readEnrichmentExecution(ctx, C, 'd'.repeat(64))).toEqual({ opaqueMetadata: true }); await x.service.listEnrichmentExecutions(ctx, C, { limit: 10, cursor: null, businessRunId: null });
    expect(x.deps.authority.verifyWorkspaceGrant).not.toHaveBeenCalled(); expect(x.deps.repository.admitHttp).not.toHaveBeenCalled(); expect(x.deps.execution.execute).not.toHaveBeenCalled(); expect(x.deps.authorizeRecovery).not.toHaveBeenCalled();
  });
  it('delegates both complete-quality read ports with the original scope and no side effects', async () => {
    const x = world();
    expect(await x.service.readEnrichmentQualityFacts(ctx, C, 'd'.repeat(64))).toEqual({ opaqueQuality: true });
    await x.service.listEnrichmentQualityFacts(ctx, C, { limit: 10, cursor: null, businessRunId: null });
    expect(x.deps.results.readEnrichmentQualityFacts).toHaveBeenCalledWith(ctx, C, 'd'.repeat(64));
    expect(x.deps.results.listEnrichmentQualityFacts).toHaveBeenCalledWith(ctx, C, { limit: 10, cursor: null, businessRunId: null });
    expect(x.deps.authority.verifyWorkspaceGrant).not.toHaveBeenCalled();
    expect(x.deps.repository.admitHttp).not.toHaveBeenCalled();
    expect(x.deps.execution.execute).not.toHaveBeenCalled();
  });
  it('rejects invalid quality read addresses before reaching the port', async () => {
    const x = world();
    await expect(x.service.readEnrichmentQualityFacts(ctx, 'not-a-uuid', 'd'.repeat(64))).rejects.toThrow();
    await expect(x.service.readEnrichmentQualityFacts(ctx, C, 'not-a-ref')).rejects.toThrow();
    await expect(x.service.listEnrichmentQualityFacts(ctx, 'not-a-uuid', { limit: 10, cursor: null, businessRunId: null })).rejects.toThrow();
    await expect(x.service.listEnrichmentQualityFacts({ ...ctx, workspaceId: 'not-a-uuid' }, C, { limit: 10, cursor: null, businessRunId: null })).rejects.toThrow();
    expect(x.deps.results.readEnrichmentQualityFacts).not.toHaveBeenCalled();
    expect(x.deps.results.listEnrichmentQualityFacts).not.toHaveBeenCalled();
  });
  it('POST recovery authorizes current company then uses only RECOVER_NO_WIRE without Grant or new admission', async () => {
    const x = world(); expect(await x.service.recoverEnrichmentExecution(ctx, C, 'd'.repeat(64))).toEqual({ opaqueMetadata: true }); expect(x.deps.execution.execute).toHaveBeenCalledWith(expect.objectContaining({ mode: 'RECOVER_NO_WIRE', actorId: ctx.userId })); expect(x.deps.authority.verifyWorkspaceGrant).not.toHaveBeenCalled(); expect(x.deps.repository.admitHttp).not.toHaveBeenCalled(); expect(x.deps.repository.admitRun).not.toHaveBeenCalled();
  });
  it('recovers a streaming result by reading only after the existing recovery scope check', async () => {
    const x = world();
    const operationRef = '7'.repeat(64);
    const pending = { operationRef, status: 'APPLY_PENDING' };
    const readStreamingEnrichmentExecution = vi.fn(async () => pending);
    x.deps.execution.findByRef.mockResolvedValueOnce(null);
    const service = new ContactEnrichmentSafetyService({
      ...x.deps, results: { ...x.deps.results, readStreamingEnrichmentExecution },
    });

    await expect(service.recoverEnrichmentExecution({ ...ctx, scopes: ['acquisition:write'] }, C, operationRef)).rejects.toThrow();
    expect(readStreamingEnrichmentExecution).not.toHaveBeenCalled();
    await expect(service.recoverEnrichmentExecution(ctx, C, operationRef)).resolves.toEqual(pending);
    expect(readStreamingEnrichmentExecution).toHaveBeenCalledWith(ctx, C, operationRef);
    expect(x.deps.execution.findByRef).toHaveBeenCalledOnce();
    expect(x.deps.execution.execute).not.toHaveBeenCalled();
    expect(x.deps.authority.verifyWorkspaceGrant).not.toHaveBeenCalled();
  });
  it('does not execute recovery when the current subject gate denies it', async () => { const x = world({ deniedRecovery: true }); await expect(x.service.recoverEnrichmentExecution(ctx, C, 'd'.repeat(64))).rejects.toThrow(); expect(x.deps.execution.execute).not.toHaveBeenCalled(); });
});
