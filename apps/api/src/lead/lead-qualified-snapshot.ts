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
  /**
   * 制裁筛查合规结论（第五门）：交付的包断言「已对 OFAC/EU 筛查」。命中(hold)绝不到此——decide(accept) 硬拦。
   * `not_screened`=门未启用（DISABLED），SaaS 侧不得据此对外触达（诚实标注，见设计 §7.1）。**追加非破坏字段**。
   */
  sanctions_screening: {
    status: 'clear' | 'not_screened';
    screened_at: string | null;
    list_versions: Record<string, string>; // { ofac_sdn:'2026-07-13', … } 本次筛覆盖的名单版本
  };
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
  /**
   * 收口⑥ 存储权利判定（DataRightsService.evaluate 对 STORE 动作的 effect：
   * ALLOW / ALLOW_WITH_BASIS / REQUIRE_APPROVAL / DENY）。调用方（lead.service.decide）算好传入；
   * 缺省 null（未接线的旧调用方/测试保持原样，非破坏）。
   */
  storageRightsDecision?: string | null;
  /**
   * 鲜度模型（v2）：本线索所依赖事实的 field_evidence 分级 + 抓取时刻。调用方（lead.service.decide）
   * 按 company/contacts 的 entity_id 取 field_evidence(dataClass, fetchedAt) 传入；缺省空数组
   *（旧调用方/测试 → valid_until 仅由 intent 事件驱动或 null，非破坏）。
   */
  evidence?: readonly EvidenceFreshness[];
  /**
   * 制裁筛查结论（第五门）：调用方（lead.service.decide）在 accept 时对公司 screen 后传入。
   * status=clear（无命中）| not_screened（门未启用）。命中(potential_match)时 decide 已抛 SANCTIONS_HOLD_UNRESOLVED、
   * 根本到不了这里。缺省 not_screened（旧调用方/测试非破坏）。
   */
  sanctionsScreening?: {
    status: 'clear' | 'not_screened';
    screenedAt: string | null;
    listVersions: Record<string, string>;
  };
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

/** 一条支撑事实的鲜度输入：分级 + 抓取时刻（Date 或 ISO 串皆可）。 */
export interface EvidenceFreshness {
  dataClass: string; // green | amber | red（field_evidence.data_class）
  fetchedAt: Date | string;
}

const DAY_MS = 86_400_000;
/**
 * 鲜度 TTL（天）：数据按易变性分级失效。公司事实(green)稳定 → 长；具名个人(red)/职能邮箱(amber)——
 * 人换岗、邮箱失效更快 → 短。未知分级保守取短（更早提示复核）。ADR-010：鲜度锚定真实 evidence.fetchedAt。
 */
const FRESHNESS_TTL_DAYS: Record<string, number> = { green: 180, amber: 90, red: 90 };
const DEFAULT_TTL_DAYS = 90;
/** 时机窗（天）：intent 信号「现在是好时机」的有效期——约一季度后需重新确认时机。 */
const INTENT_TIMING_TTL_DAYS = 90;

/** attributes.intent 里最新一条事件的 at（ms）；无逐事件回退 intent.last_change_at；都无 → null。 */
function latestIntentAtMs(attributes: unknown): number | null {
  const attrs = (attributes ?? {}) as Record<string, unknown>;
  const intent = attrs.intent as { events?: unknown; last_change_at?: unknown } | undefined;
  if (!intent || typeof intent !== 'object') return null;
  let latest: number | null = null;
  const events = Array.isArray(intent.events) ? intent.events : [];
  for (const ev of events) {
    const at = (ev as { at?: unknown })?.at;
    const ms = typeof at === 'string' ? Date.parse(at) : NaN;
    if (Number.isFinite(ms) && (latest == null || ms > latest)) latest = ms;
  }
  if (latest == null && typeof intent.last_change_at === 'string') {
    const ms = Date.parse(intent.last_change_at);
    if (Number.isFinite(ms)) latest = ms;
  }
  return latest;
}

/**
 * valid_until（鲜度模型 v2）：快照当刻起，这条线索所依赖事实**最早何时失效**。
 * = min( 每条 evidence.fetchedAt + 源分级 TTL，最新 intent 事件 at + 时机窗 )。
 * 取 min（最保守）：线索可行动性只与其**最易腐的关键事实**一样新——某条已过期即应先重新核实再触达。
 * 无任何 evidence 且无 intent 事件 → null（诚实：无鲜度依据，不臆造有效期）。
 * 纯函数、**不读时钟**（仅由输入时间戳与固定 TTL 决定，可复现）；不可解析时间戳跳过（不注入 NaN）。
 */
export function computeValidUntil(evidence: readonly EvidenceFreshness[], attributes: unknown): string | null {
  const expiries: number[] = [];
  for (const e of evidence) {
    const fetchedMs = e.fetchedAt instanceof Date ? e.fetchedAt.getTime() : Date.parse(String(e.fetchedAt));
    if (!Number.isFinite(fetchedMs)) continue;
    const ttlDays = FRESHNESS_TTL_DAYS[e.dataClass] ?? DEFAULT_TTL_DAYS;
    expiries.push(fetchedMs + ttlDays * DAY_MS);
  }
  const intentMs = latestIntentAtMs(attributes);
  if (intentMs != null) expiries.push(intentMs + INTENT_TIMING_TTL_DAYS * DAY_MS);
  if (!expiries.length) return null;
  return new Date(Math.min(...expiries)).toISOString();
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
    storage_rights_decision: input.storageRightsDecision ?? null, // 收口⑥：DataRightsService STORE 判定（调用方传入）
    personal_data_class: contactRefs.length ? 'named_person_refs' : 'company_facts_only',
    suppression_state: company.status === 'SUPPRESSED' ? 'suppressed' : 'none',
    sanctions_screening: input.sanctionsScreening
      ? {
          status: input.sanctionsScreening.status,
          screened_at: input.sanctionsScreening.screenedAt,
          list_versions: input.sanctionsScreening.listVersions,
        }
      : { status: 'not_screened', screened_at: null, list_versions: {} },
    recommended_action: 'handoff_to_campaign',
    // 鲜度 v2：min(evidence.fetchedAt + 分级TTL, 最新 intent.at + 时机窗)；无鲜度依据 → null。
    valid_until: computeValidUntil(input.evidence ?? [], company.attributes),
  };
}
