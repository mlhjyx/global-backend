import { describe, expect, it, vi } from "vitest";
import { createContactEnrichmentSafetyPreparer, createContactEnrichmentSafetyRuntime, createManagedContactEnrichmentSafety, createSqlEnrichmentDomainCommitStore, createSqlEnrichmentStepGuards } from "./contact-enrichment-safety.composition";
import { enrichmentRequestHash } from "../finders/email-enrichment-provider";
import { EnrichmentDomainCommitter } from "./enrichment-domain-commit";
import { EnrichmentResultReader } from "./enrichment-result-reader";
import { buildContactEnrichmentQualityResult } from "./contact-enrichment-results.dto";
import { createContactEnrichmentSafetyTools, type ContactEnrichmentSafetyToolDeps } from "../../tools/contact-enrichment-safety-tools";
import { buildFrozenEnrichmentPlan } from "./enrichment-call-plan";
import { contactTargetBeforeDigest } from "./enrichment-target-snapshot";
import { createHash } from "node:crypto";
import { canonicalSafetyJson } from "./enrichment-safety.contract";
import { HunterProvider } from "../finders/hunter.provider";
import { enrichmentInputVersion } from "../finders/email-enrichment-provider";
import type { ContactEnrichmentPreparationInput } from "./contact-enrichment-safety.service";
const W = '00000000-0000-4000-8000-000000000001', C = '00000000-0000-4000-8000-000000000002', CONTACT = '00000000-0000-4000-8000-000000000003';
function world(options: { extraEnv?: Record<string,string>; noKeys?: boolean; disabled?: boolean; aTier?: boolean; retention?: number; denied?: boolean; artifacts?: boolean } = {}) {
  const env = { ...(options.noKeys ? {} : { HUNTER_API_KEY: 'fake-hunter', MILLIONVERIFIER_API_KEY: 'fake-millionverifier', EMAILABLE_API_KEY: 'fake-emailable' }), ...options.extraEnv };
  const tx = { canonicalCompany: { findUnique: vi.fn(async () => ({ id: C, name: 'Synthetic Company', domain: 'company.example.invalid' })) }, canonicalContact: { findMany: vi.fn(async () => [{ id: CONTACT, fullName: 'Synthetic Person' }]) }, contactPoint: { findMany: vi.fn(async () => []) }, lead: { findFirst: vi.fn(async () => options.aTier ? { id: 'synthetic-lead' } : null) } };
  const prisma = { withWorkspace: vi.fn(async (_workspace: string, fn: (tx: unknown) => Promise<unknown>) => fn(tx)), dataProvider: { findUnique: vi.fn(async () => ({ status: options.disabled ? 'DISABLED' : 'ENABLED', config: null })) }, sourcePolicy: { findUnique: vi.fn(async () => ({ reviewStatus: 'APPROVED', allowedPurpose: ['enrichment'], retentionDays: options.retention ?? 1, updatedAt: new Date('2026-11-22T00:00:00.000Z') })) } };
  const authorizeContact = vi.fn(async () => !options.denied), artifactsConfigured = vi.fn(() => options.artifacts ?? true);
  const prepare = createContactEnrichmentSafetyPreparer({ prisma: prisma as never, env, clock: () => new Date(1000), authorizeContact, artifactsConfigured });
  const input: ContactEnrichmentPreparationInput = { workspaceId: W, companyId: C, entrypoint: 'http', businessRunId: null, requestSha256: 'a'.repeat(64), authorityCapMicrousd: '500000', options: { lawfulBasis: { basis: 'legitimate_interest' } } };
  return { prepare, prisma, tx, input, authorizeContact, artifactsConfigured };
}
describe('native-pool safe preflight composition, fake database and zero physical provider calls', () => {
  it('uses original none-email selection, canonical target hashes and all potential controlled quotes without invoking native adapters', async () => {
    const find = vi.spyOn(HunterProvider.prototype, 'findEmail').mockRejectedValue(new Error('must_not_invoke_during_preflight'));
    try {
      const x = world(); const result = await x.prepare(x.input); expect(result.status).toBe('PREPARED'); if (result.status !== 'PREPARED') throw new Error('expected prepared');
      expect(x.tx.canonicalContact.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { companyId: C, contactPoints: { none: { type: 'email' } } }, take: 10 }));
      expect(result.plan.targets[0]?.inputVersion).toBe(enrichmentInputVersion({ fullName: 'Synthetic Person', domain: 'company.example.invalid', companyName: 'Synthetic Company' }));
      expect(result.plan.slots.map((slot) => slot.provider)).toEqual(['hunter','millionverifier','emailable']); expect(result.plan.slots.map((slot) => slot.quoteMicrousd)).toEqual(['1700','1780','7600']);
      expect(result.plan.deadlineAtMs).toBe(601000); expect(JSON.stringify(result.plan)).not.toMatch(/Synthetic Person|company\.example\.invalid|fake-hunter/); expect(find).not.toHaveBeenCalled();
    } finally { find.mockRestore(); }
  });
  it.each([{ extraEnv: { FINDYMAIL_API_KEY: 'fake-extra' } }, { extraEnv: { APOLLO_API_KEY: 'fake-tail' }, aTier: true }])('refuses the complete unsupported reachable set instead of dropping it %#', async (options) => { const x = world(options); expect(await x.prepare(x.input)).toMatchObject({ status: 'NOT_ADMITTED', reasonCode: 'GOVERNANCE_PENDING' }); expect(x.tx.canonicalContact.findMany).not.toHaveBeenCalled(); });
  it('does not activate an A-only configured tail for a B-tier company', async () => { const x = world({ extraEnv: { APOLLO_API_KEY: 'fake-tail' } }); const result = await x.prepare(x.input); expect(result.status).toBe('PREPARED'); if (result.status === 'PREPARED') expect(result.plan.slots.some((slot) => slot.provider === 'apollo')).toBe(false); });
  it('returns no-config/no-enabled honestly before target materialization', async () => { for (const [x, reasonCode] of [[world({ noKeys: true }), 'NO_CONFIGURED_FINDER'], [world({ disabled: true }), 'NO_ENABLED_FINDER']] as const) { expect(await x.prepare(x.input)).toMatchObject({ status: 'NOT_ADMITTED', reasonCode }); expect(x.tx.canonicalContact.findMany).not.toHaveBeenCalled(); } });
  it('does not admit missing/invalid source retention or an uncomposed artifact path', async () => { for (const x of [world({ retention: 0 }), world({ artifacts: false })]) expect((await x.prepare(x.input)).status).toBe('NOT_ADMITTED'); });
  it('does not admit a source URL override outside the fixed HTTPS origin', async () => { const x = world({ extraEnv: { HUNTER_BASE_URL: 'http://other.example.invalid' } }); expect((await x.prepare(x.input)).status).toBe('NOT_ADMITTED'); });
  it('does not exceed the tighter actual authority cap by ignoring verification quotes', async () => { const x = world(); expect(await x.prepare({ ...x.input, authorityCapMicrousd: '5000' })).toMatchObject({ status: 'NOT_ADMITTED', reasonCode: 'BUDGET_CAP' }); });
  it('checks current contact/company suppression without starting a provider', async () => { const x = world({ denied: true }); expect(await x.prepare(x.input)).toMatchObject({ status: 'NOT_ADMITTED', reasonCode: 'SUPPRESSED' }); expect(x.authorizeContact).toHaveBeenCalled(); });
});


describe('full safety runtime composition drives bound steps through the original broker and domain commit', () => {
  const W = '00000000-0000-4000-8000-000000000001', C = '00000000-0000-4000-8000-000000000002', A = '00000000-0000-4000-8000-000000000003', ACCOUNT = '00000000-0000-4000-8000-000000000004', EXEC = '00000000-0000-4000-8000-000000000005', STEP = '00000000-0000-4000-8000-000000000006', CONTACT = '00000000-0000-4000-8000-000000000007', OP = '00000000-0000-4000-8000-000000000008', ART = '00000000-0000-4000-8000-000000000009';
  const binding = { authorityId: A, replay: false, scopeKey: W, accountKey: ['discovery.run','discovery_run','request:'+'a'.repeat(64),'a'.repeat(64)].join(':'), purpose: 'discovery.run' as const, subjectType: 'discovery_run', subjectId: 'request:'+'a'.repeat(64), requestSha256: 'a'.repeat(64) };
  const plan = buildFrozenEnrichmentPlan({ workspaceId: W, companyId: C, entrypoint: 'discovery_run', businessRunId: '00000000-0000-4000-8000-000000000010', requestSha256: 'a'.repeat(64), admittedAtMs: 1000, deadlineAtMs: 601000,
    targets: [{ contactId: CONTACT, contactOrdinal: 0, inputVersion: enrichmentInputVersion({ fullName: 'Synthetic Person', domain: 'company.example.invalid', companyName: 'Synthetic Company' }), beforeDigest: contactTargetBeforeDigest({ inputVersion: enrichmentInputVersion({ fullName: 'Synthetic Person', domain: 'company.example.invalid', companyName: 'Synthetic Company' }), points: [] }), pointRefs: [] }],
    slots: [{ slotKey: 'finder', contactId: CONTACT, contactOrdinal: 0, phase: 'FINDER', provider: 'hunter', toolId: 'contact_email.find.hunter', toolVersion: '1.0.0', quoteMicrousd: '1700', pricingVersion: 'p1', dependsOnSlotKey: null }],
    limits: { authorityCapMicrousd: '250000', companyCapMicrousd: '250000', contactCapMicrousd: '150000', finderCompanyMax: 10, finderContactMax: 3, verifyAddressMax: 6, maxContacts: 10 } });
  function world(options: { crash?: boolean } = {}) {
    const events: string[] = []; let sealed = false; let claimed = false; let linked = false; let sealedFp = ''; let sealedOp = '';
    const head = { id: EXEC, workspace_id: W, company_id: C, authority_id: A, account_id: ACCOUNT, generation: 1, account_key: binding.accountKey, entrypoint: 'discovery_run', business_run_id: plan.businessRunId, request_sha256: plan.requestSha256, admission_request_sha256: createHash('sha256').update(canonicalSafetyJson({ version: 1, entrypoint: 'discovery_run', businessRunId: plan.businessRunId, lawfulBasis: { basis: 'legitimate_interest', ref: null, note: null }, contactIds: null, maxProviders: 3, maxProbe: 6, attemptId: null })).digest('hex'), operation_ref: 'd'.repeat(64), protocol_version: 1, plan_sha256: plan.planSha256, status: 'PREPARED', frozen_limits: { caps: plan.limits, admittedAtMs: 1000, deadlineAtMs: 601000, targetCount: 1, executionOptions: { lawfulBasisKind: 'legitimate_interest', tier: 'B' } }, target_snapshot: plan.targets, created_at: new Date(1000), result_revision: 1, result_snapshot: null, current_account_id: ACCOUNT, current_authority_id: A, current_generation: 1 };
    const stepRow = () => ({ id: STEP, workspace_id: W, company_id: C, execution_id: EXEC, contact_id: CONTACT, contact_ordinal: 0, slot_key: 'finder', phase: 'FINDER', provider: 'hunter', tool_id: 'contact_email.find.hunter', tool_version: '1.0.0', quote_microusd: 1700n, pricing_version: 'p1', depends_on_slot_key: null, input_fingerprint: sealed ? sealedFp : null, operation_key: sealed ? sealedOp : null, budget_operation_id: claimed ? OP : null, candidate_ref: null, revision: sealed ? 2 : 1, dispatch_phase: linked ? 'SETTLED_WAITING_APPLY' : claimed ? 'RESERVED' : 'ADMITTED', domain_state: 'PENDING', authority_id: A, account_id: ACCOUNT, generation: 1, account_key: binding.accountKey, execution_status: 'PREPARED', deadline_open: true,
      budget_original_id: (claimed || linked) ? OP : null, budget_status: linked ? 'SETTLED' : claimed ? 'RESERVED' : null, budget_amount_unit: (claimed || linked) ? 'microusd' : null, budget_reserved_microusd: (claimed || linked) ? 1700n : null, budget_charged_microusd: linked ? 1700n : null, budget_result_schema: null, budget_result_digest: null, budget_result_json: null, budget_receipt_usage: null, budget_receipt_cost_basis: null,
      current_account_id: ACCOUNT, current_authority_id: A, current_generation: 1, original_operation_id: null, original_scope_key: null, original_account_id: null, original_generation: null, original_operation_key: null, ledger_status: null, amount_unit: null, reserved_microusd: null, result_schema_version: null, result_schema: null, result_digest: null, result_json: null, receipt_usage: null, receipt_cost_basis: null });
    const POINT = '00000000-0000-4000-8000-000000000031', EVENT = '00000000-0000-4000-8000-000000000032', ATTEMPT = '00000000-0000-4000-8000-000000000033';
    const tx = {
      $executeRawUnsafe: vi.fn(async () => 1),
      contactPoint: { upsert: vi.fn(async () => ({ id: POINT, verificationState: 'UNKNOWN', validSince: null, nextReverifyAt: null })), update: vi.fn(async () => ({ id: POINT })) },
      contactPointVerificationEvent: { count: vi.fn(async () => 0), create: vi.fn(async () => ({ id: EVENT })), findUnique: vi.fn(async () => null) },
      contactEnrichmentAttempt: { create: vi.fn(async () => ({ id: ATTEMPT, providerKey: 'hunter', requestHash: 'x'.repeat(64), outcome: 'hit', errorCode: null, emailState: null, costMicrousd: 1700n, attemptedAt: new Date(1000) })), findUnique: vi.fn(async () => null), update: vi.fn(async () => ({ id: ATTEMPT })) },
      $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => { const sql = strings.join('?');
      if (sql.includes('FROM public.contact_enrichment_execution_step') && sql.includes('ORDER BY s.slot_ordinal')) return [stepRow()];
      if (sql.includes('AS execution_id,s.id::text AS step_id')) return [{ execution_id: EXEC, step_id: STEP }];
      if (sql.includes('public.lock_enrichment_execution_step_anchor_v1')) return [{ execution_id: EXEC, step_id: STEP }];
      if (sql.includes('public.lock_enrichment_execution_v1')) return [{ id: EXEC, account_id: ACCOUNT }];
      if (sql.includes('public.lock_enrichment_step_v1')) return [{ id: STEP, revision: claimed ? 3 : 2, dispatch_phase: claimed ? 'RESERVED' : (sealed ? 'SETTLED_WAITING_APPLY' : 'ADMITTED'), budget_operation_id: claimed ? OP : null, operation_key: sealed ? sealedOp : null, result_digest: null, receipt: null, artifact_reference: null }];
      if (sql.includes('public.lock_contact_enrichment_operation_v1')) return [{ operation_id: OP, scope_key: W, account_id: ACCOUNT, generation: 1, operation_key: sealedOp, status: 'RESERVED', amount_unit: 'microusd', reserved_microusd: 1700n }];
      if (sql.includes('FROM public.tool_budget_operation') && !sql.includes('public.lock_')) return [{ operation_id: OP, scope_key: W, account_id: ACCOUNT, generation: 1, operation_key: sealedOp, status: 'RESERVED', amount_unit: 'microusd', reserved_microusd: 1700n }];
      if (sql.includes('FROM public.contact_enrichment_execution e JOIN')) return [head];
      if (sql.includes('FROM public.contact_enrichment_execution_step') && sql.includes('LEFT JOIN public.tool_budget_operation')) return [stepRow()];
      if (sql.includes('FROM public.contact_enrichment_execution_step s JOIN') && sql.includes('s.id=')) return [stepRow()];
      if (sql.includes('public.lock_contact_enrichment_account_v1')) return [{ account_id: ACCOUNT, scope_key: W, account_key: binding.accountKey, authority_id: A, generation: 1, authorized_cap_microusd: 250000n, closed_at: null, ref_count: 1 }];
      if (sql.includes('public.lock_contact_enrichment_authority_v1')) return [{ id: A, scope_key: W, usable: true, revoked_at: null }];
      if (sql.includes('SELECT id::text,revision,dispatch_phase') && sql.includes('FOR UPDATE')) return [{ id: STEP, revision: claimed ? 3 : 2, dispatch_phase: claimed ? 'RESERVED' : (sealed ? 'SETTLED_WAITING_APPLY' : 'ADMITTED'), budget_operation_id: claimed ? OP : null, operation_key: sealed ? sealedOp : null, result_digest: null, receipt: null, artifact_reference: null }];
      if (sql.includes('SET result_digest=')) { linked = true; events.push('LINK'); return [{ id: STEP }]; }
      if (sql.includes("SET dispatch_phase='RESULT_UNKNOWN'")) { events.push('HOLD_STEP'); return []; }
      if (sql.includes('UPDATE public.contact_enrichment_execution_step') && sql.includes('SET input_fingerprint')) { sealed = true; sealedFp = String(values[0]); sealedOp = String(values[1]); events.push('SEAL'); return [{ id: STEP }]; }
      if (sql.includes('FROM public.tool_budget_operation') && !sql.includes('UPDATE public.')) return [{ operation_id: OP, scope_key: W, account_id: ACCOUNT, generation: 1, operation_key: sealedOp, status: 'RESERVED', amount_unit: 'microusd', reserved_microusd: 1700n }];
      if (sql.includes('UPDATE public.contact_enrichment_execution_step') && sql.includes('budget_operation_id')) { claimed = true; events.push('CLAIM'); return [{ id: STEP }]; }
      throw new Error('unexpected synthetic runtime SQL: ' + sql.slice(0, 120));
    }) };
    const prisma = { withWorkspace: vi.fn(async (_workspace: string, fn: (tx: unknown) => Promise<unknown>) => fn(tx)) };
    const broker = { checkSourcePolicy: vi.fn(async () => ({ allowed: true })), invoke: vi.fn(async <I,O>(toolId: string, input: I, ctx: import('../../tools/tool-contract').ToolContext): Promise<import('../../tools/tool-contract').ToolResult<O>> => {
      events.push('BROKER_INVOKE'); expect(toolId).toBe('contact_email.find.hunter'); expect(input).toEqual({ stepId: STEP });
      await ctx.beforePhysicalWire!(); if (options.crash) throw new Error('synthetic_broker_ack_lost');
      return { data: { status: 'hit', email: 'person@company.example.invalid', providerConfidence: 90, acceptAll: false, pattern: null, reason: 'candidate_found' } as unknown as O, costCents: 0.17, costMicrousd: '1700', durableReceipt: { schemaVersion: 'durable-execution-receipt/v1', scopeKey: W, authorityId: A, accountId: ACCOUNT, operationId: OP, operationKey: sealedOp, resultStrategy: 'artifact_reference', resultSchema: 'contact-email-find-hunter/v1', resultDigest: 'b'.repeat(64), artifactId: ART, usage: { currency: 'USD', unit: 'microusd', callCount: 1, chargedMicrousd: '1700', upperBoundMicrousd: '1700' }, costBasis: 'estimated_upper_bound', status: 'SETTLED' } };
    }) } as never;
    const originalRef = { step: { stepId: STEP, slotKey: 'finder', contactId: CONTACT, contactOrdinal: 0, phase: 'FINDER' as const, provider: 'hunter', toolId: 'contact_email.find.hunter', toolVersion: '1.0.0', quoteMicrousd: '1700', pricingVersion: 'p1', dependsOnSlotKey: null, executionId: EXEC, workspaceId: W, companyId: C, authorityId: A, accountId: ACCOUNT, generation: 1, accountKey: binding.accountKey, inputFingerprint: 'e'.repeat(64), operationKey: 'original-op', candidateRef: null, revision: 2, budgetOperationId: OP }, reference: { stepId: STEP, producerId: 'contact_email.find.hunter', resultSchema: 'contact-email-find-hunter/v1', resultDigest: 'b'.repeat(64), durableReceipt: { schemaVersion: 'durable-execution-receipt/v1', scopeKey: W, authorityId: A, accountId: ACCOUNT, operationId: OP, operationKey: 'original-op', resultStrategy: 'artifact_reference', resultSchema: 'contact-email-find-hunter/v1', resultDigest: 'b'.repeat(64), artifactId: ART, usage: { currency: 'USD', unit: 'microusd', callCount: 1, chargedMicrousd: '1700', upperBoundMicrousd: '1700' }, costBasis: 'estimated_upper_bound', status: 'SETTLED' } } } as const;
    const store = { readCommitted: vi.fn(async () => null), lockAndLoad: vi.fn(async () => ({ workspaceId: W, companyId: C, executionId: EXEC, contactId: CONTACT, authorityId: A, accountId: ACCOUNT, generation: 1, businessRunId: plan.businessRunId, target: plan.targets[0]!, currentInput: { fullName: 'Synthetic Person', domain: 'company.example.invalid', companyName: 'Synthetic Company' }, currentPoints: [], originalReferences: [originalRef], committed: null, redacted: false, lawfulBasis: { basis: 'legitimate_interest' }, pendingOperationIds: [], originalSmtpAcknowledgements: [] })),
      persist: vi.fn(async () => { events.push('PERSIST'); }), savePending: vi.fn(async () => undefined) };
    const deps = { prisma: prisma as never, authority: { verifyWorkspaceGrant: vi.fn() } as never, broker, grantConsumer: { consumeVerifiedWorkspaceGrantInTransaction: vi.fn() } as never, guards: { assertCurrentSubjectAndPolicy: vi.fn(async (_tx: unknown, row: { pricing_version: string }) => ({ pricingVersion: row.pricing_version })), assertCandidateOrigin: vi.fn(async () => undefined) } as never,
      store: store as never, budgets: { readOperationResult: vi.fn(async () => ({ status: 'NOT_FOUND' })) } as never, artifacts: { readVerified: vi.fn(), recoverUnknown: vi.fn() } as never, finderMaterializer: { resultSchema: 'contact-email-find-hunter/v1', materialize: vi.fn() } as never,
      materializeForDomain: vi.fn(async () => ({ phase: 'FINDER' as const, step: originalRef.step, reference: originalRef.reference, result: { status: 'hit', email: 'person@company.example.invalid', providerConfidence: 90, acceptAll: false, pattern: null, reason: 'candidate_found' } })),
      authorizeCurrent: vi.fn(async () => true),
      acknowledge: vi.fn(async (request: { transaction: unknown; apply: (tx: unknown) => Promise<unknown> }) => ({ status: 'APPLIED' as const, value: await request.apply(request.transaction) as never })),
      loadTrustedInput: vi.fn(async () => ({ step: originalRef.step as never, finder: { fullName: 'Synthetic Person', domain: 'company.example.invalid', companyName: 'Synthetic Company' }, verification: null })),
      prepare: vi.fn(async () => ({ status: 'NOT_ADMITTED', reasonCode: 'GOVERNANCE_PENDING' })) as never, authorizeRecovery: vi.fn(async () => true),
      reusableAttempt: vi.fn(async () => null),
      recordAttempt: vi.fn(async () => undefined),
      circuit: { load: vi.fn(async () => ({ status: 'CLOSED', windowStartedAt: null, windowSuccesses: 0, windowFailures: 0, consecutiveFailures: 0, openedAt: null, probeInFlight: false })), save: vi.fn(async () => undefined) } };
    return { deps, events, broker, store, plan };
  }
  it('executes one admitted FINDER step through seal→broker before-physical-wire→persist without faking receipts', async () => {
    const x = world(); const runtime = createContactEnrichmentSafetyRuntime(x.deps as never);
    const result = await runtime.service.executeRun({ workspaceId: W, companyId: C, businessRunId: plan.businessRunId!, binding, lawfulBasis: { basis: 'legitimate_interest' }, remainingMicrousd: '250000', actorId: 'discovery-run:test' });
    expect(result).toMatchObject({ admission: 'ADMITTED', operationRef: 'd'.repeat(64) });
    expect(x.events).toContain('BROKER_INVOKE'); expect(x.events.indexOf('SEAL')).toBeLessThan(x.events.indexOf('BROKER_INVOKE')); expect(x.store.persist).toHaveBeenCalled();
  });
  it('does not persist or re-execute after a broker ACK loss and reports HOLD', async () => {
    const x = world({ crash: true }); const runtime = createContactEnrichmentSafetyRuntime(x.deps as never);
    await expect(runtime.service.executeRun({ workspaceId: W, companyId: C, businessRunId: plan.businessRunId!, binding, lawfulBasis: { basis: 'legitimate_interest' }, remainingMicrousd: '250000', actorId: 'discovery-run:test' })).rejects.toThrow();
    expect(x.store.persist).not.toHaveBeenCalled(); expect(x.broker.invoke).toHaveBeenCalledTimes(1);
  });
});

const SQL_W = '00000000-0000-4000-8000-000000000101';
const SQL_COMPANY = '00000000-0000-4000-8000-000000000102';
const SQL_C1 = '00000000-0000-4000-8000-000000000103';
const SQL_C2 = '00000000-0000-4000-8000-000000000104';
const SQL_A = '00000000-0000-4000-8000-000000000105';
const SQL_ACCOUNT = '00000000-0000-4000-8000-000000000106';
const SQL_EXEC = '00000000-0000-4000-8000-000000000107';
const SQL_F1 = '00000000-0000-4000-8000-000000000108';
const SQL_V1 = '00000000-0000-4000-8000-000000000109';
const SQL_F2 = '00000000-0000-4000-8000-000000000110';
const SQL_V2 = '00000000-0000-4000-8000-000000000111';
const SQL_OPF1 = '00000000-0000-4000-8000-000000000112';
const SQL_OPF2 = '00000000-0000-4000-8000-000000000113';
const SQL_P1 = '00000000-0000-4000-8000-000000000114';
const SQL_P2 = '00000000-0000-4000-8000-000000000115';
const SQL_DIG1 = 'b'.repeat(64);
const SQL_DIG2 = 'c'.repeat(64);
const SQL_ART = (operationId: string, digest: string) => ({ schemaVersion: 'generic-operation-artifact-ref/v1', operationId, artifactId: '00000000-0000-4000-8000-000000000116', resultSchema: 'contact-email-find-hunter/v1', sha256: digest, mediaType: 'application/octet-stream', sizeBytes: '128', expiresAt: '2099-01-01T00:00:00.000Z' });
const SQL_USAGE = { currency: 'USD', unit: 'microusd', callCount: 1, chargedMicrousd: '1700', upperBoundMicrousd: '1700' };
function sqlPlan() {
  const inputVersion = 'a'.repeat(64);
  return buildFrozenEnrichmentPlan({ workspaceId: SQL_W, companyId: SQL_COMPANY, entrypoint: 'http', businessRunId: null, requestSha256: 'd'.repeat(64), admittedAtMs: 1000, deadlineAtMs: 601000,
    targets: [
      { contactId: SQL_C1, contactOrdinal: 0, inputVersion, beforeDigest: 'e'.repeat(64), pointRefs: [] },
      { contactId: SQL_C2, contactOrdinal: 1, inputVersion, beforeDigest: 'e'.repeat(64), pointRefs: [] },
    ],
    slots: [
      { slotKey: 'contact-0-finder', contactId: SQL_C1, contactOrdinal: 0, phase: 'FINDER', provider: 'hunter', toolId: 'contact_email.find.hunter', toolVersion: '1.0.0', quoteMicrousd: '1700', pricingVersion: 'p1', dependsOnSlotKey: null },
      { slotKey: 'contact-0-verify-0', contactId: SQL_C1, contactOrdinal: 0, phase: 'VERIFY', provider: 'millionverifier', toolId: 'contact_email.verify.millionverifier', toolVersion: '1.0.0', quoteMicrousd: '1780', pricingVersion: 'p1', dependsOnSlotKey: 'contact-0-finder' },
      { slotKey: 'contact-1-finder', contactId: SQL_C2, contactOrdinal: 1, phase: 'FINDER', provider: 'hunter', toolId: 'contact_email.find.hunter', toolVersion: '1.0.0', quoteMicrousd: '1700', pricingVersion: 'p1', dependsOnSlotKey: null },
      { slotKey: 'contact-1-verify-0', contactId: SQL_C2, contactOrdinal: 1, phase: 'VERIFY', provider: 'millionverifier', toolId: 'contact_email.verify.millionverifier', toolVersion: '1.0.0', quoteMicrousd: '1780', pricingVersion: 'p1', dependsOnSlotKey: 'contact-1-finder' },
    ],
    limits: { authorityCapMicrousd: '500000', companyCapMicrousd: '500000', contactCapMicrousd: '150000', finderCompanyMax: 10, finderContactMax: 3, verifyAddressMax: 6, maxContacts: 10 } });
}
function sqlHead(plan: ReturnType<typeof sqlPlan>, snapshot: unknown = null) {
  return { id: SQL_EXEC, workspace_id: SQL_W, company_id: SQL_COMPANY, authority_id: SQL_A, account_id: SQL_ACCOUNT, generation: 1, account_key: 'account-key', entrypoint: 'http', business_run_id: null, status: 'PREPARED', frozen_limits: { caps: plan.limits, admittedAtMs: 1000, deadlineAtMs: 601000, targetCount: 2, executionOptions: { lawfulBasisKind: 'legitimate_interest', tier: 'B' } }, target_snapshot: plan.targets, result_snapshot: snapshot };
}
function sqlFinderRow(contactId: string, ordinal: number, stepId: string, operationId: string, digest: string) {
  return { id: stepId, contact_id: contactId, contact_ordinal: ordinal, slot_key: `contact-${ordinal}-finder`, phase: 'FINDER', provider: 'hunter', tool_id: 'contact_email.find.hunter', tool_version: '1.0.0', pricing_version: 'p1', depends_on_slot_key: null, quote_microusd: 1700n, dispatch_phase: 'SETTLED', domain_state: 'APPLIED', budget_operation_id: operationId, budget_status: 'SETTLED', input_fingerprint: 'f'.repeat(64), operation_key: `op-${ordinal}`, candidate_ref: null, revision: 2,
    budget_original_id: operationId, budget_amount_unit: 'microusd', budget_reserved_microusd: 1700n, budget_result_schema_version: 'generic-operation-artifact-ref/v1', budget_result_schema: 'contact-email-find-hunter/v1', budget_result_digest: digest, budget_result_json: SQL_ART(operationId, digest), budget_receipt_usage: SQL_USAGE, budget_receipt_cost_basis: 'estimated_upper_bound' };
}
function sqlVerifyRow(contactId: string, ordinal: number, stepId: string) {
  return { id: stepId, contact_id: contactId, contact_ordinal: ordinal, slot_key: `contact-${ordinal}-verify-0`, phase: 'VERIFY', provider: 'millionverifier', tool_id: 'contact_email.verify.millionverifier', tool_version: '1.0.0', pricing_version: 'p1', depends_on_slot_key: `contact-${ordinal}-finder`, quote_microusd: 1780n, dispatch_phase: 'ADMITTED', domain_state: 'PENDING', budget_operation_id: null, input_fingerprint: null, operation_key: null, candidate_ref: null, revision: 1,
    budget_original_id: null, budget_amount_unit: null, budget_reserved_microusd: null, budget_result_schema_version: null, budget_result_schema: null, budget_result_digest: null, budget_result_json: null, budget_receipt_usage: null, budget_receipt_cost_basis: null };
}
function sqlTx(options: { plan: ReturnType<typeof sqlPlan>; head: ReturnType<typeof sqlHead>; rows: unknown[]; plainName?: string; plainPoints?: unknown[]; state?: { snapshot: unknown; remaining: number; status: string; updates: string[]; contactsLocked: string[]; headSql: string[] } }) {
  const state = options.state ?? { snapshot: options.head.result_snapshot, remaining: 2, status: 'PREPARED', updates: [] as string[], contactsLocked: [] as string[], headSql: [] as string[] };
  const tx = {
    canonicalContact: { findUnique: vi.fn(async () => ({ id: SQL_C1, fullName: options.plainName ?? 'Plain Person', companyId: SQL_COMPANY, company: { name: 'Plain Co', domain: 'plain.example.invalid' } })) },
    contactPoint: { findMany: vi.fn(async () => options.plainPoints ?? [{ id: SQL_P1, type: 'email', value: 'plain@plain.example.invalid', status: 'ACTIVE', verificationState: 'UNKNOWN', validSince: null, verifiedAt: null, nextReverifyAt: null, lastVerificationEventId: null, confidence: null }]) },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      state.headSql.push(text);
      if (text.includes('public.lock_contact_enrichment_account_v1')) return [{ account_id: SQL_ACCOUNT, authority_id: SQL_A, generation: 1 }];
      if (text.includes('SELECT s.id::text,s.contact_id::text')) { const id = values.find((value) => value === SQL_C1 || value === SQL_C2); return (options.rows as Array<{ contact_id: string }>).filter((row) => row.contact_id === id); }
      if (text.includes('FROM public.contact_enrichment_execution e JOIN public.tool_budget_account a')) return [options.head];
      if (text.includes('SELECT id::text FROM public.canonical_contact')) { const id = String(values[0]); state.contactsLocked.push(id); return [{ id }]; }
      if (text.includes('SELECT id::text FROM public.contact_point')) return (options.plainPoints ?? [{ id: SQL_P1 }]).map((point) => ({ id: (point as { id: string }).id }));
      if (text.includes('SELECT s.id::text AS step_id,o.id::text AS operation_id')) return (options.rows as Array<{ id: string; budget_original_id?: string | null; budget_status?: string | null; dispatch_phase: string; domain_state: string }>).map((row) => ({ step_id: row.id, operation_id: row.budget_original_id ?? null, operation_status: row.budget_status ?? null, dispatch_phase: row.dispatch_phase, domain_state: row.domain_state }));
      if (text.includes('SELECT s.contact_id::text,s.domain_state,s.dispatch_phase,o.id::text AS operation_id')) return (options.rows as Array<{ contact_id: string; budget_original_id?: string | null; budget_status?: string | null; dispatch_phase: string; domain_state: string }>).map((row) => ({ contact_id: row.contact_id, operation_id: row.budget_original_id ?? null, operation_status: row.budget_status ?? null, dispatch_phase: row.dispatch_phase, domain_state: row.domain_state }));
      if (text.includes('SELECT result_snapshot,frozen_limits,status')) return [{ result_snapshot: state.snapshot, frozen_limits: options.head.frozen_limits, status: state.status }];
      if (text.includes('SELECT o.id::text AS operation_id')) return [];
      if (text.includes('SELECT result_snapshot FROM public.contact_enrichment_execution WHERE')) { const snapshot = state.snapshot; return [{ result_snapshot: snapshot }]; }
      if (text.includes('SELECT result_snapshot,target_snapshot,frozen_limits,status')) return [{ result_snapshot: state.snapshot, target_snapshot: options.plan.targets, frozen_limits: options.head.frozen_limits, status: state.status }];
      if (text.includes("SET dispatch_phase='SETTLED'")) { state.updates.push('SETTLED'); return []; }
      if (text.includes("SET dispatch_phase='RELEASED'")) { state.updates.push('RELEASED'); return []; }
      if (text.includes('SELECT count(*)::bigint AS count')) return [{ count: BigInt(state.remaining) }];
      if (text.includes('SELECT contact_id::text,domain_state,dispatch_phase')) return (options.rows as Array<{ contact_id: string; domain_state: string; dispatch_phase: string }>).map((row) => ({ contact_id: row.contact_id, domain_state: row.domain_state, dispatch_phase: row.dispatch_phase }));
      if (text.includes("SET status='APPLY_PENDING'") && text.includes("status='RUNNING'")) { state.status = 'APPLY_PENDING'; state.updates.push('FINISH'); return []; }
      if (text.includes('SET result_snapshot=')) { const json = values.find((value) => typeof value === 'string' && value.startsWith('{')); const status = values.find((value) => value === 'COMPLETED' || value === 'APPLY_PENDING' || value === 'RUNNING'); if (typeof json === 'string') state.snapshot = JSON.parse(json); if (typeof status === 'string') state.status = status; state.updates.push('HEAD'); return []; }
      if (text.includes('SET status=') && !text.includes('SET result_snapshot=')) { const status = values.find((value) => value === 'COMPLETED' || value === 'APPLY_PENDING' || value === 'RUNNING'); if (typeof status === 'string') state.status = status; state.updates.push('HEAD'); return []; }
      throw new Error('unexpected SQL: ' + text.slice(0, 120));
    }),
  };
  return { tx, state };
}
function sqlDecision(contactId: string, pointId: string) {
  return { status: 'APPLIED' as const, contactId, reasonCode: 'STORED' as const, state: 'VALID' as const, pointRefs: [pointId], eventRefs: [], attemptRefs: [], newCandidatePoints: 1 };
}

describe('SQL domain store/guards F09–F13', () => {
  it('F09/F10/F12: loads real company_id, only the requested contact rows, and an existing committed decision', async () => {
    const plan = sqlPlan(); const committed = sqlDecision(SQL_C1, SQL_P1);
    const head = sqlHead(plan, { version: 1, targetCount: 2, newCandidatePoints: 1, contacts: [committed] });
    const { tx } = sqlTx({ plan, head, rows: [sqlFinderRow(SQL_C1, 0, SQL_F1, SQL_OPF1, SQL_DIG1), sqlVerifyRow(SQL_C1, 0, SQL_V1), sqlFinderRow(SQL_C2, 1, SQL_F2, SQL_OPF2, SQL_DIG2), sqlVerifyRow(SQL_C2, 1, SQL_V2)] });
    const store = createSqlEnrichmentDomainCommitStore({ withWorkspace: (_w, fn) => fn(tx) } as never, {});
    const state = await store.lockAndLoad(tx as never, { workspaceId: SQL_W, companyId: SQL_COMPANY, executionId: SQL_EXEC, contactId: SQL_C1 });
    expect(state?.originalReferences).toHaveLength(1);
    expect(state?.originalReferences[0]?.step.companyId).toBe(SQL_COMPANY);
    expect(state?.originalReferences[0]?.step.contactId).toBe(SQL_C1);
    expect(state?.originalReferences[0]?.step.stepId).toBe(SQL_F1);
    expect(state?.committed).toMatchObject({ status: 'APPLIED', contactId: SQL_C1, reasonCode: 'STORED' });
  });
  it('F10: candidate origin is bound to the same contact/execution/ordinal; cross-contact is rejected', async () => {
    const guards = createSqlEnrichmentStepGuards({} as never, {});
    const base = { status: 'SETTLED', amount_unit: 'microusd', result_schema: 'contact-email-find-hunter/v1', result_digest: SQL_DIG1, scope_key: SQL_W, account_id: SQL_ACCOUNT, generation: 1, step_execution_id: SQL_EXEC, step_contact_ordinal: 0, step_phase: 'FINDER', execution_company_id: SQL_COMPANY };
    const own = { ...base, step_contact_id: SQL_C1 };
    const cross = { ...base, step_contact_id: SQL_C2 };
    const row = { workspace_id: SQL_W, company_id: SQL_COMPANY, execution_id: SQL_EXEC, account_id: SQL_ACCOUNT, generation: 1, contact_id: SQL_C1, contact_ordinal: 0, slot_key: 'contact-0-verify-0', phase: 'VERIFY', provider: 'millionverifier', tool_id: 'contact_email.verify.millionverifier', tool_version: '1.0.0', quote_microusd: 1780n, pricing_version: 'p1', depends_on_slot_key: 'contact-0-finder' } as never;
    const candidate = (operationId: string) => ({ operationId, resultDigest: SQL_DIG1, artifactRef: SQL_ART(operationId, SQL_DIG1) }) as never;
    await expect(guards.assertCandidateOrigin({ $queryRaw: vi.fn(async () => [own]) } as never, row, candidate(SQL_OPF1))).resolves.toBeUndefined();
    await expect(guards.assertCandidateOrigin({ $queryRaw: vi.fn(async () => [cross]) } as never, row, candidate(SQL_OPF1))).rejects.toMatchObject({ code: 'CONTROL_MISMATCH' });
  });
  it('F11: raw locks select only IDs; plaintext comes from the transparent model and drives the input hash', async () => {
    const plan = sqlPlan(); const head = sqlHead(plan);
    const { tx, state } = sqlTx({ plan, head, rows: [sqlFinderRow(SQL_C1, 0, SQL_F1, SQL_OPF1, SQL_DIG1)], plainName: 'Plain Person', plainPoints: [{ id: SQL_P1, type: 'email', value: 'plain@plain.example.invalid', status: 'ACTIVE', verificationState: 'UNKNOWN', validSince: null, verifiedAt: null, nextReverifyAt: null, lastVerificationEventId: null, confidence: null }] });
    const store = createSqlEnrichmentDomainCommitStore({ withWorkspace: (_w, fn) => fn(tx) } as never, {});
    const loaded = await store.lockAndLoad(tx as never, { workspaceId: SQL_W, companyId: SQL_COMPANY, executionId: SQL_EXEC, contactId: SQL_C1 });
    expect(loaded?.currentInput.fullName).toBe('Plain Person');
    expect(loaded?.currentPoints[0]?.value).toBe('plain@plain.example.invalid');
    expect(state.headSql.every((sql) => !sql.includes('full_name') && !sql.includes('value'))).toBe(true);
    const version = enrichmentInputVersion({ fullName: loaded!.currentInput.fullName, domain: loaded!.currentInput.domain, companyName: loaded!.currentInput.companyName });
    const digest = contactTargetBeforeDigest({ inputVersion: version, points: loaded!.currentPoints });
    expect(version).not.toBe(enrichmentInputVersion({ fullName: 'Ciphertext enc:v1:x', domain: loaded!.currentInput.domain, companyName: loaded!.currentInput.companyName }));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
  it('F12: a committed decision replays without persist and cannot be downgraded', async () => {
    const plan = sqlPlan(); const committed = sqlDecision(SQL_C1, SQL_P1);
    const head = sqlHead(plan, { version: 1, targetCount: 2, newCandidatePoints: 1, contacts: [committed] });
    const { tx, state } = sqlTx({ plan, head, rows: [sqlFinderRow(SQL_C1, 0, SQL_F1, SQL_OPF1, SQL_DIG1)] });
    const store = createSqlEnrichmentDomainCommitStore({ withWorkspace: (_w, fn) => fn(tx) } as never, {});
    const persist = vi.spyOn(store, 'persist');
    const savePending = vi.spyOn(store, 'savePending');
    const committer = new EnrichmentDomainCommitter({ transactions: { withWorkspace: (_w, fn) => fn(tx) } as never, store, materialize: vi.fn(async () => null) as never, authorizeCurrent: vi.fn(async () => true) });
    const result = await committer.commitContact({ workspaceId: SQL_W, companyId: SQL_COMPANY, executionId: SQL_EXEC, contactId: SQL_C1 }, [SQL_F1], 'actor');
    expect(result).toMatchObject({ status: 'REPLAYED', reasonCode: 'STORED' });
    expect(persist).not.toHaveBeenCalled(); expect(savePending).not.toHaveBeenCalled();
    expect(state.status).toBe('PREPARED');
  });
  it('F13: persist maintains counts, releases unexecuted slots, and only completes when all converge', async () => {
    const plan = sqlPlan(); const head = sqlHead(plan); const state = { snapshot: null as unknown, remaining: 1, status: 'PREPARED', updates: [] as string[], contactsLocked: [] as string[], headSql: [] as string[] };
    const { tx } = sqlTx({ plan, head, rows: [], state });
    const store = createSqlEnrichmentDomainCommitStore({ withWorkspace: (_w, fn) => fn(tx) } as never, {});
    await store.persist(tx as never, { workspaceId: SQL_W, companyId: SQL_COMPANY, executionId: SQL_EXEC, contactId: SQL_C1 }, sqlDecision(SQL_C1, SQL_P1), []);
    expect(state.status).toBe('RUNNING');
    await (store as { finishAttempt?: (address: unknown) => Promise<void> }).finishAttempt?.({ workspaceId: SQL_W, companyId: SQL_COMPANY, executionId: SQL_EXEC });
    expect(state.status).toBe('APPLY_PENDING');
    state.remaining = 0;
    await store.persist(tx as never, { workspaceId: SQL_W, companyId: SQL_COMPANY, executionId: SQL_EXEC, contactId: SQL_C2 }, sqlDecision(SQL_C2, SQL_P2), []);
    expect(state.status).toBe('COMPLETED');
    const snapshot = state.snapshot as { version: number; targetCount: number; newCandidatePoints: number; contacts: unknown[] };
    expect(snapshot).toMatchObject({ version: 2, targetCount: 2, newCandidatePoints: 2 });
    expect(snapshot.contacts).toHaveLength(2);
    expect((snapshot as { quality?: unknown }).quality).toEqual({ version: 1, contacts: [] });
    expect(state.updates.filter((entry) => entry === 'RELEASED').length).toBeGreaterThanOrEqual(2);
    const record = { view: { executionId: SQL_EXEC, operationRef: '9'.repeat(64), planSha256: plan.planSha256, status: 'COMPLETED', accountId: SQL_ACCOUNT, authorityId: SQL_A, generation: 1 }, workspaceId: SQL_W, companyId: SQL_COMPANY, entrypoint: 'http' as const, businessRunId: null, requestSha256: plan.requestSha256, admissionRequestSha256: '8'.repeat(64), accountKey: 'account-key', currentAccount: { accountId: SQL_ACCOUNT, authorityId: SQL_A, generation: 1 }, plan, targetCount: 2, executionOptions: { lawfulBasisKind: 'legitimate_interest' as const, tier: 'B' as const }, createdAt: '2026-11-22T00:00:00.000Z', resultRevision: 3, resultSnapshot: snapshot, steps: [sqlVerifyRow(SQL_C1, 0, SQL_V1), sqlVerifyRow(SQL_C2, 1, SQL_V2)] };
    expect(() => buildContactEnrichmentQualityResult(record as never)).not.toThrow();
  });
  it('F13b: persists per-contact quality facts beside the decisions without resetting other contacts', async () => {
    const plan = sqlPlan(); const head = sqlHead(plan); const state = { snapshot: null as unknown, remaining: 2, status: 'PREPARED', updates: [] as string[], contactsLocked: [] as string[], headSql: [] as string[] };
    const { tx } = sqlTx({ plan, head, rows: [], state });
    const store = createSqlEnrichmentDomainCommitStore({ withWorkspace: (_w, fn) => fn(tx) } as never, {});
    const fact = (contactId: string) => ({ contactId, beforeStates: [], afterStates: ['VALID' as const], stockValidPersonal: false, organizationChannel: false, emailTypeUnknown: false, eligible: true, newCandidate: true, newValidPersonal: true, unresolved: false });
    await store.persist(tx as never, { workspaceId: SQL_W, companyId: SQL_COMPANY, executionId: SQL_EXEC, contactId: SQL_C1 }, sqlDecision(SQL_C1, SQL_P1), [], fact(SQL_C1));
    expect((state.snapshot as { quality: unknown }).quality).toEqual({ version: 1, contacts: [fact(SQL_C1)] });
    const replaced = { ...fact(SQL_C1), newCandidate: false, newValidPersonal: false, afterStates: [] as const, unresolved: true };
    await store.persist(tx as never, { workspaceId: SQL_W, companyId: SQL_COMPANY, executionId: SQL_EXEC, contactId: SQL_C1 }, { ...sqlDecision(SQL_C1, SQL_P1), reasonCode: 'NO_MATCH', state: null, pointRefs: [], newCandidatePoints: 0 }, [], replaced);
    expect((state.snapshot as { quality: unknown }).quality).toEqual({ version: 1, contacts: [replaced] });
    await store.persist(tx as never, { workspaceId: SQL_W, companyId: SQL_COMPANY, executionId: SQL_EXEC, contactId: SQL_C2 }, sqlDecision(SQL_C2, SQL_P2), [], fact(SQL_C2));
    expect((state.snapshot as { quality: { contacts: unknown[] } }).quality.contacts).toEqual([replaced, fact(SQL_C2)]);
  });
  it('F14: REDACTED DTO accepts minimal metadata with empty decisions and rejects a null snapshot', () => {
    const plan = sqlPlan();
    const record = (snapshot: unknown) => ({ view: { executionId: SQL_EXEC, operationRef: '9'.repeat(64), planSha256: plan.planSha256, status: 'REDACTED', accountId: SQL_ACCOUNT, authorityId: SQL_A, generation: 1 }, workspaceId: SQL_W, companyId: SQL_COMPANY, entrypoint: 'http' as const, businessRunId: null, requestSha256: plan.requestSha256, admissionRequestSha256: '8'.repeat(64), accountKey: 'account-key', currentAccount: { accountId: SQL_ACCOUNT, authorityId: SQL_A, generation: 1 }, plan: null, targetCount: 2, executionOptions: null, createdAt: '2026-11-22T00:00:00.000Z', resultRevision: 3, resultSnapshot: snapshot, steps: [sqlVerifyRow(SQL_C1, 0, SQL_V1)] });
    expect(() => buildContactEnrichmentQualityResult(record({ version: 1, targetCount: 2, newCandidatePoints: 0, contacts: [] }) as never)).not.toThrow();
    expect(() => buildContactEnrichmentQualityResult(record(null) as never)).toThrow(/INVALID_PLAN/);
  });
});


const ARTIFACT_ENV = Object.freeze({
  GENERIC_OPERATION_ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:9000",
  GENERIC_OPERATION_ARTIFACT_S3_BUCKET: "synthetic-bucket",
  GENERIC_OPERATION_ARTIFACT_S3_REGION: "us-east-1",
  GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY: "synthetic-access",
  GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY: "synthetic-secret",
  GENERIC_OPERATION_ARTIFACT_S3_FORCE_PATH_STYLE: "true",
});
function managedPrisma() {
  const prisma = {
    dataProvider: { findUnique: vi.fn(async () => ({ status: "ENABLED", config: null })) },
    sourcePolicy: { findUnique: vi.fn(async () => ({ retentionDays: 1, updatedAt: new Date(1000) })) },
    withWorkspace: vi.fn(async (_workspace: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
  };
  return prisma;
}
describe("F02/F15 real managed composition root", () => {
  it("builds the shared broker with all four trusted provider ports and the actual artifact budget port", async () => {
    const prisma = managedPrisma();
    let captured: ContactEnrichmentSafetyToolDeps | undefined;
    const broker = { invoke: vi.fn(), checkSourcePolicy: vi.fn(async () => ({ allowed: true })) };
    const managed = await createManagedContactEnrichmentSafety({
      prisma: prisma as never,
      env: { ...ARTIFACT_ENV, HUNTER_API_KEY: "fake-hunter", MILLIONVERIFIER_API_KEY: "fake-million" } as NodeJS.ProcessEnv,
      budgetStore: { readOperationResult: vi.fn() } as never,
      authority: { verifyWorkspaceGrant: vi.fn() } as never,
      grantConsumer: { consumeVerifiedWorkspaceGrantInTransaction: vi.fn() } as never,
      buildBroker: (ports) => { captured = ports; return broker as never; },
    });
    expect(captured).toBeDefined();
    expect(Object.keys(captured!.providers).sort()).toEqual(["emailable", "hunter", "millionverifier", "zerobounce"]);
    expect(typeof captured!.currentProvider).toBe("function");
    expect(typeof captured!.loadTrustedInput).toBe("function");
    expect(managed.broker).toBe(broker);
    expect(managed.service).toBeDefined();
    expect(managed.unavailableReason).toBeUndefined();
  });
  it("passes the real broker into the preparer so the original SMTP fallback vote is present only when eligible", async () => {
    const base = world();
    const smtpEnv = { HUNTER_API_KEY: "fake-hunter", MILLIONVERIFIER_API_KEY: "fake-million", EMAIL_VERIFY_SMTP_PROBE_ENABLED: "true" } as NodeJS.ProcessEnv;
    const broker = { invoke: vi.fn(), checkSourcePolicy: vi.fn(async () => ({ allowed: true })) };
    const withBroker = createContactEnrichmentSafetyPreparer({ prisma: base.prisma as never, env: smtpEnv, broker: broker as never, clock: () => new Date(1000), authorizeContact: base.authorizeContact, artifactsConfigured: base.artifactsConfigured });
    const prepared = await withBroker(base.input);
    expect(prepared.status).toBe("PREPARED");
    if (prepared.status === "PREPARED") expect(prepared.plan.slots.map((slot) => slot.provider)).toEqual(["hunter", "millionverifier", "smtp_self"]);
    const withoutBroker = createContactEnrichmentSafetyPreparer({ prisma: base.prisma as never, env: smtpEnv, clock: () => new Date(1000), authorizeContact: base.authorizeContact, artifactsConfigured: base.artifactsConfigured });
    const noBrokerPlan = await withoutBroker(base.input);
    expect(noBrokerPlan.status).toBe("PREPARED");
    if (noBrokerPlan.status === "PREPARED") expect(noBrokerPlan.plan.slots.some((slot) => slot.provider === "smtp_self")).toBe(false);
    const disabled = world();
    disabled.prisma.dataProvider.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => ({ status: where.key === "smtp_self" ? "DISABLED" : "ENABLED", config: null }));
    const killSwitchOff = createContactEnrichmentSafetyPreparer({ prisma: disabled.prisma as never, env: smtpEnv, broker: broker as never, clock: () => new Date(1000), authorizeContact: disabled.authorizeContact, artifactsConfigured: disabled.artifactsConfigured });
    const killSwitchPlan = await killSwitchOff(disabled.input);
    expect(killSwitchPlan.status).toBe("PREPARED");
    if (killSwitchPlan.status === "PREPARED") expect(killSwitchPlan.plan.slots.some((slot) => slot.provider === "smtp_self")).toBe(false);
  });
});


/* ===== v6 remediation flow tests (append to contact-enrichment-safety.composition.spec.ts) ===== */
describe('v6 remediation: current-fact flow, stop rules, cache/circuit, recover and legacy response', () => {
  const W = '10000000-0000-4000-8000-000000000001', C = '10000000-0000-4000-8000-000000000002', A = '10000000-0000-4000-8000-000000000003', ACCOUNT = '10000000-0000-4000-8000-000000000004', EXEC = '10000000-0000-4000-8000-000000000005', RUN = '10000000-0000-4000-8000-000000000006';
  const CA = '10000000-0000-4000-8000-000000000011', CB = '10000000-0000-4000-8000-000000000012';
  const binding = { authorityId: A, replay: false, scopeKey: W, accountKey: ['discovery.run', 'discovery_run', 'request:' + 'a'.repeat(64), 'a'.repeat(64)].join(':'), purpose: 'discovery.run' as const, subjectType: 'discovery_run', subjectId: 'request:' + 'a'.repeat(64), requestSha256: 'a'.repeat(64) };
  const OP = (n: number) => `10000000-0000-4000-8000-${String(100 + n).padStart(12, '0')}`;
  const STEP = (n: number) => `10000000-0000-4000-8000-${String(200 + n).padStart(12, '0')}`;
  const ART = '10000000-0000-4000-8000-000000000099';
  type Verdict = 'VALID' | 'INVALID' | 'UNKNOWN' | 'CATCH_ALL_RISKY';
  interface Opts {
    contacts?: 1 | 2; finder?: 'hit' | 'miss'; verifiers?: Array<{ provider: 'millionverifier' | 'emailable' | 'zerobounce'; state: Verdict }>;
    reusable?: { outcome: string; emailState: string | null } | null; circuitOpen?: boolean; circuitState?: 'CLOSED' | 'OPEN_FRESH' | 'OPEN_EXPIRED' | 'HALF_OPEN'; finderError?: boolean; attemptRows?: Array<{ requestHash: string; outcome: string; emailState?: string | null; attemptedAt: Date }>; useDefaultAttemptCache?: boolean; crash?: boolean; tier?: 'A' | 'B'; deadlinePast?: boolean; uncertain?: boolean; currentEmailPoint?: boolean;
  }
  function flowWorld(options: Opts = {}) {
    const contacts = options.contacts ?? 1;
    const contactIds = [CA, CB].slice(0, contacts);
    const verifiers = options.verifiers ?? [];
    const targets = contactIds.map((contactId, ordinal) => ({ contactId, contactOrdinal: ordinal, inputVersion: enrichmentInputVersion({ fullName: `Person ${ordinal}`, domain: 'company.example.invalid', companyName: 'Synthetic Company' }), beforeDigest: contactTargetBeforeDigest({ inputVersion: enrichmentInputVersion({ fullName: `Person ${ordinal}`, domain: 'company.example.invalid', companyName: 'Synthetic Company' }), points: [] }), pointRefs: [] }));
    const slots = contactIds.flatMap((contactId, ordinal) => {
      const finder = { slotKey: `c${ordinal}-finder`, contactId, contactOrdinal: ordinal, phase: 'FINDER' as const, provider: 'hunter', toolId: 'contact_email.find.hunter', toolVersion: '1.0.0', quoteMicrousd: '1700', pricingVersion: 'p-finder', dependsOnSlotKey: null as string | null };
      const verify = verifiers.map((v, position) => ({ slotKey: `c${ordinal}-verify-${position}`, contactId, contactOrdinal: ordinal, phase: 'VERIFY' as const, provider: v.provider, toolId: `contact_email.verify.${v.provider}`, toolVersion: '1.0.0', quoteMicrousd: v.provider === 'millionverifier' ? '1780' : v.provider === 'emailable' ? '7600' : '9000', pricingVersion: `p-${v.provider}`, dependsOnSlotKey: position === 0 ? finder.slotKey : `c${ordinal}-verify-${position - 1}` }));
      return [finder, ...verify];
    });
    const admittedAtMs = options.deadlinePast ? 100 : 1000;
    const deadlineAtMs = options.deadlinePast ? 500 : 601_000;
    const plan = buildFrozenEnrichmentPlan({ workspaceId: W, companyId: C, entrypoint: 'discovery_run', businessRunId: RUN, requestSha256: 'a'.repeat(64), admittedAtMs, deadlineAtMs,
      targets, slots, limits: { authorityCapMicrousd: '250000', companyCapMicrousd: '250000', contactCapMicrousd: '150000', finderCompanyMax: 10, finderContactMax: 3, verifyAddressMax: 6, maxContacts: 10 } });
    let index = 0;
    const steps = slots.map((slot) => ({ id: STEP(++index), slot, input_fingerprint: null as string | null, operation_key: null as string | null, budget_operation_id: null as string | null, candidate_ref: null as unknown, revision: 1, dispatch_phase: 'ADMITTED' as string, domain_state: 'PENDING' as string,
      ledger: null as null | { operationKey: string; operationId: string; status: string; charged: bigint; digest: string; receipt: Record<string, unknown>; artifact: boolean } }));
    if (options.uncertain) { const finder = steps.find((step) => step.slot.phase === 'FINDER')!; finder.input_fingerprint = 'f'.repeat(64); finder.operation_key = 'original-op'; finder.budget_operation_id = OP(1); finder.revision = 2; finder.dispatch_phase = 'RESULT_UNKNOWN'; finder.ledger = { operationKey: 'original-op', operationId: OP(1), status: 'RESULT_UNKNOWN', charged: null, digest: null, receipt: null, artifact: false }; }
    const decisions = new Map<string, unknown>();
    const snapshot = { contacts: [] as unknown[] };
    const head = () => ({ id: EXEC, workspace_id: W, company_id: C, authority_id: A, account_id: ACCOUNT, generation: 1, account_key: binding.accountKey, entrypoint: 'discovery_run', business_run_id: RUN, request_sha256: plan.requestSha256,
      admission_request_sha256: createHash('sha256').update(canonicalSafetyJson({ version: 1, entrypoint: 'discovery_run', businessRunId: RUN, lawfulBasis: { basis: 'legitimate_interest', ref: null, note: null }, contactIds: null, maxProviders: 3, maxProbe: 6, attemptId: null })).digest('hex'),
      operation_ref: 'd'.repeat(64), protocol_version: 1, plan_sha256: plan.planSha256, status: decisions.size === 0 ? 'PREPARED' : decisions.size < targets.length ? 'RUNNING' : 'APPLY_PENDING',
      frozen_limits: { caps: plan.limits, admittedAtMs, deadlineAtMs, targetCount: targets.length, executionOptions: { lawfulBasisKind: 'legitimate_interest', tier: options.tier ?? 'B' } },
      target_snapshot: plan.targets, created_at: new Date(1000), result_revision: 1, result_snapshot: decisions.size > 0 ? { version: 1, targetCount: targets.length, newCandidatePoints: snapshot.contacts.reduce((n, d) => n + ((d as { newCandidatePoints?: number }).newCandidatePoints ?? 0), 0), contacts: snapshot.contacts } : null,
      current_account_id: ACCOUNT, current_authority_id: A, current_generation: 1 });
    const row = (step: typeof steps[number]) => ({ id: step.id, workspace_id: W, company_id: C, execution_id: EXEC, contact_id: step.slot.contactId, contact_ordinal: step.slot.contactOrdinal, slot_key: step.slot.slotKey, phase: step.slot.phase, provider: step.slot.provider, tool_id: step.slot.toolId, tool_version: '1.0.0', quote_microusd: BigInt(step.slot.quoteMicrousd), pricing_version: step.slot.pricingVersion, depends_on_slot_key: step.slot.dependsOnSlotKey,
      input_fingerprint: step.input_fingerprint, operation_key: step.operation_key, budget_operation_id: step.budget_operation_id, candidate_ref: step.candidate_ref, revision: step.revision, dispatch_phase: step.dispatch_phase, domain_state: step.domain_state,
      authority_id: A, account_id: ACCOUNT, generation: 1, account_key: binding.accountKey, execution_status: head().status, deadline_open: true,
      budget_original_id: step.ledger ? step.ledger.operationId : null, budget_status: step.ledger ? step.ledger.status : null, budget_amount_unit: step.ledger ? 'microusd' : null, budget_reserved_microusd: step.ledger ? BigInt(step.slot.quoteMicrousd) : null, budget_charged_microusd: step.ledger?.status === 'SETTLED' ? step.ledger.charged : null,
      budget_result_schema: step.ledger?.status === 'SETTLED' ? (step.slot.phase === 'FINDER' ? 'contact-email-find-hunter/v1' : `contact-email-verify-${step.slot.provider}/v1`) : null, budget_result_digest: step.ledger?.status === 'SETTLED' ? step.ledger.digest : null,
      budget_result_json: step.ledger?.status === 'SETTLED' ? (step.slot.phase === 'FINDER' ? { schemaVersion: 'generic-operation-artifact-ref/v1', operationId: step.ledger.operationId, artifactId: ART, resultSchema: 'contact-email-find-hunter/v1', sha256: step.ledger.digest, mediaType: 'application/octet-stream', sizeBytes: '128', expiresAt: '2099-01-01T00:00:00.000Z' } : { kind: 'tool', schema: `contact-email-verify-${step.slot.provider}/v1`, data: {} }) : null,
      budget_receipt_usage: step.ledger?.status === 'SETTLED' ? step.ledger.receipt!.usage : null, budget_receipt_cost_basis: step.ledger?.status === 'SETTLED' ? 'estimated_upper_bound' : null });
    const bindingRow = (step: typeof steps[number]) => ({
      ...row(step), current_account_id: ACCOUNT, current_authority_id: A, current_generation: 1,
      original_operation_id: step.ledger ? step.ledger.operationId : null,
      original_scope_key: step.ledger ? W : null,
      original_account_id: step.ledger ? ACCOUNT : null,
      original_generation: step.ledger ? 1 : null,
      original_operation_key: step.ledger ? step.operation_key : null,
      ledger_status: step.ledger ? step.ledger.status : null,
      amount_unit: step.ledger ? 'microusd' : null,
      reserved_microusd: step.ledger ? BigInt(step.slot.quoteMicrousd) : null,
      result_schema_version: step.ledger?.status === 'SETTLED' ? (step.slot.phase === 'FINDER' ? 'generic-operation-artifact-ref/v1' : 'generic-operation-projection/v1') : null,
      result_schema: step.ledger?.status === 'SETTLED' ? (step.slot.phase === 'FINDER' ? 'contact-email-find-hunter/v1' : `contact-email-verify-${step.slot.provider}/v1`) : null,
      result_digest: step.ledger?.status === 'SETTLED' ? step.ledger.digest : null,
      result_json: step.ledger?.status === 'SETTLED' ? (step.slot.phase === 'FINDER' ? { schemaVersion: 'generic-operation-artifact-ref/v1', operationId: step.ledger.operationId, artifactId: ART, resultSchema: 'contact-email-find-hunter/v1', sha256: step.ledger.digest, mediaType: 'application/octet-stream', sizeBytes: '128', expiresAt: '2099-01-01T00:00:00.000Z' } : { kind: 'tool', schema: `contact-email-verify-${step.slot.provider}/v1`, data: {} }) : null,
      receipt_usage: step.ledger?.status === 'SETTLED' ? step.ledger.receipt!.usage : null,
      receipt_cost_basis: step.ledger?.status === 'SETTLED' ? 'estimated_upper_bound' : null,
    });
    const tx = { $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?'); const stepByValue = () => steps.find((candidate) => values.some((value) => String(value) === candidate.id))!;
      if (sql.includes('SELECT e.id::text,e.workspace_id::text') && sql.includes('FROM public.contact_enrichment_execution e JOIN')) return [head()];
      if (sql.includes('SELECT s.id::text,s.workspace_id::text') && sql.includes('ORDER BY s.slot_ordinal')) return steps.map(row);
      if (sql.includes('SET input_fingerprint=')) { const s = stepByValue(); s.input_fingerprint = String(values[0]); s.operation_key = String(values[1]); s.candidate_ref = values[2] === null || values[2] === undefined ? null : typeof values[2] === 'string' ? JSON.parse(String(values[2])) : values[2]; s.revision += 1; return [{ id: s.id }]; }
      if (sql.includes('original_operation_id') && sql.includes('FROM public.contact_enrichment_execution_step s')) { const s = stepByValue(); return [bindingRow(s)]; }
      if (sql.includes('FROM public.contact_enrichment_execution_step s JOIN') && sql.includes('s.id=')) { const s = stepByValue(); return [row(s)]; }
      if (sql.includes('public.lock_contact_enrichment_authority_v1')) return [{ id: A, scope_key: W, revoked_at: null, usable: true }];
      if (sql.includes('public.lock_contact_enrichment_account_v1')) return [{ account_id: ACCOUNT, id: ACCOUNT, scope_key: W, account_key: binding.accountKey, authority_id: A, generation: 1, authorized_cap_microusd: 250000n, closed_at: null, ref_count: 1 }];
      if (sql.includes('public.lock_enrichment_execution_v1')) return [{ id: EXEC, account_id: ACCOUNT }];
      if (sql.includes('public.lock_enrichment_execution_step_anchor_v1')) { const stepId = String(values[values.length - 1]); return [{ execution_id: EXEC, step_id: stepId }]; }
      if (sql.includes('public.lock_enrichment_step_v1')) { const s = stepByValue(); return [{ id: s.id, revision: s.revision, dispatch_phase: s.dispatch_phase, budget_operation_id: s.budget_operation_id, operation_key: s.operation_key, result_digest: null, receipt: null, artifact_reference: null }]; }
      if (sql.includes('public.lock_contact_enrichment_operation_v1')) { const step = steps.find((s) => values.some((value) => String(value) === s.operation_key))!; const operationId = OP(steps.indexOf(step) + 1); return [{ operation_id: operationId, scope_key: W, account_id: ACCOUNT, generation: 1, operation_key: step.operation_key, status: 'RESERVED', amount_unit: 'microusd', reserved_microusd: BigInt(step.slot.quoteMicrousd) }]; }
      if (sql.includes('SELECT id::text AS operation_id') && sql.includes('FROM public.tool_budget_operation')) { const step = steps.find((s) => values.some((value) => String(value) === s.operation_key))!; const operationId = OP(steps.indexOf(step) + 1); return [{ operation_id: operationId, scope_key: W, account_id: ACCOUNT, generation: 1, operation_key: step.operation_key, status: 'RESERVED', amount_unit: 'microusd', reserved_microusd: BigInt(step.slot.quoteMicrousd) }]; }
      if (sql.includes('UPDATE public.contact_enrichment_execution_step') && sql.includes('SET budget_operation_id=')) { const s = stepByValue(); s.budget_operation_id = OP(steps.indexOf(s) + 1); s.dispatch_phase = 'RESERVED'; s.revision += 1; s.ledger = { operationKey: s.operation_key!, operationId: s.budget_operation_id, status: 'RESERVED', charged: null, digest: null, receipt: null, artifact: false }; return [{ id: s.id }]; }
      if (sql.includes('SELECT id::text,revision,dispatch_phase') && sql.includes('FOR UPDATE')) { const s = stepByValue(); return [{ id: s.id, revision: s.revision, dispatch_phase: s.dispatch_phase, budget_operation_id: s.budget_operation_id, operation_key: s.operation_key, result_digest: null, receipt: null, artifact_reference: null }]; }
      if (sql.includes('SET result_digest=')) { const s = stepByValue(); s.dispatch_phase = 'SETTLED_WAITING_APPLY'; s.revision += 1; const verify = s.slot.phase !== 'FINDER'; s.ledger = { operationKey: s.operation_key!, operationId: s.budget_operation_id!, status: 'SETTLED', charged: BigInt(s.slot.quoteMicrousd), digest: verify ? 'c'.repeat(64) : 'b'.repeat(64), artifact: !verify, receipt: receiptFor(s, s.budget_operation_id!) }; return [{ id: s.id }]; }
      if (sql.includes("SET dispatch_phase='RESULT_UNKNOWN'")) return [];
            if (sql.includes('AS execution_id,s.id::text AS step_id')) { const stepId = String(values[values.length - 1]); return [{ execution_id: EXEC, step_id: stepId }]; }
throw new Error('unexpected flow SQL: ' + sql.slice(0, 140));
    }), $executeRawUnsafe: vi.fn(async () => 1),
      contactPoint: { upsert: vi.fn(async () => ({ id: '10000000-0000-4000-8000-000000000301', verificationState: 'UNKNOWN', validSince: null, nextReverifyAt: null })), update: vi.fn(async () => ({ id: '10000000-0000-4000-8000-000000000301' })) },
      contactPointVerificationEvent: { count: vi.fn(async () => 0), create: vi.fn(async () => ({ id: '10000000-0000-4000-8000-000000000302' })), findUnique: vi.fn(async () => null) },
      contactEnrichmentAttempt: { create: vi.fn(async () => ({ id: '10000000-0000-4000-8000-000000000303', providerKey: 'hunter', requestHash: 'x'.repeat(64), outcome: 'hit', errorCode: null, emailState: null, costMicrousd: 1700n, attemptedAt: new Date(1000) })), findUnique: vi.fn(async ({ where }: { where: { workspaceId_providerKey_requestHash: { requestHash: string } } }) => (options.attemptRows ?? []).find((row) => row.requestHash === where.workspaceId_providerKey_requestHash.requestHash) ?? null), findFirst: vi.fn(async ({ where }: { where: { outcome: string; attemptedAt: { gte: Date } } }) => (options.attemptRows ?? []).filter((row) => row.outcome === where.outcome && row.attemptedAt.getTime() >= where.attemptedAt.gte.getTime()).sort((a, b) => b.attemptedAt.getTime() - a.attemptedAt.getTime())[0] ?? null), update: vi.fn(async () => ({ id: '10000000-0000-4000-8000-000000000303' })) } };
    const prisma = { withWorkspace: vi.fn(async (_workspace: string, fn: (tx: unknown) => Promise<unknown>) => fn(tx)) };
    const finderPayload = (contactId: string) => options.finder === 'miss'
      ? { status: 'miss', email: null, providerConfidence: null, acceptAll: null, pattern: null, reason: 'no_match' }
      : { status: 'hit', email: `${contactId.slice(-2)}@company.example.invalid`, providerConfidence: 90, acceptAll: false, pattern: null, reason: 'candidate_found' };
    const receiptFor = (step: typeof steps[number], operationId: string) => { const verify = step.slot.phase !== 'FINDER'; const schema = verify ? `contact-email-verify-${step.slot.provider}/v1` : 'contact-email-find-hunter/v1'; return { schemaVersion: 'durable-execution-receipt/v1', scopeKey: W, authorityId: A, accountId: ACCOUNT, operationId, operationKey: step.operation_key, resultStrategy: verify ? 'typed_projection' : 'artifact_reference', resultSchema: schema, resultDigest: step.ledger?.digest ?? 'b'.repeat(64), artifactId: verify ? null : ART, usage: { currency: 'USD', unit: 'microusd', callCount: 1, chargedMicrousd: step.slot.quoteMicrousd, upperBoundMicrousd: step.slot.quoteMicrousd }, costBasis: 'estimated_upper_bound', status: 'SETTLED' }; };
    const verifyIndex = new Map<string, number>();
    const broker = { checkSourcePolicy: vi.fn(async () => ({ allowed: true })), invoke: vi.fn(async (toolId: string, input: { stepId: string }, ctx: { beforePhysicalWire?: () => Promise<void> }) => {
      await ctx.beforePhysicalWire!(); const step = steps.find((s) => s.id === input.stepId)!; const operationId = step.budget_operation_id!;
      if (step.slot.phase === 'FINDER') {
        if (options.finderError) throw new Error('synthetic_provider_error');
        const data = finderPayload(step.slot.contactId);
        return { data, costCents: 0.17, costMicrousd: '1700', durableReceipt: receiptFor(step, operationId) };
      }
      const position = verifyIndex.get(step.slot.contactId) ?? 0; verifyIndex.set(step.slot.contactId, position + 1);
      const verdict = verifiers[position]?.state ?? 'UNKNOWN'; const quote = Number(step.slot.quoteMicrousd);
      const data = { providerKey: step.slot.provider, state: verdict, catchAll: 'unknown', catchAllClass: 'unknown', score: verdict === 'VALID' ? 90 : 10, acceptAll: false, disposable: null, role: null, reason: 'provider_verdict', costBasis: 'estimated_upper_bound' };
      return { data: { data, costCents: quote / 10000, costMicrousd: step.slot.quoteMicrousd }, costCents: quote / 10000, costMicrousd: step.slot.quoteMicrousd, durableReceipt: receiptFor(step, operationId) };
    }) };
    const bound = (step: typeof steps[number]) => ({ stepId: step.id, slotKey: step.slot.slotKey, contactId: step.slot.contactId, contactOrdinal: step.slot.contactOrdinal, phase: step.slot.phase, provider: step.slot.provider, toolId: step.slot.toolId, toolVersion: '1.0.0', quoteMicrousd: step.slot.quoteMicrousd, pricingVersion: step.slot.pricingVersion, dependsOnSlotKey: step.slot.dependsOnSlotKey, executionId: EXEC, workspaceId: W, companyId: C, authorityId: A, accountId: ACCOUNT, generation: 1, accountKey: binding.accountKey, inputFingerprint: step.input_fingerprint!, operationKey: step.operation_key!, candidateRef: step.candidate_ref as never, revision: step.revision, budgetOperationId: step.budget_operation_id });
    const materialize = vi.fn(async (stepId: string) => {
      const step = steps.find((s) => s.id === stepId)!; if (!step.ledger) return null;
      if (step.slot.phase === 'FINDER') return { phase: 'FINDER' as const, step: bound(step) as never, reference: { stepId: step.id, producerId: step.slot.toolId, resultSchema: 'contact-email-find-hunter/v1', resultDigest: step.ledger.digest, durableReceipt: receiptFor(step, step.ledger.operationId) } as never, result: finderPayload(step.slot.contactId) as never };
      const position = [...steps.filter((s) => s.slot.contactOrdinal === step.slot.contactOrdinal && s.slot.phase !== 'FINDER')].indexOf(step);
      const verdict = verifiers[position]?.state ?? 'UNKNOWN'; const quote = Number(step.slot.quoteMicrousd);
      return { phase: 'VERIFY' as const, step: bound(step) as never, reference: { stepId: step.id, producerId: step.slot.toolId, resultSchema: `contact-email-verify-${step.slot.provider}/v1`, resultDigest: step.ledger.digest, durableReceipt: receiptFor(step, step.ledger.operationId) } as never,
        result: { data: { providerKey: step.slot.provider, state: verdict, catchAll: 'unknown', catchAllClass: 'unknown', score: verdict === 'VALID' ? 90 : 10, acceptAll: false, disposable: null, role: null, reason: 'provider_verdict', costBasis: 'estimated_upper_bound' }, costCents: quote / 10000, costMicrousd: step.slot.quoteMicrousd } as never };
    });
    const store = {
      readCommitted: vi.fn(async (_tx: unknown, address: { contactId: string }) => decisions.get(address.contactId) ?? null),
      lockAndLoad: vi.fn(async (_tx: unknown, address: { contactId: string }) => {
        const contactSteps = steps.filter((s) => s.slot.contactId === address.contactId);
        const refs = contactSteps.filter((s) => s.ledger !== null && s.ledger.status === 'SETTLED').map((s) => ({ step: bound(s) as never, reference: { stepId: s.id, producerId: s.slot.toolId, resultSchema: s.slot.phase === 'FINDER' ? 'contact-email-find-hunter/v1' : `contact-email-verify-${s.slot.provider}/v1`, resultDigest: s.ledger!.digest, durableReceipt: receiptFor(s, s.ledger!.operationId) } as never }));
        return { workspaceId: W, companyId: C, executionId: EXEC, contactId: address.contactId, authorityId: A, accountId: ACCOUNT, generation: 1, businessRunId: RUN, target: targets.find((t) => t.contactId === address.contactId)!, currentInput: { fullName: `Person ${targets.find((t) => t.contactId === address.contactId)!.contactOrdinal}`, domain: 'company.example.invalid', companyName: 'Synthetic Company' }, currentPoints: options.currentEmailPoint ? [{ id: '10000000-0000-4000-8000-000000000401', type: 'email', value: 'existing@company.example.invalid', status: 'ACTIVE', verificationState: 'VALID', validSince: null, verifiedAt: null, nextReverifyAt: null, lastVerificationEventId: null, confidence: null }] : [], originalReferences: refs, committed: decisions.get(address.contactId) ?? null, redacted: false, lawfulBasis: { basis: 'legitimate_interest' }, pendingOperationIds: [], originalSmtpAcknowledgements: [] };
      }),
      persist: vi.fn(async (_tx: unknown, address: { contactId: string }, decision: unknown) => { decisions.set(address.contactId, decision); snapshot.contacts = [...snapshot.contacts, decision]; }),
      savePending: vi.fn(async () => undefined),
    };
    const deps = { prisma: prisma as never, authority: { verifyWorkspaceGrant: vi.fn() } as never, broker: broker as never, grantConsumer: { consumeVerifiedWorkspaceGrantInTransaction: vi.fn() } as never,
      guards: { assertCurrentSubjectAndPolicy: vi.fn(async (_tx: unknown, row: { pricing_version: string }) => ({ pricingVersion: row.pricing_version })), assertCandidateOrigin: vi.fn(async () => undefined) } as never,
      store: store as never, budgets: { readOperationResult: vi.fn(async () => ({ status: 'NOT_FOUND' })) } as never, artifacts: { readVerified: vi.fn(), recoverUnknown: vi.fn(async () => ({ reference: {}, durableReceipt: {} })) } as never, finderMaterializer: { resultSchema: 'contact-email-find-hunter/v1', materialize: vi.fn() } as never,
      materializeForDomain: materialize as never, authorizeCurrent: vi.fn(async () => true),
      acknowledge: vi.fn(async (request: { transaction: unknown; apply: (tx: unknown) => Promise<unknown> }) => ({ status: 'APPLIED' as const, value: await request.apply(request.transaction) as never })),
      loadTrustedInput: vi.fn(async (stepId: string) => { const step = steps.find((s) => s.id === stepId)!; return { step: bound(step) as never, finder: step.slot.phase === 'FINDER' ? { fullName: `Person ${step.slot.contactOrdinal}`, domain: 'company.example.invalid', companyName: 'Synthetic Company' } : null, verification: null }; }),
      prepare: vi.fn(async () => ({ status: 'NOT_ADMITTED', reasonCode: 'GOVERNANCE_PENDING' })) as never, authorizeRecovery: vi.fn(async () => true),
      ...(options.useDefaultAttemptCache ? {} : { reusableAttempt: vi.fn(async () => options.reusable ?? null) }), recordAttempt: vi.fn(async () => undefined),
      circuit: { load: vi.fn(async () => { const mode = options.circuitState ?? (options.circuitOpen ? 'OPEN_FRESH' : 'CLOSED'); const openedAt = mode === 'OPEN_FRESH' ? new Date().toISOString() : mode === 'OPEN_EXPIRED' ? new Date(Date.now() - 16 * 60_000).toISOString() : null; return mode === 'CLOSED' ? { status: 'CLOSED', windowStartedAt: null, windowSuccesses: 0, windowFailures: 0, consecutiveFailures: 0, openedAt: null, probeInFlight: false } : { status: mode === 'HALF_OPEN' ? 'HALF_OPEN' : 'OPEN', windowStartedAt: new Date(0).toISOString(), windowSuccesses: 0, windowFailures: 9, consecutiveFailures: 9, openedAt, probeInFlight: false }; }), save: vi.fn(async () => undefined) } };
    const seed = (decision: unknown) => { const contactId = (decision as { contactId: string }).contactId; decisions.set(contactId, decision); snapshot.contacts = [...snapshot.contacts, decision]; };
    return { deps, broker, store, plan, steps, decisions, materialize, seed };
  }
  const run = (x: ReturnType<typeof flowWorld>) => createContactEnrichmentSafetyRuntime(x.deps as never).service.executeRun({ workspaceId: W, companyId: C, businessRunId: RUN, binding, lawfulBasis: { basis: 'legitimate_interest' }, remainingMicrousd: '250000', actorId: 'discovery-run:test' });

  it('F05 uses the freshly persisted finder reference for the following VERIFY step', async () => {
    const x = flowWorld({ verifiers: [{ provider: 'millionverifier', state: 'VALID' }] }); const original = x.plan.planSha256; const quotes = x.plan.slots.map((s) => s.quoteMicrousd).join(',');
    const result = await run(x); expect(result.attempted).toBe(1); expect(x.broker.invoke).toHaveBeenCalledTimes(2); expect(x.steps[1]!.ledger).not.toBeNull();
    expect(x.plan.planSha256).toBe(original); expect(x.plan.slots.map((s) => s.quoteMicrousd).join(',')).toBe(quotes);
  });
  it('F06 each contact verification uses its own finder candidate', async () => {
    const x = flowWorld({ contacts: 2, verifiers: [{ provider: 'millionverifier', state: 'VALID' }] });
    await run(x); const verifyCalls = x.broker.invoke.mock.calls.filter(([tool]) => String(tool).startsWith('contact_email.verify'));
    expect(verifyCalls).toHaveLength(2);
    const verifySteps = x.steps.filter((s) => s.slot.phase === 'VERIFY');
    for (const verify of verifySteps) {
      const finder = x.steps.find((s) => s.slot.phase === 'FINDER' && s.slot.contactId === verify.slot.contactId)!;
      expect(finder.ledger).not.toBeNull();
      expect((verify.candidate_ref as { operationId: string }).operationId).toBe(finder.ledger!.operationId);
    }
  });
  it('F07 finder miss does not wire verification', async () => {
    const x = flowWorld({ finder: 'miss', verifiers: [{ provider: 'millionverifier', state: 'VALID' }] }); const result = await run(x);
    expect(x.broker.invoke).toHaveBeenCalledTimes(1); expect(result.results[0]?.status).toBe('not_found');
  });
  it('F07 primary INVALID stops before secondary', async () => {
    const x = flowWorld({ verifiers: [{ provider: 'millionverifier', state: 'INVALID' }, { provider: 'emailable', state: 'VALID' }] }); const result = await run(x);
    expect(x.broker.invoke).toHaveBeenCalledTimes(2); expect(result.results[0]?.status).toBe('invalid_all');
  });
  it('F07 two converged positive votes stop before arbiter', async () => {
    const x = flowWorld({ verifiers: [{ provider: 'millionverifier', state: 'VALID' }, { provider: 'emailable', state: 'VALID' }, { provider: 'zerobounce', state: 'VALID' }] }); const result = await run(x);
    expect(x.broker.invoke).toHaveBeenCalledTimes(3); expect(result.results[0]?.status).toBe('stored');
  });
  it('F07 unresolved two votes spend the arbiter once', async () => {
    const x = flowWorld({ verifiers: [{ provider: 'millionverifier', state: 'VALID' }, { provider: 'emailable', state: 'UNKNOWN' }, { provider: 'zerobounce', state: 'VALID' }] }); const result = await run(x);
    expect(x.broker.invoke).toHaveBeenCalledTimes(4); expect(result.results[0]?.status).toBe('stored');
  });
  it('F16 a reusable hit buys zero provider calls and reports REUSED', async () => {
    const x = flowWorld({ reusable: { outcome: 'hit', emailState: 'VALID' } }); const result = await run(x);
    expect(x.broker.invoke).not.toHaveBeenCalled(); expect(result.results[0]?.status).toBe('reused');
  });
  it('F17 an open circuit buys zero provider calls and records the original attempt', async () => {
    const x = flowWorld({ circuitOpen: true, verifiers: [{ provider: 'millionverifier', state: 'VALID' }] }); const result = await run(x);
    expect(x.broker.invoke).not.toHaveBeenCalled(); expect(x.deps.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'circuit_open' })); expect(result.results[0]?.status).not.toBe('stored');
  });
  it('F18 miss/pending/tier/deadline and real charges map honestly', async () => {
    const miss = flowWorld({ finder: 'miss', tier: 'A', deadlinePast: true }); const missResult = await run(miss);
    expect(missResult.tier).toBe('A'); expect(missResult.deadlineHit).toBe(true); expect(missResult.costMicrousd).toBe(1700); expect(missResult.results[0]?.status).toBe('not_found');
    const pending = flowWorld({ circuitOpen: true }); const pendingResult = await run(pending);
    expect(pendingResult.results[0]?.status).not.toBe('stored'); expect(pendingResult.costMicrousd).toBe(0);
  });
  it('F08 explicit recovery calls the original artifact recovery and applies with zero new wire', async () => {
    const x = flowWorld({ uncertain: true });
    const finder = x.steps.find((step) => step.slot.phase === 'FINDER')!;
    const operationId = finder.budget_operation_id!;
    const receipt = { schemaVersion: 'durable-execution-receipt/v1', scopeKey: W, authorityId: A, accountId: ACCOUNT, operationId, operationKey: finder.operation_key!, resultStrategy: 'artifact_reference', resultSchema: 'contact-email-find-hunter/v1', resultDigest: 'b'.repeat(64), artifactId: ART, usage: { currency: 'USD', unit: 'microusd', callCount: 1, chargedMicrousd: '1700', upperBoundMicrousd: '1700' }, costBasis: 'estimated_upper_bound', status: 'SETTLED' };
    const reference = { stepId: finder.id, producerId: 'contact_email.find.hunter', resultSchema: 'contact-email-find-hunter/v1', resultDigest: 'b'.repeat(64), durableReceipt: receipt };
    const spy = vi.spyOn(EnrichmentResultReader.prototype, 'recoverEnrichmentStepResult').mockResolvedValue({ status: 'SETTLED', reference } as never);
    try {
      const service = createContactEnrichmentSafetyRuntime(x.deps as never).service;
      const context = { userId: 'u1', workspaceId: W, roles: ['admin'], scopes: ['acquisition:write', 'contact-discovery:read', 'compliance:manage'] };
      await service.recoverEnrichmentExecution(context as never, C, 'd'.repeat(64)).catch(() => null);
      expect(spy).toHaveBeenCalledWith(finder.id, { workspaceId: W, companyId: C }, expect.any(Function));
      expect(x.broker.invoke).not.toHaveBeenCalled();
      expect(finder.ledger?.status).toBe('SETTLED');
    } finally { spy.mockRestore(); }
  });
  it('F16 a fresh miss row reuses locally with zero wire', async () => {
    const requestHash = enrichmentRequestHash(CA, 'hunter', { fullName: 'Person 0', domain: 'company.example.invalid', companyName: 'Synthetic Company' });
    const x = flowWorld({ finder: 'miss', useDefaultAttemptCache: true, attemptRows: [{ requestHash, outcome: 'miss', attemptedAt: new Date(Date.now() - 60 * 60_000) }] });
    const result = await run(x);
    expect(x.broker.invoke).not.toHaveBeenCalled(); expect(result.results[0]?.status).toBe('not_found');
  });
  it('F16 a stale miss row falls through and wires once', async () => {
    const requestHash = enrichmentRequestHash(CA, 'hunter', { fullName: 'Person 0', domain: 'company.example.invalid', companyName: 'Synthetic Company' });
    const x = flowWorld({ finder: 'miss', useDefaultAttemptCache: true, attemptRows: [{ requestHash, outcome: 'miss', attemptedAt: new Date(Date.now() - 2 * 86_400_000) }] });
    const result = await run(x);
    expect(x.broker.invoke).toHaveBeenCalledTimes(1); expect(result.results[0]?.status).toBe('not_found');
  });
  it('F16 a 90-day hit reuses with zero wire and reports REUSED', async () => {
    const requestHash = enrichmentRequestHash(CA, 'hunter', { fullName: 'Person 0', domain: 'company.example.invalid', companyName: 'Synthetic Company' });
    const x = flowWorld({ useDefaultAttemptCache: true, attemptRows: [{ requestHash, outcome: 'hit', emailState: 'VALID', attemptedAt: new Date(Date.now() - 10 * 86_400_000) }] });
    const result = await run(x);
    expect(x.broker.invoke).not.toHaveBeenCalled(); expect(result.results[0]?.status).toBe('reused');
  });
  it('F17 OPEN not expired stays wire 0; expired OPEN and CLOSED call and record success', async () => {
    const blocked = flowWorld({ circuitState: 'OPEN_FRESH' }); const blockedResult = await run(blocked);
    expect(blocked.broker.invoke).not.toHaveBeenCalled(); expect(blockedResult.results[0]?.status).not.toBe('stored');
    expect((blocked.deps.recordAttempt as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'circuit_open' }));
    const expired = flowWorld({ circuitState: 'OPEN_EXPIRED' }); await run(expired);
    expect(expired.broker.invoke).toHaveBeenCalledTimes(1);
    expect((expired.deps.circuit as { save: ReturnType<typeof vi.fn> }).save).toHaveBeenCalled();
    const closed = flowWorld({ circuitState: 'CLOSED' }); await run(closed);
    expect(closed.broker.invoke).toHaveBeenCalledTimes(1);
    expect((closed.deps.circuit as { save: ReturnType<typeof vi.fn> }).save).toHaveBeenCalled();
  });
  it('F17 a provider error is recorded in the original circuit and attempt ports', async () => {
    const x = flowWorld({ circuitState: 'CLOSED', finderError: true });
    await expect(run(x)).rejects.toThrow();
    expect(x.broker.invoke).toHaveBeenCalledTimes(1);
    expect((x.deps.circuit as { save: ReturnType<typeof vi.fn> }).save).toHaveBeenCalled();
    expect((x.deps.recordAttempt as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', errorCode: 'provider_error' }));
  });

  it('C4: recover links a SETTLED ledger held on a RESERVED typed step without wire', async () => {
    const candidate = { operationId: OP(1), resultDigest: 'b'.repeat(64), artifactRef: { schemaVersion: 'generic-operation-artifact-ref/v1', operationId: OP(1), artifactId: ART, resultSchema: 'contact-email-find-hunter/v1', sha256: 'b'.repeat(64), mediaType: 'application/octet-stream', sizeBytes: '128', expiresAt: '2099-01-01T00:00:00.000Z' } };
    const x = flowWorld({ verifiers: [{ provider: 'millionverifier', state: 'VALID' }] });
    const finder = x.steps.find((step) => step.slot.phase === 'FINDER')!;
    const verify = x.steps.find((step) => step.slot.phase === 'VERIFY')!;
    const finderReceipt = { schemaVersion: 'durable-execution-receipt/v1', scopeKey: W, authorityId: A, accountId: ACCOUNT, operationId: OP(1), operationKey: 'find-op', resultStrategy: 'artifact_reference', resultSchema: 'contact-email-find-hunter/v1', resultDigest: 'b'.repeat(64), artifactId: ART, usage: { currency: 'USD', unit: 'microusd', callCount: 1, chargedMicrousd: '1700', upperBoundMicrousd: '1700' }, costBasis: 'estimated_upper_bound', status: 'SETTLED' };
    const receipt = { schemaVersion: 'durable-execution-receipt/v1', scopeKey: W, authorityId: A, accountId: ACCOUNT, operationId: OP(2), operationKey: 'verify-op', resultStrategy: 'typed_projection', resultSchema: 'contact-email-verify-millionverifier/v1', resultDigest: 'c'.repeat(64), artifactId: null, usage: { currency: 'USD', unit: 'microusd', callCount: 1, chargedMicrousd: '1780', upperBoundMicrousd: '1780' }, costBasis: 'estimated_upper_bound', status: 'SETTLED' };
    Object.assign(finder, { candidate_ref: null, input_fingerprint: 'f'.repeat(64), operation_key: 'find-op', budget_operation_id: OP(1), revision: 2, dispatch_phase: 'SETTLED_WAITING_APPLY', ledger: { operationKey: 'find-op', operationId: OP(1), status: 'SETTLED', charged: 1700n, digest: 'b'.repeat(64), receipt: finderReceipt, artifact: true } });
    Object.assign(verify, { candidate_ref: candidate, input_fingerprint: 'f'.repeat(64), operation_key: 'verify-op', budget_operation_id: OP(2), revision: 2, dispatch_phase: 'RESERVED', ledger: { operationKey: 'verify-op', operationId: OP(2), status: 'SETTLED', charged: 1780n, digest: 'c'.repeat(64), receipt, artifact: false } });
    const reference = { stepId: verify.id, producerId: 'contact_email.verify.millionverifier', resultSchema: 'contact-email-verify-millionverifier/v1', resultDigest: 'c'.repeat(64), durableReceipt: receipt };
    const spy = vi.spyOn(EnrichmentResultReader.prototype, 'loadEnrichmentStepResult').mockResolvedValue({ status: 'SETTLED', reference } as never);
    try {
      const service = createContactEnrichmentSafetyRuntime(x.deps as never).service;
      (service as unknown as { deps: { results: { readEnrichmentExecution: () => Promise<null> } } }).deps.results.readEnrichmentExecution = async () => null;
      const context = { userId: 'u1', workspaceId: W, roles: ['admin'], scopes: ['acquisition:write', 'contact-discovery:read', 'compliance:manage'] };
      await service.recoverEnrichmentExecution(context as never, C, 'd'.repeat(64));
      expect(spy).toHaveBeenCalledWith(verify.id, { workspaceId: W, companyId: C });
      expect(verify.dispatch_phase).toBe('SETTLED_WAITING_APPLY');
      expect(x.decisions.get(CA)?.status).toBe('APPLIED');
      expect(x.broker.invoke).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('C4: SAVE_PENDING recovery retries the original apply once its typed result is available', async () => {
    const candidate = { operationId: OP(1), resultDigest: 'b'.repeat(64), artifactRef: { schemaVersion: 'generic-operation-artifact-ref/v1', operationId: OP(1), artifactId: ART, resultSchema: 'contact-email-find-hunter/v1', sha256: 'b'.repeat(64), mediaType: 'application/octet-stream', sizeBytes: '128', expiresAt: '2099-01-01T00:00:00.000Z' } };
    const x = flowWorld({ verifiers: [{ provider: 'millionverifier', state: 'VALID' }] });
    const finder = x.steps.find((step) => step.slot.phase === 'FINDER')!;
    const verify = x.steps.find((step) => step.slot.phase === 'VERIFY')!;
    const finderReceipt = { schemaVersion: 'durable-execution-receipt/v1', scopeKey: W, authorityId: A, accountId: ACCOUNT, operationId: OP(1), operationKey: 'find-op', resultStrategy: 'artifact_reference', resultSchema: 'contact-email-find-hunter/v1', resultDigest: 'b'.repeat(64), artifactId: ART, usage: { currency: 'USD', unit: 'microusd', callCount: 1, chargedMicrousd: '1700', upperBoundMicrousd: '1700' }, costBasis: 'estimated_upper_bound', status: 'SETTLED' };
    const verifyReceipt = { schemaVersion: 'durable-execution-receipt/v1', scopeKey: W, authorityId: A, accountId: ACCOUNT, operationId: OP(2), operationKey: 'verify-op', resultStrategy: 'typed_projection', resultSchema: 'contact-email-verify-millionverifier/v1', resultDigest: 'c'.repeat(64), artifactId: null, usage: { currency: 'USD', unit: 'microusd', callCount: 1, chargedMicrousd: '1780', upperBoundMicrousd: '1780' }, costBasis: 'estimated_upper_bound', status: 'SETTLED' };
    Object.assign(finder, { candidate_ref: null, input_fingerprint: 'f'.repeat(64), operation_key: 'find-op', budget_operation_id: OP(1), revision: 2, dispatch_phase: 'SETTLED_WAITING_APPLY', ledger: { operationKey: 'find-op', operationId: OP(1), status: 'SETTLED', charged: 1700n, digest: 'b'.repeat(64), receipt: finderReceipt, artifact: true } });
    Object.assign(verify, { candidate_ref: candidate, input_fingerprint: 'f'.repeat(64), operation_key: 'verify-op', budget_operation_id: OP(2), revision: 2, dispatch_phase: 'RESULT_UNKNOWN', ledger: { operationKey: 'verify-op', operationId: OP(2), status: 'RESULT_UNKNOWN', charged: null, digest: null, receipt: null, artifact: false } });
    x.seed({ status: 'SAVE_PENDING', contactId: CA, reasonCode: 'RESULT_UNKNOWN', state: null, pointRefs: [], eventRefs: [], attemptRefs: [], newCandidatePoints: 0 });
    const reference = { stepId: verify.id, producerId: 'contact_email.verify.millionverifier', resultSchema: 'contact-email-verify-millionverifier/v1', resultDigest: 'c'.repeat(64), durableReceipt: verifyReceipt };
    const spy = vi.spyOn(EnrichmentResultReader.prototype, 'loadEnrichmentStepResult').mockResolvedValue({ status: 'SETTLED', reference } as never);
    try {
      const service = createContactEnrichmentSafetyRuntime(x.deps as never).service;
      (service as unknown as { deps: { results: { readEnrichmentExecution: () => Promise<null> } } }).deps.results.readEnrichmentExecution = async () => null;
      const context = { userId: 'u1', workspaceId: W, roles: ['admin'], scopes: ['acquisition:write', 'contact-discovery:read', 'compliance:manage'] };
      await service.recoverEnrichmentExecution(context as never, C, 'd'.repeat(64));
      expect(spy).toHaveBeenCalledWith(verify.id, { workspaceId: W, companyId: C });
      expect(x.decisions.get(CA)?.status).toBe('APPLIED');
      expect(x.broker.invoke).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('C4: a still-conflicting SAVE_PENDING recovery stays pending and never turns terminal', async () => {
    const candidate = { operationId: OP(1), resultDigest: 'b'.repeat(64), artifactRef: { schemaVersion: 'generic-operation-artifact-ref/v1', operationId: OP(1), artifactId: ART, resultSchema: 'contact-email-find-hunter/v1', sha256: 'b'.repeat(64), mediaType: 'application/octet-stream', sizeBytes: '128', expiresAt: '2099-01-01T00:00:00.000Z' } };
    const x = flowWorld({ verifiers: [{ provider: 'millionverifier', state: 'VALID' }], currentEmailPoint: true });
    const finder = x.steps.find((step) => step.slot.phase === 'FINDER')!;
    const verify = x.steps.find((step) => step.slot.phase === 'VERIFY')!;
    const finderReceipt = { schemaVersion: 'durable-execution-receipt/v1', scopeKey: W, authorityId: A, accountId: ACCOUNT, operationId: OP(1), operationKey: 'find-op', resultStrategy: 'artifact_reference', resultSchema: 'contact-email-find-hunter/v1', resultDigest: 'b'.repeat(64), artifactId: ART, usage: { currency: 'USD', unit: 'microusd', callCount: 1, chargedMicrousd: '1700', upperBoundMicrousd: '1700' }, costBasis: 'estimated_upper_bound', status: 'SETTLED' };
    const verifyReceipt = { schemaVersion: 'durable-execution-receipt/v1', scopeKey: W, authorityId: A, accountId: ACCOUNT, operationId: OP(2), operationKey: 'verify-op', resultStrategy: 'typed_projection', resultSchema: 'contact-email-verify-millionverifier/v1', resultDigest: 'c'.repeat(64), artifactId: null, usage: { currency: 'USD', unit: 'microusd', callCount: 1, chargedMicrousd: '1780', upperBoundMicrousd: '1780' }, costBasis: 'estimated_upper_bound', status: 'SETTLED' };
    Object.assign(finder, { candidate_ref: null, input_fingerprint: 'f'.repeat(64), operation_key: 'find-op', budget_operation_id: OP(1), revision: 2, dispatch_phase: 'SETTLED_WAITING_APPLY', ledger: { operationKey: 'find-op', operationId: OP(1), status: 'SETTLED', charged: 1700n, digest: 'b'.repeat(64), receipt: finderReceipt, artifact: true } });
    Object.assign(verify, { candidate_ref: candidate, input_fingerprint: 'f'.repeat(64), operation_key: 'verify-op', budget_operation_id: OP(2), revision: 3, dispatch_phase: 'SETTLED_WAITING_APPLY', ledger: { operationKey: 'verify-op', operationId: OP(2), status: 'SETTLED', charged: 1780n, digest: 'c'.repeat(64), receipt: verifyReceipt, artifact: false } });
    x.seed({ status: 'SAVE_PENDING', contactId: CA, reasonCode: 'INPUT_CONFLICT', state: null, pointRefs: [], eventRefs: [], attemptRefs: [], newCandidatePoints: 0 });
    const service = createContactEnrichmentSafetyRuntime(x.deps as never).service;
    (service as unknown as { deps: { results: { readEnrichmentExecution: () => Promise<null> } } }).deps.results.readEnrichmentExecution = async () => null;
    const context = { userId: 'u1', workspaceId: W, roles: ['admin'], scopes: ['acquisition:write', 'contact-discovery:read', 'compliance:manage'] };
    await service.recoverEnrichmentExecution(context as never, C, 'd'.repeat(64));
    expect(x.decisions.get(CA)?.status).toBe('SAVE_PENDING');
    expect(x.deps.store.savePending).toHaveBeenCalled();
    expect(x.broker.invoke).not.toHaveBeenCalled();
  });

  it('C4: SAVE_PENDING recovery holds when the typed original is still unavailable', async () => {
    const x = flowWorld({ verifiers: [{ provider: 'millionverifier', state: 'VALID' }] });
    const candidate = { operationId: OP(1), resultDigest: 'b'.repeat(64), artifactRef: { schemaVersion: 'generic-operation-artifact-ref/v1', operationId: OP(1), artifactId: ART, resultSchema: 'contact-email-find-hunter/v1', sha256: 'b'.repeat(64), mediaType: 'application/octet-stream', sizeBytes: '128', expiresAt: '2099-01-01T00:00:00.000Z' } };
    const finder = x.steps.find((step) => step.slot.phase === 'FINDER')!;
    const verify = x.steps.find((step) => step.slot.phase === 'VERIFY')!;
    const finderReceipt = { schemaVersion: 'durable-execution-receipt/v1', scopeKey: W, authorityId: A, accountId: ACCOUNT, operationId: OP(1), operationKey: 'find-op', resultStrategy: 'artifact_reference', resultSchema: 'contact-email-find-hunter/v1', resultDigest: 'b'.repeat(64), artifactId: ART, usage: { currency: 'USD', unit: 'microusd', callCount: 1, chargedMicrousd: '1700', upperBoundMicrousd: '1700' }, costBasis: 'estimated_upper_bound', status: 'SETTLED' };
    Object.assign(finder, { candidate_ref: null, input_fingerprint: 'f'.repeat(64), operation_key: 'find-op', budget_operation_id: OP(1), revision: 2, dispatch_phase: 'SETTLED_WAITING_APPLY', ledger: { operationKey: 'find-op', operationId: OP(1), status: 'SETTLED', charged: 1700n, digest: 'b'.repeat(64), receipt: finderReceipt, artifact: true } });
    Object.assign(verify, { candidate_ref: candidate, input_fingerprint: 'f'.repeat(64), operation_key: 'verify-op', budget_operation_id: OP(2), revision: 2, dispatch_phase: 'RESULT_UNKNOWN', ledger: { operationKey: 'verify-op', operationId: OP(2), status: 'RESULT_UNKNOWN', charged: null, digest: null, receipt: null, artifact: false } });
    x.seed({ status: 'SAVE_PENDING', contactId: CA, reasonCode: 'RESULT_UNKNOWN', state: null, pointRefs: [], eventRefs: [], attemptRefs: [], newCandidatePoints: 0 });
    const spy = vi.spyOn(EnrichmentResultReader.prototype, 'loadEnrichmentStepResult').mockResolvedValue({ status: 'NOT_FOUND' } as never);
    try {
      const service = createContactEnrichmentSafetyRuntime(x.deps as never).service;
      (service as unknown as { deps: { results: { readEnrichmentExecution: () => Promise<null> } } }).deps.results.readEnrichmentExecution = async () => null;
      const context = { userId: 'u1', workspaceId: W, roles: ['admin'], scopes: ['acquisition:write', 'contact-discovery:read', 'compliance:manage'] };
      await service.recoverEnrichmentExecution(context as never, C, 'd'.repeat(64));
      expect(spy).toHaveBeenCalledWith(verify.id, { workspaceId: W, companyId: C });
      expect(x.decisions.get(CA)?.status).toBe('SAVE_PENDING');
      expect(verify.dispatch_phase).toBe('RESULT_UNKNOWN');
      expect(x.broker.invoke).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

describe('V10 RED preparation: residual lifecycle and paid-fact boundaries (test-only)', () => {
  const W = '10000000-0000-4000-8000-000000000001', C = '10000000-0000-4000-8000-000000000002', A = '10000000-0000-4000-8000-000000000003', ACCOUNT = '10000000-0000-4000-8000-000000000004', EXEC = '10000000-0000-4000-8000-000000000005', RUN = '10000000-0000-4000-8000-000000000006';
  const CA = '10000000-0000-4000-8000-000000000011';
  const OP = (n: number) => `30000000-0000-4000-8000-${String(100 + n).padStart(12, '0')}`;
  const ART = '30000000-0000-4000-8000-000000000099';
  const finderReceipt = (operationId: string, digest: string) => ({ schemaVersion: 'durable-execution-receipt/v1', scopeKey: W, authorityId: A, accountId: ACCOUNT, operationId, operationKey: 'find-op', resultStrategy: 'artifact_reference', resultSchema: 'contact-email-find-hunter/v1', resultDigest: digest, artifactId: ART, usage: { currency: 'USD', unit: 'microusd', callCount: 1, chargedMicrousd: '1700', upperBoundMicrousd: '1700' }, costBasis: 'estimated_upper_bound', status: 'SETTLED' });
  const candidateRef = (operationId: string, digest: string) => ({ operationId, resultDigest: digest, artifactRef: { schemaVersion: 'generic-operation-artifact-ref/v1', operationId, artifactId: ART, resultSchema: 'contact-email-find-hunter/v1', sha256: digest, mediaType: 'application/octet-stream', sizeBytes: '128', expiresAt: '2099-01-01T00:00:00.000Z' } });
  function paidWorld() {
    const x = flowWorld({ verifiers: [{ provider: 'millionverifier', state: 'VALID' }] });
    const finder = x.steps.find((step) => step.slot.phase === 'FINDER')!;
    const verify = x.steps.find((step) => step.slot.phase === 'VERIFY')!;
    const finderDigest = 'b'.repeat(64);
    Object.assign(finder, { candidate_ref: null, input_fingerprint: 'f'.repeat(64), operation_key: 'find-op', budget_operation_id: OP(1), revision: 2, dispatch_phase: 'SETTLED_WAITING_APPLY', ledger: { operationKey: 'find-op', operationId: OP(1), status: 'SETTLED', charged: 1700n, digest: finderDigest, receipt: finderReceipt(OP(1), finderDigest), artifact: true } });
    Object.assign(verify, { candidate_ref: candidateRef(OP(1), finderDigest), input_fingerprint: 'f'.repeat(64), operation_key: 'verify-op', budget_operation_id: OP(2), revision: 2, dispatch_phase: 'RESERVED', ledger: { operationKey: 'verify-op', operationId: OP(2), status: 'RESULT_UNKNOWN', charged: null, digest: null, receipt: null, artifact: false } });
    const rawRead = vi.fn(async (_query: { scopeKey: string; authorityId: string; accountKey: string; accountGeneration: number; operationKey: string; resultSchema: string }) => ({ status: 'RESULT_UNKNOWN' as const }));
    (x.deps as unknown as { budgets: { readOperationResult: unknown } }).budgets = { readOperationResult: rawRead };
    return { x, finder, verify, finderDigest, rawRead };
  }
  it('V10 RED C2a: a SAVE_PENDING decision cannot be falsely COMPLETED by remaining0 plus all slots RELEASED', async () => {
    const plan = sqlPlan();
    const pending = { status: 'SAVE_PENDING' as const, contactId: SQL_C1, reasonCode: 'RESULT_UNKNOWN' as const, state: null, pointRefs: [], eventRefs: [], attemptRefs: [], newCandidatePoints: 0 };
    const applied = sqlDecision(SQL_C2, SQL_P2);
    const head = sqlHead(plan, { version: 1, targetCount: 2, newCandidatePoints: 1, contacts: [pending, applied] });
    const rows = [
      { contact_id: SQL_C1, dispatch_phase: 'RELEASED', domain_state: 'SAVE_PENDING' },
      { contact_id: SQL_C1, dispatch_phase: 'RELEASED', domain_state: 'SAVE_PENDING' },
      { contact_id: SQL_C2, dispatch_phase: 'SETTLED', domain_state: 'APPLIED' },
      { contact_id: SQL_C2, dispatch_phase: 'SETTLED', domain_state: 'APPLIED' },
    ];
    const state = { snapshot: head.result_snapshot, remaining: 0, status: 'APPLY_PENDING', updates: [] as string[], contactsLocked: [] as string[], headSql: [] as string[] };
    const { tx } = sqlTx({ plan, head, rows, state });
    const store = createSqlEnrichmentDomainCommitStore({ withWorkspace: (_w, fn) => fn(tx) } as never, {});
    await store.persist(tx as never, { workspaceId: SQL_W, companyId: SQL_COMPANY, executionId: SQL_EXEC, contactId: SQL_C2 }, applied, []);
    const snapshot = state.snapshot as { contacts: Array<{ contactId: string; status: string }> };
    const outcome = { head: state.status, decisions: snapshot.contacts.map((entry) => ({ contactId: entry.contactId, status: entry.status })), updates: state.updates };
    expect(outcome).toEqual({ head: 'APPLY_PENDING', decisions: [{ contactId: SQL_C1, status: 'SAVE_PENDING' }, { contactId: SQL_C2, status: 'APPLIED' }], updates: ['RELEASED', 'HEAD'] });
  });
  it('V10 RED C2b: a RELEASED old SAVE_PENDING marker must not freeze another normal target', async () => {
    const plan = sqlPlan();
    const applied = sqlDecision(SQL_C1, SQL_P1);
    const head = sqlHead(plan, { version: 1, targetCount: 2, newCandidatePoints: 1, contacts: [applied] });
    const rows = [
      { contact_id: SQL_C1, dispatch_phase: 'SETTLED', domain_state: 'APPLIED' },
      { contact_id: SQL_C1, dispatch_phase: 'RELEASED', domain_state: 'SAVE_PENDING' },
      { contact_id: SQL_C2, dispatch_phase: 'ADMITTED', domain_state: 'PENDING' },
      { contact_id: SQL_C2, dispatch_phase: 'ADMITTED', domain_state: 'PENDING' },
    ];
    const state = { snapshot: head.result_snapshot, remaining: 1, status: 'APPLY_PENDING', updates: [] as string[], contactsLocked: [] as string[], headSql: [] as string[] };
    const { tx } = sqlTx({ plan, head, rows, state });
    const store = createSqlEnrichmentDomainCommitStore({ withWorkspace: (_w, fn) => fn(tx) } as never, {});
    await store.persist(tx as never, { workspaceId: SQL_W, companyId: SQL_COMPANY, executionId: SQL_EXEC, contactId: SQL_C1 }, applied, []);
    const outcome = { head: state.status, remainingActive: rows.filter((row) => row.contact_id === SQL_C2 && row.dispatch_phase === 'ADMITTED').length, oldMarker: rows.find((row) => row.contact_id === SQL_C1 && row.dispatch_phase === 'RELEASED')?.domain_state };
    expect(outcome).toEqual({ head: 'RUNNING', remainingActive: 2, oldMarker: 'SAVE_PENDING' });
  });
  it('V10 RED C4a: a paid typed PENDING original behind a RESERVED index must not disappear from the apply-required set (recover path)', async () => {
    const { x, finder, verify, finderDigest, rawRead } = paidWorld();
    const before = { finder: finder.ledger?.status, finderDigest: finder.ledger?.digest, verify: verify.ledger?.status, verifyOperation: verify.budget_operation_id, verifyDispatch: verify.dispatch_phase };
    const recoverSpy = vi.spyOn(EnrichmentResultReader.prototype, 'recoverEnrichmentStepResult');
    try {
      const service = createContactEnrichmentSafetyRuntime(x.deps as never).service;
      (service as unknown as { deps: { results: { readEnrichmentExecution: () => Promise<null> } } }).deps.results.readEnrichmentExecution = async () => null;
      const context = { userId: 'u1', workspaceId: W, roles: ['admin'], scopes: ['acquisition:write', 'contact-discovery:read', 'compliance:manage'] };
      await service.recoverEnrichmentExecution(context as never, C, 'd'.repeat(64));
      const decision = x.decisions.get(CA);
      const rawQuery = rawRead.mock.calls[0]?.[0] ?? null;
      const outcome = { decision: decision?.status ?? 'HELD', reason: decision?.reasonCode ?? null, before, after: { finder: finder.ledger?.status, finderDigest: finder.ledger?.digest, verify: verify.ledger?.status, verifyOperation: verify.budget_operation_id, verifyDispatch: verify.dispatch_phase }, brokerCalls: x.broker.invoke.mock.calls.length, grantConsumes: (x.deps.grantConsumer.consumeVerifiedWorkspaceGrantInTransaction as ReturnType<typeof vi.fn>).mock.calls.length, recoveryCalls: recoverSpy.mock.calls.length, readerPending: rawRead.mock.calls.length, rawStatus: 'RESULT_UNKNOWN', rawQuery };
      expect(outcome).toEqual({ decision: 'HELD', reason: null, before: { finder: 'SETTLED', finderDigest, verify: 'RESULT_UNKNOWN', verifyOperation: OP(2), verifyDispatch: 'RESERVED' }, after: { finder: 'SETTLED', finderDigest, verify: 'RESULT_UNKNOWN', verifyOperation: OP(2), verifyDispatch: 'RESERVED' }, brokerCalls: 0, grantConsumes: 0, recoveryCalls: 0, readerPending: 1, rawStatus: 'RESULT_UNKNOWN', rawQuery: { scopeKey: W, authorityId: A, accountKey: binding.accountKey, accountGeneration: 1, operationKey: 'verify-op', resultSchema: 'contact-email-verify-millionverifier/v1' } });
    } finally { recoverSpy.mockRestore(); }
  });
  it('V10 RED C4b: the same paid typed PENDING original must stay SAVE_PENDING in the existing-decision recovery path', async () => {
    const { x, finder, verify, finderDigest, rawRead } = paidWorld();
    x.seed({ status: 'SAVE_PENDING', contactId: CA, reasonCode: 'RESULT_UNKNOWN', state: null, pointRefs: [], eventRefs: [], attemptRefs: [], newCandidatePoints: 0 });
    const recoverSpy = vi.spyOn(EnrichmentResultReader.prototype, 'recoverEnrichmentStepResult');
    try {
      const service = createContactEnrichmentSafetyRuntime(x.deps as never).service;
      (service as unknown as { deps: { results: { readEnrichmentExecution: () => Promise<null> } } }).deps.results.readEnrichmentExecution = async () => null;
      const context = { userId: 'u1', workspaceId: W, roles: ['admin'], scopes: ['acquisition:write', 'contact-discovery:read', 'compliance:manage'] };
      await service.recoverEnrichmentExecution(context as never, C, 'd'.repeat(64));
      const decision = x.decisions.get(CA);
      const rawQuery = rawRead.mock.calls[0]?.[0] ?? null;
      const outcome = { decision: decision?.status ?? 'HELD', reason: decision?.reasonCode ?? null, finder: finder.ledger?.status, verify: verify.ledger?.status, verifyDispatch: verify.dispatch_phase, verifyOperation: verify.budget_operation_id, brokerCalls: x.broker.invoke.mock.calls.length, grantConsumes: (x.deps.grantConsumer.consumeVerifiedWorkspaceGrantInTransaction as ReturnType<typeof vi.fn>).mock.calls.length, recoveryCalls: recoverSpy.mock.calls.length, readerPending: rawRead.mock.calls.length, rawStatus: 'RESULT_UNKNOWN', rawQuery };
      expect(outcome).toEqual({ decision: 'SAVE_PENDING', reason: 'RESULT_UNKNOWN', finder: 'SETTLED', verify: 'RESULT_UNKNOWN', verifyDispatch: 'RESERVED', verifyOperation: OP(2), brokerCalls: 0, grantConsumes: 0, recoveryCalls: 0, readerPending: 1, rawStatus: 'RESULT_UNKNOWN', rawQuery: { scopeKey: W, authorityId: A, accountKey: binding.accountKey, accountGeneration: 1, operationKey: 'verify-op', resultSchema: 'contact-email-verify-millionverifier/v1' } });
    } finally { recoverSpy.mockRestore(); }
  });
  it('V10 RED C4c: a paid UNKNOWN finder must take precedence over a fresh reusable cache shortcut', async () => {
    const requestHash = enrichmentRequestHash(CA, 'hunter', { fullName: 'Person 0', domain: 'company.example.invalid', companyName: 'Synthetic Company' });
    const x = flowWorld({ uncertain: true, useDefaultAttemptCache: true, attemptRows: [{ requestHash, outcome: 'miss', attemptedAt: new Date(Date.now() - 60 * 60_000) }] });
    const finder = x.steps.find((step) => step.slot.phase === 'FINDER')!;
    const before = { dispatch: finder.dispatch_phase, ledger: finder.ledger?.status, operation: finder.budget_operation_id };
    const recoverSpy = vi.spyOn(EnrichmentResultReader.prototype, 'recoverEnrichmentStepResult');
    try {
      let thrown: unknown = null;
      try { await run(x); } catch (error) { thrown = error; }
      const decision = x.decisions.get(CA);
      const outcome = { decision: decision?.status ?? 'HELD', reason: decision?.reasonCode ?? null, error: thrown === null ? null : ((thrown as { code?: string }).code ?? (thrown as Error).message), before, after: { dispatch: finder.dispatch_phase, ledger: finder.ledger?.status, operation: finder.budget_operation_id }, brokerCalls: x.broker.invoke.mock.calls.length, recoveryCalls: recoverSpy.mock.calls.length, grantConsumes: (x.deps.grantConsumer.consumeVerifiedWorkspaceGrantInTransaction as ReturnType<typeof vi.fn>).mock.calls.length };
      expect(outcome).toEqual({ decision: 'HELD', reason: null, error: 'HOLD', before: { dispatch: 'RESULT_UNKNOWN', ledger: 'RESULT_UNKNOWN', operation: '10000000-0000-4000-8000-000000000101' }, after: { dispatch: 'RESULT_UNKNOWN', ledger: 'RESULT_UNKNOWN', operation: '10000000-0000-4000-8000-000000000101' }, brokerCalls: 0, recoveryCalls: 0, grantConsumes: 0 });
      expect((x.deps.prisma.withWorkspace as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    } finally { recoverSpy.mockRestore(); }
  });
  it('V10 v2 L06: raw SETTLED with dispatch SETTLED but no ACK/domain apply must hold', async () => {
    const x = flowWorld({});
    const finder = x.steps.find((step) => step.slot.phase === 'FINDER')!;
    const receipt = { schemaVersion: 'durable-execution-receipt/v1', scopeKey: W, authorityId: A, accountId: ACCOUNT, operationId: OP(1), operationKey: 'find-op', resultStrategy: 'artifact_reference', resultSchema: 'contact-email-find-hunter/v1', resultDigest: 'b'.repeat(64), artifactId: ART, usage: { currency: 'USD', unit: 'microusd', callCount: 1, chargedMicrousd: '1700', upperBoundMicrousd: '1700' }, costBasis: 'estimated_upper_bound', status: 'SETTLED' };
    Object.assign(finder, { candidate_ref: null, input_fingerprint: 'f'.repeat(64), operation_key: 'find-op', budget_operation_id: OP(1), revision: 2, dispatch_phase: 'SETTLED', domain_state: 'PENDING', ledger: { operationKey: 'find-op', operationId: OP(1), status: 'SETTLED', charged: 1700n, digest: 'b'.repeat(64), receipt, artifact: true } });
    const service = createContactEnrichmentSafetyRuntime(x.deps as never).service;
    (service as unknown as { deps: { results: { readEnrichmentExecution: () => Promise<null> } } }).deps.results.readEnrichmentExecution = async () => null;
    const context = { userId: 'u1', workspaceId: W, roles: ['admin'], scopes: ['acquisition:write', 'contact-discovery:read', 'compliance:manage'] };
    await service.recoverEnrichmentExecution(context as never, C, 'd'.repeat(64));
    expect({ decision: x.decisions.get(CA)?.status ?? 'HELD', dispatch: finder.dispatch_phase, domain: finder.domain_state, ledger: finder.ledger?.status, brokerCalls: x.broker.invoke.mock.calls.length }).toEqual({ decision: 'HELD', dispatch: 'SETTLED', domain: 'PENDING', ledger: 'SETTLED', brokerCalls: 0 });
  });
  it('V10 v2 L09: a safe RELEASED finder with no fee/apply obligation may reuse cache', async () => {
    const requestHash = enrichmentRequestHash(CA, 'hunter', { fullName: 'Person 0', domain: 'company.example.invalid', companyName: 'Synthetic Company' });
    const x = flowWorld({ finder: 'miss', useDefaultAttemptCache: true, attemptRows: [{ requestHash, outcome: 'hit', emailState: 'VALID', attemptedAt: new Date(Date.now() - 60 * 60_000) }] });
    const finder = x.steps.find((step) => step.slot.phase === 'FINDER')!;
    Object.assign(finder, { candidate_ref: null, input_fingerprint: 'f'.repeat(64), operation_key: 'find-op', budget_operation_id: OP(1), revision: 2, dispatch_phase: 'RELEASED', ledger: { operationKey: 'find-op', operationId: OP(1), status: 'RELEASED', charged: null, digest: null, receipt: null, artifact: false } });
    let thrown: unknown = null;
    try { await run(x); } catch (error) { thrown = error; }
    expect({ decision: x.decisions.get(CA)?.status ?? 'HELD', reason: x.decisions.get(CA)?.reasonCode ?? null, error: thrown === null ? null : ((thrown as { code?: string }).code ?? (thrown as Error).message), ledger: finder.ledger?.status, dispatch: finder.dispatch_phase, brokerCalls: x.broker.invoke.mock.calls.length }).toEqual({ decision: 'APPLIED', reason: 'REUSED', error: null, ledger: 'RELEASED', dispatch: 'RELEASED', brokerCalls: 0 });
  });
  it('V10 v2 head: persist must not silently reopen a COMPLETED head', async () => {
    const plan = sqlPlan();
    const applied1 = sqlDecision(SQL_C1, SQL_P1), applied2 = sqlDecision(SQL_C2, SQL_P2);
    const head = sqlHead(plan, { version: 1, targetCount: 2, newCandidatePoints: 2, contacts: [applied1, applied2] });
    const state = { snapshot: head.result_snapshot, remaining: 0, status: 'COMPLETED', updates: [] as string[], contactsLocked: [] as string[], headSql: [] as string[] };
    const { tx } = sqlTx({ plan, head, rows: [], state });
    const store = createSqlEnrichmentDomainCommitStore({ withWorkspace: (_w, fn) => fn(tx) } as never, {});
    await expect(store.persist(tx as never, { workspaceId: SQL_W, companyId: SQL_COMPANY, executionId: SQL_EXEC, contactId: SQL_C1 }, applied1, [])).rejects.toMatchObject({ code: 'HOLD' });
  });
  it('V11 RED: a safe RELEASED money row with an old SAVE_PENDING marker must not freeze the next target', async () => {
    const plan = sqlPlan();
    const rows = [
      { id: SQL_F1, contact_id: SQL_C1, dispatch_phase: 'SETTLED_WAITING_APPLY', domain_state: 'PENDING', budget_operation_id: SQL_OPF1, budget_original_id: SQL_OPF1, budget_status: 'SETTLED', operation_key: 'find-op' },
      { id: SQL_V1, contact_id: SQL_C1, dispatch_phase: 'ADMITTED', domain_state: 'PENDING', budget_operation_id: null, budget_original_id: SQL_OPF2, budget_status: 'RELEASED', operation_key: 'verify-op' },
      { id: SQL_F2, contact_id: SQL_C2, dispatch_phase: 'ADMITTED', domain_state: 'PENDING', budget_operation_id: null, budget_original_id: null, budget_status: null, operation_key: null },
      { id: SQL_V2, contact_id: SQL_C2, dispatch_phase: 'ADMITTED', domain_state: 'PENDING', budget_operation_id: null, budget_original_id: null, budget_status: null, operation_key: null },
    ];
    const state = { snapshot: null as unknown, status: 'PREPARED' };
    const head = sqlHead(plan);
    const tx = { $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('public.lock_enrichment_execution_v1')) return [{ id: SQL_EXEC, account_id: SQL_ACCOUNT }];
      if (sql.includes('SELECT result_snapshot,target_snapshot,frozen_limits,status')) return [{ result_snapshot: state.snapshot, target_snapshot: head.target_snapshot, frozen_limits: head.frozen_limits, status: state.status }];
      if (sql.includes("SET domain_state='SAVE_PENDING'")) { for (const row of rows) if (row.contact_id === SQL_C1 && row.domain_state === 'PENDING') row.domain_state = 'SAVE_PENDING'; return []; }
      if (sql.includes("SET dispatch_phase='SETTLED',domain_state='APPLIED'")) { const row = rows.find((entry) => entry.budget_operation_id !== null && values.some((value) => String(value) === entry.id) && values.some((value) => String(value) === entry.budget_operation_id)); if (!row) throw new Error('missing paid step'); row.dispatch_phase = 'SETTLED'; row.domain_state = 'APPLIED'; return [{ id: row.id }]; }
      if (sql.includes("SET dispatch_phase='RELEASED'")) { for (const row of rows) if (row.contact_id === SQL_C1 && row.dispatch_phase === 'ADMITTED' && row.budget_operation_id === null) row.dispatch_phase = 'RELEASED'; return []; }
      if (sql.includes('SELECT count(*)::bigint AS count')) return [{ count: BigInt(rows.filter((row) => !['SETTLED', 'RELEASED', 'REDACTED'].includes(row.dispatch_phase)).length) }];
      if (sql.includes('SELECT s.contact_id::text,s.domain_state,s.dispatch_phase,o.id::text AS operation_id')) return rows.map((row) => ({ contact_id: row.contact_id, operation_id: row.budget_original_id, operation_status: row.budget_status, dispatch_phase: row.dispatch_phase, domain_state: row.domain_state }));
      if (sql.includes('SET result_snapshot=')) { const json = values.find((value) => typeof value === 'string' && value.startsWith('{')); const status = values.find((value) => value === 'COMPLETED' || value === 'APPLY_PENDING' || value === 'RUNNING'); if (typeof json === 'string') state.snapshot = JSON.parse(json); if (typeof status === 'string') state.status = status; return []; }
      if (sql.includes('SET status=') && !sql.includes('SET result_snapshot=')) { const status = values.find((value) => value === 'COMPLETED' || value === 'APPLY_PENDING' || value === 'RUNNING'); if (typeof status === 'string') state.status = status; return []; }
      throw new Error('unexpected V11 SQL: ' + sql.slice(0, 120));
    }) };
    const store = createSqlEnrichmentDomainCommitStore({ withWorkspace: (_w, fn) => fn(tx) } as never, {});
    await store.savePending(tx as never, { workspaceId: SQL_W, companyId: SQL_COMPANY, executionId: SQL_EXEC, contactId: SQL_C1 }, 'INPUT_CONFLICT');
    await store.persist(tx as never, { workspaceId: SQL_W, companyId: SQL_COMPANY, executionId: SQL_EXEC, contactId: SQL_C1 }, sqlDecision(SQL_C1, SQL_P1), [{ stepId: SQL_F1, durableReceipt: { operationId: SQL_OPF1 } } as never]);
    expect({ head: state.status, c1Finder: rows.find((row) => row.id === SQL_F1), c1Verify: rows.find((row) => row.id === SQL_V1), c2: rows.filter((row) => row.contact_id === SQL_C2).map((row) => row.dispatch_phase) }).toEqual({ head: 'RUNNING', c1Finder: expect.objectContaining({ dispatch_phase: 'SETTLED', domain_state: 'APPLIED' }), c1Verify: expect.objectContaining({ dispatch_phase: 'RELEASED', domain_state: 'SAVE_PENDING', budget_original_id: SQL_OPF2, budget_status: 'RELEASED' }), c2: ['ADMITTED', 'ADMITTED'] });
  });
  it('V10 control R2: an active paid UNKNOWN keeps head APPLY_PENDING even when all decisions are APPLIED', async () => {
    const plan = sqlPlan();
    const applied1 = sqlDecision(SQL_C1, SQL_P1), applied2 = sqlDecision(SQL_C2, SQL_P2);
    const head = sqlHead(plan, { version: 1, targetCount: 2, newCandidatePoints: 2, contacts: [applied1, applied2] });
    const rows = [
      { id: SQL_F1, contact_id: SQL_C1, dispatch_phase: 'RESERVED', domain_state: 'PENDING', budget_original_id: SQL_OPF1, budget_status: 'RESULT_UNKNOWN' },
      { id: SQL_F2, contact_id: SQL_C2, dispatch_phase: 'SETTLED', domain_state: 'APPLIED', budget_original_id: SQL_OPF2, budget_status: 'SETTLED' },
    ];
    const state = { snapshot: head.result_snapshot, remaining: 0, status: 'APPLY_PENDING', updates: [] as string[], contactsLocked: [] as string[], headSql: [] as string[] };
    const { tx } = sqlTx({ plan, head, rows, state });
    const store = createSqlEnrichmentDomainCommitStore({ withWorkspace: (_w, fn) => fn(tx) } as never, {});
    await store.persist(tx as never, { workspaceId: SQL_W, companyId: SQL_COMPANY, executionId: SQL_EXEC, contactId: SQL_C1 }, applied1, []);
    expect({ head: state.status, decisions: (state.snapshot as { contacts: Array<{ status: string }> }).contacts.map((entry) => entry.status) }).toEqual({ head: 'APPLY_PENDING', decisions: ['APPLIED', 'APPLIED'] });
  });
  it('V10 control I09: readCommitted does not replay APPLIED while a paid original remains UNKNOWN', async () => {
    const plan = sqlPlan();
    const applied = sqlDecision(SQL_C1, SQL_P1);
    const head = sqlHead(plan, { version: 1, targetCount: 2, newCandidatePoints: 1, contacts: [applied] });
    const unknownRows = [{ id: SQL_F1, contact_id: SQL_C1, dispatch_phase: 'RESERVED', domain_state: 'PENDING', budget_original_id: SQL_OPF1, budget_status: 'RESULT_UNKNOWN' }];
    const blocked = sqlTx({ plan, head, rows: unknownRows });
    const store = createSqlEnrichmentDomainCommitStore({ withWorkspace: (_w, fn) => fn(blocked.tx) } as never, {});
    expect(await store.readCommitted(blocked.tx as never, { workspaceId: SQL_W, companyId: SQL_COMPANY, executionId: SQL_EXEC, contactId: SQL_C1 })).toBeNull();
    const coherent = sqlTx({ plan, head, rows: [sqlFinderRow(SQL_C1, 0, SQL_F1, SQL_OPF1, SQL_DIG1)] });
    const coherentStore = createSqlEnrichmentDomainCommitStore({ withWorkspace: (_w, fn) => fn(coherent.tx) } as never, {});
    expect(await coherentStore.readCommitted(coherent.tx as never, { workspaceId: SQL_W, companyId: SQL_COMPANY, executionId: SQL_EXEC, contactId: SQL_C1 })).toMatchObject({ status: 'APPLIED', contactId: SQL_C1 });
  });
  it('V10 control: an unpaid fresh miss still reuses the safe cache with zero wire and NO_MATCH', async () => {
    const requestHash = enrichmentRequestHash(CA, 'hunter', { fullName: 'Person 0', domain: 'company.example.invalid', companyName: 'Synthetic Company' });
    const x = flowWorld({ finder: 'miss', useDefaultAttemptCache: true, attemptRows: [{ requestHash, outcome: 'miss', attemptedAt: new Date(Date.now() - 60 * 60_000) }] });
    await run(x);
    const decision = x.decisions.get(CA);
    expect({ status: decision?.status, reason: decision?.reasonCode, brokerCalls: x.broker.invoke.mock.calls.length }).toEqual({ status: 'APPLIED', reason: 'NO_MATCH', brokerCalls: 0 });
  });
});
});

describe('V8 lifecycle RED/GREEN: real managed loader and real SQL store status', () => {
  const LW = '20000000-0000-4000-8000-000000000001', LC = '20000000-0000-4000-8000-000000000002', LA = '20000000-0000-4000-8000-000000000003', LACCOUNT = '20000000-0000-4000-8000-000000000004', LEXEC = '20000000-0000-4000-8000-000000000005', LSTEP = '20000000-0000-4000-8000-000000000006', LCONTACT = '20000000-0000-4000-8000-000000000007';
  function lifecyclePrisma(row: Record<string, unknown>) {
    const tx = {
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
        const sql = strings.join('?');
        if (sql.includes('FROM public.contact_enrichment_execution_step s JOIN')) return [row];
        throw new Error('unexpected lifecycle SQL: ' + sql.slice(0, 120));
      }),
      canonicalContact: { findFirst: vi.fn(async () => ({ fullName: 'Synthetic Person', company: { name: 'Synthetic Company', domain: 'company.example.invalid' } })) },
    };
    return {
      dataProvider: { findUnique: vi.fn(async () => ({ status: 'ENABLED' })) },
      sourcePolicy: { findUnique: vi.fn(async () => ({ reviewStatus: 'APPROVED', allowedPurpose: ['enrichment'], retentionDays: 1, updatedAt: new Date(1000) })) },
      withWorkspace: vi.fn(async (_workspace: string, fn: (client: unknown) => Promise<unknown>) => fn(tx)),
    };
  }
  const unsealedFinderRow = { id: LSTEP, workspace_id: LW, execution_id: LEXEC, contact_id: LCONTACT, contact_ordinal: 0, slot_key: 'c0-finder', phase: 'FINDER', provider: 'hunter', tool_id: 'contact_email.find.hunter', tool_version: '1.0.0', quote_microusd: 1700n, pricing_version: 'p1', depends_on_slot_key: null, input_fingerprint: null, operation_key: null, budget_operation_id: null, candidate_ref: null, revision: 1, dispatch_phase: 'ADMITTED', domain_state: 'PENDING', company_id: LC, authority_id: LA, account_id: LACCOUNT, generation: 1, account_key: 'original-key', execution_status: 'PREPARED', deadline_open: true, budget_original_id: null, budget_status: null, budget_amount_unit: null, budget_reserved_microusd: null, budget_charged_microusd: null, budget_result_schema: null, budget_result_digest: null, budget_result_json: null, budget_receipt_usage: null, budget_receipt_cost_basis: null };
  it('a fresh unsealed FINDER derives trusted input through the real managed loader without pre-sealing', async () => {
    let captured: ContactEnrichmentSafetyToolDeps | undefined;
    const managed = await createManagedContactEnrichmentSafety({
      prisma: lifecyclePrisma(unsealedFinderRow) as never,
      env: { ...ARTIFACT_ENV, HUNTER_API_KEY: 'fake-hunter' } as NodeJS.ProcessEnv,
      budgetStore: { readOperationResult: vi.fn() } as never,
      authority: { verifyWorkspaceGrant: vi.fn() } as never,
      grantConsumer: { consumeVerifiedWorkspaceGrantInTransaction: vi.fn() } as never,
      buildBroker: (ports) => { captured = ports; return { invoke: vi.fn(), checkSourcePolicy: vi.fn(async () => ({ allowed: true })) } as never; },
    });
    expect(managed.service).toBeDefined();
    await expect((captured!.loadTrustedInput as unknown as (stepId: string, ctx: unknown, derive: boolean) => Promise<unknown>)(LSTEP, { workspaceId: LW, runId: 'original-key', purpose: 'enrichment', authorizeExternalAction: async () => true, artifactSubject: { subjectType: 'contact', subjectId: LCONTACT } }, true)).resolves.toMatchObject({ finder: { fullName: 'Synthetic Person', domain: 'company.example.invalid' } });
  });
  it('a partial multi-contact persist keeps the head RUNNING so the next contact is not blocked', async () => {
    const plan = sqlPlan(); const state = { snapshot: null as unknown, remaining: 1, status: 'PREPARED', updates: [] as string[], contactsLocked: [] as string[], headSql: [] as string[] };
    state.snapshot = { version: 1, targetCount: 2, newCandidatePoints: 0, contacts: [] };
    const { tx } = sqlTx({ plan, head: sqlHead(plan), rows: [], state });
    const store = createSqlEnrichmentDomainCommitStore({ withWorkspace: (_w, fn) => fn(tx) } as never, {});
    await store.persist(tx as never, { workspaceId: SQL_W, companyId: SQL_COMPANY, executionId: SQL_EXEC, contactId: SQL_C1 }, sqlDecision(SQL_C1, SQL_P1), []);
    expect(state.status).toBe('RUNNING');
  });
});

describe('V9 four source-block REDs', () => {
  it('C2: another contact SAVE_PENDING prevents persist from reopening RUNNING', async () => {
    const plan = sqlPlan(); const state = { snapshot: { version: 1, targetCount: 2, newCandidatePoints: 0, contacts: [] } as unknown, remaining: 1, status: 'APPLY_PENDING', updates: [] as string[], contactsLocked: [] as string[], headSql: [] as string[] };
    const { tx } = sqlTx({ plan, head: sqlHead(plan), rows: [], state });
    const store = createSqlEnrichmentDomainCommitStore({ withWorkspace: (_w, fn) => fn(tx) } as never, {});
    const pending = { status: 'SAVE_PENDING' as const, contactId: SQL_C1, reasonCode: 'INPUT_CONFLICT' as const, state: null, pointRefs: [], eventRefs: [], attemptRefs: [], newCandidatePoints: 0 };
    await store.persist(tx as never, { workspaceId: SQL_W, companyId: SQL_COMPANY, executionId: SQL_EXEC, contactId: SQL_C1 }, pending, []);
    expect(state.status).toBe('APPLY_PENDING');
    await store.persist(tx as never, { workspaceId: SQL_W, companyId: SQL_COMPANY, executionId: SQL_EXEC, contactId: SQL_C2 }, sqlDecision(SQL_C2, SQL_P2), []);
    expect(state.status).toBe('APPLY_PENDING');
  });
  it('C3: candidate-origin guard connects UUID workspace to VARCHAR ledger scope explicitly', async () => {
    let sqlText = '';
    const tx = { $queryRaw: vi.fn(async (strings: TemplateStringsArray) => { sqlText = strings.join('?'); return [{ status: 'SETTLED', amount_unit: 'microusd', result_schema: 'contact-email-find-hunter/v1', result_digest: 'b'.repeat(64), scope_key: SQL_W, account_id: SQL_ACCOUNT, generation: 1, step_contact_id: SQL_C1, step_execution_id: SQL_EXEC, step_contact_ordinal: 0, step_phase: 'FINDER', execution_company_id: SQL_COMPANY }]; }) };
    const guards = createSqlEnrichmentStepGuards({} as never, {});
    await guards.assertCandidateOrigin(tx as never, { workspace_id: SQL_W, contact_id: SQL_C1, execution_id: SQL_EXEC, contact_ordinal: 0, company_id: SQL_COMPANY, account_id: SQL_ACCOUNT, generation: 1 } as never, { operationId: SQL_OPF1, resultDigest: 'b'.repeat(64), artifactRef: { operationId: SQL_OPF1 } } as never);
    expect(sqlText).toContain('s.workspace_id::text=o.scope_key');
  });
  it('C5: an invalid optional provider keeps the shared broker alive and contact lane unavailable', async () => {
    const prisma = { dataProvider: { findUnique: vi.fn(async () => ({ status: 'ENABLED' })) }, sourcePolicy: { findUnique: vi.fn(async ({ where }: { where: { domain: string } }) => ({ reviewStatus: 'APPROVED', allowedPurpose: ['enrichment'], retentionDays: where.domain.includes('zerobounce') ? 0 : 1, updatedAt: new Date(1000) })) }, withWorkspace: vi.fn(async (_w: string, fn: (tx: unknown) => Promise<unknown>) => fn({})) };
    const dummy = { invoke: vi.fn(), checkSourcePolicy: vi.fn(async () => ({ allowed: true })) };
    const managed = await createManagedContactEnrichmentSafety({
      prisma: prisma as never,
      env: { ...ARTIFACT_ENV, HUNTER_API_KEY: 'h', MILLIONVERIFIER_API_KEY: 'm', EMAILABLE_API_KEY: 'e', ZEROBOUNCE_API_KEY: 'z' } as NodeJS.ProcessEnv,
      budgetStore: { readOperationResult: vi.fn() } as never,
      authority: { verifyWorkspaceGrant: vi.fn() } as never,
      grantConsumer: { consumeVerifiedWorkspaceGrantInTransaction: vi.fn() } as never,
      buildBroker: (ports) => { if (ports) createContactEnrichmentSafetyTools(ports); return dummy as never; },
    });
    expect(managed.broker).toBe(dummy); expect(managed.service).toBeUndefined(); expect(managed.unavailableReason).toBeDefined();
  });
});
