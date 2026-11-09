/**
 * 跨源佐证门（2026-11-10，多源证据图核心切片 ③，shadow）。
 *
 * 口径：FIT / NOT_FIT 这类**有结论的判定**应当有 ≥2 个独立来源分层（T1/T2/T3，见
 * discovery/evidence-bundle.ts）支撑；只有单一层（例如仅官网）时判定应被标记为
 * 佐证不足。本模块只做**评估与记录**：
 *
 *  - `JUDGE_CORROBORATION_MODE`：`off` 关闭；`shadow`（默认）评估并写入判定记录的
 *    sampling.corroboration，**不改变 verdict/Lead**；`enforce` 预留（当前与 shadow
 *    相同，拦截语义需单独评审后实现——绝不静默上线拦截）。
 *  - 评估输入是公司 `attributes.evidence_bundle`（证据包 v1）；没有包的公司记
 *    `NO_BUNDLE`，同样不影响判定。
 *
 * 纯函数模块；落库接线在 fit-judge.ts 的 `persistJudgmentRecordInTransaction`
 * （recordJudgment 同事务、同唯一写入口）。
 */
import type { EvidenceBundle, EvidenceTier } from '../evidence-bundle';

export const JUDGE_CORROBORATION_MODES = ['off', 'shadow', 'enforce'] as const;
export type JudgeCorroborationMode = (typeof JUDGE_CORROBORATION_MODES)[number];

/**
 * 佐证门开关。默认 `shadow`：评估并记录、不拦截（brief 2026-11-10 的「默认 shadow」）。
 * 非法值按 `shadow` 处理（fail-safe 到「只记录」，绝不因拼写错误变成拦截或消失）。
 * `enforce` 目前与 shadow 行为相同——真正的拦截语义尚未实现，留待单独评审。
 */
export function judgeCorroborationMode(
  env: { readonly [key: string]: string | undefined } = process.env,
): JudgeCorroborationMode {
  const raw = env.JUDGE_CORROBORATION_MODE?.trim().toLowerCase();
  return (JUDGE_CORROBORATION_MODES as readonly string[]).includes(raw ?? '')
    ? (raw as JudgeCorroborationMode)
    : 'shadow';
}

/** 需要跨源佐证的有结论判定。 */
const CORROBORATION_VERDICTS = new Set(['FIT', 'NOT_FIT']);

/** 判定结论口径：≥2 个独立分层。 */
export const REQUIRED_MIN_TIERS = 2;

export type CorroborationReason = 'CORROBORATED' | 'INSUFFICIENT_TIERS' | 'NO_BUNDLE' | 'NOT_APPLICABLE';

export interface CorroborationRecord {
  version: 1;
  shadow: true;
  mode: JudgeCorroborationMode;
  verdict: string;
  /** 该 verdict 是否属于「需要佐证」的结论类（FIT/NOT_FIT）。 */
  requires_corroboration: boolean;
  evaluated: boolean;
  reason: CorroborationReason;
  /** 有证据包的判定：分层清单与来源数。 */
  tiers_present?: EvidenceTier[];
  distinct_sources?: number;
  corroborated?: boolean;
  required_min_tiers: number;
  bundle_built_at?: string;
}

/**
 * 评估一条判定的跨源佐证。`bundle` 来自公司 attributes.evidence_bundle
 * （readEvidenceBundle 的宽容读侧）；null/缺省 → NO_BUNDLE。
 * 结论：corroborated = 包覆盖 ≥2 个不同 tier。
 */
export function evaluateCorroboration(args: {
  verdict: string;
  bundle: EvidenceBundle | null;
  mode?: JudgeCorroborationMode;
}): CorroborationRecord {
  const mode = args.mode ?? judgeCorroborationMode();
  const requires = CORROBORATION_VERDICTS.has(args.verdict);
  const base: CorroborationRecord = {
    version: 1,
    shadow: true,
    mode,
    verdict: args.verdict,
    requires_corroboration: requires,
    evaluated: false,
    reason: 'NOT_APPLICABLE',
    required_min_tiers: REQUIRED_MIN_TIERS,
  };
  if (!requires) return base;
  if (!args.bundle) {
    return { ...base, evaluated: true, reason: 'NO_BUNDLE' };
  }
  const tiers = args.bundle.coverage?.tier_list ?? [];
  const corroborated = tiers.length >= REQUIRED_MIN_TIERS;
  return {
    ...base,
    evaluated: true,
    reason: corroborated ? 'CORROBORATED' : 'INSUFFICIENT_TIERS',
    tiers_present: [...tiers],
    distinct_sources: args.bundle.coverage?.distinct_sources ?? 0,
    corroborated,
    bundle_built_at: args.bundle.built_at,
  };
}
