import { DeletionSubjectType, ErasureCounts, LocatedErasureTargets } from './deletion.types';

/**
 * DeletionCompleted 事件 payload + 分级（收口⑥ PR-B）。
 * 🔴 内容最小化：只带**计数** + subject 行 id 引用（非人名/邮箱）——SaaS 消费方仅知「某主体已擦除多少行」。
 */

export const DELETION_COMPLETED_SCHEMA_VERSION = 1;
export const DELETION_RULE_VERSION = 'art17-erasure-v1';

/** located 快照 → 计数（回执/事件同源，Temporal 重试不失真）。 */
export function countsFromLocated(located: LocatedErasureTargets): ErasureCounts {
  return {
    contactsErased: located.contactIds.length,
    contactPointsErased: located.contactPointsCount,
    fieldEvidenceErased: located.fieldEvidenceCount,
    signalsRevoked: located.signalsToRevoke,
    companiesSuppressed: located.companyIdsToSuppress.length,
    leadsRescoreRequested: located.affectedIcpIds.length,
  };
}

export interface DeletionCompletedPayloadV1 {
  snapshot_version: number;
  deletion_request_id: string;
  subject_type: DeletionSubjectType;
  subject_ref: string; // 🔴 主体行 id 引用，非人名明文
  contacts_erased: number;
  contact_points_erased: number;
  field_evidence_erased: number;
  signals_revoked: number;
  companies_suppressed: number;
  leads_rescore_requested: number;
  patent_cache_erased: number; // 平台专利发明人缓存按盲键命中删的行数（Art.17 扫描面，scale-safe #89）
  rule_version: string;
  erased_at: string; // ISO（调用方注入，避免 workflow 内非确定性时间）
}

export interface DeletionCompletedInput {
  deletionRequestId: string;
  subjectType: DeletionSubjectType;
  subjectId: string;
  counts: ErasureCounts;
  erasedAt: string;
}

export function buildDeletionCompletedPayload(input: DeletionCompletedInput): DeletionCompletedPayloadV1 {
  return {
    snapshot_version: DELETION_COMPLETED_SCHEMA_VERSION,
    deletion_request_id: input.deletionRequestId,
    subject_type: input.subjectType,
    subject_ref: input.subjectId,
    contacts_erased: input.counts.contactsErased,
    contact_points_erased: input.counts.contactPointsErased,
    field_evidence_erased: input.counts.fieldEvidenceErased,
    signals_revoked: input.counts.signalsRevoked,
    companies_suppressed: input.counts.companiesSuppressed,
    leads_rescore_requested: input.counts.leadsRescoreRequested,
    patent_cache_erased: input.counts.patentCacheErased ?? 0,
    rule_version: DELETION_RULE_VERSION,
    erased_at: input.erasedAt,
  };
}

/**
 * 事件分级：擦除到具名个人（contactsErased>0）→ RESTRICTED（🔴 关涉自然人权利事件）；
 * 纯 company 无联系人擦除 → CONFIDENTIAL。值域对齐 envelope 契约 privacy_classification 枚举。
 */
export function classifyDeletionCompleted(counts: ErasureCounts): 'RESTRICTED' | 'CONFIDENTIAL' {
  return counts.contactsErased > 0 ? 'RESTRICTED' : 'CONFIDENTIAL';
}
