/**
 * 权威 Fit 细粒度打分与可达性/完整度辅助函数（从 `scoring.ts` 抽出，保持 `scoreLead` 圈复杂度在 G9 预算内）。
 *
 * 解决现网评分倒挂的两个根因：
 *  1) 历史 `AUTHORITATIVE_FIT_SCORE` 把所有 `weak` 一刀切为 `0.45`，导致 `C1=8,C2=10,C4=10` 的真买家与全 `unclear`/无关行业同分；
 *  2) `company_contact_channel`（电话/职能邮箱/表单）未计入可达性，且已做过官网画像（`website_profile.trade_role`）的真实买家因缺 `industry` 字段在 `dataQuality` 上反输给维基数据无关公司。
 */
import { REACHABLE_COMPANY_CONTACT_KINDS } from './scoring';

const REACHABLE_STATUSES = new Set(['VALID', 'UNVERIFIED']);
const REACHABLE_CHANNEL_KINDS = new Set(['email', 'phone', 'form_url']);

interface ParsedCriterion {
  label: 'pass' | 'weak' | 'fail' | 'unclear' | 'not_applicable';
  score: number | null;
}

const CRITERION_LINE_RE =
  /^(pass|weak|fail|unclear|not_applicable)\s*[（(]\s*score\s+([0-9]+(?:\.[0-9]+)?|—|-)\s*[）)]/iu;
const WEIGHTED_SCORE_RE = /加权分\s*=\s*([0-9]+(?:\.[0-9]+)?)/u;

function parseCriterionText(raw: unknown): ParsedCriterion | null {
  if (typeof raw !== 'string') return null;
  const match = CRITERION_LINE_RE.exec(raw.trim());
  if (!match) return null;
  const label = match[1]!.toLowerCase() as ParsedCriterion['label'];
  const scoreToken = match[2]!;
  const score = /^[0-9]+(?:\.[0-9]+)?$/u.test(scoreToken) ? Number(scoreToken) : null;
  return { label, score: score !== null && Number.isFinite(score) ? score : null };
}

function parseWeightedScore(reasons: unknown): number | null {
  if (!Array.isArray(reasons)) return null;
  for (const line of reasons) {
    if (typeof line !== 'string') continue;
    const match = WEIGHTED_SCORE_RE.exec(line);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value >= 0 && value <= 10) return value;
  }
  return null;
}

function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n;
}

/**
 * 根据 L2 `fit_reasons` 中的分项得分计算细粒度权威 Fit（[0, 1]）。
 * 若无 v2 分项分（例如旧 v1 数据或调用方未传 `fitReasons`），返回 `null` 回退静态映射，保证既有单测零破坏。
 */
export function deriveAuthoritativeFitScore(
  verdict: 'match' | 'weak' | 'mismatch',
  fitReasons: unknown,
): number | null {
  if (verdict === 'mismatch') return 0;
  if (!fitReasons || typeof fitReasons !== 'object' || Array.isArray(fitReasons)) return null;
  const rec = fitReasons as Record<string, unknown>;
  const c1 = parseCriterionText(rec.material);
  const c2 = parseCriterionText(rec.role);
  const c3 = parseCriterionText(rec.process);
  const c4 = parseCriterionText(rec.business_model);
  const weighted = parseWeightedScore(rec.reasons);

  const parsed = [c1, c2, c3, c4].filter((item): item is ParsedCriterion => item !== null);
  if (parsed.length === 0 && weighted === null) return null;

  const numericScores = parsed
    .map((item) => item.score)
    .filter((score): score is number => score !== null);
  const avgScore =
    weighted ??
    (numericScores.length > 0
      ? numericScores.reduce((sum, score) => sum + score, 0) / numericScores.length
      : null);

  if (verdict === 'match') {
    if (avgScore === null) return 0.85;
    // 6..10 线性映射到 0.85..0.98，让 C1-C4 高分真实买家明显高于边缘 match
    const normalized = clamp((avgScore - 6) / 4, 0, 1);
    return Number((0.85 + 0.13 * normalized).toFixed(4));
  }

  // verdict === 'weak'：严格拉开「被证据门/佐证门卡住的真买家」与「无关行业/信息空白垃圾」的分差
  const coreFailed =
    c1?.label === 'fail' ||
    c2?.label === 'fail' ||
    (c1?.score !== null && c1 !== null && c1.score <= 3) ||
    (c2?.score !== null && c2 !== null && c2.score <= 3);
  if (coreFailed) return 0.15;

  if (avgScore === null) return 0.25; // 全 unclear（无有效正向分项）

  const anyFail = parsed.some((item) => item.label === 'fail');
  const strongCorePass =
    !anyFail &&
    (((c1?.score ?? 0) >= 7 && (c2?.score ?? 0) >= 7) ||
      (c1?.score ?? 0) >= 8 ||
      (c2?.score ?? 0) >= 8);
  if (strongCorePass) {
    const ratio = clamp((avgScore - 6) / 4, 0, 1);
    return Number((0.55 + 0.17 * ratio).toFixed(4));
  }

  const ratio = clamp(avgScore / 10, 0, 1);
  return Number((0.3 + 0.2 * ratio).toFixed(4));
}

export const AUTHORITATIVE_FIT_FALLBACK: Readonly<Record<'match' | 'weak' | 'mismatch', number>> = Object.freeze({
  match: 0.85,
  weak: 0.45,
  mismatch: 0,
});

/** 综合权威资格门（含 v2 分项分）与规则引擎结果计算 Fit 维原始值。 */
export function resolveFitDimension(
  authoritative: 'match' | 'weak' | 'mismatch' | null,
  fitReasons: unknown,
  fitResult: { verdict: string; score: number | null },
): number {
  if (authoritative) {
    return deriveAuthoritativeFitScore(authoritative, fitReasons) ?? AUTHORITATIVE_FIT_FALLBACK[authoritative];
  }
  if (fitResult.verdict === 'match') return 0.6 + 0.4 * (fitResult.score ?? 0.5);
  if (fitResult.verdict === 'review') return 0.3 + 0.3 * (fitResult.score ?? 0);
  return 0;
}

/**
 * 官网画像已产出有效 `trade_role` 时，视为行业/角色字段已补全，
 * 避免真实中小光伏商因原始记录缺少 `industry` 列在 DataQuality 上输给维基数据无关公司。
 */
export function effectiveIndustryForDataQuality(
  industry: string | null,
  attrs: Record<string, unknown>,
): string | null {
  if (industry) return industry;
  const profile = attrs.website_profile;
  if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
    const tradeRole = (profile as Record<string, unknown>).trade_role;
    if (typeof tradeRole === 'string' && tradeRole.trim().length > 0 && tradeRole.trim() !== 'unknown') {
      return tradeRole.trim();
    }
  }
  return null;
}

/**
 * 公司级可达性：同时认可 `company_contact_point`（联系页/表单/Impressum/供应商页）与
 * `company_contact_channel`（职能邮箱/总机电话/表单 URL），剔除 INVALID。
 */
export function hasReachableCompanyChannel(
  points: ReadonlyArray<{ kind: string; status: string }>,
  channels?: ReadonlyArray<{ channel: string; status: string }>,
): boolean {
  if (
    points.some(
      (p) => REACHABLE_COMPANY_CONTACT_KINDS.has(p.kind) && REACHABLE_STATUSES.has(p.status),
    )
  ) {
    return true;
  }
  if (!channels?.length) return false;
  return channels.some(
    (c) => REACHABLE_CHANNEL_KINDS.has(c.channel) && REACHABLE_STATUSES.has(c.status),
  );
}
