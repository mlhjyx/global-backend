/**
 * 确定性聚合器（P3 J10；设计 §4.3.3.4 R0–R4）。
 *
 * 模型只产出 criterion 级判断与 `verdict_proposed`（仅诊断，**不生效**）；
 * 最终 verdict 只由本文件的纯函数按固定顺序计算：
 *
 *   R0 反注入：证据命中页面内嵌指令 → 该 criterion 强制 unclear
 *   R1 硬失败：C1/C2 ≤2 且证据有效 → NOT_FIT（不被加权分救回）
 *   R2 证据门：任何 applicable criterion unclear / 无有效证据 → UNKNOWN
 *   R3 加权分：仅 applicable 项，权重按适用集重新归一
 *   R4 判定：≥7.0 且全部 applicable ≥5 → FIT；≤3.5 → NOT_FIT；其余 UNKNOWN
 *
 * R5（conformal）不在此文件：它在 R4 之上做接受/弃权，属 L4 的独立工件。
 * 本函数确定性：同输入永远同输出，不读时钟、不读环境、不调模型。
 */

import {
  CRITERION_IDS,
  RUBRIC_AGGREGATION,
  RUBRIC_CRITERIA,
  type CriterionId,
} from './fit-rubric';
import type { EvidenceValidationReport } from './evidence-validate';
import type { JudgeOutputV2 } from './judge-output-v2';

export const AGGREGATION_VERSION = 'judge-aggregate/v1' as const;

export const JUDGMENT_VERDICTS = ['FIT', 'NOT_FIT', 'UNKNOWN'] as const;
export type JudgmentVerdict = (typeof JUDGMENT_VERDICTS)[number];

/** 聚合器的稳定 reason 闭集（报表与校准按此分组）。 */
export const JUDGMENT_REASON_CODES = [
  'FIT_ACCEPTED',
  'HARD_FAIL',
  'WEIGHTED_NOT_FIT',
  'EVIDENCE_GATE_UNKNOWN',
  'BORDERLINE_UNKNOWN',
  'SCORE_MISSING',
  'NO_APPLICABLE_CRITERIA',
  'PROMPT_INJECTION_DETECTED',
] as const;
export type JudgmentReasonCode = (typeof JUDGMENT_REASON_CODES)[number];

/** R4 阈值来自 rubric 常量，禁止在代码里再写一份数字。 */
const FIT_MIN_WEIGHTED = 7.0;
const NOT_FIT_MAX_WEIGHTED = 3.5;
const FIT_MIN_CRITERION_SCORE = 5;
const HARD_FAIL_MAX_SCORE = 2;
const HARD_FAIL_CRITERIA: readonly CriterionId[] = ['C1_MATERIAL', 'C2_ROLE'];

export interface AggregateJudgmentInput {
  evidence: EvidenceValidationReport;
  output: JudgeOutputV2;
}

export interface CriterionAggregation {
  applicable: boolean;
  /** R0/R2 之后的生效 label（不覆盖模型原始输出，仅聚合视角）。 */
  effectiveLabel: 'fail' | 'not_applicable' | 'pass' | 'unclear' | 'weak';
  flags: string[];
  hardFail: boolean;
  id: CriterionId;
  score: null | number;
  /** 归一化后的权重（不适用或未参与计算为 null）。 */
  weight: null | number;
}

export interface AggregationResult {
  criteria: CriterionAggregation[];
  gates: {
    evidenceGate: boolean;
    hardFail: boolean;
    injection: CriterionId[];
  };
  reasonCodes: JudgmentReasonCode[];
  scoreWeighted: null | number;
  verdict: JudgmentVerdict;
  version: typeof AGGREGATION_VERSION;
}

function weightFor(id: CriterionId): number {
  const definition = RUBRIC_CRITERIA.find((item) => item.id === id);
  if (!definition) {
    throw new Error(`judge-aggregate: no rubric weight for ${id}`);
  }
  return definition.weight;
}

function pushReason(
  reasons: JudgmentReasonCode[],
  code: JudgmentReasonCode,
): void {
  if (!reasons.includes(code)) reasons.push(code);
}

/**
 * R0–R4 聚合。调用方必须先用 `validateJudgeOutputV2` 校验结构、用
 * `validateEvidence` 校验证据；本函数对缺失/重复 criterion 直接抛错（编程错误，
 * 不允许静默降级）。
 */
export function aggregateJudgment(
  input: AggregateJudgmentInput,
): AggregationResult {
  const { output, evidence } = input;

  if (output.criteria.length !== CRITERION_IDS.length) {
    throw new Error(
      `judge-aggregate: expected ${CRITERION_IDS.length} criteria, got ${output.criteria.length}`,
    );
  }
  const byId = new Map<CriterionId, JudgeOutputV2['criteria'][number]>();
  for (const criterion of output.criteria) {
    if (byId.has(criterion.id)) {
      throw new Error(`judge-aggregate: duplicate criterion ${criterion.id}`);
    }
    byId.set(criterion.id, criterion);
  }
  for (const id of CRITERION_IDS) {
    if (!byId.has(id)) {
      throw new Error(`judge-aggregate: missing criterion ${id}`);
    }
  }

  const reasons: JudgmentReasonCode[] = [];
  const injection: CriterionId[] = [];
  const criteria: CriterionAggregation[] = [];
  let evidenceGate = false;
  let hardFail = false;

  // R0 + R2 归一化：把注入与证据缺失折算成 effectiveLabel。
  for (const id of CRITERION_IDS) {
    const criterion = byId.get(id)!;
    const validation = evidence.byCriterion[id];
    if (!validation) {
      throw new Error(`judge-aggregate: evidence report missing ${id}`);
    }
    const applicable = criterion.applicable;
    let effectiveLabel = criterion.label;

    if (!applicable) {
      effectiveLabel = 'not_applicable';
    } else if (validation.injectionDetected) {
      // R0：证据命中了页面内嵌指令 → 该 criterion 不可信。
      effectiveLabel = 'unclear';
      injection.push(id);
      pushReason(reasons, 'PROMPT_INJECTION_DETECTED');
    } else if (effectiveLabel !== 'unclear' && !validation.hasValidEvidence) {
      // R2 前置：applicable 且声称可判，却没有任何有效证据。
      effectiveLabel = 'unclear';
    }

    const criterionHardFail =
      applicable &&
      effectiveLabel !== 'unclear' &&
      effectiveLabel !== 'not_applicable' &&
      validation.hasValidEvidence &&
      criterion.score !== null &&
      criterion.score <= HARD_FAIL_MAX_SCORE &&
      HARD_FAIL_CRITERIA.includes(id);
    if (criterionHardFail) hardFail = true;

    criteria.push({
      id,
      applicable,
      effectiveLabel,
      score: criterion.score,
      weight: null,
      flags: [...validation.flags],
      hardFail: criterionHardFail,
    });
  }

  // R1 先于 R2：竞品硬失败不被证据缺口或高加权分救回。
  if (hardFail) {
    pushReason(reasons, 'HARD_FAIL');
    return {
      version: AGGREGATION_VERSION,
      verdict: 'NOT_FIT',
      scoreWeighted: null,
      gates: { hardFail, evidenceGate: false, injection },
      reasonCodes: reasons,
      criteria,
    };
  }

  // R2 证据门：任何 applicable criterion unclear（含无有效证据）→ UNKNOWN。
  for (const criterion of criteria) {
    if (criterion.applicable && criterion.effectiveLabel === 'unclear') {
      evidenceGate = true;
    }
  }
  if (evidenceGate) {
    pushReason(reasons, 'EVIDENCE_GATE_UNKNOWN');
    return {
      version: AGGREGATION_VERSION,
      verdict: 'UNKNOWN',
      scoreWeighted: null,
      gates: { hardFail: false, evidenceGate, injection },
      reasonCodes: reasons,
      criteria,
    };
  }

  // R3 加权分：只在 applicable 上重新归一。
  const applicable = criteria.filter((criterion) => criterion.applicable);
  if (applicable.length === 0) {
    pushReason(reasons, 'NO_APPLICABLE_CRITERIA');
    return {
      version: AGGREGATION_VERSION,
      verdict: 'UNKNOWN',
      scoreWeighted: null,
      gates: { hardFail: false, evidenceGate: false, injection },
      reasonCodes: reasons,
      criteria,
    };
  }
  if (applicable.some((criterion) => criterion.score === null)) {
    pushReason(reasons, 'SCORE_MISSING');
    return {
      version: AGGREGATION_VERSION,
      verdict: 'UNKNOWN',
      scoreWeighted: null,
      gates: { hardFail: false, evidenceGate: false, injection },
      reasonCodes: reasons,
      criteria,
    };
  }

  const totalWeight = applicable.reduce(
    (sum, criterion) => sum + weightFor(criterion.id),
    0,
  );
  let weighted = 0;
  for (const criterion of applicable) {
    const weight = weightFor(criterion.id) / totalWeight;
    criterion.weight = weight;
    weighted += criterion.score! * weight;
  }

  // R4 判定。
  let verdict: JudgmentVerdict;
  if (
    weighted >= FIT_MIN_WEIGHTED &&
    applicable.every((criterion) => (criterion.score ?? 0) >= FIT_MIN_CRITERION_SCORE)
  ) {
    verdict = 'FIT';
    pushReason(reasons, 'FIT_ACCEPTED');
  } else if (weighted <= NOT_FIT_MAX_WEIGHTED) {
    verdict = 'NOT_FIT';
    pushReason(reasons, 'WEIGHTED_NOT_FIT');
  } else {
    verdict = 'UNKNOWN';
    pushReason(reasons, 'BORDERLINE_UNKNOWN');
  }

  return {
    version: AGGREGATION_VERSION,
    verdict,
    scoreWeighted: weighted,
    gates: { hardFail: false, evidenceGate: false, injection },
    reasonCodes: reasons,
    criteria,
  };
}

/**
 * 设计 §4.3.3.4 的金标边界断言（值来自 RUBRIC_AGGREGATION 常量）：
 * 任何对该常量的修改都应先与设计对齐，再改这里。
 */
export function aggregationRulesSnapshot(): typeof RUBRIC_AGGREGATION & {
  fitMinWeighted: number;
  notFitMaxWeighted: number;
  hardFailCriteria: readonly CriterionId[];
  hardFailMaxScore: number;
} {
  return {
    ...RUBRIC_AGGREGATION,
    fitMinWeighted: FIT_MIN_WEIGHTED,
    notFitMaxWeighted: NOT_FIT_MAX_WEIGHTED,
    hardFailCriteria: HARD_FAIL_CRITERIA,
    hardFailMaxScore: HARD_FAIL_MAX_SCORE,
  };
}
