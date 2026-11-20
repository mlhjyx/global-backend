import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  applyFeedback, canonicalJson, createInitialDocument, documentHash,
  parseDocument, parseDraft, parseFeedback,
} from './market-candidate-set.document';

const companyId = '00000000-0000-4000-8000-000000000001';
const offeringId = '00000000-0000-4000-8000-000000000002';
const candidateIds = ['00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004'];
const setId = '00000000-0000-4000-8000-000000000005';
const key = `OFFERING:${offeringId}`;
const statement = (text: string, knowledgeState = 'INFERENCE') => ({ text, knowledgeState, basisKeys: [key], impact: 'SYNTHETIC: requires independent verification' });
function draft() {
  return {
    generationOutcome: 'CANDIDATES_PROPOSED',
    sources: [{ kind: 'OFFERING', sourceId: offeringId }],
    candidates: [
      { proposal: {
        supplyOrCapability: { offeringId, description: 'SYNTHETIC HJT cells, not manufacturing equipment' },
        buyerOrganizationCountry: 'DE', projectCountry: 'FR',
        application: statement('SYNTHETIC module assembly'), organizationRole: statement('SYNTHETIC potential module manufacturer'),
        fitExplanation: statement('SYNTHETIC cells are a possible input; purchasing relation unverified'),
        entryConditions: [statement('SYNTHETIC certification unavailable', 'UNKNOWN')],
        support: [statement('SYNTHETIC seller claims supply', 'SELLER_ASSERTION')],
        counterEvidence: [statement('SYNTHETIC conflicting supply limit', 'CONFLICT')], gaps: [statement('SYNTHETIC no independent market evidence', 'UNKNOWN')],
        recommendation: { status: 'CONDITIONAL', reason: 'SYNTHETIC pending evidence, not verified buyer' },
        nextVerification: ['SYNTHETIC verify purchasing object and relation'],
      } },
      { proposal: {
        supplyOrCapability: { offeringId, description: 'SYNTHETIC cells' }, buyerOrganizationCountry: 'DE', projectCountry: null,
        application: statement('SYNTHETIC agricultural application'), organizationRole: statement('SYNTHETIC award/title alone does not establish buyer', 'UNKNOWN'),
        fitExplanation: statement('SYNTHETIC capability conflict', 'CONFLICT'), entryConditions: [], support: [],
        counterEvidence: [statement('SYNTHETIC unsupported supply scope', 'SELLER_ASSERTION')], gaps: [statement('SYNTHETIC procurement object unknown', 'UNKNOWN')],
        recommendation: { status: 'NOT_RECOMMENDED', reason: 'SYNTHETIC counter-evidence retained' }, nextVerification: [],
      } },
    ],
  };
}
function doc() {
  return createInitialDocument(parseDraft(draft()), { setId, companyId, candidateIds }, {
    company: { companyId, version: 1 },
    sources: [{ key, kind: 'OFFERING', sourceId: offeringId, version: null, status: null,
      digest: 'a'.repeat(64), contentHash: null, parentId: null, parentContentHash: null,
      position: null, sourceDate: null }],
  });
}

describe('MarketCandidateSetV1 immutable document', () => {
  it('keeps supply/application, two countries, unknowns and same-country candidates distinct', () => {
    const value = parseDocument(doc());
    expect(value.candidates.map(c => c.candidateId)).toEqual(candidateIds);
    expect(value.candidates[0].proposal.buyerOrganizationCountry).toBe('DE');
    expect(value.candidates[0].proposal.projectCountry).toBe('FR');
    expect(value.candidates[1].proposal.projectCountry).toBeNull();
    expect(value.candidates[0].proposal.supplyOrCapability.description).toContain('not manufacturing equipment');
    expect(value.candidates[1].proposal.organizationRole.knowledgeState).toBe('UNKNOWN');
  });
  it('distinguishes a legitimate completed empty document from an invalid positive outcome', () => {
    expect(parseDraft({ generationOutcome: 'COMPLETED_EMPTY', sources: [], candidates: [] }).candidates).toEqual([]);
    expect(() => parseDraft({ generationOutcome: 'CANDIDATES_PROPOSED', sources: [], candidates: [] })).toThrow();
    const nonempty = draft(); nonempty.generationOutcome = 'COMPLETED_EMPTY';
    expect(() => parseDraft(nonempty)).toThrow();
  });
  it('rejects duplicated stable candidate identities and references outside the snapshot', () => {
    const duplicate = doc(); duplicate.candidates[1].candidateId = candidateIds[0];
    expect(() => parseDocument(duplicate)).toThrow();
    const forged = doc(); forged.candidates[0].proposal.support[0].basisKeys = ['CLAIM:00000000-0000-4000-8000-000000000099'];
    expect(() => parseDocument(forged)).toThrow();
  });
  it.each([
    (d: ReturnType<typeof draft>) => { (d as unknown as Record<string, unknown>).workspaceId = companyId; },
    (d: ReturnType<typeof draft>) => { (d.candidates[0] as unknown as Record<string, unknown>).candidateId = candidateIds[0]; },
    (d: ReturnType<typeof draft>) => { (d.candidates[0].proposal as unknown as Record<string, unknown>).verified = true; },
    (d: ReturnType<typeof draft>) => { (d.candidates[0].proposal.organizationRole as unknown as Record<string, unknown>).email = 'synthetic@example.invalid'; },
    (d: ReturnType<typeof draft>) => { d.candidates[0].proposal.buyerOrganizationCountry = 'de'; },
    (d: ReturnType<typeof draft>) => { d.candidates[0].proposal.application.knowledgeState = 'VERIFIED_BUYER'; },
    (d: ReturnType<typeof draft>) => { d.candidates[0].proposal.support[0].text = 'x'.repeat(2001); },
    (d: ReturnType<typeof draft>) => { (d.candidates[0].proposal as unknown as Record<string, unknown>).support = null; },
    (d: ReturnType<typeof draft>) => { (d.sources[0] as unknown as Record<string, unknown>).version = 42; },
  ])('rejects forged identity, hidden fields and malformed nested inputs', mutate => {
    const value = draft(); mutate(value); expect(() => parseDraft(value)).toThrow();
  });
  it('enforces resource bounds without a business minimum', () => {
    const value = draft(); value.candidates = Array.from({ length: 101 }, () => structuredClone(value.candidates[0]));
    expect(() => parseDraft(value)).toThrow();
    const oversized = draft(); oversized.candidates = Array.from({ length: 100 }, () => structuredClone(oversized.candidates[0]));
    for (const c of oversized.candidates) c.proposal.fitExplanation.text = 'x'.repeat(2000);
    expect(() => parseDraft(oversized)).toThrow();
  });
  it('canonicalizes object keys, preserves array order and rejects non-JSON values', () => {
    expect(canonicalJson({ b: 2, a: [1, 2] })).toBe('{"a":[1,2],"b":2}');
    expect(canonicalJson({ a: [2, 1], b: 2 })).toBe('{"a":[2,1],"b":2}');
    for (const invalid of [NaN, Infinity, undefined, new Date(), () => 1, { a: undefined }, 1n]) expect(() => canonicalJson(invalid)).toThrow();
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic; expect(() => canonicalJson(cyclic)).toThrow();
    expect(documentHash({ b: 2, a: [1, 2] })).toBe(createHash('sha256').update('{"a":[1,2],"b":2}').digest('hex'));
  });
  it.each([['CONFIRM', 'CONFIRMED'], ['KEEP_PENDING', 'PENDING_EVIDENCE'], ['REJECT', 'REJECTED']])('records %s without rewriting proposal or another candidate', (action, state) => {
    const old = doc(); const before = structuredClone(old);
    const next = applyFeedback(old, candidateIds[0], parseFeedback({ expectedRevision: 1, action, reason: ' original reason ' }));
    expect(next.revision).toBe(2); expect(next.candidates[0].feedback).toBe(state);
    expect(next.candidates[0].proposal).toEqual(before.candidates[0].proposal);
    expect(next.candidates[1]).toEqual(before.candidates[1]); expect(old).toEqual(before);
  });
  it('correction preserves proposal/basis/counter-evidence, marks reassessment unknown and persists through later confirmation', () => {
    const original = doc();
    const corrected = applyFeedback(original, candidateIds[0], parseFeedback({ expectedRevision: 1, action: 'CORRECT', correction: { projectCountry: null, application: 'SYNTHETIC changed user assertion' } }));
    expect(corrected.candidates[0]).toMatchObject({ candidateId: candidateIds[0], feedback: 'CORRECTED', needsReassessment: true, impactScope: 'UNKNOWN', corrections: { projectCountry: null, application: 'SYNTHETIC changed user assertion' } });
    const confirmed = applyFeedback(corrected, candidateIds[0], parseFeedback({ expectedRevision: 2, action: 'CONFIRM' }));
    expect(confirmed.candidates[0].corrections).toEqual(corrected.candidates[0].corrections);
    expect(confirmed.candidates[0].needsReassessment).toBe(true);
    expect(confirmed.basisSnapshot).toEqual(original.basisSnapshot);
    expect(confirmed.candidates[0].proposal).toEqual(original.candidates[0].proposal);
  });
  it.each(['supplyOrCapability', 'application', 'organizationRole', 'fitExplanation', 'recommendation'])('rejects a missing required nested %s object', field => {
    const value = draft(); delete (value.candidates[0].proposal as Record<string, unknown>)[field];
    expect(() => parseDraft(value)).toThrow();
  });
  it('rejects missing required nullable snapshot fields instead of silently producing an incomplete contract', () => {
    const value = doc(); delete (value.basisSnapshot.sources[0] as unknown as Record<string, unknown>).position;
    expect(() => parseDocument(value)).toThrow();
  });
  it('requires a substantive correction rather than an empty or unchanged patch', () => {
    expect(() => parseFeedback({ expectedRevision: 1, action: 'CORRECT', correction: {} })).toThrow();
    expect(() => applyFeedback(doc(), candidateIds[0], parseFeedback({ expectedRevision: 1, action: 'CORRECT', correction: { projectCountry: 'FR' } }))).toThrow();
  });
  it.each([
    { action: 'CONFIRM', correction: { application: 'x' } }, { action: 'CORRECT' },
    { action: 'CORRECT', correction: { verified: true } }, { action: 'CORRECT', correction: { application: null } },
    { action: 'CONFIRM', actorId: companyId }, { action: 'ACCEPT' },
    { action: 'CONFIRM', expectedRevision: null }, { action: 'CONFIRM', expectedRevision: 1.2 },
    { action: 'CONFIRM', expectedRevision: 2147483648 },
  ])('rejects an invalid feedback intention: %j', patch => {
    expect(() => parseFeedback({ expectedRevision: 1, ...patch })).toThrow();
  });
  it('preserves nonblank reasons verbatim and normalizes absent/null/blank reasons to null', () => {
    for (const reason of [undefined, null, '', ' \t\n']) expect(parseFeedback({ expectedRevision: 1, action: 'REJECT', ...(reason === undefined ? {} : { reason }) }).reason).toBeNull();
    expect(parseFeedback({ expectedRevision: 1, action: 'REJECT', reason: ' because ' }).reason).toBe(' because ');
  });
});
