/**
 * Conformal 弃权数学（P3 J15；设计 §4.3.7）。
 *
 * 目标：给「自动 FIT」一个带统计意义的错误率上界——阈值 τ 由 calib 金标拟合，
 * 使接受集 A(τ) = { s_i ≤ τ } 里 NOT_FIT 的比例在置信水平 1−δ 下的
 * Clopper–Pearson 单侧上界 ≤ α，取满足条件的最大 τ（接受最多）；不存在则全弃权。
 *
 * 本模块是纯函数（无 I/O、无时钟）：Clopper–Pearson 上界用正则不完全 Beta
 * 分位数的反函数实现（二分 + Lentz 连分式），不引第三方统计库。
 * 运行时（L4）接线与阈值工件落库（conformal_threshold 表）属后续卡；
 * 本文件只回答「给定样本与 α/δ，阈值是多少、这条分数要不要弃权」。
 */

/** k 次自洽采样的 FIT 票占比 → 非 conformity 分数 s = 1 − p̄（§4.3.7.2）。 */
export function conformalScore(fitVotes: number, k: number): number {
  if (!Number.isInteger(k) || k < 1) {
    throw new Error(`conformalScore: k must be a positive integer (got ${k})`);
  }
  if (!Number.isInteger(fitVotes) || fitVotes < 0 || fitVotes > k) {
    throw new Error(
      `conformalScore: fitVotes must be an integer in [0, ${k}] (got ${fitVotes})`,
    );
  }
  return 1 - fitVotes / k;
}

/** 连分式（Lentz）计算正则不完全 Beta I_x(a,b)。数值稳定版（NR §6.4）。 */
function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnBeta =
    lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  if (Math.abs(lnBeta) > 700) {
    // 极端参数下退化为单调二分近似（仍保证边界语义）。
    return x;
  }
  const front = Math.exp(lnBeta);
  const EPS = 1e-12;
  const TINY = 1e-300;
  let f = 1;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  f = d;
  for (let m = 1; m <= 200; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    f *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    f *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  const result = (front * f) / a;
  // I_x(a,b) 与 I_{1-x}(b,a) 的对称性用于 x > (a+1)/(a+b+2) 区域。
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - regularizedIncompleteBeta(1 - x, b, a);
  }
  return Math.min(1, Math.max(0, result));
}

/** Lanczos log-gamma（g=7, n=9），误差 ~1e-13。 */
function lgamma(z: number): number {
  const COF = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  }
  const x = z - 1;
  let a = COF[0]!;
  const t = x + 7.5;
  for (let i = 1; i < COF.length; i += 1) {
    a += COF[i]! / (x + i);
  }
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * Clopper–Pearson 单侧上界：n 次观测中 E 次「错误」，置信水平 1−δ 的上界
 * = Beta 分布的 1−δ 分位数 Beta(E+1, n−E)。E=0 时闭式 = 1 − δ^{1/n}。
 */
export function clopperPearsonUpper(
  errors: number,
  n: number,
  delta: number,
): number {
  if (!Number.isInteger(errors) || !Number.isInteger(n) || n < 1) {
    throw new Error(`clopperPearsonUpper: invalid samples (errors=${errors}, n=${n})`);
  }
  if (errors < 0 || errors > n) {
    throw new Error(`clopperPearsonUpper: errors must be in [0, n]`);
  }
  if (!(delta > 0 && delta < 1)) {
    throw new Error(`clopperPearsonUpper: delta must be in (0,1) (got ${delta})`);
  }
  if (errors === 0) return 1 - Math.pow(delta, 1 / n);
  if (errors === n) return 1;
  // 二分反演 Beta 分位数。
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    const cdf = regularizedIncompleteBeta(mid, errors + 1, n - errors);
    if (cdf < 1 - delta) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-12) break;
  }
  return (lo + hi) / 2;
}

export interface ConformalSample {
  /** 该例是否真的是 FIT（金标标签）。 */
  isFit: boolean;
  /** nonconformity 分数（越小越自信）。 */
  score: number;
}

export interface ConformalFitOptions {
  /** 目标错误率上界（设计默认 0.05）。 */
  alpha?: number;
  /** 置信水平参数 δ（设计默认 0.05 → 1−δ = 95% 单侧）。 */
  delta?: number;
}

export interface ConformalFitResult {
  /** 满足条件的最大 τ；null = 没有任何阈值安全（全部弃权）。 */
  threshold: number | null;
  accepted: number;
  acceptedErrors: number;
  /** 接受集的 CP 上界（threshold 为 null 时也为 null）。 */
  upper: number | null;
}

/**
 * 阈值拟合（§4.3.7.3）：从小到大遍历候选 τ，取「接受集 CP 上界 ≤ α」的最大 τ。
 * 纯函数；同样本永远同样结果（排序稳定）。
 */
export function fitConformalThreshold(
  samples: readonly ConformalSample[],
  options: ConformalFitOptions = {},
): ConformalFitResult {
  const alpha = options.alpha ?? 0.05;
  const delta = options.delta ?? 0.05;
  if (!(alpha > 0 && alpha < 1) || !(delta > 0 && delta < 1)) {
    throw new Error('fitConformalThreshold: alpha/delta must be in (0,1)');
  }
  if (samples.length === 0) {
    return { threshold: null, accepted: 0, acceptedErrors: 0, upper: null };
  }
  const sorted = [...samples].sort((a, b) => a.score - b.score);
  let best: ConformalFitResult = {
    threshold: null,
    accepted: 0,
    acceptedErrors: 0,
    upper: null,
  };
  let accepted = 0;
  let errors = 0;
  let index = 0;
  while (index < sorted.length) {
    const tau = sorted[index]!.score;
    while (index < sorted.length && sorted[index]!.score === tau) {
      accepted += 1;
      if (!sorted[index]!.isFit) errors += 1;
      index += 1;
    }
    const upper = clopperPearsonUpper(errors, accepted, delta);
    if (upper <= alpha) {
      best = { threshold: tau, accepted, acceptedErrors: errors, upper };
    }
  }
  return best;
}

/** L4 运行时（shadow/enforce 共用）：给定分数与阈值，是否弃权。 */
export function conformalAbstain(score: number, threshold: number | null): boolean {
  if (threshold === null) return true; // 无安全阈值 → 全部弃权（fail-safe）
  return score > threshold;
}
