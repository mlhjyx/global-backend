/**
 * 判定校准数学（P3 J14；设计 §4.3.6）。
 *
 * 报告纪律（§4.3.6.2）：任何 precision/recall 必须带 n 与 95% CI（Wilson）；
 * kappa 必须与混淆矩阵同时出现；Rogan–Gladen 把观测 pass rate 校正为真实匹配率。
 * 本模块全部是纯函数；bootstrap 用显式种子的确定性 PRNG（同输入同输出，报告可复算）。
 */

export interface LabeledVerdict {
  /** 金标：这条判定真正的答案。 */
  actual: 'FIT' | 'NOT_FIT';
  /** 系统判定（FIT / NOT_FIT / UNKNOWN；UNKNOWN 在严格口径下计为「未自动通过」）。 */
  predicted: 'FIT' | 'NOT_FIT' | 'UNKNOWN';
}

export interface ConfusionMatrix {
  fn: number;
  fp: number;
  /** 金标 FIT 且判 FIT。 */
  tn: number;
  /** 金标 NOT_FIT 且判 NOT_FIT。 */
  tp: number;
}

/**
 * 混淆矩阵口径（以「目标客户 = 阳性」）：
 *  tp = actual FIT & predicted FIT（真阳性）；fp = actual NOT_FIT & predicted FIT；
 *  fn = actual FIT & predicted 非 FIT（含 UNKNOWN）；tn = actual NOT_FIT & predicted 非 FIT。
 */
export function confusionMatrix(rows: readonly LabeledVerdict[]): ConfusionMatrix {
  const matrix: ConfusionMatrix = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (const row of rows) {
    const predictedFit = row.predicted === 'FIT';
    if (row.actual === 'FIT') {
      if (predictedFit) matrix.tp += 1;
      else matrix.fn += 1;
    } else if (predictedFit) matrix.fp += 1;
    else matrix.tn += 1;
  }
  return matrix;
}

/** Wilson 95% 区间（默认 z=1.96）；n=0 时返回 [0,1]（不假装有信息）。 */
export function wilsonInterval(
  successes: number,
  n: number,
  z = 1.96,
): [number, number] {
  if (n === 0) return [0, 1];
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

export interface RateWithCI {
  ci: [number, number];
  n: number;
  value: number;
}

export interface CalibrationRates {
  fnr: RateWithCI; // 1 - TPR
  kappa: number;
  matrix: ConfusionMatrix;
  npv: RateWithCI;
  ppv: RateWithCI;
  tnr: RateWithCI; // specificity
  tpr: RateWithCI; // recall / sensitivity
}

function rate(successes: number, n: number): RateWithCI {
  return { value: n === 0 ? 0 : successes / n, n, ci: wilsonInterval(successes, n) };
}

/** Cohen's kappa（二元；po−pe / 1−pe）。1−pe=0 时返回 1（完全由边际决定的一致性）。 */
export function cohenKappa(matrix: ConfusionMatrix): number {
  const n = matrix.tp + matrix.fp + matrix.tn + matrix.fn;
  if (n === 0) return 0;
  const po = (matrix.tp + matrix.tn) / n;
  const pActualFit = (matrix.tp + matrix.fn) / n;
  const pPredictedFit = (matrix.tp + matrix.fp) / n;
  const pe = pActualFit * pPredictedFit + (1 - pActualFit) * (1 - pPredictedFit);
  if (Math.abs(1 - pe) < 1e-12) return 1;
  return (po - pe) / (1 - pe);
}

/**
 * Rogan–Gladen 校正（§4.3.6.3）：
 *   π̂ = (p_obs + TNR − 1) / (TPR + TNR − 1)；PPV = π̂·TPR / (π̂·TPR + (1−π̂)(1−TNR))
 * TPR+TNR ≤ 1（分类器不优于随机）时返回 null——此时校正无意义，必须重校准。
 */
export function roganGladen(
  observedPassRate: number,
  tpr: number,
  tnr: number,
): { ppv: number | null; prevalence: number | null } {
  const denom = tpr + tnr - 1;
  if (denom <= 1e-12) return { prevalence: null, ppv: null };
  const prevalence = (observedPassRate + tnr - 1) / denom;
  if (prevalence < 0 || prevalence > 1) {
    // 校正值越界 = 校准集与生产分布不一致（设计明确要求的信号）。
    return { prevalence, ppv: null };
  }
  const ppvDenom = prevalence * tpr + (1 - prevalence) * (1 - tnr);
  const ppv = ppvDenom === 0 ? null : (prevalence * tpr) / ppvDenom;
  return { prevalence, ppv };
}

/** 确定性 PRNG（mulberry32）：bootstrap 可复算，报告同输入同数字。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 分层 bootstrap 的百分位 CI（默认 B=1000，种子固定）。stat 接收重采样后的行。 */
export function bootstrapPercentileCI(
  rows: readonly LabeledVerdict[],
  stat: (sample: readonly LabeledVerdict[]) => number,
  options: { b?: number; seed?: number; alpha?: number } = {},
): [number, number] {
  const b = options.b ?? 1000;
  const seed = options.seed ?? 20261109;
  const alpha = options.alpha ?? 0.05;
  if (rows.length === 0) return [Number.NaN, Number.NaN];
  const random = mulberry32(seed);
  const values: number[] = [];
  for (let i = 0; i < b; i += 1) {
    const sample: LabeledVerdict[] = [];
    for (let j = 0; j < rows.length; j += 1) {
      sample.push(rows[Math.floor(random() * rows.length)]!);
    }
    values.push(stat(sample));
  }
  values.sort((a, bValue) => a - bValue);
  const loIndex = Math.floor((alpha / 2) * (values.length - 1));
  const hiIndex = Math.ceil((1 - alpha / 2) * (values.length - 1));
  return [values[loIndex]!, values[hiIndex]!];
}

/** 汇总一次校准评估（矩阵/TPR/TNR/PPV/NPV/FNR/kappa，均带 Wilson CI）。 */
export function evaluateCalibration(rows: readonly LabeledVerdict[]): CalibrationRates {
  const matrix = confusionMatrix(rows);
  const positives = matrix.tp + matrix.fn;
  const negatives = matrix.tn + matrix.fp;
  const predictedFit = matrix.tp + matrix.fp;
  const predictedNotFit = matrix.tn + matrix.fn;
  const tpr = rate(matrix.tp, positives);
  return {
    matrix,
    tpr,
    tnr: rate(matrix.tn, negatives),
    ppv: rate(matrix.tp, predictedFit),
    npv: rate(matrix.tn, predictedNotFit),
    fnr: rate(matrix.fn, positives),
    kappa: cohenKappa(matrix),
  };
}
