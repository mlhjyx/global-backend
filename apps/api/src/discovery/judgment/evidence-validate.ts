/**
 * 判定证据校验（P3 J10；设计 §4.3.3.5 证据字段规则、§4.3.3.4 R0/R2）。
 *
 * 规则（fail-closed，全部确定性、零模型调用）：
 * 1. `evidence[].url` 必须通过注入的域白名单/source_policy 门；未通过 → 该条无效。
 * 2. `span` 必须逐字出现在本次输入快照（去空白子串匹配）；找不到 → 该条无效。
 * 3. `kind=website/impressum` 的证据超过 `EVIDENCE_MAX_AGE_DAYS` 天 → 该条按
 *    stale 失效（criterion 只剩 stale 证据时降为 unclear）。
 * 4. 无有效证据的 applicable criterion 由聚合器记 `NO_EVIDENCE` 并走 R2 → UNKNOWN。
 * 5. span 命中页面内嵌指令模式 → criterion 记 `PROMPT_INJECTION_DETECTED`，
 *    聚合器按 R0 强制 unclear。
 */

import {
  CRITERION_IDS,
  type CriterionId,
} from './fit-rubric';
import type {
  JudgeCriterionOutput,
  JudgeEvidenceItem,
} from './judge-output-v2';

export const EVIDENCE_VALIDATION_VERSION = 'evidence-validate/v1' as const;

export const EVIDENCE_MAX_AGE_DAYS = 30;

/** 只有网页类证据有「新鲜度」语义；注册库/目录证据不过期（本身是静态登记）。 */
export const EVIDENCE_KINDS_REQUIRING_FRESHNESS = [
  'website',
  'impressum',
] as const;

export type EvidenceFlag =
  | 'EVIDENCE_URL_DENIED'
  | 'EVIDENCE_SPAN_NOT_FOUND'
  | 'EVIDENCE_STALE'
  | 'EVIDENCE_FETCH_TIME_INVALID'
  | 'PROMPT_INJECTION_DETECTED';

/**
 * 页面内嵌指令的检测模式（不可信输入里出现的「指令」一律当数据）。
 * 版本化在这里而不是 prompt 里：新增模式会改变判定行为，必须经评审。
 */
export const INJECTION_PATTERNS: readonly RegExp[] = Object.freeze([
  /ignore\s+(all\s+)?(the\s+)?(previous|prior|above)\s+instructions?/iu,
  /disregard\s+(all\s+)?(the\s+)?(previous|prior|above)/iu,
  /system\s+prompt/iu,
  /you\s+are\s+now\s+(a|an|the)\b/iu,
  /忽略(上述|以上|之前|前面|先前)?(的)?(所有)?(指令|提示|要求|规则)/u,
  /新的(系统)?(指令|提示词)/u,
  /不要(再)?(遵循|遵守|理会)(上述|以上|之前|前面)/u,
  /作为(一个)?\s*(ai|人工智能)/iu,
]);

export interface EvidenceUrlPolicyResult {
  allowed: boolean;
  reason?: string;
}

/** 由调用方注入（复用 source_policy / 域白名单出网门）；缺省视为拒绝。 */
export type EvidenceUrlPolicy = (url: string) => EvidenceUrlPolicyResult;

export interface EvidenceValidationContext {
  /** 本次判定的「现在」（ISO 8601），用于 30 天新鲜度计算。 */
  now: string;
  /** 本次输入快照的抓取时间（ISO 8601），证据缺 fetched_at 时的兜底。 */
  snapshotFetchedAt: string;
  /** 本次输入快照正文（website_profile/抓取文本拼接）；span 必须逐字来自这里。 */
  snapshotText: string;
  urlPolicy: EvidenceUrlPolicy;
}

export interface CriterionEvidenceValidation {
  flags: EvidenceFlag[];
  hasValidEvidence: boolean;
  id: CriterionId;
  /** 命中页面内嵌指令（R0 信号；聚合器据此强制 unclear）。 */
  injectionDetected: boolean;
  validEvidence: JudgeEvidenceItem[];
}

export interface EvidenceValidationReport {
  byCriterion: Record<CriterionId, CriterionEvidenceValidation>;
  version: typeof EVIDENCE_VALIDATION_VERSION;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, '');
}

function parseIsoInstant(value: string): number | null {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function containsInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

function validateItem(
  item: JudgeEvidenceItem,
  context: EvidenceValidationContext,
  normalizedSnapshot: string,
  nowMs: number,
  snapshotMs: number | null,
): { flags: EvidenceFlag[]; valid: boolean } {
  const flags: EvidenceFlag[] = [];

  if (!context.urlPolicy(item.url).allowed) {
    flags.push('EVIDENCE_URL_DENIED');
  }
  if (!normalizedSnapshot.includes(normalizeWhitespace(item.span))) {
    flags.push('EVIDENCE_SPAN_NOT_FOUND');
  }
  if (containsInjection(item.span)) {
    flags.push('PROMPT_INJECTION_DETECTED');
  }

  if (
    (EVIDENCE_KINDS_REQUIRING_FRESHNESS as readonly string[]).includes(
      item.kind,
    )
  ) {
    const fetchedMs =
      item.fetched_at === undefined ? snapshotMs : parseIsoInstant(item.fetched_at);
    if (fetchedMs === null) {
      // 有 fetched_at 但不是合法时间：不能证明新鲜 → fail-closed。
      flags.push('EVIDENCE_FETCH_TIME_INVALID');
    } else if (nowMs - fetchedMs > EVIDENCE_MAX_AGE_DAYS * DAY_MS) {
      flags.push('EVIDENCE_STALE');
    }
  }

  const valid =
    !flags.includes('EVIDENCE_URL_DENIED') &&
    !flags.includes('EVIDENCE_SPAN_NOT_FOUND') &&
    !flags.includes('EVIDENCE_STALE') &&
    !flags.includes('EVIDENCE_FETCH_TIME_INVALID');
  return { flags, valid };
}

/**
 * 校验一份 judge 输出的全部证据，返回按 criterion 的汇总。
 * 纯函数：同一 (output, context) 永远得到同一报告。
 */
export function validateEvidence(
  criteria: readonly JudgeCriterionOutput[],
  context: EvidenceValidationContext,
): EvidenceValidationReport {
  const nowMs = parseIsoInstant(context.now);
  if (nowMs === null) {
    throw new Error(`evidence-validate: invalid now "${context.now}"`);
  }
  const snapshotMs = parseIsoInstant(context.snapshotFetchedAt);
  if (snapshotMs === null) {
    throw new Error(
      `evidence-validate: invalid snapshotFetchedAt "${context.snapshotFetchedAt}"`,
    );
  }
  const normalizedSnapshot = normalizeWhitespace(context.snapshotText);

  const byCriterion = {} as Record<CriterionId, CriterionEvidenceValidation>;
  for (const id of CRITERION_IDS) {
    const criterion = criteria.find((item) => item.id === id);
    if (!criterion) {
      // schema 校验在聚合前完成；到这里说明调用方跳过了校验，直接失败。
      throw new Error(`evidence-validate: missing criterion ${id}`);
    }
    const flags: EvidenceFlag[] = [];
    const validEvidence: JudgeEvidenceItem[] = [];
    for (const item of criterion.evidence) {
      const result = validateItem(item, context, normalizedSnapshot, nowMs, snapshotMs);
      for (const flag of result.flags) {
        if (!flags.includes(flag)) flags.push(flag);
      }
      if (result.valid) validEvidence.push(item);
    }
    byCriterion[id] = {
      id,
      flags,
      validEvidence,
      hasValidEvidence: validEvidence.length > 0,
      injectionDetected: flags.includes('PROMPT_INJECTION_DETECTED'),
    };
  }

  return { version: EVIDENCE_VALIDATION_VERSION, byCriterion };
}
