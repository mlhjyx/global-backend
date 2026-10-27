/**
 * BI-20（交付闭环设计 §4）：失败/未达成原因码。
 *
 * 三组枚举，全部稳定、大写、可入 CSV 与事件：
 *  - 拒绝原因：运营 reject 与客户反馈共用；
 *  - 正向结果：客户认可（含人工 QGO）；
 *  - Fit 原因码：由确定性规则从 lead 的评分依据推出，不让模型自由命名。
 * 自由文本仍保留在 lead_decision.reason 与 fit_reasons 里给人看。
 */

export const REJECT_REASON_CODES = Object.freeze([
  'NOT_TARGET_ROLE',
  'WRONG_PRODUCT',
  'TOO_SMALL',
  'TOO_LARGE',
  'ALREADY_KNOWN',
  'NO_IMPORT_SIGNAL',
  'WRONG_COUNTRY',
  'BAD_CONTACT_PATH',
  'DUPLICATE',
  'OTHER',
] as const);
export type RejectReasonCode = (typeof REJECT_REASON_CODES)[number];

/** 正向结果：真实匹配（GOOD_FIT）与人工 QGO（WILL_FOLLOW_UP，设计 §6 的评测口径）。 */
export const POSITIVE_OUTCOME_CODES = Object.freeze(['GOOD_FIT', 'WILL_FOLLOW_UP'] as const);
export type PositiveOutcomeCode = (typeof POSITIVE_OUTCOME_CODES)[number];

/** 客户反馈与 accept 允许的完整原因码集合。 */
export const OUTCOME_REASON_CODES = Object.freeze([
  ...REJECT_REASON_CODES,
  ...POSITIVE_OUTCOME_CODES,
] as const);
export type OutcomeReasonCode = (typeof OUTCOME_REASON_CODES)[number];

const REJECT_SET: ReadonlySet<string> = new Set(REJECT_REASON_CODES);
const OUTCOME_SET: ReadonlySet<string> = new Set(OUTCOME_REASON_CODES);

function isMember(set: ReadonlySet<string>, value: unknown): boolean {
  return typeof value === 'string' && set.has(value);
}

export function isRejectReasonCode(value: unknown): value is RejectReasonCode {
  return isMember(REJECT_SET, value);
}

export function isOutcomeReasonCode(value: unknown): value is OutcomeReasonCode {
  return isMember(OUTCOME_SET, value);
}

export interface FitReasonCodeInput {
  /** lead.fitVerdict（资格门权威判定）：match | weak | mismatch | null。 */
  readonly fitVerdict?: unknown;
  /** lead.queue：sanctions_hold 时补 SANCTIONS_HOLD。 */
  readonly queue?: unknown;
  /** lead.scores：reachability === 0 时补 MISSING_CONTACT_POINT。 */
  readonly scores?: unknown;
  /** lead.scoreDetail：ruleEvaluations / missingFields / 评分阶段已写的 reasonCodes。 */
  readonly scoreDetail?: unknown;
}

const VERDICT_CODES: Readonly<Record<string, string>> = Object.freeze({
  match: 'FIT_MATCH',
  weak: 'FIT_WEAK',
  mismatch: 'FIT_MISMATCH',
});
const RULE_KINDS: ReadonlySet<string> = new Set(['MUST_HAVE', 'NICE_TO_HAVE', 'EXCLUSION']);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 字段名 → MISSING_<FIELD> 的稳定词元；空词元丢弃。 */
function fieldToken(value: unknown): string | null {
  const token = text(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  return token || null;
}

/**
 * 从一条 lead 的既有事实推出 Fit 原因码。顺序固定（verdict → 失败规则 → 缺字段 →
 * 可达性 → 制裁），同一码只出现一次，便于导出与比对。
 */
export function deriveFitReasonCodes(input: FitReasonCodeInput): readonly string[] {
  const codes: string[] = [];
  const verdictCode = Object.hasOwn(VERDICT_CODES, text(input.fitVerdict))
    ? VERDICT_CODES[text(input.fitVerdict)]!
    : null;
  if (verdictCode) codes.push(verdictCode);

  const detail = record(input.scoreDetail);
  for (const raw of array(detail?.ruleEvaluations)) {
    const evaluation = record(raw);
    if (!evaluation || evaluation.outcome !== 'fail' || evaluation.advisory === true) continue;
    const kind = text(evaluation.kind);
    if (RULE_KINDS.has(kind)) codes.push(`RULE_${kind}_FAIL`);
  }

  for (const field of array(detail?.missingFields)) {
    const token = fieldToken(field);
    if (token) codes.push(`MISSING_${token}`);
  }

  const scores = record(input.scores);
  if (scores?.reachability === 0) codes.push('MISSING_CONTACT_POINT');
  if (array(detail?.reasonCodes).includes('MISSING_CONTACT_POINT')) codes.push('MISSING_CONTACT_POINT');

  if (text(input.queue) === 'sanctions_hold') codes.push('SANCTIONS_HOLD');

  return Object.freeze([...new Set(codes)]);
}
