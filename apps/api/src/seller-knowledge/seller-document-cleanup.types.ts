/** 内部 seller_document 清理：复用 DeletionRequest/Receipt 底座，公共 DSR 主体闭集不变。 */

export const SELLER_DOCUMENT_CLEANUP_SUBJECT_TYPE = 'seller_document' as const;
export const SELLER_DOCUMENT_CLEANUP_POLICY_VERSION = 'seller-document-cleanup/v1';
export const SELLER_DOCUMENT_CLEANUP_MAX_CHUNKS = 512;
/** Per-invocation work bound of the resumable cleanup activity (matches the definer's 1..200). */
export const SELLER_DOCUMENT_CLEANUP_BATCH_SIZE = 100;

export interface SellerDocumentCleanupTargets {
  readonly policyVersion: string;
  readonly documentId: string;
  readonly companyId: string;
  readonly workspaceId: string;
  readonly chunkIds: readonly string[];
  readonly claimIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly referenceIds: readonly string[];
  readonly knowledgeSourceIds: readonly string[];
}
export interface LocatedSellerDocumentCleanupTargets {
  readonly subjectType: 'seller_document';
  readonly subjectId: string;
  readonly documentId: string;
  readonly companyId: string;
  readonly policyVersion: string;
  readonly chunkCount: number;
  readonly claimCount: number;
  readonly evidenceCount: number;
  readonly referenceCount: number;
  readonly knowledgeSourceCount: number;
}
export interface SellerDocumentErasureCounts {
  readonly chunksErased: number;
  readonly claimsErased: number;
  readonly evidenceErased: number;
  readonly referencesErased: number;
  readonly knowledgeSourcesErased: number;
  readonly blobDeleted: boolean;
  readonly blobFailures: number;
}
/** One bounded cleanup activity invocation: cumulative counts plus whether every batch finished. */
export interface SellerDocumentEraseProgress extends SellerDocumentErasureCounts {
  readonly done: boolean;
}
export type SellerDocumentCleanupPhase = 'claims' | 'sources' | 'chunks' | 'done';
export interface SellerDocumentCleanupCursor {
  readonly phase: SellerDocumentCleanupPhase;
  readonly afterId: string | null;
}
export interface SellerDocumentCleanupCompletedPayloadV1 {
  readonly snapshot_version: 1;
  readonly deletion_request_id: string;
  readonly document_id: string;
  readonly policy_version: string;
  readonly chunks_erased: number;
  readonly claims_erased: number;
  readonly evidence_erased: number;
  readonly references_erased: number;
  readonly blob_deleted: boolean;
  readonly blob_failures: number;
  readonly completed_at: string;
}
export function buildSellerDocumentCleanupCompletedPayload(input: {
  deletionRequestId: string;
  documentId: string;
  policyVersion: string;
  counts: SellerDocumentErasureCounts;
  completedAt: string;
}): SellerDocumentCleanupCompletedPayloadV1 {
  return {
    snapshot_version: 1,
    deletion_request_id: input.deletionRequestId,
    document_id: input.documentId,
    policy_version: input.policyVersion,
    chunks_erased: input.counts.chunksErased,
    claims_erased: input.counts.claimsErased,
    evidence_erased: input.counts.evidenceErased,
    references_erased: input.counts.referencesErased,
    blob_deleted: input.counts.blobDeleted,
    blob_failures: input.counts.blobFailures,
    completed_at: input.completedAt,
  };
}
/** Stored on DeletionReceipt.sellerDocumentDetail; counts only, no original text or names. */
export interface SellerDocumentCleanupReceiptDetail {
  readonly policyVersion: string;
  readonly documentId: string;
  readonly chunksErased: number;
  readonly claimsErased: number;
  readonly evidenceErased: number;
  readonly referencesErased: number;
  readonly knowledgeSourcesErased: number;
  readonly blobDeleted: boolean;
  readonly blobFailures: number;
}
