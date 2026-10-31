import { qualify, QualifyResult, RuleLike } from '../icp/rule-engine';
import { TENDER_PUBLISHED, US_FED_SOURCES_SOUGHT } from '../signals/signal-mappers';

/**
 * 六维评分（LED-006, PRD 5.6/7.5）—— 全部确定性计算，AI 不参与打分：
 * Fit          规则引擎判定 + nice-to-have 加权分（ICP 资格门已判时以其为准）
 * Role         已发现联系人对买家委员会角色的覆盖（v3 起零权重：RL1 无具名联系人，仍计算、仍上报）
 * Intent       **真实网站变更 intent 事件（#4，attributes.intent.*）按新近度衰减取最强** + ICP 关键词代理兜底
 * DataQuality  关键字段完整度
 * Reachability 联系路径可达性 = max(公司级联系路径 BI-14, 个人联系点旧口径)
 * Engagement   互动历史（触达能力未上线 → 恒 0，权重最低）
 * 排除规则永远优先（EXCLUSION 命中 → rejected 队列，不进推荐）；唯一例外：权威 Fit 存在时，MUST_HAVE 的
 * 镜像 EXCLUSION 只记录（非镜像的否定型 EXCLUSION 照旧排除）。
 *
 * 规则版本 `additive-6dim-v3`（lead-qualified-snapshot.ts QUALIFICATION_RULE_VERSION，计分时写进
 * score_detail.ruleVersion），v3 替换了：
 *  - 可达性只读人级 contact_point（xin 上 recommended 结构性为 0：自动链路没有联系人发现）；
 *  - 权重 fit .35 / role .15 / reach .15（Role 恒 0 → 15% 闲置，match + 联系页也只有 0.5225 够不着 0.55）；
 *  - 关键词代理 JSON.stringify 全文子串扫描（2 字母 token「ce」命中键名 certifications；「new」命中「news」）；
 *  - 镜像 EXCLUSION 在权威 Fit 之前硬排除（keywords 受控英文词表 → 带 keywords 的公司一律 rejected）。
 */

export interface CompanyForScoring {
  name: string;
  domain: string | null;
  country: string | null;
  industry: string | null;
  employeeCount: number | null;
  revenueUsd: number | null;
  attributes: Record<string, unknown> | null;
  status: string; // NEW | ENRICHED | SUPPRESSED
  contacts: {
    title: string | null;
    seniority: string | null;
    contactPoints: { type: string; status: string }[];
  }[];
  /**
   * 公司级联系路径（BI-14 `company_contact_point`，#630）：调用方（qualify.activities）已按
   * status ∈ VALID/UNVERIFIED 读取并在读时做禁联过滤；这里再按 kind 与 status 兜底。
   */
  companyContactPoints: { kind: string; status: string }[];
}

export interface IcpForScoring {
  rules: RuleLike[];
  triggerSignals: string[];
  committeeRoles: { role: string; title: string | null }[];
}

export interface LeadScoreResult {
  // 'sanctions_hold'（第五门制裁命中）= 独立隔离队列，压过一切（人工复核前不交付）。
  queue: 'recommended' | 'needs_review' | 'rejected' | 'suppressed' | 'sanctions_hold';
  totalScore: number;
  scores: {
    fit: number;
    role: number;
    intent: number;
    /**
     * 需求证据维（收口⑤）：**观测值，不进 totalScore**——只由带 evidence 的真实需求类事件驱动
     *（TENDER_PUBLISHED 招标 / SOURCING_OPENED 供应商招募），按新近度衰减取最强；无关键词代理
     *（ADR-010：无 evidence 的字段不得参与评分）。乘法门 Fit^a×(1+DemandProof)×… 待 R2 backtest
     *（人工确认 QGO 标签 ≥50 条）后启用。
     */
    demandProof: number;
    dataQuality: number;
    reachability: number;
    engagement: number;
  };
  detail: {
    fitVerdict: QualifyResult['verdict'];
    ruleEvaluations: QualifyResult['evaluations'];
    matchedSignals: string[];
    /** 命中的真实 intent 事件类型（来自 #4 attributes.intent.events，如 SOURCING_OPENED/HIRING_UP）。 */
    intentSignals: string[];
    missingFields: string[];
    /**
     * 稳定原因码（v3；BI-20 再统一收编为枚举）：`MISSING_CONTACT_POINT` = 零可达且进 needs_review
     *（下一步动作：补公司级联系路径）。给持久痕迹与验收 SQL 用，不替代 notes。
     */
    reasonCodes: string[];
    notes: string[];
  };
}

/**
 * 加法六维权重 v3（additive-6dim-v3，2026-10-14，产品负责人按方案 A 授权）：RL1 没有具名联系人
 *（联系人发现在 LIA 之后才走），Role 恒 0、15% 权重闲置 → 并入 Fit（.35→.45）与 Reachability（.15→.20），
 * 其余不变，门槛 0.55 不变。Role 仍计算、仍上报（零权重）。不含 demandProof——观测维不进总分，
 * 乘法门待 R2 backtest（见 LeadScoreResult.scores 注）。v2：fit .35 / role .15 / intent .15 / dq .15 / reach .15 / eng .05。
 */
const WEIGHTS = { fit: 0.45, role: 0, intent: 0.15, dataQuality: 0.15, reachability: 0.2, engagement: 0.05 };
// 需求证据类事件（收口⑤拍板 + P4 扩）：买方公开采购（TED 招标 / SAM Sources Sought——皆买方侧需求，
// Sources Sought 为招标前市场调研=最早的买方需求证据）+ 供应商招募页开放；FDA_CLEARANCE 属**卖方侧**上市时机，留 Intent 维不进需求证据。
const DEMAND_PROOF_EVENT_TYPES = new Set<string>([TENDER_PUBLISHED, US_FED_SOURCES_SOUGHT, 'SOURCING_OPENED']);
const RECOMMEND_THRESHOLD = 0.55;
const INTENT_HALFLIFE_DAYS = 60; // 意向信号半衰期：B2B 买家信号约 2 月衰减一半（越久越弱，防陈旧信号长期占分）
const DAY_MS = 86_400_000;

/**
 * 计入可达性的公司级联系路径 kind（BI-14 设计 §10，2026-10-10 变更）：官网联系页 / Impressum / 联系表单 /
 * 供应商页——任一存在即「存在公司级渠道」记 1.0。公司 LinkedIn / X 页不是联系路径，不计。
 * 「可达」= 官网公开、未验证投递，**不等于发送许可**（UWG §7 由 BI-15 legal_note 提示）。
 */
export const REACHABLE_COMPANY_CONTACT_KINDS: ReadonlySet<string> = new Set([
  'contact_page',
  'impressum_page',
  'contact_form',
  'supplier_page',
]);
const REACHABLE_COMPANY_CONTACT_STATUSES: ReadonlySet<string> = new Set(['VALID', 'UNVERIFIED']);
export const MISSING_CONTACT_POINT = 'MISSING_CONTACT_POINT';

function companyAttributes(c: CompanyForScoring): Record<string, unknown> {
  return {
    name: c.name,
    domain: c.domain,
    country: c.country,
    industry: c.industry,
    employee_count: c.employeeCount,
    revenue_usd: c.revenueUsd,
    ...(c.attributes ?? {}),
  };
}

export interface ScoreLeadOpts {
  nowMs?: number;
  /**
   * ICP 资格门（LLM 四门）的权威 Fit 判定（Lead.fit_verdict，per ICP×公司）。存在时**只覆盖 Fit 维**——
   * 当前 ICP 规则值与 canonical 属性存在语言/词表不一致（"制造业" vs "metal fabrication"，
   * 词表归一欠账），确定性规则 Fit 会误判；资格门更可靠。但队列归属仍走六维总分 + 阈值 +
   * Reachability 硬底——此前 fitVerdict=match 直接盖整个队列，推荐队列里 9/11 家一个联系人
   * 都没有（联系不上的"推荐"），其余五维形同虚设。词表归一落地后此覆盖退化为一致性校验。
   * v3：权威 Fit 存在时，MUST_HAVE 的镜像 EXCLUSION 只记进 ruleEvaluations，不改队列；非镜像的否定型
   * EXCLUSION（如手加的 country not_in […]）照旧排除。
   */
  authoritativeFit?: 'match' | 'weak' | 'mismatch' | null;
  /**
   * 制裁筛查命中（qualify 第五门）：有未决命中（potential_match/confirmed_true_hit）→ `sanctionsHold=true`
   * → queue 强制 `'sanctions_hold'`（隔离队列，**压过一切**——含 exclude/权威 match/阈值）。命中≠低分而是合规硬停，
   * 故不进六维总分；decide(accept) 另有硬拦（绝不交付）。fail-open：未启用/清白 → false（不影响队列）。
   */
  sanctionsHold?: boolean;
}

/** 权威 Fit 判定 → Fit 维分值（match 高带、weak 复核带、mismatch 零）。 */
const AUTHORITATIVE_FIT_SCORE: Record<'match' | 'weak' | 'mismatch', number> = { match: 0.85, weak: 0.45, mismatch: 0 };

export function scoreLead(company: CompanyForScoring, icp: IcpForScoring, opts?: ScoreLeadOpts): LeadScoreResult {
  const notes: string[] = [];
  const reasonCodes: string[] = [];
  const attrs = companyAttributes(company);
  const authoritative = opts?.authoritativeFit ?? null;
  // v3：资格门已判 Fit 时，MUST_HAVE 的镜像 EXCLUSION 只记录不排除；其余 EXCLUSION（正向、非镜像否定型）照旧最高优先。
  const fitResult = qualify(icp.rules, attrs, { mirrorExclusionsAdvisory: authoritative !== null });

  // Fit：权威资格门判过 → 用它（只覆盖本维）；否则规则引擎。
  // clamp01（J）：nice-to-have 权重若混入负值，归一化比可超 1 → fit>1 会污染 totalScore 与队列排序
  //（与 intent 维已有的 clamp 对齐；DTO @Min(0) 是第一道门，此处是系统边界兜底）。
  const fit = clamp01(
    authoritative
      ? AUTHORITATIVE_FIT_SCORE[authoritative]
      : fitResult.verdict === 'match'
        ? 0.6 + 0.4 * (fitResult.score ?? 0.5)
        : fitResult.verdict === 'review'
          ? 0.3 + 0.3 * (fitResult.score ?? 0)
          : 0,
  );
  if (authoritative) notes.push(`Fit 维由 ICP 资格门（LLM 四门）判定=${authoritative}，覆盖规则引擎（词表归一欠账）`);
  const advisoryHits = fitResult.evaluations.filter((e) => e.advisory && e.outcome === 'pass');
  if (advisoryHits.length) {
    notes.push(
      `${advisoryHits.length} 条 MUST_HAVE 的镜像 EXCLUSION 命中但只记录不排除（资格门已判 Fit；见 IcpDto.ruleLint）`,
    );
  }

  // Role coverage：委员会角色被联系人 title 覆盖的比例（v3 零权重，仍上报）
  const titles = company.contacts.map((c) => `${c.title ?? ''} ${c.seniority ?? ''}`.toLowerCase());
  const covered = icp.committeeRoles.filter((r) => {
    const probe = `${r.title ?? ''} ${r.role}`.toLowerCase();
    const words = probe.split(/[\s/|]+/).filter((w) => w.length > 2);
    return titles.some((t) => words.some((w) => t.includes(w)));
  });
  const role = icp.committeeRoles.length
    ? covered.length / icp.committeeRoles.length
    : company.contacts.length
      ? 0.5
      : 0;

  // Intent：真实网站变更 intent 事件（#4，attributes.intent.*，按新近度衰减）为主 + ICP 关键词代理兜底
  const intentDim = intentDimension(attrs, icp.triggerSignals, opts?.nowMs ?? Date.now());
  const intent = intentDim.intent;
  const matchedSignals = intentDim.matchedSignals;
  notes.push(intentDim.note);

  // DataQuality：关键字段完整度
  const keyFields: [string, unknown][] = [
    ['domain', company.domain],
    ['country', company.country],
    ['industry', company.industry],
    ['employee_count', company.employeeCount],
  ];
  const missingFields = keyFields.filter(([, v]) => v == null).map(([k]) => k);
  const dataQuality = (keyFields.length - missingFields.length) / keyFields.length;

  // Reachability（v3，BI-14 D-028）= max(公司级, 个人旧口径)：
  //  - 公司级：任一联系路径 kind（contact_page / impressum_page / contact_form / supplier_page）且
  //    status ∈ VALID/UNVERIFIED → 1.0；社交页不计；INVALID 不计。自动链路只写 UNVERIFIED，VALID 只能由人给出。
  //  - 个人旧口径不变（Q4，不收回已有能力）：VALID 1 / UNVERIFIED|RISKY 0.5。🔴 **排除标识点 external_id**——它不是可达渠道
  //   （#58 P1：CH officer_id 默认 UNVERIFIED，若计入会让「无邮箱/电话的董事」被误判可达、越过推荐队列 Reachability 硬底）。
  //    用黑名单（非白名单 email/phone）以保留 linkedin 等真实联系渠道（#62 复审 P2）。
  const companyReachability = company.companyContactPoints.some(
    (p) => REACHABLE_COMPANY_CONTACT_KINDS.has(p.kind) && REACHABLE_COMPANY_CONTACT_STATUSES.has(p.status),
  )
    ? 1
    : 0;
  const points = company.contacts
    .flatMap((c) => c.contactPoints)
    .filter((p) => p.type !== 'external_id');
  const personalReachability = points.some((p) => p.status === 'VALID')
    ? 1
    : points.some((p) => p.status === 'UNVERIFIED' || p.status === 'RISKY')
      ? 0.5
      : 0;
  const reachability = Math.max(companyReachability, personalReachability);
  if (reachability === 0) notes.push('无可达联系方式（公司级联系路径与个人联系点皆无）');

  const engagement = 0; // 触达/互动未上线

  const scores = {
    fit: r4(fit),
    role: r4(role),
    intent: r4(intent),
    demandProof: r4(intentDim.demandProof),
    dataQuality: r4(dataQuality),
    reachability: r4(reachability),
    engagement,
  };
  // totalScore 只按 WEIGHTS 六键合成——demandProof 是观测维（键不在 WEIGHTS 中，天然不入总分）。
  const totalScore = r4(
    Object.entries(WEIGHTS).reduce((s, [k, w]) => s + w * scores[k as keyof typeof scores], 0),
  );

  // 队列（LED-008）：硬排除 > 权威资格门 > 阈值 + Reachability 硬底。
  // 正向排除规则（EXCLUSION）永远优先——即便资格门 match（如后来进禁联行业名单）。
  // Reachability 硬底：推荐 = 「对的公司 + 联系得上」。总分达标但零可达联系方式的一律进复核
  // （下一步动作明确：先补公司级联系路径），**绝不进推荐**——用户点开却无从触达的"推荐"是伪推荐。
  // 此底对**所有会进 recommended 的分支统一生效**（权威 match 与规则引擎老路径皆然），不再只挡权威分支。
  const reachable = reachability > 0;
  const canRecommend = totalScore >= RECOMMEND_THRESHOLD && reachable;
  let queue: LeadScoreResult['queue'];
  // 第五门制裁命中 = 最高优先隔离，压过一切（含硬排除/权威 match/阈值）。合规硬停，人工复核前绝不交付。
  if (opts?.sanctionsHold) {
    queue = 'sanctions_hold';
    notes.push('制裁筛查命中 —— 进隔离队列（sanctions_hold），人工复核前不交付（第五门）');
  } else if (company.status === 'SUPPRESSED') queue = 'suppressed';
  else if (fitResult.verdict === 'exclude') queue = 'rejected';
  else if (authoritative === 'mismatch') queue = 'rejected';
  else if (authoritative === 'weak') queue = 'needs_review';
  else if (authoritative === 'match') {
    queue = canRecommend ? 'recommended' : 'needs_review';
    if (!reachable) notes.push('资格门 match 但无可达联系方式 —— 先补公司级联系路径，再进推荐');
  } else if (fitResult.verdict === 'no_match') queue = 'rejected';
  else if (fitResult.verdict === 'review') queue = 'needs_review';
  else {
    queue = canRecommend ? 'recommended' : 'needs_review';
    if (!reachable && totalScore >= RECOMMEND_THRESHOLD) {
      notes.push('总分达标但无可达联系方式 —— 先补公司级联系路径，再进推荐');
    }
  }
  if (queue === 'needs_review' && !reachable) reasonCodes.push(MISSING_CONTACT_POINT);

  return {
    queue,
    totalScore,
    scores,
    detail: {
      fitVerdict: fitResult.verdict,
      ruleEvaluations: fitResult.evaluations,
      matchedSignals,
      intentSignals: intentDim.intentSignals,
      missingFields,
      reasonCodes,
      notes,
    },
  };
}

interface IntentEventLike {
  type?: unknown;
  at?: unknown;
  strength?: unknown;
  evidence?: unknown;
}
interface IntentAttrLike {
  intent_score?: unknown;
  last_change_at?: unknown;
  events?: unknown;
}

/**
 * 意向维：**真实网站变更 intent 事件**（#4 网站变更引擎投影的 `attributes.intent.*`）为主，
 * 逐事件按新近度指数衰减(半衰期 60d)后取最强；无真实信号时回退到 ICP 关键词代理（弱先验）。
 * intent = max(realIntent, keywordIntent)——让真实证据能压过纯关键词命中，同时保留代理兜底。
 */
function intentDimension(
  attrs: Record<string, unknown>,
  triggerSignals: string[],
  nowMs: number,
): { intent: number; demandProof: number; matchedSignals: string[]; intentSignals: string[]; note: string } {
  // ① 真实 intent：attributes.intent.events 逐条 strength × 新近度衰减，取最强
  const intentAttr = attrs.intent as IntentAttrLike | undefined;
  let realIntent = 0;
  let demandProof = 0; // 需求证据维（收口⑤）：仅需求类事件（招标/供应商招募），无代理兜底
  const intentSignals: string[] = [];
  if (intentAttr && typeof intentAttr === 'object') {
    const events = Array.isArray(intentAttr.events) ? (intentAttr.events as IntentEventLike[]) : [];
    for (const e of events) {
      const strength = typeof e.strength === 'number' ? e.strength : 0;
      const atMs = typeof e.at === 'string' ? Date.parse(e.at) : NaN;
      const decayed = strength * recencyDecay(nowMs - atMs);
      if (decayed > realIntent) realIntent = decayed;
      // evidence 判据强制（ADR-010「无 evidence 的字段不得参与评分或导出」——demand_proof 会进快照导出）
      if (typeof e.type === 'string' && DEMAND_PROOF_EVENT_TYPES.has(e.type) && e.evidence != null && decayed > demandProof) {
        demandProof = decayed;
      }
      if (typeof e.type === 'string' && !intentSignals.includes(e.type)) intentSignals.push(e.type);
    }
    // 事件缺失但有 intent_score 概要 → 用概要 × last_change_at 衰减兜底
    if (!events.length && typeof intentAttr.intent_score === 'number') {
      realIntent = intentAttr.intent_score * recencyDecay(nowMs - Date.parse(String(intentAttr.last_change_at)));
    }
  }
  realIntent = clamp01(realIntent);

  // ② 关键词代理（v3）：ICP triggerSignals ↔ 公司属性**值**文本命中（弱先验兜底）。
  //    只扫属性值不扫键名（v2 用 JSON.stringify 全文，2 字母 token「ce」命中键名 certifications），也不扫 `_` 前缀的
  //    记账键（_ts / _contact_parser / _contact_attempt_at …）；排除 intent 命名空间（否则触发词会命中 intent 事件
  //    自身的元数据，对同一信号在 realIntent 之外再计一次未衰减的分）、extraction_*（抽取账本 / 摘要，非公司事实）
  //    与 website_profile.evidence（模型判定的证据片段）。Latin token 按词边界匹配（「new」不命中「news」），CJK 按子串。
  const attrText = keywordProxyText(attrs);
  const matchedSignals = triggerSignals.filter((s) => keywordTokens(s).some((w) => keywordTokenMatches(attrText, w)));
  const keywordIntent = triggerSignals.length
    ? Math.min(1, matchedSignals.length / Math.min(triggerSignals.length, 3))
    : 0;

  const intent = clamp01(Math.max(realIntent, keywordIntent));
  // 注/信号来源以**实际决定最终分的项**为准（含仅有 intent_score 概要、无逐事件的兜底路径），
  // 否则概要兜底会被误标成「关键词代理·无真实信号」，与 0.65 的真实分自相矛盾（可审计性）。
  const usedReal = realIntent > 0 && realIntent >= keywordIntent;
  const note = usedReal
    ? `Intent 由真实网站变更信号驱动（${intentSignals.length ? intentSignals.join('/') : 'intent 概要'}；新近度加权 realIntent=${r4(realIntent)}）`
    : 'Intent 基于关键词代理（无真实意向信号）';
  return { intent, demandProof: clamp01(demandProof), matchedSignals, intentSignals, note };
}

const CJK_SCRIPT = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;
/** 触发词 token：Latin ≥3 字符（2 字母如「ce」「de」噪声太大），CJK ≥2 字（信息密度高，「扩产」有意义）。 */
function keywordTokens(signal: string): string[] {
  return signal
    .toLowerCase()
    .split(/[\s，,、；;/|()（）]+/)
    .filter((w) => w.length >= 3 || (w.length >= 2 && CJK_SCRIPT.test(w)));
}

/**
 * token 是否出现在文本里：含 CJK 的 token 按子串（中文不按空格分词）；其余按词边界——前后都不是字母或数字
 *（Unicode 意义上，ß / ü 也算字母），所以「new」不命中「news」、「dach」不命中「bedachung」，但命中「dach-region」。
 */
function keywordTokenMatches(text: string, token: string): boolean {
  if (CJK_SCRIPT.test(token)) return text.includes(token);
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(text);
}

/** 公司属性里参与关键词代理的**字符串值**（小写、换行拼接）；键名、数字、布尔、`_` 前缀的记账键不参与。 */
function keywordProxyText(attrs: Record<string, unknown>): string {
  const parts: string[] = [];
  const visit = (value: unknown, path: readonly string[]): void => {
    if (typeof value === 'string') {
      parts.push(value.toLowerCase());
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, path);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // `_` 前缀 = 记账值（_ts、_contact_parser、_contact_attempt_at …），不是公司事实。
      if (key.startsWith('_')) continue;
      if (path.length === 0 && (key === 'intent' || key.startsWith('extraction_'))) continue;
      if (path.length === 1 && path[0] === 'website_profile' && key === 'evidence') continue;
      visit(item, [...path, key]);
    }
  };
  visit(attrs, []);
  return parts.join('\n');
}

/** 指数衰减：半衰期 INTENT_HALFLIFE_DAYS。刚发生/未来(时钟偏移)→1；越旧越接近 0；
 *  **无有效/不可解析时间戳→0（不给分）**——防无日期或畸形信号盖过真实的陈旧信号 / 半掉一个概要分。 */
function recencyDecay(ageMs: number): number {
  if (!Number.isFinite(ageMs)) return 0;
  if (ageMs <= 0) return 1;
  return Math.pow(0.5, ageMs / DAY_MS / INTENT_HALFLIFE_DAYS);
}

/** [0,1] 夹取：评分/快照契约的系统边界共用（lead-qualified-snapshot.ts 复用）。 */
export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

const r4 = (n: number): number => Number(n.toFixed(4));
