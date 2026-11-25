import { DomainAckService, type DomainAckRecord } from "../../durable-results/domain-ack";
import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { EnrichmentDomainCommitter, type EnrichmentDomainCommitDeps, type EnrichmentContactApplyDecision, type LockedEnrichmentContactCommitState } from "./enrichment-domain-commit";
import { contactTargetBeforeDigest } from "./enrichment-target-snapshot";
import { enrichmentInputVersion } from "../finders/email-enrichment-provider";
import type { EnrichmentDomainMaterializedResult, BoundEnrichmentStep, SettledEnrichmentStepReference } from "./enrichment-safety.contract";
import { getDomainAckProductConsumerBinding } from "../../durable-results/domain-ack-consumer-bindings";
const id = (n: number) => '00000000-0000-4000-8000-' + n.toString().padStart(12, '0');
const address = { workspaceId: id(1), companyId: id(2), executionId: id(3), contactId: id(4) };
const input = { fullName: 'Synthetic Person', domain: 'company.example.invalid', companyName: 'Synthetic Company' };
const NOW = new Date('2026-11-22T00:00:00.000Z');
function domainWorld(options: { miss?: boolean; singleVote?: boolean; wrongInput?: boolean; existingPoint?: boolean; denied?: boolean; failEvent?: boolean; failSnapshot?: boolean } = {}) {
  const events: string[] = []; let saved: EnrichmentContactApplyDecision | null = null; let pointRows: string[] = [], eventRows: string[] = [], attemptRows: string[] = [], ackRows: string[] = [];
  const materialized: EnrichmentDomainMaterializedResult[] = [];
  const base = (n: number, provider: string, phase: 'FINDER' | 'VERIFY', quote: string): BoundEnrichmentStep => ({ ...address, stepId: id(10 + n), slotKey: 'slot' + n, contactOrdinal: 0, phase, provider, toolId: phase === 'FINDER' ? 'contact_email.find.hunter' : 'contact_email.verify.' + provider, toolVersion: '1.0.0', quoteMicrousd: quote, pricingVersion: 'p1', dependsOnSlotKey: phase === 'FINDER' ? null : 'slot0', authorityId: id(5), accountId: id(6), generation: 1, accountKey: 'actual-account-key', inputFingerprint: 'e'.repeat(64), operationKey: 'actual-operation-' + n, candidateRef: null, revision: 3, budgetOperationId: id(20 + n) });
  const reference = (step: BoundEnrichmentStep): SettledEnrichmentStepReference => ({ stepId: step.stepId, producerId: step.toolId, resultSchema: step.phase === 'FINDER' ? 'contact-email-find-hunter/v1' : 'contact-email-verify-' + step.provider + '/v1', resultDigest: 'b'.repeat(64), durableReceipt: { schemaVersion: 'durable-execution-receipt/v1', scopeKey: address.workspaceId, authorityId: step.authorityId, accountId: step.accountId, operationId: step.budgetOperationId!, operationKey: step.operationKey, resultStrategy: step.phase === 'FINDER' ? 'artifact_reference' : 'typed_projection', resultSchema: step.phase === 'FINDER' ? 'contact-email-find-hunter/v1' : 'contact-email-verify-' + step.provider + '/v1', resultDigest: 'b'.repeat(64), artifactId: step.phase === 'FINDER' ? id(30) : null, usage: { currency: 'USD', unit: 'microusd', callCount: 1, chargedMicrousd: step.quoteMicrousd, upperBoundMicrousd: step.quoteMicrousd }, costBasis: 'estimated_upper_bound', status: 'SETTLED' } });
  const finder = base(0, 'hunter', 'FINDER', '1700'); materialized.push({ phase: 'FINDER', step: finder, reference: reference(finder), result: options.miss ? { status: 'miss', email: null, providerConfidence: null, acceptAll: null, pattern: null, reason: 'no_match' } : { status: 'hit', email: 'person@company.example.invalid', providerConfidence: 90, acceptAll: false, pattern: null, reason: 'candidate_found' } });
  if (!options.miss) for (const [n, provider, quote] of [[1, 'millionverifier', '1780'], [2, 'emailable', '1700']] as const) {
    if (options.singleVote && n === 2) break;
    const step = base(n, provider, 'VERIFY', quote); Object.assign(step, { candidateRef: { operationId: finder.budgetOperationId, resultDigest: 'b'.repeat(64), artifactRef: { schemaVersion: 'generic-operation-artifact-ref/v1', operationId: finder.budgetOperationId, artifactId: id(30), resultSchema: 'contact-email-find-hunter/v1', sha256: 'b'.repeat(64), sizeBytes: '128', mediaType: 'application/octet-stream', expiresAt: '2099-01-01T00:00:00.000Z' } } }); materialized.push({ phase: 'VERIFY', step, reference: reference(step), result: { data: { providerKey: provider, state: 'VALID', catchAll: 'not_catch_all', catchAllClass: 'not_catch_all', score: 90, acceptAll: false, disposable: false, role: false, reason: 'provider_verdict', costBasis: 'estimated_upper_bound' }, costCents: Number(quote) / 10000, costMicrousd: quote } });
  }
  const inputVersion = enrichmentInputVersion(input);
  const state: LockedEnrichmentContactCommitState = { ...address, authorityId: id(5), accountId: id(6), generation: 1, businessRunId: null, target: { contactId: address.contactId, contactOrdinal: 0, inputVersion, beforeDigest: contactTargetBeforeDigest({ inputVersion, points: [] }), pointRefs: [] }, currentInput: options.wrongInput ? { ...input, fullName: 'Changed Person' } : input, currentPoints: options.existingPoint ? [{ id: id(31), type: 'email', value: 'already@company.example.invalid', status: 'VALID', verificationState: 'VALID', validSince: NOW.toISOString(), verifiedAt: NOW.toISOString(), nextReverifyAt: null, lastVerificationEventId: null, confidence: 95 }] : [], originalReferences: materialized.map(({ step, reference }) => ({ step, reference })), committed: null, redacted: false, lawfulBasis: { basis: 'legitimate_interest' }, pendingOperationIds: [], originalSmtpAcknowledgements: [], qualityPoints: [] };
  const tx = {
    $executeRawUnsafe: vi.fn(async () => 1),
    contactPoint: { upsert: vi.fn(async () => { events.push('POINT'); pointRows.push(id(31)); return { id: id(31), verificationState: 'UNKNOWN', validSince: null, nextReverifyAt: null }; }), update: vi.fn(async () => { events.push('POINT_STATE'); return { id: id(31) }; }) },
    contactPointVerificationEvent: { count: vi.fn(async () => eventRows.length), create: vi.fn(async () => { events.push('EVENT'); if (options.failEvent) throw new Error('synthetic_event_failure'); const row = id(40 + eventRows.length); eventRows.push(row); return { id: row }; }), findUnique: vi.fn(async () => null) },
    contactEnrichmentAttempt: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { events.push('ATTEMPT'); const row = id(50); attemptRows.push(row); return { id: row, providerKey: data.providerKey, requestHash: data.requestHash, outcome: data.outcome, errorCode: null, emailState: data.emailState ?? null, costMicrousd: data.costMicrousd, attemptedAt: NOW }; }), findUnique: vi.fn(async () => null), update: vi.fn(async () => ({ id: id(50) })) },
  };
  const transactions = { withWorkspace: async <T>(_workspace: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) => {
    const snapshot = structuredClone({ saved, pointRows, eventRows, attemptRows, ackRows }); events.push('BEGIN_FAKE');
    try { const result = await fn(tx as never); events.push('COMMIT_FAKE'); return result; }
    catch (error) { ({ saved, pointRows, eventRows, attemptRows, ackRows } = snapshot); events.push('ROLLBACK_FAKE'); throw error; }
  } };
  const deps: EnrichmentDomainCommitDeps = { transactions, clock: () => NOW, store: {
    readCommitted: vi.fn(async () => saved), lockAndLoad: vi.fn(async () => { events.push('AUTHORITY_ACCOUNT_HEAD_STEPS_CONTACT_POINTS_LOCK_PORT_FAKE'); return { ...state, committed: saved }; }),
    savePending: vi.fn(async () => { events.push('SAVE_PENDING'); }), persist: vi.fn(async (_tx, _address, decision) => { events.push('HEAD_STEP_SNAPSHOT'); if (options.failSnapshot) throw new Error('synthetic_snapshot_failure'); saved = decision; }),
  }, materialize: vi.fn(async (stepId) => materialized.find((result) => result.step.stepId === stepId) ?? null), authorizeCurrent: vi.fn(async () => !options.denied), acknowledge: vi.fn(async (request) => { expect(request.transaction).toBe(tx); events.push('ACK'); ackRows.push(...request.acknowledgements.map((item) => item.receipt.operationId)); return { status: 'APPLIED', value: await request.apply(tx as never) }; }) };
  return { committer: new EnrichmentDomainCommitter(deps), deps, state, materialized, stepIds: materialized.map((result) => result.step.stepId), tx, events, data: () => ({ saved, pointRows, eventRows, attemptRows, ackRows }) };
}
describe('same-transaction domain commit with original writers, fake ports only', () => {
  it('stores one actually new point and original votes/attempt, then ACK and head/step snapshot in one transaction port', async () => {
    const x = domainWorld(); const result = await x.committer.commitContact(address, x.stepIds, 'synthetic-actor');
    expect(result).toMatchObject({ status: 'APPLIED', state: 'VALID', newCandidatePoints: 1, pointRefs: [id(31)] }); expect(x.data().eventRows).toHaveLength(2); expect(x.data().attemptRows).toHaveLength(1); expect(x.data().ackRows).toHaveLength(3);
    expect(x.events.indexOf('ACK')).toBeGreaterThan(x.events.indexOf('EVENT')); expect(x.events.indexOf('HEAD_STEP_SNAPSHOT')).toBeGreaterThan(x.events.indexOf('ACK')); expect(x.tx.contactPoint.update).toHaveBeenCalled();
  });
  it('never upgrades a single positive vote to VALID', async () => { const x = domainWorld({ singleVote: true }); expect(await x.committer.commitContact(address, x.stepIds, 'synthetic-actor')).toMatchObject({ state: 'UNKNOWN', newCandidatePoints: 1 }); });
  it('commits a real paid miss decision and attempt without inventing a point or free cost', async () => { const x = domainWorld({ miss: true }); expect(await x.committer.commitContact(address, x.stepIds, 'synthetic-actor')).toMatchObject({ status: 'APPLIED', reasonCode: 'NO_MATCH', newCandidatePoints: 0 }); expect(x.tx.contactPoint.upsert).not.toHaveBeenCalled(); expect(x.tx.contactEnrichmentAttempt.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ costMicrousd: 1700n, outcome: 'miss' }) })); });
  it('replays committed metadata without rematerialization, point writes or counting a second candidate', async () => { const x = domainWorld(); await x.committer.commitContact(address, x.stepIds, 'synthetic-actor'); const reads = vi.mocked(x.deps.materialize).mock.calls.length; expect(await x.committer.commitContact(address, x.stepIds, 'synthetic-actor')).toMatchObject({ status: 'REPLAYED', newCandidatePoints: 0 }); expect(x.tx.contactPoint.upsert).toHaveBeenCalledTimes(1); expect(vi.mocked(x.deps.materialize).mock.calls.length).toBe(reads); expect(x.data().saved?.newCandidatePoints).toBe(1); });
  it.each([{ wrongInput: true }, { existingPoint: true }, { denied: true }])('keeps changed input/current VALID/suppression pending without overwriting or ACK %#', async (options) => { const x = domainWorld(options); expect(await x.committer.commitContact(address, x.stepIds, 'synthetic-actor')).toMatchObject({ status: 'SAVE_PENDING', newCandidatePoints: 0 }); expect(x.tx.contactPoint.upsert).not.toHaveBeenCalled(); expect(x.deps.acknowledge).not.toHaveBeenCalled(); });
  it.each([{ failEvent: true }, { failSnapshot: true }])('propagates a write failure and fake-rolls back points/events/attempts/ACK/head %#', async (options) => { const x = domainWorld(options); await expect(x.committer.commitContact(address, x.stepIds, 'synthetic-actor')).rejects.toThrow(); expect(x.data()).toEqual({ saved: null, pointRows: [], eventRows: [], attemptRows: [], ackRows: [] }); expect(x.events).toContain('ROLLBACK_FAKE'); });
  it('rejects a materialized result from another original account before all domain writes', async () => { const x = domainWorld(); Object.assign(x.state, { accountId: id(99) }); await expect(x.committer.commitContact(address, x.stepIds, 'synthetic-actor')).rejects.toThrow(); expect(x.tx.contactPoint.upsert).not.toHaveBeenCalled(); expect(x.deps.acknowledge).not.toHaveBeenCalled(); });
  it('persists the same-transaction quality facts of a stored candidate', async () => {
    const x = domainWorld();
    const result = await x.committer.commitContact(address, x.stepIds, 'synthetic-actor');
    expect(result).toMatchObject({ status: 'APPLIED', newCandidatePoints: 1 });
    expect(x.deps.store.persist).toHaveBeenCalledWith(expect.anything(), address, expect.objectContaining({ newCandidatePoints: 1 }), expect.any(Array), expect.objectContaining({
      contactId: address.contactId, beforeStates: [], afterStates: ['VALID'], stockValidPersonal: false, eligible: true, newCandidate: true, newValidPersonal: false, unresolved: true,
    }));
  });
  it('persists a miss as unresolved without inventing a point state', async () => {
    const x = domainWorld({ miss: true });
    await x.committer.commitContact(address, x.stepIds, 'synthetic-actor');
    expect(x.deps.store.persist).toHaveBeenCalledWith(expect.anything(), address, expect.objectContaining({ reasonCode: 'NO_MATCH' }), expect.any(Array), expect.objectContaining({
      beforeStates: [], afterStates: [], newCandidate: false, newValidPersonal: false, unresolved: true,
    }));
  });
  it('records stock personal protection from the locked before points on a cache reuse', async () => {
    const inputVersion = enrichmentInputVersion(input);
    const stock = { id: id(31), type: 'email', value: 'person@company.example.invalid', status: 'VALID', verificationState: 'VALID', validSince: NOW.toISOString(), verifiedAt: NOW.toISOString(), nextReverifyAt: null, lastVerificationEventId: null, confidence: 95 };
    const state: LockedEnrichmentContactCommitState = { ...address, authorityId: id(5), accountId: id(6), generation: 1, businessRunId: null, target: { contactId: address.contactId, contactOrdinal: 0, inputVersion, beforeDigest: contactTargetBeforeDigest({ inputVersion, points: [stock] }), pointRefs: [stock.id] }, currentInput: input, currentPoints: [stock], qualityPoints: [{ id: stock.id, type: 'email', emailType: 'personal', verificationState: 'VALID' }], originalReferences: [], committed: null, redacted: false, lawfulBasis: { basis: 'legitimate_interest' }, pendingOperationIds: [], originalSmtpAcknowledgements: [] };
    const store = { readCommitted: vi.fn(async () => null), lockAndLoad: vi.fn(async () => state), savePending: vi.fn(async () => undefined), persist: vi.fn(async () => undefined) };
    const committer = new EnrichmentDomainCommitter({ transactions: { withWorkspace: async (_w, fn) => fn({} as never) } as never, store, materialize: vi.fn(async () => null) as never, authorizeCurrent: vi.fn(async () => true) });
    const decision = { status: 'APPLIED' as const, contactId: address.contactId, reasonCode: 'REUSED' as const, state: null, pointRefs: [], eventRefs: [], attemptRefs: [], newCandidatePoints: 0 };
    await committer.commitSkipped(address, decision);
    expect(store.persist).toHaveBeenCalledWith(expect.anything(), address, decision, [], expect.objectContaining({ beforeStates: ['VALID'], stockValidPersonal: true, eligible: false, newCandidate: false, newValidPersonal: false, unresolved: false }));
  });
});
describe('new producer consumption bindings are exact; SMTP retains its original consumer', () => {
  it.each(['hunter', 'millionverifier', 'emailable', 'zerobounce'])('binds only the actual safety domain consumer for %s', (provider) => {
    const producer = provider === 'hunter' ? 'contact_email.find.hunter' : 'contact_email.verify.' + provider;
    expect(getDomainAckProductConsumerBinding(producer)).toMatchObject({ consumer: 'EnrichmentDomainCommitter.commitContact', domainAggregateType: 'ContactEnrichmentExecution', resultSchema: provider === 'hunter' ? 'contact-email-find-hunter/v1' : 'contact-email-verify-' + provider + '/v1' });
  });
  it('does not add a second SMTP consumer', () => { expect(getDomainAckProductConsumerBinding('smtp.rcpt_probe').consumer).toBe('EmailVerificationProvider'); });
});


function addOriginalSmtpResult(x: ReturnType<typeof domainWorld>, reachable = true) {
  const original = x.materialized[1]!, old = original.step;
  const step: BoundEnrichmentStep = { ...old, phase: 'SMTP', provider: 'smtp_self', toolId: 'smtp.rcpt_probe', quoteMicrousd: '0', stepId: id(12), slotKey: 'smtp-slot', operationKey: 'actual-original-smtp-key', budgetOperationId: id(22) };
  const receipt = { ...original.reference.durableReceipt, operationId: id(22), operationKey: step.operationKey, resultSchema: 'smtp-probe-verdict/v1', usage: { currency: 'USD' as const, unit: 'microusd' as const, callCount: 1, chargedMicrousd: '0', upperBoundMicrousd: '0' } };
  const reference: SettledEnrichmentStepReference = { stepId: step.stepId, producerId: step.toolId, resultSchema: 'smtp-probe-verdict/v1', resultDigest: receipt.resultDigest, durableReceipt: receipt };
  const result: EnrichmentDomainMaterializedResult = { phase: 'SMTP', step, reference, result: { data: { reachable, mailFromCode: reachable ? 250 : null, codes: reachable ? [250, 550] : [] }, costCents: 0, durableReceipt: receipt } };
  x.materialized.push(result); x.stepIds.push(step.stepId); Object.assign(x.state, { originalReferences: [...x.state.originalReferences, { step, reference }] });
  return result;
}
describe('original verdict and ACK control regressions in the domain transaction', () => {
  it('preserves original INVALID stop semantics without silently creating a new email-qualified point', async () => {
    const x = domainWorld({ singleVote: true }); const vote = x.materialized[1]!;
    if (vote.phase !== 'VERIFY') throw new Error('bad synthetic fixture');
    Object.assign(vote.result.data, { state: 'INVALID', score: 0 });
    const result = await x.committer.commitContact(address, x.stepIds, 'synthetic-actor');
    expect(result).toMatchObject({ status: 'APPLIED', reasonCode: 'INVALID_ALL', newCandidatePoints: 0, pointRefs: [], eventRefs: [] });
    expect(x.tx.contactPoint.upsert).not.toHaveBeenCalled(); expect(x.tx.contactEnrichmentAttempt.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ emailState: 'INVALID' }) }));
  });
  it('uses the original SMTP verification score instead of fabricating a zero', async () => {
    const x = domainWorld({ singleVote: true }); addOriginalSmtpResult(x);
    expect(await x.committer.commitContact(address, x.stepIds, 'synthetic-actor')).toMatchObject({ state: 'VALID' });
    expect(x.tx.contactPointVerificationEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ providerKey: 'smtp_self', method: 'smtp_rcpt', score: 95, costMicrousd: 0n }) }));
  });
  it('preserves the last real voted provider when an original SMTP result has no verdict', async () => {
    const x = domainWorld({ singleVote: true }); addOriginalSmtpResult(x, false);
    expect(await x.committer.commitContact(address, x.stepIds, 'synthetic-actor')).toMatchObject({ state: 'UNKNOWN' });
    expect(x.tx.contactPoint.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ verificationProvider: 'millionverifier', verificationMethod: 'third_party_api' }) }));
  });
  it('never applies a known partial result while another original operation is still pending', async () => {
    const x = domainWorld(); Object.assign(x.state, { pendingOperationIds: [id(90)] }); await expect(x.committer.commitContact(address, x.stepIds, 'synthetic-actor')).rejects.toThrow(); expect(x.tx.contactPoint.upsert).not.toHaveBeenCalled(); expect(x.deps.acknowledge).not.toHaveBeenCalled();
  });
  it('uses the actual original ACK service/helper with a fake SQL-response port, not only the private acknowledge callback', async () => {
    const x = domainWorld(); const records = new Map<string, DomainAckRecord>();
    const expected = new DomainAckService({ apply: async (record: DomainAckRecord) => { records.set(record.operationId, record); return { status: 'APPLIED' as const, ack: record }; } });
    for (const result of x.materialized) {
      const binding = getDomainAckProductConsumerBinding(result.step.toolId);
      await expected.applyWithAck({ receipt: result.reference.durableReceipt, consumer: binding.consumer, domainAggregateType: binding.domainAggregateType, domainAckKey: `contact-enrichment:${address.executionId}:${address.contactId}:${result.reference.durableReceipt.operationId}`, domainRevision: result.reference.resultDigest }, async () => undefined);
    }
    x.deps.acknowledge = undefined;
    const query = vi.fn(async (sql: Prisma.Sql) => {
      if (sql.sql.includes('lock_execution_domain_ack_authority_first_v1')) return [{ locked: 1 }];
      if (!sql.sql.includes('apply_execution_domain_ack_v1')) throw new Error('unexpected synthetic ACK statement');
      const record = records.get(String(sql.values[1])); if (!record) throw new Error('missing synthetic original ACK expectation');
      expect(sql.values).toEqual([record.scopeKey, record.operationId, record.consumer, record.domainAggregateType, record.domainAckKey, record.domainRevision]);
      expect(x.events).toContain('POINT'); expect(x.events).toContain('EVENT'); x.events.push('ORIGINAL_ACK_HELPER_SQL_PORT_FAKE');
      return [{ status: 'APPLIED', ack_json: record }];
    });
    Object.assign(x.tx, { $queryRaw: query });
    expect(await x.committer.commitContact(address, x.stepIds, 'synthetic-actor')).toMatchObject({ status: 'APPLIED', state: 'VALID', newCandidatePoints: 1 }); expect(query).toHaveBeenCalledTimes(6);
  });
});

describe('Batch 1.6: Prospeo only_verified_email attestation & unverified point upgrade', () => {
  it('commits Prospeo VERIFIED (confidence=95) as VALID even when smtp_self returns unreachable/UNKNOWN', async () => {
    const x = domainWorld();
    const prospeoStep: BoundEnrichmentStep = {
      ...x.materialized[0]!.step,
      provider: 'prospeo',
      toolId: 'contact_email.find.prospeo',
      quoteMicrousd: '19800',
    };
    const prospeoRef: SettledEnrichmentStepReference = {
      ...x.materialized[0]!.reference,
      producerId: 'contact_email.find.prospeo',
      resultSchema: 'contact-email-find-prospeo/v1',
      durableReceipt: {
        ...x.materialized[0]!.reference.durableReceipt,
        resultSchema: 'contact-email-find-prospeo/v1',
        usage: {
          ...x.materialized[0]!.reference.durableReceipt.usage,
          chargedMicrousd: '19800',
          upperBoundMicrousd: '19800',
        },
      },
    };
    const prospeoMat: EnrichmentDomainMaterializedResult = {
      phase: 'FINDER',
      step: prospeoStep,
      reference: prospeoRef,
      result: {
        status: 'hit',
        email: 'person@company.example.invalid',
        providerConfidence: 95,
        acceptAll: null,
        pattern: null,
        reason: 'candidate_found',
      },
    };
    x.materialized.splice(0, x.materialized.length, prospeoMat);
    x.stepIds.splice(0, x.stepIds.length, prospeoStep.stepId);
    Object.assign(x.state, { originalReferences: [{ step: prospeoStep, reference: prospeoRef }] });
    const result = await x.committer.commitContact(address, x.stepIds, 'synthetic-actor');
    expect(result).toMatchObject({ status: 'APPLIED', reasonCode: 'STORED', state: 'VALID', newCandidatePoints: 1 });
    expect(x.tx.contactPointVerificationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          providerKey: 'prospeo',
          verdict: 'valid',
          detail: 'prospeo_only_verified_email',
        }),
      }),
    );
    expect(x.tx.contactEnrichmentAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ providerKey: 'prospeo', emailState: 'VALID' }),
      }),
    );
  });

  it('accepts corporate-group sibling TLD emails from Hunter (e.g. enpal.com -> @enpal.de) without HOLD', async () => {
    const x = domainWorld();
    const siblingInput = { fullName: 'Mario Kohle', domain: 'enpal.com', companyName: 'Enpal Italia Srl' };
    const inputVersion = enrichmentInputVersion(siblingInput);
    const hunterMat = x.materialized[0]!;
    if (hunterMat.phase !== 'FINDER') throw new Error('expected finder');
    Object.assign(hunterMat.result, { email: 'mario.kohle@enpal.de' });
    Object.assign(x.state, {
      currentInput: siblingInput,
      target: {
        ...x.state.target,
        inputVersion,
        beforeDigest: contactTargetBeforeDigest({ inputVersion, points: [] }),
      },
    });
    const result = await x.committer.commitContact(address, x.stepIds, 'synthetic-actor');
    expect(result).toMatchObject({ status: 'APPLIED', reasonCode: 'STORED', state: 'VALID', newCandidatePoints: 1 });
  });

  it('allows upgrading an existing unverified (UNKNOWN) email point without INPUT_CONFLICT', async () => {
    const x = domainWorld();
    const unverifiedPoint = {
      id: id(31),
      type: 'email',
      value: 'guess@company.example.invalid',
      status: 'RISKY',
      verificationState: 'UNKNOWN',
      validSince: null,
      verifiedAt: null,
      nextReverifyAt: null,
      lastVerificationEventId: null,
      confidence: 20,
    };
    const inputVersion = enrichmentInputVersion(input);
    Object.assign(x.state, {
      currentPoints: [unverifiedPoint],
      target: {
        ...x.state.target,
        beforeDigest: contactTargetBeforeDigest({ inputVersion, points: [unverifiedPoint] }),
        pointRefs: [unverifiedPoint.id],
      },
    });
    const result = await x.committer.commitContact(address, x.stepIds, 'synthetic-actor');
    expect(result).toMatchObject({ status: 'APPLIED', reasonCode: 'STORED', state: 'VALID', newCandidatePoints: 1 });
  });
});

describe('V9 C4: pending apply decisions are retried, not terminal-replayed', () => {
  it('retries a cached SAVE_PENDING decision when original results are available', async () => {
    const x = domainWorld();
    const pending: EnrichmentContactApplyDecision = { status: 'SAVE_PENDING', contactId: address.contactId, reasonCode: 'INPUT_CONFLICT', state: null, pointRefs: [], eventRefs: [], attemptRefs: [], newCandidatePoints: 0 };
    vi.mocked(x.deps.store.readCommitted).mockResolvedValue(pending);
    vi.mocked(x.deps.store.lockAndLoad).mockResolvedValue({ ...x.state, committed: pending });
    const result = await x.committer.commitContact(address, x.stepIds, 'synthetic-actor');
    expect(result.status).toBe('APPLIED');
    expect(x.deps.store.persist).toHaveBeenCalled();
  });
});
