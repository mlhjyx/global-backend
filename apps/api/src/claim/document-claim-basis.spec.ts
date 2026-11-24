import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  buildDocumentClaimApprovalProof,
  documentClaimBindingHash,
  documentClaimDependenciesStillCurrent,
  documentClaimOriginKey,
  documentClaimQuoteBytes,
  documentClaimRequestDigest,
  documentClaimStatementDigest,
  effectiveApprovedClaimsInTransaction,
  hasValidDocumentClaimApprovalAudit,
  loadDocumentClaimBindingInTransaction,
  loadDocumentClaimBindingsInTransaction,
  parseDocumentClaimSourceRef,
  verifyDocumentClaimReference,
  type DocumentClaimSourceRef,
  type VerifiedDocumentClaimBinding,
} from './document-claim-basis';

const W = '00000000-0000-4000-8000-000000000001';
const C = '00000000-0000-4000-8000-000000000002';
const D = '00000000-0000-4000-8000-000000000003';
const R = '00000000-0000-4000-8000-000000000004';
const USER = '00000000-0000-4000-8000-000000000005';
const sha = (n: string) => n.repeat(64).slice(0, 64);
const text = 'Acme 通过 ISO 9001 认证';
const textBytes = Buffer.from(text, 'utf8');
const chunkHash = createHash('sha256').update(text).digest('hex');
const ref = (overrides: Partial<DocumentClaimSourceRef> = {}): DocumentClaimSourceRef => ({
  documentId: D,
  documentContentHash: sha('a'),
  parseRevision: 2,
  chunkSeq: 0,
  chunkTextHash: chunkHash,
  quoteStartByte: 0,
  quoteEndByte: textBytes.length,
  ...overrides,
});
const document = {
  id: D,
  workspaceId: W,
  companyId: C,
  contentHash: sha('a'),
  parseRevision: 2,
  status: 'ready',
  deletedAt: null,
};
const chunk = { documentId: D, seq: 0, text };

describe('typed document claim reference is server-reverified and bounded', () => {
  it('accepts only the exact closed input keys', () => {
    expect(parseDocumentClaimSourceRef(ref())).toEqual(ref());
    for (const bad of [
      { ...ref(), workspaceId: W },
      { ...ref(), documentContentHash: 'A'.repeat(64) },
      { ...ref(), parseRevision: 0 },
      { ...ref(), chunkSeq: -1 },
      { ...ref(), quoteEndByte: 0 },
      { ...ref(), quoteStartByte: 10, quoteEndByte: 5 },
    ])
      expect(() => parseDocumentClaimSourceRef(bad)).toThrow();
  });
  it('slices complete UTF-8 bytes and refuses to split a multi-byte character', () => {
    expect(documentClaimQuoteBytes(text, 0, textBytes.length).quote).toBe(text);
    const eAcute = 'é';
    const bytes = Buffer.from(eAcute, 'utf8');
    expect(() => documentClaimQuoteBytes(eAcute, 0, 1)).toThrow(/BOUNDARY/);
    expect(documentClaimQuoteBytes(eAcute, 0, bytes.length).quote).toBe(eAcute);
    expect(() => documentClaimQuoteBytes('a', 0, 2)).toThrow(/OUT_OF_RANGE/);
  });
  it('refuses quotations over the existing evidence bound or blank text', () => {
    expect(() => documentClaimQuoteBytes('x'.repeat(2001), 0, 2001)).toThrow(/TOO_LARGE/);
    expect(() => documentClaimQuoteBytes('   ', 0, 3)).toThrow(/TOO_LARGE/);
  });
  it('binds request digest to requester while origin stays cross-requester stable', () => {
    const reference = ref();
    const base = { workspaceId: W, companyId: C, requesterId: USER, reference, type: 'certification', statement: 'ISO 9001' };
    expect(documentClaimRequestDigest(base)).not.toBe(documentClaimRequestDigest({ ...base, requesterId: '00000000-0000-4000-8000-000000000006' }));
    expect(documentClaimRequestDigest(base)).not.toBe(documentClaimRequestDigest({ ...base, statement: 'ISO 14001' }));
    const origin = {
      workspaceId: W,
      companyId: C,
      documentId: D,
      parseRevision: 2,
      chunkSeq: 0,
      quoteStartByte: 0,
      quoteEndByte: 10,
      type: 'certification',
      statementDigest: documentClaimStatementDigest('ISO 9001'),
    };
    expect(documentClaimOriginKey(origin)).toBe(documentClaimOriginKey({ ...origin }));
    expect(documentClaimOriginKey(origin)).not.toBe(documentClaimOriginKey({ ...origin, parseRevision: 3 }));
  });
  it('verifies the exact current document revision and quote against Evidence', () => {
    expect(
      verifyDocumentClaimReference({ document, chunk, evidenceSnippet: null, reference: ref(), context: { workspaceId: W, companyId: C } }).quote,
    ).toBe(text);
    expect(() => verifyDocumentClaimReference({ document: { ...document, status: 'processing' }, chunk, evidenceSnippet: null, reference: ref(), context: { workspaceId: W, companyId: C } })).toThrow(/UNAVAILABLE/);
    expect(() => verifyDocumentClaimReference({ document: { ...document, parseRevision: 3 }, chunk, evidenceSnippet: null, reference: ref(), context: { workspaceId: W, companyId: C } })).toThrow(/UNAVAILABLE/);
    expect(() => verifyDocumentClaimReference({ document, chunk: { ...chunk, text: text + '!' }, evidenceSnippet: null, reference: ref(), context: { workspaceId: W, companyId: C } })).toThrow(/CHANGED|OUT_OF_RANGE/);
    expect(() => verifyDocumentClaimReference({ document, chunk, evidenceSnippet: 'other', reference: ref(), context: { workspaceId: W, companyId: C } })).toThrow(/MISMATCH/);
  });
});

describe('document claim approval proof is version 4 only', () => {
  const binding = (): VerifiedDocumentClaimBinding => ({
    referenceId: R,
    bindingHash: sha('c'),
    documentId: D,
    sourceDocumentId: D,
    documentContentHash: sha('a'),
    parseRevision: 2,
    chunkSeq: 0,
    chunkTextHash: chunkHash,
    quoteStartByte: 0,
    quoteEndByte: textBytes.length,
    quote: text,
    claimType: 'certification',
    claimStatementDigest: documentClaimStatementDigest('ISO 9001'),
  });
  const claim = {
    id: '00000000-0000-4000-8000-000000000007',
    workspaceId: W,
    companyId: C,
    sourceId: '00000000-0000-4000-8000-000000000008',
    originKey: sha('d'),
    type: 'certification',
    statement: 'ISO 9001',
    validUntil: null,
    version: 2,
    verifiedBy: USER,
    verifiedAt: new Date('2026-11-23T00:00:00.000Z'),
    verificationMethod: 'human_review' as const,
    verificationProof: null as unknown,
  };
  const audit = { verifiedBy: USER, verifiedAt: claim.verifiedAt, verificationMethod: 'human_review' as const };
  it('round-trips a real human-review proof bound to reference, binding and version', () => {
    const proof = buildDocumentClaimApprovalProof(claim, 2, audit, binding());
    expect(proof.proofVersion).toBe(4);
    expect(proof.documentReferenceId).toBe(R);
    expect(hasValidDocumentClaimApprovalAudit({ ...claim, verificationProof: proof }, binding())).toBe(true);
    expect(hasValidDocumentClaimApprovalAudit({ ...claim, verificationProof: { ...proof, proofVersion: 3 } }, binding())).toBe(false);
    expect(hasValidDocumentClaimApprovalAudit({ ...claim, version: 3, verificationProof: proof }, binding())).toBe(false);
    expect(hasValidDocumentClaimApprovalAudit({ ...claim, verificationProof: { ...proof, bindingHash: sha('e') } }, binding())).toBe(false);
    expect(hasValidDocumentClaimApprovalAudit({ ...claim, verifiedBy: null, verificationProof: proof }, binding())).toBe(false);
  });
  it('recomputes binding digest from document, revision, exact quote, type and statement', () => {
    const base = {
      documentId: D,
      documentContentHash: sha('a'),
      parseRevision: 2,
      chunkSeq: 0,
      chunkTextHash: chunkHash,
      quoteStartByte: 0,
      quoteEndByte: textBytes.length,
      quoteDigest: documentClaimStatementDigest(text),
      type: 'certification',
      statementDigest: documentClaimStatementDigest('ISO 9001'),
    };
    expect(documentClaimBindingHash(base)).toBe(documentClaimBindingHash({ ...base }));
    expect(documentClaimBindingHash(base)).not.toBe(documentClaimBindingHash({ ...base, quoteEndByte: textBytes.length - 1 }));
    expect(documentClaimBindingHash(base)).not.toBe(documentClaimBindingHash({ ...base, statementDigest: documentClaimStatementDigest('other') }));
  });
});

describe('dependency recheck helper is wired', () => {
  it('returns false when no current binding can be loaded', async () => {
    const tx = {
      claim: { findFirst: async () => null },
    };
    expect(await documentClaimDependenciesStillCurrent(tx as never, { workspaceId: W, companyId: C }, [
      { claimId: '00000000-0000-4000-8000-000000000009', claimVersion: 2, referenceId: R, bindingHash: sha('c'), documentId: D, documentContentHash: sha('a'), parseRevision: 2, chunkSeq: 0, quoteStartByte: 0, quoteEndByte: 10 },
    ])).toBe(false);
  });

  it('handles Claim.statement = null safely without throwing', async () => {
    const binding: VerifiedDocumentClaimBinding = {
      referenceId: R,
      bindingHash: sha('c'),
      documentId: D,
      sourceDocumentId: D,
      documentContentHash: sha('a'),
      parseRevision: 2,
      chunkSeq: 0,
      chunkTextHash: chunkHash,
      quoteStartByte: 0,
      quoteEndByte: textBytes.length,
      quote: text,
      claimType: 'certification',
      claimStatementDigest: documentClaimStatementDigest('ISO 9001'),
    };
    const claim = {
      id: '00000000-0000-4000-8000-000000000010',
      workspaceId: W,
      companyId: C,
      sourceId: null,
      originKey: sha('d'),
      type: 'certification',
      statement: null,
      validUntil: null,
      version: 2,
      verifiedBy: USER,
      verifiedAt: new Date('2026-11-23T00:00:00.000Z'),
      verificationMethod: 'human_review',
      verificationProof: { action: 'claim_approval', proofVersion: 4, approvedVersion: 2, documentReferenceId: R, bindingHash: sha('c'), claimDigest: sha('f') },
    };
    expect(hasValidDocumentClaimApprovalAudit(claim, binding)).toBe(false);
    const tx = { claimDocumentEvidence: { findUnique: vi.fn() } };
    expect(await loadDocumentClaimBindingInTransaction(tx as never, { workspaceId: W, companyId: C }, claim)).toBeNull();
    expect(tx.claimDocumentEvidence.findUnique).not.toHaveBeenCalled();
  });

  it('batches N document claims in constant queries without N+1 round-trips', async () => {
    const verifiedAt = new Date('2026-11-25T00:00:00.000Z');
    const audit = { verifiedBy: USER, verifiedAt, verificationMethod: 'human_review' as const };
    const count = 8;
    const quoteDigest = documentClaimStatementDigest(text);
    const claimsList = Array.from({ length: count }, (_, i) => {
      const id = `00000000-0000-4000-8000-00000000010${i}`;
      const statement = `ISO 9001 claim #${i}`;
      const statementDigest = documentClaimStatementDigest(statement);
      const bindingHash = documentClaimBindingHash({
        documentId: D,
        documentContentHash: sha('a'),
        parseRevision: 2,
        chunkSeq: 0,
        chunkTextHash: chunkHash,
        quoteStartByte: 0,
        quoteEndByte: textBytes.length,
        quoteDigest,
        type: 'certification',
        statementDigest,
      });
      const referenceId = `00000000-0000-4000-8000-00000000020${i}`;
      const evidenceId = `00000000-0000-4000-8000-00000000030${i}`;
      const binding: VerifiedDocumentClaimBinding = {
        referenceId,
        bindingHash,
        documentId: D,
        sourceDocumentId: D,
        documentContentHash: sha('a'),
        parseRevision: 2,
        chunkSeq: 0,
        chunkTextHash: chunkHash,
        quoteStartByte: 0,
        quoteEndByte: textBytes.length,
        quote: text,
        claimType: 'certification',
        claimStatementDigest: statementDigest,
      };
      const baseClaim = {
        id,
        workspaceId: W,
        companyId: C,
        sourceId: null,
        originKey: sha(String(i)),
        type: 'certification',
        statement,
        version: 2,
        validUntil: null,
        createdAt: verifiedAt,
      };
      const verificationProof = buildDocumentClaimApprovalProof(baseClaim, 2, audit, binding);
      return {
        row: { ...baseClaim, verifiedBy: USER, verifiedAt, verificationMethod: 'human_review', verificationProof },
        reference: {
          id: referenceId,
          workspaceId: W,
          companyId: C,
          claimId: id,
          evidenceId,
          documentId: D,
          sourceDocumentId: D,
          documentContentSha256: sha('a'),
          parseRevision: 2,
          chunkSeq: 0,
          chunkTextSha256: chunkHash,
          quoteStartByte: 0,
          quoteEndByte: textBytes.length,
          claimType: 'certification',
          claimStatementDigest: statementDigest,
          bindingSha256: bindingHash,
        },
        evidence: { id: evidenceId, claimId: id, snippet: text },
      };
    });

    const tx = {
      claim: { findMany: vi.fn(async () => claimsList.map((item) => item.row)), findUnique: vi.fn(), findFirst: vi.fn() },
      claimDocumentEvidence: { findMany: vi.fn(async () => claimsList.map((item) => item.reference)), findUnique: vi.fn() },
      sellerDocument: { findMany: vi.fn(async () => [document]), findFirst: vi.fn() },
      sellerDocumentChunk: { findMany: vi.fn(async () => [chunk]), findFirst: vi.fn() },
      evidence: { findMany: vi.fn(async () => claimsList.map((item) => item.evidence)), findFirst: vi.fn() },
    };

    const bindings = await loadDocumentClaimBindingsInTransaction(
      tx as never,
      { workspaceId: W, companyId: C },
      claimsList.map((item) => item.row),
    );
    expect(bindings.size).toBe(count);
    expect(tx.claimDocumentEvidence.findMany).toHaveBeenCalledTimes(1);
    expect(tx.sellerDocument.findMany).toHaveBeenCalledTimes(1);
    expect(tx.sellerDocumentChunk.findMany).toHaveBeenCalledTimes(1);
    expect(tx.evidence.findMany).toHaveBeenCalledTimes(1);
    expect(tx.claimDocumentEvidence.findUnique).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const effective = await effectiveApprovedClaimsInTransaction(
      tx as never,
      { workspaceId: W, userId: USER, roles: ['MEMBER'], scopes: ['acquisition:read'] },
      C,
      {},
      'icp',
    );
    expect(effective.claims).toHaveLength(count);
    expect(effective.dependencies.size).toBe(count);
    expect(effective.rejectedDocumentClaimIds).toHaveLength(0);
    // Constant query budget: 2 claim.findMany + 2 ref.findMany + 1 doc + 1 chunk + 1 evidence = 7 (O(1), independent of N=8)
    expect(tx.claim.findMany).toHaveBeenCalledTimes(2);
    expect(tx.claim.findUnique).not.toHaveBeenCalled();
    expect(tx.sellerDocument.findMany).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    const stillCurrent = await documentClaimDependenciesStillCurrent(
      tx as never,
      { workspaceId: W, companyId: C },
      [...effective.dependencies.values()],
    );
    expect(stillCurrent).toBe(true);
    expect(tx.claim.findMany).toHaveBeenCalledTimes(1);
    expect(tx.claim.findFirst).not.toHaveBeenCalled();
    expect(tx.sellerDocument.findMany).toHaveBeenCalledTimes(1);
  });
});
