/**
 * `engage.reply_classify` 的确定性后置守卫（M2 步 13-1，设计 §4）。
 *
 * 模型输出只是建议；本守卫在落库/消费前强制三条安全规则：
 * ① 意图必须属于闭集 7 枚举（schema 之外再兜一层）。
 * ② 自动回复/外出通知文本不得被当成 POSITIVE（设计 §7 负向 4）。
 * ③ 置信度 < 0.6 一律 NEEDS_HUMAN，不得静默归类（决策 D-13-d / 负向 5）。
 *
 * 冲突时统一升级为 NEEDS_HUMAN（保守：宁可人工看，不在冲突信号上自动行动）。
 * 违例码是闭集，进 Golden Set 断言与事件轨迹。
 */

import { isReplyIntent, type ReplyIntent } from "../../ai-tasks/reply-intents";

export { REPLY_INTENTS, isReplyIntent, type ReplyIntent } from "../../ai-tasks/reply-intents";

export const REPLY_GUARD_VIOLATION_CODES = [
  "INVALID_INTENT",
  "AUTO_REPLY_CONFLICT",
  "LOW_CONFIDENCE_ESCALATED",
] as const;
export type ReplyGuardViolationCode = (typeof REPLY_GUARD_VIOLATION_CODES)[number];

/** 低置信阈值（设计 D-13-d）。 */
export const REPLY_CONFIDENCE_FLOOR = 0.6;

/** 自动回复/外出通知的文本特征（英/德/中，大小写不敏感）。 */
export const AUTO_REPLY_PATTERNS: readonly RegExp[] = [
  /out of (the )?office/iu,
  /automatic(ally)? (reply|response)/iu,
  /auto[\s-]?reply/iu,
  /abwesenheits?(notiz|meldung)?/iu,
  /automatische antwort/iu,
  /自动回复|不在办公室/iu,
];

export interface ReplyClassification {
  readonly intent: string;
  readonly confidence: number;
  readonly rationale: string;
  readonly matchedSignals: readonly string[];
}

export interface ReplyGuardViolation {
  readonly code: ReplyGuardViolationCode;
  readonly detail: string;
}

export interface ReplyGuardResult {
  readonly final: ReplyClassification;
  readonly violations: readonly ReplyGuardViolation[];
}

export function looksLikeAutoReply(replyText: string): boolean {
  return AUTO_REPLY_PATTERNS.some((pattern) => pattern.test(replyText));
}

/**
 * 对模型分类结果套用确定性守卫。`replyText` 是分类的输入原文（守卫只看它判定
 * 「自动回复」这一结构性事实，不重判意图）。
 *
 * 自动回复文本上的两类意图必须升级人工：POSITIVE（把 OOO 当兴趣）与 UNSUBSCRIBE
 * （OOO 套话常带「回复 STOP 退订」，自动退订会在无人复核下压制真实联系人）
 * ——两者都记 AUTO_REPLY_CONFLICT。
 */
export function guardReplyClassification(
  classification: ReplyClassification,
  replyText: string,
): ReplyGuardResult {
  const violations: ReplyGuardViolation[] = [];
  if (!isReplyIntent(classification.intent)) {
    violations.push({
      code: "INVALID_INTENT",
      detail: `intent ${classification.intent} is outside the closed set`,
    });
  } else if (
    (classification.intent === "POSITIVE" || classification.intent === "UNSUBSCRIBE") &&
    looksLikeAutoReply(replyText)
  ) {
    violations.push({
      code: "AUTO_REPLY_CONFLICT",
      detail: `reply text carries auto-reply/out-of-office markers but was classified ${classification.intent}`,
    });
  }
  if (
    Number.isFinite(classification.confidence) &&
    classification.confidence < REPLY_CONFIDENCE_FLOOR &&
    classification.intent !== "NEEDS_HUMAN"
  ) {
    violations.push({
      code: "LOW_CONFIDENCE_ESCALATED",
      detail: `confidence ${classification.confidence} < ${REPLY_CONFIDENCE_FLOOR}; escalating to NEEDS_HUMAN`,
    });
  }
  if (violations.length === 0) {
    return { final: classification, violations };
  }
  return { final: { ...classification, intent: "NEEDS_HUMAN" }, violations };
}

export function replyGuardViolationCodes(result: ReplyGuardResult): string[] {
  return result.violations.map((violation) => violation.code);
}
