/**
 * 双源捕获-再捕获：Chapman 估计与 95% 置信区间（获客 vNext W3）。
 *
 * 场景：同一「地区×品类」内，选两条相互独立的发现源 A、B。n1 = A 命中的
 * 公司数，n2 = B 命中的公司数，m = 两源都命中的公司数（按 canonical 公司去重后
 * 的交集）。Chapman（1951）对 Lincoln–Petersen 估计做小样本偏置修正：
 *
 *     N̂ = (n1+1)(n2+1)/(m+1) − 1
 *
 * 即两源所覆盖的「可发现公司」总数估计。方差（Seber 1970 等文献通用形式）：
 *
 *     Var(N̂) = (n1+1)(n2+1)(n1−m)(n2−m) / ((m+1)²·(m+2))
 *
 * 95% CI = N̂ ± 1.96·√Var，下界不低于已观测并集 n1+n2−m（总体不可能小于
 * 亲眼见过的公司数）。
 *
 * 承重假设（报告与 PR 必须一并说明，端点响应也原样带出）：
 *   1. 总体封闭：估计窗口内没有公司迁入/迁出该地区×品类；
 *   2. 两源相互独立：A 抓到与否不改变 B 抓到的概率；
 *   3. 同质可捕获性：同一源对每家公司的捕获概率相同；
 *   4. 匹配无误：跨源同一法人按 canonical 公司被正确合并（W2 实体图谱的职责）。
 *
 * 边界语义（本模块显式建模，单测覆盖）：
 *   - 任一边为空（n1=0 或 n2=0）：不可估计，返回 estimable=false、
 *     reason=EMPTY_SOURCE，estimate/CI 为 null —— 不做点估计，避免拿 0 冒充；
 *   - 零重叠（m=0）：公式仍有定义，照常给出点估计与区间，但标记
 *     warning=ZERO_OVERLAP —— 在独立性假设下这是「两源几乎不重叠」的强信号，
 *     区间对模型偏差非常敏感，引用时必须自带这条警告。
 */

/** 95% 正态分位（1.96）。样本量小时 Chapman 的方差近似本身已弱于正态近似，
 *  这里不引入 t 分位修正，保持与文献口径一致、可复算。 */
const Z95 = 1.96;

export const CHAPMAN_ESTIMATOR_VERSION = "chapman/v1" as const;

export interface ChapmanInput {
  /** 源 A 命中的去重公司数（≥0）。 */
  readonly n1: number;
  /** 源 B 命中的去重公司数（≥0）。 */
  readonly n2: number;
  /** 两源交集的去重公司数（≥0，且 ≤ min(n1, n2)）。 */
  readonly overlap: number;
}

export type ChapmanResult =
  | {
      readonly estimable: true;
      readonly estimator: typeof CHAPMAN_ESTIMATOR_VERSION;
      readonly n1: number;
      readonly n2: number;
      readonly overlap: number;
      /** 已观测并集（两源合计去重数），CI 下界的硬地板。 */
      readonly observedUnion: number;
      readonly estimate: number;
      readonly variance: number;
      readonly ciLow: number;
      readonly ciHigh: number;
      /** 估计的召回率下界/点值/上界 = observedUnion / 区间上界、N̂、区间下界。 */
      readonly recallEstimate: number;
      readonly warning: "ZERO_OVERLAP" | null;
    }
  | {
      readonly estimable: false;
      readonly estimator: typeof CHAPMAN_ESTIMATOR_VERSION;
      readonly n1: number;
      readonly n2: number;
      readonly overlap: number;
      readonly observedUnion: number;
      readonly reason: "EMPTY_SOURCE";
      readonly estimate: null;
      readonly ciLow: null;
      readonly ciHigh: null;
      readonly warning: null;
    };

function assertCount(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`chapman: ${name} must be a non-negative integer (got ${value})`);
  }
}

export function chapmanEstimate(input: ChapmanInput): ChapmanResult {
  const { n1, n2, overlap } = input;
  assertCount("n1", n1);
  assertCount("n2", n2);
  assertCount("overlap", overlap);
  if (overlap > Math.min(n1, n2)) {
    throw new Error(
      `chapman: overlap (${overlap}) cannot exceed min(n1, n2) (${Math.min(n1, n2)})`,
    );
  }
  const observedUnion = n1 + n2 - overlap;
  if (n1 === 0 || n2 === 0) {
    return {
      estimable: false,
      estimator: CHAPMAN_ESTIMATOR_VERSION,
      n1,
      n2,
      overlap,
      observedUnion,
      reason: "EMPTY_SOURCE",
      estimate: null,
      ciLow: null,
      ciHigh: null,
      warning: null,
    };
  }
  const estimate = ((n1 + 1) * (n2 + 1)) / (overlap + 1) - 1;
  // m=0 时 (n1−m)(n2−m)=n1·n2、(m+1)²(m+2)=2，方差仍有定义。
  const variance =
    ((n1 + 1) * (n2 + 1) * (n1 - overlap) * (n2 - overlap)) /
    ((overlap + 1) * (overlap + 1) * (overlap + 2));
  const halfWidth = Z95 * Math.sqrt(variance);
  // 下界钳到已观测并集；且不得越过点估计（保护极小数样本下的区间次序）。
  const ciLow = Math.min(Math.max(estimate - halfWidth, observedUnion), estimate);
  const ciHigh = Math.max(estimate + halfWidth, estimate);
  return {
    estimable: true,
    estimator: CHAPMAN_ESTIMATOR_VERSION,
    n1,
    n2,
    overlap,
    observedUnion,
    estimate,
    variance,
    ciLow,
    ciHigh,
    recallEstimate: observedUnion / estimate,
    warning: overlap === 0 ? "ZERO_OVERLAP" : null,
  };
}
