/**
 * 收口⑥ PR-B 删除编排（GDPR Art.17）——共享类型。
 * 🔴 内容最小化红线：跨 workflow 传递与落回执的都是**计数 + 行 id 引用**，绝不含人名/邮箱明文。
 */

export const DELETION_SUBJECT_TYPES = ['contact', 'company'] as const;
export type DeletionSubjectType = (typeof DELETION_SUBJECT_TYPES)[number];

export const DELETION_STATUSES = ['RECEIVED', 'FROZEN', 'ERASING', 'COMPLETED', 'FAILED'] as const;
export type DeletionStatus = (typeof DELETION_STATUSES)[number];

export const DELETION_REASONS = ['erasure', 'objection', 'legal', 'manual'] as const;
export type DeletionReason = (typeof DELETION_REASONS)[number];

/** 冻结阶段写入的禁联项（对外动作第一道闸；删除期间与删除后都禁止该主体再入库/再触达）。 */
export interface SuppressionEntry {
  type: 'email' | 'domain' | 'company_name';
  value: string;
  reason: string; // 'legal'（Art.17 擦除/Art.21 反对 = 法定义务保留最小禁联项）
}

/**
 * 冻结阶段定位出的擦除面（**pre-deletion 快照**）。计数经此结构流经 workflow → 回执，
 * 故 Temporal 重试擦除活动（此时行已删、二次统计为 0）也不会让回执失真。
 * 🔴 **PII-free 红线**：本结构会进 Temporal workflow 历史（持久化层），故只含 uuid + 计数，
 * **绝不含邮箱/人名**。禁联项（含邮箱明文）由冻结活动内部计算并落库，永不返回、永不入 workflow 历史。
 */
export interface LocatedErasureTargets {
  subjectType: DeletionSubjectType;
  subjectId: string;
  contactIds: string[]; // 待硬删的 canonical_contact.id（company 主体=其全部联系人）
  contactPointsCount: number; // 待级联删的 contact_point 行数（快照）
  fieldEvidenceCount: number; // 待删的 field_evidence（entityType=contact）行数（快照）
  companyIdsToSuppress: string[]; // 待标 SUPPRESSED 的 canonical_company.id（company 主体）
  // source_signal 是**平台共享零-PII 绿库**（一次采集服务所有租户），租户 DSR 不撤平台信号（否则跨租户误删）；
  // 「自然人漏入信号 subjectName」的 Art.17 清除走平台级 revoke 路径，不在租户 DSR 范围。恒 0，保留回执列稳定。
  signalsToRevoke: number;
  affectedIcpIds: string[]; // 需重评分的 ICP（对受影响公司持有 Lead 的 ACTIVE ICP）
}

/** 擦除计数（deletion_receipt + DeletionCompleted 事件内容，🔴 只计数无 PII）。 */
export interface ErasureCounts {
  contactsErased: number;
  contactPointsErased: number;
  fieldEvidenceErased: number;
  signalsRevoked: number;
  companiesSuppressed: number;
  leadsRescoreRequested: number;
}

/** 删除工作流输入（Temporal args，全部为 id/枚举，可确定性序列化）。 */
export interface DeletionWorkflowInput {
  workspaceId: string;
  deletionRequestId: string;
  subjectType: DeletionSubjectType;
  subjectId: string;
}
