/**
 * precision@k（获客 vNext W3）：评估集标注 × 某次 run/某源产出的候选排名。
 *
 * 口径（与 golden set 报告一并写进 PR）：
 *   - 候选按「判定分数」降序排名（排序在 SQL 层完成；本模块只消费已排好的
 *     label 序列，保持纯函数、可单测）；
 *   - 分母 = 实际评估深度 min(k, 候选数)——候选不足 k 条时按实际条数算，
 *     不用 k 硬凑，避免小 run 的 precision 被系统性压低；
 *   - 未标注的候选计入分母、记为「非命中」（保守口径，等价于把未标注当作
 *     未被证明的正例）；同时单列 precisionAtLabeledK（只在已标注者上算），
 *     让「标注覆盖率」与「纯度」两个问题分开可读，不互相掩盖。
 */

export type EvaluationLabelValue = "POSITIVE" | "NEGATIVE";

export interface PrecisionAtK {
  readonly k: number;
  /** 实际评估深度 min(k, 候选数)。 */
  readonly evaluated: number;
  readonly hits: number;
  readonly negatives: number;
  readonly unlabeled: number;
  /** hits / evaluated；evaluated=0 时为 null（没有候选就没有 precision，不写 0）。 */
  readonly precisionAtK: number | null;
  /** hits / 已标注数；已标注数=0 时为 null。 */
  readonly precisionAtLabeledK: number | null;
}

export function precisionAtK(
  labels: ReadonlyArray<EvaluationLabelValue | null>,
  k: number,
): PrecisionAtK {
  if (!Number.isInteger(k) || k < 1) {
    throw new Error(`precisionAtK: k must be a positive integer (got ${k})`);
  }
  const evaluated = Math.min(k, labels.length);
  let hits = 0;
  let negatives = 0;
  let unlabeled = 0;
  for (const label of labels.slice(0, evaluated)) {
    if (label === "POSITIVE") hits += 1;
    else if (label === "NEGATIVE") negatives += 1;
    else unlabeled += 1;
  }
  const labeledCount = hits + negatives;
  return {
    k,
    evaluated,
    hits,
    negatives,
    unlabeled,
    precisionAtK: evaluated === 0 ? null : hits / evaluated,
    precisionAtLabeledK: labeledCount === 0 ? null : hits / labeledCount,
  };
}
