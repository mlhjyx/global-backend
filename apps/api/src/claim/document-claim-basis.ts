import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { RequestContext } from '../auth/request-context';

/** S1a：文档原句 typed 引用、审批 proof v4 与固定消费者的当前有效性门。 */

export const DOCUMENT_CLAIM_DRAFT_CONTRACT = 'seller-document-claim-draft-request/v1';
export const DOCUMENT_CLAIM_REFERENCE_VERSION = 1;
export const MAX_DOCUMENT_CLAIM_QUOTE_CHARS = 2000;
export const MAX_DOCUMENT_CLAIM_STATEMENT_CHARS = 4000;
const MAX_DOCUMENT_CLAIM_QUOTE_BYTES = 8192;
const MAX_CHUNK_SEQ = 1_000_000;
const MAX_QUOTE_BYTE = 4_000_000;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLAIM_TYPE = /^[A-Za-z0-9._:-]{1,50}$/;

export interface DocumentClaimSourceRef {
  readonly documentId: string;
  readonly documentContentHash: string;
  readonly parseRevision: number;
  readonly chunkSeq: number;
  readonly chunkTextHash: string;
  readonly quoteStartByte: number;
  readonly quoteEndByte: number;
}
export interface VerifiedDocumentClaimBinding {
  readonly referenceId: string;
  readonly bindingHash: string;
  readonly documentId: string;
  readonly sourceDocumentId: string;
  readonly documentContentHash: string;
  readonly parseRevision: number;
  readonly chunkSeq: number;
  readonly chunkTextHash: string;
  readonly quoteStartByte: number;
  readonly quoteEndByte: number;
  readonly quote: string;
  readonly claimType: string;
  readonly claimStatementDigest: string;
}
export interface DocumentClaimDependency {
  readonly claimId: string;
  readonly claimVersion: number;
  readonly referenceId: string;
  readonly bindingHash: string;
  readonly documentId: string;
  readonly documentContentHash: string;
  readonly parseRevision: number;
  readonly chunkSeq: number;
  readonly quoteStartByte: number;
  readonly quoteEndByte: number;
}

function fail(code: string): never {
  throw new DocumentClaimBasisError(code);
}
export class DocumentClaimBasisError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DocumentClaimBasisError';
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Deterministic JSON: sorted keys, arrays preserved. Shared by digest and origin key. */
export function canonicalDocumentClaimJson(value: unknown): string {
  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(walk);
    if (isRecord(input)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input).sort()) out[key] = walk(input[key]);
      return out;
    }
    return input;
  };
  return JSON.stringify(walk(value));
}
function sha(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}
const integer = (value: unknown, min: number, max: number): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : fail('INVALID_DOCUMENT_CLAIM_REF');
const digest = (value: unknown): string =>
  typeof value === 'string' && SHA256.test(value) ? value : fail('INVALID_DOCUMENT_CLAIM_REF');
const uuid = (value: unknown): string =>
  typeof value === 'string' && UUID.test(value) ? value : fail('INVALID_DOCUMENT_CLAIM_REF');

/** Closed client input; hashes and byte offsets are verified server-side, never trusted. */
export function parseDocumentClaimSourceRef(value: unknown): DocumentClaimSourceRef {
  if (!isRecord(value)) return fail('INVALID_DOCUMENT_CLAIM_REF');
  const keys = Reflect.ownKeys(value);
  const allowed = [
    'documentId',
    'documentContentHash',
    'parseRevision',
    'chunkSeq',
    'chunkTextHash',
    'quoteStartByte',
    'quoteEndByte',
  ];
  if (keys.length !== allowed.length || keys.some((key) => typeof key !== 'string' || !allowed.includes(key)))
    return fail('INVALID_DOCUMENT_CLAIM_REF');
  const ref = {
    documentId: uuid(value.documentId),
    documentContentHash: digest(value.documentContentHash),
    parseRevision: integer(value.parseRevision, 1, 2_147_483_647),
    chunkSeq: integer(value.chunkSeq, 0, MAX_CHUNK_SEQ),
    chunkTextHash: digest(value.chunkTextHash),
    quoteStartByte: integer(value.quoteStartByte, 0, MAX_QUOTE_BYTE),
    quoteEndByte: integer(value.quoteEndByte, 0, MAX_QUOTE_BYTE),
  };
  if (ref.quoteStartByte >= ref.quoteEndByte) return fail('INVALID_DOCUMENT_CLAIM_REF');
  return Object.freeze(ref);
}
export function documentClaimStatementDigest(statement: string): string {
  return sha(statement);
}
export function documentClaimRequestDigest(input: {
  readonly workspaceId: string;
  readonly companyId: string;
  readonly requesterId: string;
  readonly reference: DocumentClaimSourceRef;
  readonly type: string;
  readonly statement: string;
}): string {
  return sha(
    canonicalDocumentClaimJson({
      contractVersion: DOCUMENT_CLAIM_DRAFT_CONTRACT,
      workspaceId: input.workspaceId,
      companyId: input.companyId,
      requesterId: input.requesterId,
      reference: input.reference,
      type: input.type,
      statement: input.statement,
    }),
  );
}
/** Stable across requesters: identity/parse/quote/type/statement digest, not intent ids. */
export function documentClaimOriginKey(input: {
  readonly workspaceId: string;
  readonly companyId: string;
  readonly documentId: string;
  readonly parseRevision: number;
  readonly chunkSeq: number;
  readonly quoteStartByte: number;
  readonly quoteEndByte: number;
  readonly type: string;
  readonly statementDigest: string;
}): string {
  return sha(
    canonicalDocumentClaimJson({
      contract: 'seller-document-claim-origin/v1',
      workspaceId: input.workspaceId,
      companyId: input.companyId,
      documentId: input.documentId,
      parseRevision: input.parseRevision,
      chunkSeq: input.chunkSeq,
      quoteStartByte: input.quoteStartByte,
      quoteEndByte: input.quoteEndByte,
      type: input.type,
      statementDigest: input.statementDigest,
    }),
  );
}
export function documentClaimBindingHash(input: {
  readonly documentId: string;
  readonly documentContentHash: string;
  readonly parseRevision: number;
  readonly chunkSeq: number;
  readonly chunkTextHash: string;
  readonly quoteStartByte: number;
  readonly quoteEndByte: number;
  readonly quoteDigest: string;
  readonly type: string;
  readonly statementDigest: string;
}): string {
  return sha(
    canonicalDocumentClaimJson({
      contract: 'seller-document-claim-binding/v1',
      documentId: input.documentId,
      documentContentHash: input.documentContentHash,
      parseRevision: input.parseRevision,
      chunkSeq: input.chunkSeq,
      chunkTextHash: input.chunkTextHash,
      quoteStartByte: input.quoteStartByte,
      quoteEndByte: input.quoteEndByte,
      quoteDigest: input.quoteDigest,
      type: input.type,
      statementDigest: input.statementDigest,
    }),
  );
}
export function validDocumentClaimType(value: unknown): value is string {
  return typeof value === 'string' && CLAIM_TYPE.test(value);
}
export function validDocumentClaimStatement(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_DOCUMENT_CLAIM_STATEMENT_CHARS;
}
/** Exact UTF-8 byte boundary check; never truncates or repairs a multi-byte character. */
export function documentClaimQuoteBytes(
  chunkText: string,
  start: number,
  end: number,
): { quote: string; quoteDigest: string } {
  const bytes = Buffer.from(chunkText, 'utf8');
  if (start < 0 || end <= start || end > bytes.length || end - start > MAX_DOCUMENT_CLAIM_QUOTE_BYTES)
    return fail('DOCUMENT_CLAIM_QUOTE_OUT_OF_RANGE');
  let quote: string;
  try {
    quote = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, end));
  } catch {
    return fail('DOCUMENT_CLAIM_QUOTE_NOT_BOUNDARY');
  }
  if (!quote.trim() || Array.from(quote).length > MAX_DOCUMENT_CLAIM_QUOTE_CHARS)
    return fail('DOCUMENT_CLAIM_QUOTE_TOO_LARGE');
  return { quote, quoteDigest: sha(quote) };
}
export function documentDependencyDigest(dependency: DocumentClaimDependency): string {
  return sha(canonicalDocumentClaimJson({ contract: 'seller-document-claim-dependency/v1', ...dependency }));
}
interface DocumentLike {
  id: string;
  workspaceId: string;
  companyId: string;
  contentHash: string | null;
  parseRevision: number | null;
  status: string;
  deletedAt: Date | null;
}
interface ChunkLike {
  documentId: string;
  seq: number;
  text: string;
}
/** Server-side re-read of the exact current document/chunk; no client hash or offset trusted. */
export function verifyDocumentClaimReference(input: {
  document: DocumentLike | null;
  chunk: ChunkLike | null;
  evidenceSnippet: string | null;
  reference: DocumentClaimSourceRef;
  context: { workspaceId: string; companyId: string };
}): { quote: string; quoteDigest: string; chunkTextHash: string } {
  const { document, chunk, reference, context } = input;
  if (
    !document ||
    !chunk ||
    document.workspaceId !== context.workspaceId ||
    document.companyId !== context.companyId ||
    document.id !== reference.documentId ||
    document.status !== 'ready' ||
    document.deletedAt !== null ||
    document.contentHash !== reference.documentContentHash ||
    document.parseRevision !== reference.parseRevision ||
    chunk.documentId !== document.id ||
    chunk.seq !== reference.chunkSeq
  )
    return fail('DOCUMENT_CLAIM_SOURCE_UNAVAILABLE');
  const chunkTextHash = sha(chunk.text);
  if (chunkTextHash !== reference.chunkTextHash) return fail('DOCUMENT_CLAIM_SOURCE_CHANGED');
  const quote = documentClaimQuoteBytes(chunk.text, reference.quoteStartByte, reference.quoteEndByte);
  if (input.evidenceSnippet !== null && input.evidenceSnippet !== quote.quote)
    return fail('DOCUMENT_CLAIM_QUOTE_MISMATCH');
  return { quote: quote.quote, quoteDigest: quote.quoteDigest, chunkTextHash };
}

const proofDigest = (
  claim: ClaimProofIdentity,
  approvedVersion: number,
  audit: ClaimProofAudit,
  binding: VerifiedDocumentClaimBinding,
): string =>
  sha(
    `claim-approval/4\u0000${canonicalDocumentClaimJson([
      claim.id,
      claim.workspaceId,
      claim.companyId,
      claim.sourceId,
      claim.originKey,
      claim.type,
      claim.statement,
      claim.validUntil?.toISOString() ?? null,
      approvedVersion,
      audit.verifiedBy,
      audit.verifiedAt.toISOString(),
      audit.verificationMethod,
      binding.referenceId,
      binding.bindingHash,
      binding.sourceDocumentId,
      binding.documentContentHash,
      binding.parseRevision,
      binding.chunkSeq,
      binding.chunkTextHash,
      binding.quoteStartByte,
      binding.quoteEndByte,
      sha(binding.quote),
    ])}`,
  );
interface ClaimProofIdentity {
  id: string;
  workspaceId: string;
  companyId: string;
  sourceId: string | null;
  originKey: string | null;
  type: string;
  statement: string;
  validUntil: Date | null;
}
interface ClaimProofAudit {
  verifiedBy: string;
  verifiedAt: Date;
  verificationMethod: 'human_review';
}
/** proofVersion 4 is the only accepted document-claim approval audit; legacy v2/v3 never substitutes. */
export function buildDocumentClaimApprovalProof(
  claim: ClaimProofIdentity,
  approvedVersion: number,
  audit: ClaimProofAudit,
  binding: VerifiedDocumentClaimBinding,
): {
  action: 'claim_approval';
  proofVersion: 4;
  approvedVersion: number;
  documentReferenceId: string;
  bindingHash: string;
  claimDigest: string;
} {
  return {
    action: 'claim_approval',
    proofVersion: 4,
    approvedVersion,
    documentReferenceId: binding.referenceId,
    bindingHash: binding.bindingHash,
    claimDigest: proofDigest(claim, approvedVersion, audit, binding),
  };
}
export function hasValidDocumentClaimApprovalAudit(
  claim: ClaimProofIdentity & {
    version: number;
    verifiedBy: string | null;
    verifiedAt: Date | null;
    verificationMethod: string | null;
    verificationProof: unknown;
  },
  binding: VerifiedDocumentClaimBinding,
): boolean {
  const proof = claim.verificationProof;
  if (
    !claim.verifiedBy?.trim() ||
    !(claim.verifiedAt instanceof Date) ||
    !Number.isFinite(claim.verifiedAt.getTime()) ||
    claim.verificationMethod !== 'human_review' ||
    !isRecord(proof) ||
    proof.action !== 'claim_approval' ||
    proof.proofVersion !== 4 ||
    proof.approvedVersion !== claim.version ||
    proof.documentReferenceId !== binding.referenceId ||
    proof.bindingHash !== binding.bindingHash
  )
    return false;
  const audit = {
    verifiedBy: claim.verifiedBy,
    verifiedAt: claim.verifiedAt,
    verificationMethod: claim.verificationMethod,
  } as const;
  return proof.claimDigest === proofDigest(claim, claim.version, audit, binding);
}

export interface ClaimDocumentEvidenceRow {
  id: string;
  workspaceId: string;
  companyId: string;
  claimId: string;
  evidenceId: string;
  documentId: string | null;
  sourceDocumentId: string;
  documentContentSha256: string;
  parseRevision: number;
  chunkSeq: number;
  chunkTextSha256: string;
  quoteStartByte: number;
  quoteEndByte: number;
  claimType: string;
  claimStatementDigest: string;
  bindingSha256: string;
}
/** Current binding or null; missing/renamed/deleted/reprocessed sources are immediately invalid. */
export async function loadDocumentClaimBindingInTransaction(
  tx: Prisma.TransactionClient,
  context: { workspaceId: string; companyId: string },
  claim: { id: string; companyId: string; statement: string; type: string },
): Promise<VerifiedDocumentClaimBinding | null> {
  const reference = await tx.claimDocumentEvidence.findUnique({ where: { claimId: claim.id } });
  if (!reference) return null;
  if (
    reference.workspaceId !== context.workspaceId ||
    reference.companyId !== context.companyId ||
    reference.claimId !== claim.id ||
    reference.documentId === null ||
    claim.type !== reference.claimType ||
    documentClaimStatementDigest(claim.statement) !== reference.claimStatementDigest
  )
    return null;
  const [document, chunk, evidence] = await Promise.all([
    tx.sellerDocument.findFirst({
      where: { id: reference.documentId, workspaceId: context.workspaceId, companyId: context.companyId, deletedAt: null },
    }),
    tx.sellerDocumentChunk.findFirst({ where: { documentId: reference.documentId, seq: reference.chunkSeq } }),
    tx.evidence.findFirst({ where: { id: reference.evidenceId, claimId: claim.id } }),
  ]);
  if (!document || !chunk || !evidence) return null;
  let verified: { quote: string; quoteDigest: string; chunkTextHash: string };
  try {
    verified = verifyDocumentClaimReference({
      document,
      chunk,
      evidenceSnippet: evidence.snippet,
      reference: {
        documentId: reference.sourceDocumentId,
        documentContentHash: reference.documentContentSha256,
        parseRevision: reference.parseRevision,
        chunkSeq: reference.chunkSeq,
        chunkTextHash: reference.chunkTextSha256,
        quoteStartByte: reference.quoteStartByte,
        quoteEndByte: reference.quoteEndByte,
      },
      context,
    });
  } catch {
    return null;
  }
  const bindingHash = documentClaimBindingHash({
    documentId: reference.sourceDocumentId,
    documentContentHash: reference.documentContentSha256,
    parseRevision: reference.parseRevision,
    chunkSeq: reference.chunkSeq,
    chunkTextHash: reference.chunkTextSha256,
    quoteStartByte: reference.quoteStartByte,
    quoteEndByte: reference.quoteEndByte,
    quoteDigest: verified.quoteDigest,
    type: reference.claimType,
    statementDigest: reference.claimStatementDigest,
  });
  if (bindingHash !== reference.bindingSha256) return null;
  return Object.freeze({
    referenceId: reference.id,
    bindingHash,
    documentId: reference.documentId,
    sourceDocumentId: reference.sourceDocumentId,
    documentContentHash: reference.documentContentSha256,
    parseRevision: reference.parseRevision,
    chunkSeq: reference.chunkSeq,
    chunkTextHash: reference.chunkTextSha256,
    quoteStartByte: reference.quoteStartByte,
    quoteEndByte: reference.quoteEndByte,
    quote: verified.quote,
    claimType: reference.claimType,
    claimStatementDigest: reference.claimStatementDigest,
  });
}
export type DocumentConsumerPurpose = 'icp' | 'generation' | 'market_candidate_set' | 'outreach_draft' | 'campaign_planning' | 'understanding_preview';
export interface EffectiveApprovedClaims {
  readonly claims: ReadonlyArray<{
    id: string;
    workspaceId: string;
    companyId: string;
    type: string;
    statement: string;
    version: number;
    validUntil: Date | null;
    createdAt: Date;
  }>;
  readonly dependencies: ReadonlyMap<string, DocumentClaimDependency>;
  readonly rejectedDocumentClaimIds: readonly string[];
  readonly consumerPurpose: DocumentConsumerPurpose;
}
/**
 * The single current-validity gate for every fixed consumer. Legacy non-document Claims keep
 * their existing APPROVED semantics; document-backed Claims must still match the current
 * document revision, exact quote and v4 human-review proof.
 */
export async function effectiveApprovedClaimsInTransaction(
  tx: Prisma.TransactionClient,
  context: RequestContext,
  companyId: string,
  selection: { claimIds?: readonly string[] },
  consumerPurpose: DocumentConsumerPurpose,
): Promise<EffectiveApprovedClaims> {
  const now = new Date();
  const claims = await tx.claim.findMany({
    where: {
      workspaceId: context.workspaceId,
      companyId,
      status: 'APPROVED',
      ...(selection.claimIds === undefined ? {} : { id: { in: [...selection.claimIds] } }),
      OR: [{ validUntil: null }, { validUntil: { gt: now } }],
    },
    select: {
      id: true,
      workspaceId: true,
      companyId: true,
      type: true,
      statement: true,
      version: true,
      validUntil: true,
      createdAt: true,
    },
    orderBy: { id: 'asc' },
  });
  const dependencies = new Map<string, DocumentClaimDependency>();
  const rejected: string[] = [];
  const effective: EffectiveApprovedClaims['claims'][number][] = [];
  for (const claim of claims) {
    const hasReference = await tx.claimDocumentEvidence.findUnique({
      where: { claimId: claim.id },
      select: { id: true },
    });
    if (!hasReference) {
      effective.push(claim);
      continue;
    }
    const binding = await loadDocumentClaimBindingInTransaction(tx, { workspaceId: context.workspaceId, companyId }, claim);
    // Re-read the full proof-bearing row; the list select never trusts a caller-supplied proof.
    const audited = await tx.claim.findUnique({ where: { id: claim.id } });
    if (!binding || !audited || !hasValidDocumentClaimApprovalAudit(audited, binding)) {
      rejected.push(claim.id);
      continue;
    }
    dependencies.set(claim.id, {
      claimId: claim.id,
      claimVersion: claim.version,
      referenceId: binding.referenceId,
      bindingHash: binding.bindingHash,
      documentId: binding.sourceDocumentId,
      documentContentHash: binding.documentContentHash,
      parseRevision: binding.parseRevision,
      chunkSeq: binding.chunkSeq,
      quoteStartByte: binding.quoteStartByte,
      quoteEndByte: binding.quoteEndByte,
    });
    effective.push(claim);
  }
  return Object.freeze({
    claims: Object.freeze(effective),
    dependencies,
    rejectedDocumentClaimIds: Object.freeze(rejected),
    consumerPurpose,
  });
}

/** Prepare→apply recheck for consumers that carried typed document dependencies. */
export async function documentClaimDependenciesStillCurrent(
  tx: Prisma.TransactionClient,
  context: { workspaceId: string; companyId: string },
  dependencies: readonly DocumentClaimDependency[],
): Promise<boolean> {
  for (const dependency of dependencies) {
    const claim = await tx.claim.findFirst({
      where: {
        id: dependency.claimId,
        workspaceId: context.workspaceId,
        companyId: context.companyId,
        status: 'APPROVED',
        version: dependency.claimVersion,
      },
      select: { id: true, workspaceId: true, companyId: true, sourceId: true, originKey: true, statement: true, type: true, version: true, validUntil: true, verifiedBy: true, verifiedAt: true, verificationMethod: true, verificationProof: true },
    });
    if (!claim || (claim.validUntil !== null && claim.validUntil.getTime() <= Date.now())) return false;
    const binding = await loadDocumentClaimBindingInTransaction(tx, context, claim);
    if (!binding || binding.referenceId !== dependency.referenceId || binding.bindingHash !== dependency.bindingHash || !hasValidDocumentClaimApprovalAudit(claim, binding))
      return false;
  }
  return true;
}
/** Claim ids that currently carry a document reference (regardless of validity). */
export async function documentReferencedClaimIds(
  tx: Prisma.TransactionClient,
  context: { workspaceId: string },
  claimIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (claimIds.length === 0) return new Set();
  const rows = await tx.claimDocumentEvidence.findMany({
    where: { workspaceId: context.workspaceId, claimId: { in: [...claimIds] } },
    select: { claimId: true },
  });
  return new Set(rows.map((row) => row.claimId));
}
/** Current binding map for a reachable claim; invalid document claims are omitted. */
export async function currentDocumentClaimDependencies(
  tx: Prisma.TransactionClient,
  context: { workspaceId: string; companyId: string },
  claims: ReadonlyArray<{ id: string; workspaceId: string; companyId: string; sourceId: string | null; originKey: string | null; statement: string; type: string; version: number; validUntil: Date | null; verifiedBy: string | null; verifiedAt: Date | null; verificationMethod: string | null; verificationProof: unknown }>,
): Promise<ReadonlyMap<string, DocumentClaimDependency>> {
  const referenced = await documentReferencedClaimIds(tx, context, claims.map((claim) => claim.id));
  const out = new Map<string, DocumentClaimDependency>();
  for (const claim of claims) {
    if (!referenced.has(claim.id)) continue;
    if (claim.validUntil !== null && claim.validUntil.getTime() <= Date.now()) continue;
    const binding = await loadDocumentClaimBindingInTransaction(tx, context, claim);
    if (!binding || !hasValidDocumentClaimApprovalAudit(claim, binding)) continue;
    out.set(claim.id, {
      claimId: claim.id,
      claimVersion: claim.version,
      referenceId: binding.referenceId,
      bindingHash: binding.bindingHash,
      documentId: binding.sourceDocumentId,
      documentContentHash: binding.documentContentHash,
      parseRevision: binding.parseRevision,
      chunkSeq: binding.chunkSeq,
      quoteStartByte: binding.quoteStartByte,
      quoteEndByte: binding.quoteEndByte,
    });
  }
  return out;
}
