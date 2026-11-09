/**
 * L0 硬门引擎（P3 J05；设计 §4.3.2）。
 *
 * 门引擎是「判定」的第一层：确定性、零模型、毫秒级。它决定的是
 * **「这家公司有没有资格/条件被判定」**，不是「它是不是目标客户」——后者是
 * L1/L2 judge 的语义工作。两者必须分开记账（设计 §4.3.2.6 的 34.8% 池噪声
 * 与「77% match 无域名」正是混合两者的结构性后果）。
 *
 * 执行顺序（短路语义）：G1 制裁 → G2 禁联 → G2b ICP 排除 → G3 国家 → G4 规模
 * → G5 域名/可验证性。任一 FAIL 短路：该公司已被排除，后续门不再评估、不写行。
 * UNKNOWN 不短路：后续门照常评估（补数完成后重评时所有门都有最新记录）。
 *
 * 判定语义（设计 §4.3.2.1）：
 *  - PASS：继续；
 *  - FAIL：NOT_FIT（必须带 GATE_REASON_CODES 闭集里的 reason_code）；
 *  - UNKNOWN：数据不足以判定——绝不记 pass，也绝不记 fail；G3/G4/G5 的
 *    UNKNOWN 同时写 `gate_enrichment_task`（queued）进补数队列；
 *  - NOT_APPLICABLE：ICP 未声明该条件（applicable=false，等价 PASS）。
 * 缺失数据策略：数据缺失 ≠ 条件满足。ICP 未声明 → NOT_APPLICABLE；
 * ICP 声明了而公司数据缺失 → UNKNOWN。
 *
 * 写库的唯一入口是 `evaluateGates(tx, ctx)`：任何调用方不得手写 verdict
 * （与 `upsertLeadFit` 同理，语义必须单一实现）。replay 幂等由两张表的
 * 表达式唯一索引（`hard_gate_result_replay_key` / `gate_enrichment_task_key`）
 * + `createMany({ skipDuplicates: true })`（INSERT … ON CONFLICT DO NOTHING）保证：
 * 同 digest 的重试不重复写行。
 *
 * 版本化：`gate_set_version` + 每门 `gate_version`；任何阈值/规则改动必须 bump
 * 版本号（input_digest 也随之变化 → 旧记录保留、新评估换行）。
 *
 * 本文件是纯逻辑 + 一个事务内编排：不读 env（阈值是常量）、不调模型、不联网。
 */

import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';

import {
  evaluateRule,
  mirrorExclusionRuleIndexes,
  type RuleLike,
} from '../../icp/rule-engine';
import { normalizeDomain } from '../identity';
import { prefilterAttributes } from '../run2/quick-scan';
import {
  canonicalizeSuppressionValue,
  canonicalizeSuppressionValues,
} from '../suppression-value';
import {
  COUNTRY_ISO,
  MARKET_REGION_COUNTRIES,
  expandMarketRegions,
  lookupCountryIso,
  lookupMarketRegion,
} from '../vocab';
import {
  isGateReasonCode,
  type GateReasonCode,
} from './failure-codes';

export const GATE_SET_VERSION = 'gates-v1' as const;

/**
 * 门的稳定 id 闭集（与 `hard_gate_result.gate_id` 的注释一致）。
 * G6 自指 / G7 存活 / G8 行业排除是设计 §4.3.2.7 的第二批，本版未实现；
 * 它们的 reason code（GATE_SELF / GATE_COMPANY_DISSOLVED）已在闭集里预留。
 */
export const GATE_IDS = [
  'G_SANCTIONS',
  'G_SUPPRESSION',
  'G_ICP_EXCLUSION',
  'G_COUNTRY',
  'G_SIZE',
  'G_DOMAIN',
] as const;
export type GateId = (typeof GATE_IDS)[number];

/** 执行顺序 = 本数组顺序（G2 的两个执行器各占一个 gate_id，便于按门统计拦截率）。 */
export const GATE_ORDER: readonly GateId[] = GATE_IDS;

/** 每门的规则版本：规则/阈值改动 → 必须 bump。 */
export const GATE_VERSIONS: Readonly<Record<GateId, string>> = Object.freeze({
  G_SANCTIONS: 'sanctions-gate/v1',
  G_SUPPRESSION: 'suppression-gate/v1',
  G_ICP_EXCLUSION: 'icp-exclusion-gate/v1',
  G_COUNTRY: 'country-gate/v1',
  G_SIZE: 'size-gate/v1',
  G_DOMAIN: 'domain-gate/v1',
});

export const GATE_VERDICTS = ['PASS', 'FAIL', 'UNKNOWN', 'NOT_APPLICABLE'] as const;
export type GateVerdict = (typeof GATE_VERDICTS)[number];

/** 整链结论：FAIL > UNKNOWN > PASS；NOT_APPLICABLE 视为 PASS。 */
export const GATE_CHAIN_VERDICTS = ['PASS', 'FAIL', 'UNKNOWN'] as const;
export type GateChainVerdict = (typeof GATE_CHAIN_VERDICTS)[number];

/** 制裁名单新鲜度阈值（设计 §4.3.2.2；常量，不走 env——门槛变更要 bump 版本）。 */
export const SANCTIONS_FRESH_MAX_HOURS = 72;
export const SANCTIONS_YELLOW_MAX_HOURS = 168; // 7 天

/** UNKNOWN 时进补数队列的门（与 Prisma 注释「目前主要 G_DOMAIN / G_COUNTRY / G_SIZE」一致）。 */
const ENRICHMENT_GATE_IDS: ReadonlySet<GateId> = new Set([
  'G_COUNTRY',
  'G_SIZE',
  'G_DOMAIN',
]);

/** 与 ICP 无关的合规门：写 `hard_gate_result.icp_id = NULL`（设计 §4.3.2.8）。 */
const ICP_INDEPENDENT_GATE_IDS: ReadonlySet<GateId> = new Set([
  'G_SANCTIONS',
  'G_SUPPRESSION',
]);

// ── 决策类型 ────────────────────────────────────────────────────────────────

export interface GateDecision {
  readonly gateId: GateId;
  readonly gateVersion: string;
  readonly verdict: GateVerdict;
  readonly reasonCode: GateReasonCode | null;
  readonly applicable: boolean;
  /** 本次评估实际用到的归一值（事后可复算；只放 JSON 安全、可稳定序列化的值）。 */
  readonly facts: Record<string, unknown>;
  /** sha256(canonical(facts) + gate config)；同输入同 digest，用于 replay 幂等。 */
  readonly inputDigest: string;
}

export interface GateEvaluationContext {
  readonly workspaceId: string;
  readonly canonicalCompanyId: string;
  /** 本次评估的 ICP（公司 × ICP 视角）；G1/G2 的行以 icp_id=NULL 写入。 */
  readonly icpId: string;
  /** 注入时钟（测试/回放）；默认 new Date()。 */
  readonly now?: Date;
  /**
   * 域名存活校验结果（P2 域名解析流水线提供）。null/未提供 = 没有存活证据，
   * 不视为 DEAD（只要域名存在即可继续）；'DEAD' → G5 UNKNOWN 进补数队列。
   */
  readonly domainStatus?: 'ALIVE' | 'DEAD' | 'UNKNOWN' | null;
}

export interface GateEvaluation {
  readonly gateSetVersion: string;
  readonly verdict: GateChainVerdict;
  /** 实际评估过的门（按执行顺序；FAIL 之后的门不在其中）。 */
  readonly results: readonly GateDecision[];
  readonly failedGate: GateDecision | null;
  readonly unknownGates: readonly GateDecision[];
  readonly insertedResultCount: number;
  readonly enrichmentTaskCount: number;
}

// ── 规范化与 digest ─────────────────────────────────────────────────────────

/**
 * 稳定 canonical JSON：对象键排序、跳过 undefined；与 JSON.stringify 的差别只在
 * 键序——同输入在任何进程/机器上都得到同一字符串（digest 可复算的前提）。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

/** 门配置参与 digest：阈值/规则归属哪一版必须可复算。 */
function gateConfig(gateId: GateId): Record<string, unknown> {
  switch (gateId) {
    case 'G_SANCTIONS':
      return {
        fresh_max_hours: SANCTIONS_FRESH_MAX_HOURS,
        yellow_max_hours: SANCTIONS_YELLOW_MAX_HOURS,
      };
    default:
      return {};
  }
}

export function gateInputDigest(
  gateId: GateId,
  facts: Record<string, unknown>,
): string {
  const payload = canonicalJson({
    gate_id: gateId,
    gate_version: GATE_VERSIONS[gateId],
    gate_set_version: GATE_SET_VERSION,
    config: gateConfig(gateId),
    facts,
  });
  return createHash('sha256').update(payload).digest('hex');
}

function makeDecision(
  gateId: GateId,
  verdict: GateVerdict,
  reasonCode: GateReasonCode | null,
  facts: Record<string, unknown>,
): GateDecision {
  return {
    gateId,
    gateVersion: GATE_VERSIONS[gateId],
    verdict,
    reasonCode,
    applicable: verdict !== 'NOT_APPLICABLE',
    facts,
    inputDigest: gateInputDigest(gateId, facts),
  };
}

/**
 * 写库前的硬校验（fail-closed）：
 *  - reason_code 必须是 GATE_REASON_CODES 闭集成员；
 *  - FAIL / UNKNOWN 必须带 reason_code；
 *  - NOT_APPLICABLE 必须是 applicable=false 且无 reason_code；
 *  - PASS 允许带 reason_code（G1 的 stale-yellow/red 是「可继续但降级」的标记）。
 * 任何违反都抛错——不允许把拼错的码写进判定历史。
 */
export function assertGateDecision(decision: GateDecision): void {
  if (decision.reasonCode !== null && !isGateReasonCode(decision.reasonCode)) {
    throw new Error(`UNKNOWN_GATE_REASON_CODE:${String(decision.reasonCode)}`);
  }
  if (decision.verdict === 'FAIL' || decision.verdict === 'UNKNOWN') {
    if (decision.reasonCode === null) {
      throw new Error(`GATE_REASON_CODE_REQUIRED:${decision.gateId}:${decision.verdict}`);
    }
    if (!decision.applicable) {
      throw new Error(`GATE_APPLICABLE_INVALID:${decision.gateId}:${decision.verdict}`);
    }
  }
  if (decision.verdict === 'NOT_APPLICABLE') {
    if (decision.applicable || decision.reasonCode !== null) {
      throw new Error(`GATE_NOT_APPLICABLE_INVALID:${decision.gateId}`);
    }
  }
  if (decision.verdict === 'PASS' && !decision.applicable) {
    throw new Error(`GATE_APPLICABLE_INVALID:${decision.gateId}:PASS`);
  }
  if (!/^[0-9a-f]{64}$/.test(decision.inputDigest)) {
    throw new Error(`GATE_DIGEST_INVALID:${decision.gateId}`);
  }
}

// ── 归一化小工具 ────────────────────────────────────────────────────────────

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(jsonObject(value))) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'string') return [value];
  return [];
}

function normFieldName(field: unknown): string {
  return String(field ?? '')
    .toLowerCase()
    .replace(/[_\s-]/g, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 国家词 → ISO 3166-1 alpha-2。词表（vocab.ts）覆盖中/英/德文国名；
 * 已经是 alpha-2 的原始值（canonical 列里 `DE` 与 `德国` 并存，见设计 §4.3.2.4）
 * 直接大写返回——词表本身不收 2 字母码。
 */
export function normalizeCountryIso(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const mapped = lookupCountryIso(trimmed);
  if (mapped) return mapped;
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return null;
}

/**
 * 目标市场词列表 → 排序去重的 ISO 集合（地区词就地展开：DACH → DE/AT/CH）。
 *
 * 现场事实：`icp_definition.target_markets` 是**自由文本**（2026-11-09 dev 库
 * 实测：`德国工业泵分销与批发渠道`、`DACH地区工业泵分销市场`、
 * `瑞士（德语区优先）`），词表精确匹配会把它们全部漏掉、让国家门静默
 * NOT_APPLICABLE。因此先精确匹配（词表 + alpha-2），再做保守的子串抽取：
 * 只认 CJK 国名（`德国`/`瑞士`…，不会出现在无关词内部）与地区词 `dach`，
 * 拉丁语系国名仍要求精确匹配（避免 `us`/`uk` 之类的子串误命中）。
 */
export function marketTermIsos(term: string): string[] {
  const trimmed = term.trim();
  if (!trimmed) return [];
  const exactRegion = lookupMarketRegion(trimmed);
  if (exactRegion) return [...exactRegion];
  const exactCountry = normalizeCountryIso(trimmed);
  if (exactCountry) return [exactCountry];
  const isos = new Set<string>();
  for (const [word, iso] of Object.entries(COUNTRY_ISO)) {
    if (/[一-鿿]/.test(word) && trimmed.includes(word)) isos.add(iso);
  }
  const lower = trimmed.toLowerCase();
  for (const [region, members] of Object.entries(MARKET_REGION_COUNTRIES)) {
    if (region.length < 4) continue;
    // 拉丁词要求词边界：`DACH地区…` 命中，德语 `Dachdecker`（屋顶）不误命中。
    const pattern = new RegExp(`(^|[^a-z])${escapeRegExp(region)}(?![a-z])`);
    if (pattern.test(lower)) {
      for (const iso of members) isos.add(iso);
    }
  }
  return [...isos];
}

export function normalizeMarketIsos(terms: readonly string[]): string[] {
  const isos = new Set<string>();
  for (const term of terms) {
    for (const part of expandMarketRegions([term])) {
      const exact = normalizeCountryIso(part);
      if (exact) {
        isos.add(exact);
        continue;
      }
      for (const iso of marketTermIsos(part)) isos.add(iso);
    }
  }
  return [...isos].sort();
}

/** Parse numbers including range strings ("51-200", "200+") → [min, max]（与 rule-engine.toRange 同语义）。 */
export function parseNumberRange(value: unknown): [number, number] | null {
  if (typeof value === 'number' && Number.isFinite(value)) return [value, value];
  const text = String(value).replace(/[,\s]/g, '');
  const range = text.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
  if (range) return [Number(range[1]), Number(range[2])];
  const plus = text.match(/^(\d+(?:\.\d+)?)\+$/);
  if (plus) return [Number(plus[1]), Number.POSITIVE_INFINITY];
  const single = Number(text);
  return Number.isFinite(single) ? [single, single] : null;
}

// ── G1 制裁门（含陈旧门） ───────────────────────────────────────────────────

export interface SanctionsScreeningRow {
  readonly status: string;
  readonly reviewState: string | null;
  readonly listVersions: unknown;
}

export interface SanctionsSourceRow {
  readonly key: string;
  readonly lastRefreshedAt: Date | null;
  readonly lastFetchStatus: string | null;
}

/**
 * 归一化的 G1 输入。`refreshAgeHours` 是**决策用**的派生值，不进入写库 facts
 * （它随时钟连续变化，会破坏 replay digest 的稳定性）；facts 里保存的是
 * 分钟的名单刷新时间戳与三档 freshness。
 */
export interface SanctionsFacts {
  readonly screeningStatus: string | null;
  readonly reviewState: string | null;
  readonly listVersions: Record<string, string>;
  readonly enabledSourceKeys: readonly string[];
  readonly failedSourceKeys: readonly string[];
  readonly missingRefreshSourceKeys: readonly string[];
  readonly minRefreshedAt: string | null;
  readonly refreshAgeHours: number | null;
}

export function buildSanctionsFacts(input: {
  screening: SanctionsScreeningRow | null;
  sources: readonly SanctionsSourceRow[];
  now: Date;
}): SanctionsFacts {
  const enabledSourceKeys = input.sources.map((source) => source.key).sort();
  const failedSourceKeys = input.sources
    .filter((source) => source.lastFetchStatus === 'FAILED')
    .map((source) => source.key)
    .sort();
  const missingRefreshSourceKeys = input.sources
    .filter((source) => source.lastRefreshedAt === null)
    .map((source) => source.key)
    .sort();
  const timestamps = input.sources
    .map((source) => source.lastRefreshedAt)
    .filter((value): value is Date => value instanceof Date);
  const minRefreshedAt =
    timestamps.length > 0
      ? new Date(Math.min(...timestamps.map((value) => value.getTime())))
      : null;
  const refreshAgeHours = minRefreshedAt
    ? Math.max(0, (input.now.getTime() - minRefreshedAt.getTime()) / 3_600_000)
    : null;
  return {
    screeningStatus: input.screening?.status ?? null,
    reviewState: input.screening?.reviewState ?? null,
    listVersions: stringRecord(input.screening?.listVersions),
    enabledSourceKeys,
    failedSourceKeys,
    missingRefreshSourceKeys,
    minRefreshedAt: minRefreshedAt?.toISOString() ?? null,
    refreshAgeHours,
  };
}

/** 四态：fresh / yellow / red / none（无 ENABLED 源）。 */
export type SanctionsFreshnessState = 'fresh' | 'yellow' | 'red' | 'none';

export function sanctionsFreshnessState(
  facts: SanctionsFacts,
): SanctionsFreshnessState {
  if (facts.enabledSourceKeys.length === 0) return 'none';
  // 任一 ENABLED 源从没刷新过 = 没有新鲜度证据 → 按最坏处理（fail-safe）。
  if (facts.refreshAgeHours === null || facts.missingRefreshSourceKeys.length > 0) {
    return 'red';
  }
  if (facts.refreshAgeHours > SANCTIONS_YELLOW_MAX_HOURS) return 'red';
  if (
    facts.refreshAgeHours > SANCTIONS_FRESH_MAX_HOURS ||
    facts.failedSourceKeys.length > 0
  ) {
    return 'yellow';
  }
  return 'fresh';
}

/**
 * G1 决策表（设计 §4.3.2.2）：
 *  - potential_match 且 review_state ∈ {open, confirmed_true_hit} → FAIL（压过一切）；
 *  - potential_match + cleared_false_positive → 视为清白，继续走新鲜度判定；
 *  - 无记录 / not_screened / 状态值漂移 → UNKNOWN（未筛查不是通过）；
 *  - 无 ENABLED 源（筛门本身未启用）→ UNKNOWN（fail-open → fail-safe 的关键转变；
 *    照样不阻断管线——UNKNOWN 按现状进复核，不 reject）；
 *  - 清白 + fresh → PASS；清白 + yellow/red → PASS 但带 stale reason_code 与
 *    `freshness` facts（「判定可继续，但不可进 recommended/导出/交付」，由下游
 *    J07 接线读取；设计 §4.3.2.2）。
 */
export function decideSanctionsGate(facts: SanctionsFacts): GateDecision {
  const freshness = sanctionsFreshnessState(facts);
  const baseFacts: Record<string, unknown> = {
    screening_status: facts.screeningStatus,
    review_state: facts.reviewState,
    list_versions: facts.listVersions,
    enabled_sources: [...facts.enabledSourceKeys],
    failed_sources: [...facts.failedSourceKeys],
    missing_refresh_sources: [...facts.missingRefreshSourceKeys],
    min_refreshed_at: facts.minRefreshedAt,
    freshness,
  };

  if (facts.screeningStatus === null || facts.screeningStatus === 'not_screened') {
    return makeDecision('G_SANCTIONS', 'UNKNOWN', 'GATE_SANCTIONS_NOT_SCREENED', baseFacts);
  }
  if (facts.screeningStatus === 'potential_match') {
    if (facts.reviewState !== 'cleared_false_positive') {
      // open / confirmed_true_hit / 未知 review_state 一律按未清白处理（fail-safe）。
      return makeDecision('G_SANCTIONS', 'FAIL', 'GATE_SANCTIONS_HIT', {
        ...baseFacts,
        matched: true,
      });
    }
  } else if (facts.screeningStatus !== 'clear') {
    // 状态闭集漂移：不认识的库值不得被当成清白。
    return makeDecision('G_SANCTIONS', 'UNKNOWN', 'GATE_SANCTIONS_NOT_SCREENED', baseFacts);
  }

  if (freshness === 'none') {
    return makeDecision('G_SANCTIONS', 'UNKNOWN', 'GATE_SANCTIONS_NOT_SCREENED', baseFacts);
  }
  if (freshness === 'yellow') {
    return makeDecision('G_SANCTIONS', 'PASS', 'GATE_SANCTIONS_STALE_YELLOW', {
      ...baseFacts,
      sanctions_stale: true,
    });
  }
  if (freshness === 'red') {
    return makeDecision('G_SANCTIONS', 'PASS', 'GATE_SANCTIONS_STALE_RED', {
      ...baseFacts,
      sanctions_stale: true,
    });
  }
  return makeDecision('G_SANCTIONS', 'PASS', null, baseFacts);
}

// ── G2 禁联门（suppression_record） ─────────────────────────────────────────

export interface SuppressionRow {
  readonly id: string;
  readonly type: string;
  readonly value: string;
}

export interface SuppressionFacts {
  readonly companyName: string;
  readonly companyDomain: string | null;
  /** canonical_company.status：SUPPRESSED 是派生状态，rows 落盘前即已生效的禁联也必须拦。 */
  readonly companyStatus?: string | null;
  readonly rows: readonly SuppressionRow[];
}

/** 命中的 suppression 记录 id（按 domain/company_name 的既有 canonical 语义比较）。 */
export function matchedSuppressionIds(facts: SuppressionFacts): string[] {
  const domain = facts.companyDomain
    ? canonicalizeSuppressionValue('domain', facts.companyDomain)
    : null;
  const name = canonicalizeSuppressionValue('company_name', facts.companyName);
  const domains = canonicalizeSuppressionValues(
    'domain',
    facts.rows.filter((row) => row.type === 'domain').map((row) => row.value),
  );
  const names = canonicalizeSuppressionValues(
    'company_name',
    facts.rows.filter((row) => row.type === 'company_name').map((row) => row.value),
  );
  return facts.rows
    .filter((row) => {
      if (row.type === 'domain') {
        const canonical = canonicalizeSuppressionValue('domain', row.value);
        return !!domain && !!canonical && domains.has(canonical) && canonical === domain;
      }
      if (row.type === 'company_name') {
        const canonical = canonicalizeSuppressionValue('company_name', row.value);
        return !!name && !!canonical && names.has(canonical) && canonical === name;
      }
      return false;
    })
    .map((row) => row.id)
    .sort();
}

/**
 * G2（禁联部分）决策：域名/公司名命中 → FAIL（GATE_SUPPRESSION）；
 * 无命中 → PASS。缺失不构成证据缺失（suppression 是「已知坏」清单，查无即 PASS）。
 */
export function decideSuppressionGate(facts: SuppressionFacts): GateDecision {
  const matched = matchedSuppressionIds(facts);
  const decisionFacts: Record<string, unknown> = {
    matched_suppression_ids: matched,
    company_status: facts.companyStatus ?? null,
  };
  if (matched.length > 0 || facts.companyStatus === 'SUPPRESSED') {
    return makeDecision('G_SUPPRESSION', 'FAIL', 'GATE_SUPPRESSION', decisionFacts);
  }
  return makeDecision('G_SUPPRESSION', 'PASS', null, decisionFacts);
}

// ── G2b ICP 排除门（EXCLUSION 规则） ────────────────────────────────────────

export interface IcpExclusionFacts {
  /** ICP 的全部规则（镜像 EXCLUSION 的判定需要 MUST_HAVE 一起参与）。 */
  readonly rules: readonly RuleLike[];
  /** 与 quick-scan 预筛同一套属性归一（canonical 列优先于 attributes）。 */
  readonly attributes: Record<string, unknown>;
}

/**
 * G2b 决策：非镜像的 EXCLUSION 规则命中（outcome=pass）→ FAIL（带 rule_id）；
 * 镜像 EXCLUSION（MUST_HAVE 的否定型镜像）只记录为 advisory、不排除
 * （设计 §4.3.2.3 与 rule-engine `mirrorExclusionsAdvisory` 语义）；
 * ICP 没有 EXCLUSION 规则 → NOT_APPLICABLE。规则数据缺失（unknown）不构成命中。
 */
export function decideIcpExclusionGate(facts: IcpExclusionFacts): GateDecision {
  const exclusionIndexes: number[] = [];
  facts.rules.forEach((rule, index) => {
    if (rule.kind === 'EXCLUSION') exclusionIndexes.push(index);
  });
  if (exclusionIndexes.length === 0) {
    return makeDecision('G_ICP_EXCLUSION', 'NOT_APPLICABLE', null, {
      exclusion_rule_count: 0,
      rule_ids: [],
      advisory_rule_ids: [],
      unknown_rule_ids: [],
    });
  }
  const mirrorIndexes = new Set(mirrorExclusionRuleIndexes(facts.rules));
  const failedRuleIds: string[] = [];
  const advisoryRuleIds: string[] = [];
  const unknownRuleIds: string[] = [];
  for (const index of exclusionIndexes) {
    const rule = facts.rules[index]!;
    const outcome = evaluateRule(rule, facts.attributes);
    const ruleId = rule.id ?? null;
    if (outcome === 'pass') {
      if (mirrorIndexes.has(index)) {
        if (ruleId) advisoryRuleIds.push(ruleId);
      } else if (ruleId) {
        failedRuleIds.push(ruleId);
      } else {
        failedRuleIds.push(`#${index}`);
      }
    } else if (outcome === 'unknown' && ruleId) {
      unknownRuleIds.push(ruleId);
    }
  }
  const decisionFacts: Record<string, unknown> = {
    exclusion_rule_count: exclusionIndexes.length,
    rule_ids: failedRuleIds.sort(),
    advisory_rule_ids: advisoryRuleIds.sort(),
    unknown_rule_ids: unknownRuleIds.sort(),
  };
  if (failedRuleIds.length > 0) {
    return makeDecision('G_ICP_EXCLUSION', 'FAIL', 'GATE_ICP_EXCLUSION', decisionFacts);
  }
  return makeDecision('G_ICP_EXCLUSION', 'PASS', null, decisionFacts);
}

// ── G3 国家/市场门 ──────────────────────────────────────────────────────────

export interface CountryFacts {
  readonly companyCountry: string | null;
  /** ICP 声明的市场词（targetMarkets + MUST_HAVE country/region 规则的操作数）。 */
  readonly marketTerms: readonly string[];
}

/**
 * G3 决策：公司国家 ∈ 市场集合 → PASS；∉ → FAIL；公司国家缺失/无法归一 → UNKNOWN；
 * ICP 未声明市场 → NOT_APPLICABLE。两边都先归一成 ISO alpha-2 再比较
 * （`德国` 与 `DE` 并存是现场事实，见设计 §4.3.2.4）。
 */
export function decideCountryGate(facts: CountryFacts): GateDecision {
  const markets = normalizeMarketIsos(facts.marketTerms);
  const companyCountryIso = normalizeCountryIso(facts.companyCountry);
  const decisionFacts: Record<string, unknown> = {
    company_country: facts.companyCountry,
    company_country_iso: companyCountryIso,
    markets,
  };
  if (markets.length === 0) {
    return makeDecision('G_COUNTRY', 'NOT_APPLICABLE', null, decisionFacts);
  }
  if (companyCountryIso === null) {
    return makeDecision('G_COUNTRY', 'UNKNOWN', 'GATE_COUNTRY_UNKNOWN', decisionFacts);
  }
  if (markets.includes(companyCountryIso)) {
    return makeDecision('G_COUNTRY', 'PASS', null, decisionFacts);
  }
  return makeDecision('G_COUNTRY', 'FAIL', 'GATE_COUNTRY_MISMATCH', decisionFacts);
}

// ── G4 规模门 ───────────────────────────────────────────────────────────────

export interface SizeFacts {
  readonly employeeCount: number | null;
  readonly employeeBand: string | null;
  /** ICP 的 MUST_HAVE 规模规则（employee_count/employees/employee_band 的 gte/lte/in）。 */
  readonly rules: readonly RuleLike[];
}

const SIZE_RULE_FIELDS: ReadonlySet<string> = new Set([
  'employeecount',
  'employees',
  'employeeband',
]);

export function isSizeRule(rule: RuleLike): boolean {
  return rule.kind === 'MUST_HAVE' && SIZE_RULE_FIELDS.has(normFieldName(rule.field));
}

/**
 * G4 决策：在范围内 → PASS；明确越界 → FAIL；employeeCount 与 employee_band
 * 均缺失 → UNKNOWN；ICP 无规模条件 → NOT_APPLICABLE。规则值不可解析时该规则记
 * unknown（不静默当通过）。
 */
export function decideSizeGate(facts: SizeFacts): GateDecision {
  if (facts.rules.length === 0) {
    return makeDecision('G_SIZE', 'NOT_APPLICABLE', null, {
      employee_count: facts.employeeCount,
      employee_band: facts.employeeBand,
      failed_rule_ids: [],
      unknown_rule_ids: [],
    });
  }
  const companyRange: [number, number] | null =
    typeof facts.employeeCount === 'number' && Number.isFinite(facts.employeeCount)
      ? [facts.employeeCount, facts.employeeCount]
      : facts.employeeBand
        ? parseNumberRange(facts.employeeBand)
        : null;
  const decisionFacts: Record<string, unknown> = {
    employee_count: facts.employeeCount,
    employee_band: facts.employeeBand,
    failed_rule_ids: [] as string[],
    unknown_rule_ids: [] as string[],
  };
  if (companyRange === null) {
    return makeDecision('G_SIZE', 'UNKNOWN', 'GATE_SIZE_UNKNOWN', decisionFacts);
  }
  const failedRuleIds: string[] = [];
  const unknownRuleIds: string[] = [];
  facts.rules.forEach((rule, index) => {
    const ruleId = rule.id ?? null;
    const outcome = evaluateSizeRule(rule, companyRange);
    if (outcome === 'fail') failedRuleIds.push(ruleId ?? `#${index}`);
    else if (outcome === 'unknown' && ruleId) unknownRuleIds.push(ruleId);
  });
  decisionFacts.failed_rule_ids = failedRuleIds.sort();
  decisionFacts.unknown_rule_ids = unknownRuleIds.sort();
  if (failedRuleIds.length > 0) {
    return makeDecision('G_SIZE', 'FAIL', 'GATE_SIZE_OUT_OF_RANGE', decisionFacts);
  }
  if (unknownRuleIds.length > 0) {
    return makeDecision('G_SIZE', 'UNKNOWN', 'GATE_SIZE_UNKNOWN', decisionFacts);
  }
  return makeDecision('G_SIZE', 'PASS', null, decisionFacts);
}

function evaluateSizeRule(
  rule: RuleLike,
  companyRange: [number, number],
): 'pass' | 'fail' | 'unknown' {
  const values = Array.isArray(rule.value) ? rule.value : [rule.value];
  switch (rule.operator) {
    case 'gte': {
      const threshold = parseNumberRange(values[0]);
      if (!threshold) return 'unknown';
      return companyRange[1] >= threshold[0] ? 'pass' : 'fail';
    }
    case 'lte': {
      const threshold = parseNumberRange(values[0]);
      if (!threshold) return 'unknown';
      return companyRange[0] <= threshold[0] ? 'pass' : 'fail';
    }
    case 'in':
    case 'eq': {
      const bands = values
        .map((value) => parseNumberRange(value))
        .filter((value): value is [number, number] => value !== null);
      if (bands.length === 0) return 'unknown';
      return bands.some(
        (band) => companyRange[0] >= band[0] && companyRange[1] <= band[1],
      )
        ? 'pass'
        : 'fail';
    }
    default:
      return 'unknown';
  }
}

// ── G5 域名/可验证性门 ──────────────────────────────────────────────────────

export interface DomainFacts {
  readonly domain: string | null;
  readonly domainStatus: 'ALIVE' | 'DEAD' | 'UNKNOWN' | null;
  readonly allowDomainless: boolean;
}

/**
 * G5 决策（设计 §4.3.2.6）：有域名且存活校验非 DEAD → PASS；无域名或 DEAD → UNKNOWN
 * （`GATE_DOMAIN_MISSING` / `GATE_DOMAIN_DEAD`，进域名补数队列，**不进 LLM judge**）；
 * ICP 显式允许无官网渠道（companyAttributes.allow_domainless=true）→ NOT_APPLICABLE。
 */
export function decideDomainGate(facts: DomainFacts): GateDecision {
  const normalized = normalizeDomain(facts.domain);
  const decisionFacts: Record<string, unknown> = {
    domain: facts.domain,
    domain_normalized: normalized,
    domain_status: facts.domainStatus,
    allow_domainless: facts.allowDomainless,
  };
  if (facts.allowDomainless) {
    return makeDecision('G_DOMAIN', 'NOT_APPLICABLE', null, decisionFacts);
  }
  if (normalized === null) {
    return makeDecision('G_DOMAIN', 'UNKNOWN', 'GATE_DOMAIN_MISSING', decisionFacts);
  }
  if (facts.domainStatus === 'DEAD') {
    return makeDecision('G_DOMAIN', 'UNKNOWN', 'GATE_DOMAIN_DEAD', decisionFacts);
  }
  return makeDecision('G_DOMAIN', 'PASS', null, decisionFacts);
}

// ── 编排：evaluateGates（唯一写入口） ───────────────────────────────────────

interface HardGateResultWriteRow {
  workspaceId: string;
  canonicalCompanyId: string;
  icpId: string | null;
  gateSetVersion: string;
  gateId: string;
  gateVersion: string;
  verdict: string;
  reasonCode: string | null;
  applicable: boolean;
  facts: Prisma.InputJsonValue;
  inputDigest: string;
}

interface EnrichmentTaskWriteRow {
  workspaceId: string;
  canonicalCompanyId: string;
  icpId: string | null;
  gateId: string;
  reasonCode: string;
  status: string;
}

/**
 * 评估一组硬门并写库。
 *
 * ctx.icpId 必填：判定语义是「公司 × ICP」；G1/G2 虽与 ICP 无关，但其行以
 * `icp_id = NULL` 写入（replay 键因此跨 ICP 去重）。
 *
 * 校验与短路：
 *  - 任一 FAIL 短路（后续门不评估、不写行）——公司已被排除；
 *  - UNKNOWN 不短路；G3/G4/G5 的 UNKNOWN 写 `gate_enrichment_task`（queued）；
 *  - 写库前的每个决策都过 `assertGateDecision`（reason_code 闭集校验，fail-closed）。
 */
export async function evaluateGates(
  tx: Prisma.TransactionClient,
  ctx: GateEvaluationContext,
): Promise<GateEvaluation> {
  const now = ctx.now ?? new Date();

  const company = await tx.canonicalCompany.findFirst({
    where: { id: ctx.canonicalCompanyId, workspaceId: ctx.workspaceId },
    select: {
      id: true,
      name: true,
      domain: true,
      country: true,
      industry: true,
      employeeCount: true,
      revenueUsd: true,
      status: true,
      attributes: true,
    },
  });
  if (!company) throw new Error('GATE_COMPANY_NOT_FOUND');

  const icp = await tx.icpDefinition.findFirst({
    where: { id: ctx.icpId, workspaceId: ctx.workspaceId },
    select: { companyAttributes: true, targetMarkets: true },
  });
  if (!icp) throw new Error('GATE_ICP_NOT_FOUND');

  const rules = await tx.qualificationRule.findMany({
    where: { workspaceId: ctx.workspaceId, icpId: ctx.icpId },
    select: {
      id: true,
      kind: true,
      field: true,
      operator: true,
      value: true,
      weight: true,
    },
  });

  const [screening, sources, suppressions] = await Promise.all([
    tx.sanctionsScreeningResult.findUnique({
      where: {
        workspaceId_canonicalCompanyId: {
          workspaceId: ctx.workspaceId,
          canonicalCompanyId: ctx.canonicalCompanyId,
        },
      },
      select: { status: true, reviewState: true, listVersions: true },
    }),
    tx.sanctionsSource.findMany({
      where: { status: 'ENABLED' },
      select: { key: true, lastRefreshedAt: true, lastFetchStatus: true },
    }),
    tx.suppressionRecord.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        type: { in: ['domain', 'company_name'] },
      },
      select: { id: true, type: true, value: true },
    }),
  ]);

  const attributes = jsonObject(company.attributes);
  const ruleAttributes = prefilterAttributes({
    id: company.id,
    name: company.name,
    domain: company.domain,
    country: company.country,
    industry: company.industry,
    employeeCount: company.employeeCount,
    revenueUsd: company.revenueUsd,
    attributes: company.attributes,
  });
  const icpAttributes = jsonObject(icp.companyAttributes);
  const allowDomainless =
    icpAttributes.allow_domainless === true || icpAttributes.allowDomainless === true;
  const targetMarkets = Array.isArray(icp.targetMarkets)
    ? icp.targetMarkets.filter((term): term is string => typeof term === 'string')
    : [];
  const countryRuleTerms = rules
    .filter(
      (rule) =>
        rule.kind === 'MUST_HAVE' &&
        (normFieldName(rule.field) === 'country' || normFieldName(rule.field) === 'region') &&
        (rule.operator === 'in' || rule.operator === 'eq'),
    )
    .flatMap((rule) => asStringArray(rule.value));
  const rawEmployeeBand =
    attributes.employee_band ?? attributes.employeeBand ?? attributes.employees ?? null;
  const employeeBand =
    typeof rawEmployeeBand === 'number'
      ? String(rawEmployeeBand)
      : typeof rawEmployeeBand === 'string' && rawEmployeeBand.trim()
        ? rawEmployeeBand
        : null;
  const sizeRules = rules.filter((rule) => isSizeRule(rule));

  const evaluators: Record<GateId, () => GateDecision> = {
    G_SANCTIONS: () =>
      decideSanctionsGate(buildSanctionsFacts({ screening, sources, now })),
    G_SUPPRESSION: () =>
      decideSuppressionGate({
        companyName: company.name,
        companyDomain: company.domain,
        companyStatus: company.status,
        rows: suppressions,
      }),
    G_ICP_EXCLUSION: () =>
      decideIcpExclusionGate({ rules, attributes: ruleAttributes }),
    G_COUNTRY: () =>
      decideCountryGate({
        companyCountry:
          company.country ??
          (typeof attributes.country === 'string' ? attributes.country : null),
        marketTerms: [...targetMarkets, ...countryRuleTerms],
      }),
    G_SIZE: () =>
      decideSizeGate({
        employeeCount: company.employeeCount,
        employeeBand,
        rules: sizeRules,
      }),
    G_DOMAIN: () =>
      decideDomainGate({
        domain: company.domain,
        domainStatus: ctx.domainStatus ?? null,
        allowDomainless,
      }),
  };

  const results: GateDecision[] = [];
  let failedGate: GateDecision | null = null;
  for (const gateId of GATE_ORDER) {
    const decision = evaluators[gateId]();
    assertGateDecision(decision);
    results.push(decision);
    if (decision.verdict === 'FAIL') {
      failedGate = decision;
      break; // 短路：后续门不评估、不写行
    }
  }

  const resultRows: HardGateResultWriteRow[] = results.map((decision) => ({
    workspaceId: ctx.workspaceId,
    canonicalCompanyId: ctx.canonicalCompanyId,
    icpId: ICP_INDEPENDENT_GATE_IDS.has(decision.gateId) ? null : ctx.icpId,
    gateSetVersion: GATE_SET_VERSION,
    gateId: decision.gateId,
    gateVersion: decision.gateVersion,
    verdict: decision.verdict,
    reasonCode: decision.reasonCode,
    applicable: decision.applicable,
    facts: decision.facts as Prisma.InputJsonValue,
    inputDigest: decision.inputDigest,
  }));
  const taskRows: EnrichmentTaskWriteRow[] = results
    .filter(
      (decision) =>
        decision.verdict === 'UNKNOWN' &&
        ENRICHMENT_GATE_IDS.has(decision.gateId) &&
        decision.reasonCode !== null,
    )
    .map((decision) => ({
      workspaceId: ctx.workspaceId,
      canonicalCompanyId: ctx.canonicalCompanyId,
      icpId: ctx.icpId,
      gateId: decision.gateId,
      reasonCode: decision.reasonCode!,
      status: 'queued',
    }));

  // INSERT … ON CONFLICT DO NOTHING：同 digest / 同 (company, icp, gate) 的重试不翻行。
  const inserted = await tx.hardGateResult.createMany({
    data: resultRows,
    skipDuplicates: true,
  });
  const taskInserted = await tx.gateEnrichmentTask.createMany({
    data: taskRows,
    skipDuplicates: true,
  });

  const unknownGates = results.filter((decision) => decision.verdict === 'UNKNOWN');
  const verdict: GateChainVerdict = failedGate
    ? 'FAIL'
    : unknownGates.length > 0
      ? 'UNKNOWN'
      : 'PASS';

  return {
    gateSetVersion: GATE_SET_VERSION,
    verdict,
    results,
    failedGate,
    unknownGates,
    insertedResultCount: inserted.count,
    enrichmentTaskCount: taskInserted.count,
  };
}
