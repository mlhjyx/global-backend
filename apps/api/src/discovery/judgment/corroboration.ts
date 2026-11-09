/**
 * 跨源佐证门（2026-11-10，多源证据图核心切片 ③；产品负责人当晚口径：直接 enforce，取消影子期）。
 *
 * 口径：FIT / NOT_FIT 这类**有结论的判定**必须有 ≥2 个独立来源分层（T1/T2/T3，见
 * discovery/evidence-bundle.ts）支撑；只有单一层（例如仅官网）时判定按 **fail-closed
 * 降级为 UNKNOWN**（Lead 投影 weak/待复核，绝不自动推荐或自动拒绝），并把降级原因
 * 记入判定记录 `sampling.corroboration`。
 *
 * 开关 `JUDGE_CORROBORATION_MODE`：
 *  - `enforce`（默认）：门生效——佐证不足的 FIT/NOT_FIT 降级 UNKNOWN；证据记录照写。
 *  - `shadow`：可回滚观察位——只记录不降级（等同取消影子期前的行为）。
 *  - `off`：完全关闭（不评估、不记录、不降级）。
 *  非法值按 `enforce` 处理（fail-closed：拼写错误绝不静默放宽门）。
 *
 * 纯函数模块；接线在 fit-judge-v2.ts（v2 判定链 + Lead 投影）与 fit-judge.ts（v1 路径），
 * 证据包落库在 persistJudgmentRecordInTransaction 同事务。
 */
import type { EvidenceBundle, EvidenceTier } from '../evidence-bundle';

export const JUDGE_CORROBORATION_MODES = ['off', 'shadow', 'enforce'] as const;
export type JudgeCorroborationMode = (typeof JUDGE_CORROBORATION_MODES)[number];

/**
 * 佐证门开关。默认 `enforce`（产品负责人 2026-11-10 决定取消影子期）。
 * 非法值 fail-closed 到 `enforce`：拼写错误不得静默关闭门或退回只记录。
 */
export function judgeCorroborationMode(
  env: { readonly [key: string]: string | undefined } = process.env,
): JudgeCorroborationMode {
  const raw = env.JUDGE_CORROBORATION_MODE?.trim().toLowerCase();
  return (JUDGE_CORROBORATION_MODES as readonly string[]).includes(raw ?? '')
    ? (raw as JudgeCorroborationMode)
    : 'enforce';
}

/** 需要跨源佐证的有结论判定。 */
const CORROBORATION_VERDICTS = new Set(['FIT', 'NOT_FIT']);

/** 判定结论口径：≥2 个独立分层。 */
export const REQUIRED_MIN_TIERS = 2;

export type CorroborationReason = 'CORROBORATED' | 'INSUFFICIENT_TIERS' | 'NO_BUNDLE' | 'NOT_APPLICABLE';

export interface CorroborationRecord {
  version: 1;
  mode: JudgeCorroborationMode;
  /** enforce 下该记录是否真实参与了判定（mode=enforce 且 verdict 属结论类）。 */
  enforced: boolean;
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
  /** enforce 降级时记录原判定（判定记录 verdictProposed 同步保留）。 */
  downgraded_from?: string;
}

/**
 * 评估一条判定的跨源佐证。`bundle` 来自公司 attributes.evidence_bundle
 * （readEvidenceBundle 的宽容读侧）或判定时按当前属性现场装配的包；null → NO_BUNDLE。
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
    mode,
    enforced: mode === 'enforce' && requires,
    verdict: args.verdict,
    requires_corroboration: requires,
    evaluated: false,
    reason: 'NOT_APPLICABLE',
    required_min_tiers: REQUIRED_MIN_TIERS,
  };
  if (!requires) return base;
  // 空包（零条目）与无包同义：该判定没有任何可分层来源。
  if (!args.bundle || (args.bundle.entries?.length ?? 0) === 0) {
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

export type LeadVerdict = 'match' | 'weak' | 'mismatch';

const LEAD_TO_JUDGMENT = Object.freeze({ match: 'FIT', weak: 'UNKNOWN', mismatch: 'NOT_FIT' } as const);
export interface CorroborationEnforcement {
  /** 有效 verdict（enforce 且佐证不足 → weak/UNKNOWN；否则原值）。 */
  verdict: LeadVerdict;
  /** 原判定（与有效值不同即发生降级）。 */
  proposed: LeadVerdict;
  record: CorroborationRecord;
  downgraded: boolean;
  /** 追加到判定理由的中文说明（降级时给操作者看的一句话；未降级为 null）。 */
  reasonLine: string | null;
}

/**
 * 把佐证门应用到「Lead 视角 verdict」（fit-judge 的 match/weak/mismatch）。
 *  - enforce 且结论类（match/mismatch）且佐证不足 → 降级为 weak（fail-closed 弃权）。
 *  - shadow/off 只产出记录，不改 verdict。
 */
export function enforceCorroboration(args: {
  verdict: LeadVerdict;
  bundle: EvidenceBundle | null;
  mode: JudgeCorroborationMode;
}): CorroborationEnforcement {
  const judgmentVerdict = LEAD_TO_JUDGMENT[args.verdict];
  const record = evaluateCorroboration({
    verdict: judgmentVerdict,
    bundle: args.bundle,
    mode: args.mode,
  });
  const downgraded =
    record.enforced && record.requires_corroboration && record.corroborated !== true;
  if (!downgraded) {
    return { verdict: args.verdict, proposed: args.verdict, record, downgraded: false, reasonLine: null };
  }
  const tiers = record.tiers_present?.length ? record.tiers_present.join('/') : '无';
  const reason =
    record.reason === 'NO_BUNDLE'
      ? '无证据包'
      : `仅 ${tiers} ${record.tiers_present?.length ?? 0} 个来源分层`;
  return {
    verdict: 'weak',
    proposed: args.verdict,
    record: { ...record, downgraded_from: judgmentVerdict },
    downgraded: true,
    reasonLine:
      `跨源佐证门（enforce）：${reason}，不足以支撑 ${judgmentVerdict}（要求 ≥${REQUIRED_MIN_TIERS} 个独立分层 T1/T2/T3）；` +
      'fail-closed 降级为 UNKNOWN，转人工复核。',
  };
}
