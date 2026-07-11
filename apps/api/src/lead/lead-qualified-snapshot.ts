/**
 * LeadQualified 快照 v1（收口③）：decide(accept) 当刻的**事实不可变副本**，
 * 之后 lead/company 变化不回写。契约：packages/contracts/events/payloads/lead-qualified.v1.schema.json。
 *
 * 🔴 GDPR 最小化：company_ref 只带公司事实（绿区）；contact_refs 只带 ref + 职务元数据，
 * **绝不嵌 full_name/email**——SaaS 拿 contact_id 走受控 API 取详情（契约 additionalProperties:false 兜底）。
 */

import { clamp01 } from './scoring';

export const LEAD_QUALIFIED_SCHEMA_VERSION = 1;
/**
 * v2（收口⑤）：总分构成不变（加法六维 + recommended≥0.55 且 Reachability>0），新增 **demand_proof
 * 观测维填充**（一等 Signal 事实驱动，不入总分——乘法门待 R2 backtest）。快照 v1 契约已预留
 * demand_proof 为 number|null 槽位，填充**非破坏**、无需 v2 schema 文件（snapshot_version 仍 1）。
 */
export const QUALIFICATION_RULE_VERSION = 'additive-6dim-v2';

/** lead.scores Json 的现行形状（lead/scoring.ts 写入）。 */
interface LeadScoresJson {
  fit?: number;
  role?: number;
  intent?: number;
  demandProof?: number; // 收口⑤观测维（旧 lead 无此键 → 快照 null）
  dataQuality?: number;
  reachability?: number;
  engagement?: number;
}

export interface LeadQualifiedSnapshotV1 {
  snapshot_version: number;
  lead_id: string;
  workspace_id: string;
  icp_id: string;
  icp_version: number | null;
  company_ref: {
    canonical_company_id: string;
    name: string;
    domain: string | null;
    country: string | null;
    identifiers: { lei: string | null; fda_reg: string | null };
  };
  contact_refs: Array<{
    contact_id: string;
    title: string | null;
    seniority: string | null;
    department: string | null;
    has_verified_contact_point: boolean;
    personal_data: boolean;
  }>;
  scores: {
    fit: number | null;
    role: number | null;
    intent: number | null;
    demand_proof: number | null;
    reachability: number | null;
    data_quality: number | null;
    engagement: number | null;
    total: number | null;
  };
  fit_verdict: string | null;
  evidence_refs: { score_detail_available: boolean; fit_reasons_available: boolean };
  qualification_rule_version: string;
  storage_rights_decision: string | null;
  personal_data_class: 'named_person_refs' | 'company_facts_only';
  suppression_state: 'none' | 'suppressed';
  recommended_action: string;
  valid_until: string | null;
}

export interface LeadQualifiedSnapshotInput {
  lead: {
    id: string;
    workspaceId: string;
    icpId: string;
    fitVerdict: string | null;
    totalScore: number | null;
    scores: unknown;
    scoreDetail: unknown;
    fitReasons: unknown;
  };
  /** icpDefinition.version（ICP 已删则 null——lead.icpId 无 FK 强约束）。 */
  icpVersion: number | null;
  company: {
    id: string;
    name: string;
    domain: string | null;
    country: string | null;
    status: string;
    attributes: unknown;
    contacts: Array<{
      id: string;
      title: string | null;
      seniority: string | null;
      department: string | null;
      contactPoints: Array<{ status: string }>;
    }>;
  };
}

/** attributes 按源命名空间取标识符（attributes.gleif.lei / attributes.fda.registration_number），缺省 null。 */
function extractIdentifiers(attributes: unknown): { lei: string | null; fda_reg: string | null } {
  const attrs = (attributes ?? {}) as Record<string, unknown>;
  const gleif = (attrs.gleif ?? {}) as Record<string, unknown>;
  const fda = (attrs.fda ?? {}) as Record<string, unknown>;
  return {
    lei: typeof gleif.lei === 'string' && gleif.lei ? gleif.lei : null,
    fda_reg:
      typeof fda.registration_number === 'string' && fda.registration_number ? fda.registration_number : null,
  };
}

/**
 * 六维分映射：lead.scores（camelCase Json）→ 快照 snake_case；未评分（scores=null）→ 各维 null。
 * clamp01（J）：契约是系统边界——payload 永不违反自身 schema 的 [0,1]，即便库里存了越界历史值
 *（负权重时代/上游 bug），也不把违约数据推给 SaaS。
 */
function mapScores(scores: unknown, totalScore: number | null): LeadQualifiedSnapshotV1['scores'] {
  const s = (scores ?? null) as LeadScoresJson | null;
  const dim = (v: number | undefined): number | null => (typeof v === 'number' ? clamp01(v) : null);
  return {
    fit: dim(s?.fit),
    role: dim(s?.role),
    intent: dim(s?.intent),
    demand_proof: dim(s?.demandProof), // 收口⑤：一等 Signal 需求证据（旧 lead 未重评 → null，如实）
    reachability: dim(s?.reachability),
    data_quality: dim(s?.dataQuality),
    engagement: dim(s?.engagement),
    total: totalScore == null ? null : clamp01(totalScore),
  };
}

/**
 * LeadQualified 事件分级（H，与快照同源）：含具名人 contact_refs → RESTRICTED
 *（🔴 后续保留/删除策略挂此级）；纯公司事实 → CONFIDENTIAL。值域 = envelope 契约
 * privacy_classification 枚举（packages/contracts/events/envelope.schema.json）。
 */
export function classifyLeadQualified(snapshot: LeadQualifiedSnapshotV1): 'RESTRICTED' | 'CONFIDENTIAL' {
  return snapshot.contact_refs.length ? 'RESTRICTED' : 'CONFIDENTIAL';
}

export function buildLeadQualifiedSnapshot(input: LeadQualifiedSnapshotInput): LeadQualifiedSnapshotV1 {
  const { lead, company, icpVersion } = input;
  const contactRefs = company.contacts.map((c) => ({
    contact_id: c.id,
    title: c.title,
    seniority: c.seniority,
    department: c.department,
    has_verified_contact_point: c.contactPoints.some((p) => p.status === 'VALID'),
    personal_data: true, // 具名决策人 ref 一律 🔴 personalData（即使只带 id+职务）
  }));
  return {
    snapshot_version: LEAD_QUALIFIED_SCHEMA_VERSION,
    lead_id: lead.id,
    workspace_id: lead.workspaceId,
    icp_id: lead.icpId,
    icp_version: icpVersion,
    company_ref: {
      canonical_company_id: company.id,
      name: company.name,
      domain: company.domain,
      country: company.country,
      identifiers: extractIdentifiers(company.attributes),
    },
    contact_refs: contactRefs,
    scores: mapScores(lead.scores, lead.totalScore),
    fit_verdict: lead.fitVerdict,
    evidence_refs: {
      score_detail_available: lead.scoreDetail != null,
      fit_reasons_available: lead.fitReasons != null,
    },
    qualification_rule_version: QUALIFICATION_RULE_VERSION,
    storage_rights_decision: null, // 收口⑥（storage rights）前恒 null
    personal_data_class: contactRefs.length ? 'named_person_refs' : 'company_facts_only',
    suppression_state: company.status === 'SUPPRESSED' ? 'suppressed' : 'none',
    recommended_action: 'handoff_to_campaign',
    valid_until: null, // v1 无鲜度模型；v2 接 evidence freshness
  };
}
