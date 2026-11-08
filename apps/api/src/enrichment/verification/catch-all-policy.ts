import type { EmailVerificationState } from '../../discovery/contact-point-verification-state';

/**
 * P1（首波）：catch-all 发送分层策略——配置 + 纯函数。
 *
 * 阈值分层（产品负责人 2026-11-09 口径）：**≥70 正常、40–69 灰度、<40 抑制**。
 * 灰度白名单**仅 US / FR**：德国一律不进灰度（UWG §7(2) Nr.2 冷邮件需事先明示同意），
 * 其他国家（含 FR 以外的 EU）同样不进入（CNIL 三条件与 DNC 是 FR 的准入前提，由发送门
 * 另行检查；本模块只回答「分层与白名单」）。
 *
 * 本模块不含发送执行；SaaS 发送门（P1-13/P1-16）消费同一配置与函数，避免两边阈值漂移。
 * 计划 §2.3.6 的 S3a/S3b 更严门槛（min_score 70/85、每箱 5/3 封）属于灰度实验参数，
 * 待 800 条样本落地后在 `catch_all_send_policy` 表上校准——本模块给的是默认常量。
 */

/** 灰度白名单（计划 §2.3.6.1：只对 US / FR 做灰度发送；DE 永不进入）。 */
export const CATCH_ALL_GRAY_COUNTRIES = ['US', 'FR'] as const;

export interface CatchAllSendPolicyConfig {
  /** ≥该分数：正常分层（唯一的「正常」入口）。 */
  normalMinScore: number;
  /** ≥该分数且 < normalMinScore：灰度分层（还须命中国家白名单）。 */
  grayMinScore: number;
  /** 灰度国家白名单（ISO 3166-1 alpha-2，大写）。 */
  grayCountries: readonly string[];
}

export const DEFAULT_CATCH_ALL_SEND_POLICY: CatchAllSendPolicyConfig = {
  normalMinScore: 70,
  grayMinScore: 40,
  grayCountries: CATCH_ALL_GRAY_COUNTRIES,
};

/** 从 env 解析策略（缺省用默认值；值非法时回退默认并保持区间有效）。 */
export function resolveCatchAllSendPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CatchAllSendPolicyConfig {
  const int = (raw: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt(raw ?? '', 10);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 ? parsed : fallback;
  };
  const normalMinScore = int(env.CATCH_ALL_NORMAL_MIN_SCORE, DEFAULT_CATCH_ALL_SEND_POLICY.normalMinScore);
  const grayMinScore = Math.min(
    int(env.CATCH_ALL_GRAY_MIN_SCORE, DEFAULT_CATCH_ALL_SEND_POLICY.grayMinScore),
    normalMinScore,
  );
  const countries = (env.CATCH_ALL_GRAY_COUNTRIES ?? '')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter((value) => /^[A-Z]{2}$/u.test(value));
  return {
    normalMinScore,
    grayMinScore,
    grayCountries: countries.length > 0 ? countries : DEFAULT_CATCH_ALL_SEND_POLICY.grayCountries,
  };
}

export type CatchAllSendTier = 'normal' | 'gray' | 'suppressed';

/** 阈值分层：≥normalMinScore 正常；≥grayMinScore 灰度；其余抑制。 */
export function catchAllSendTier(
  score: number,
  config: CatchAllSendPolicyConfig = DEFAULT_CATCH_ALL_SEND_POLICY,
): CatchAllSendTier {
  if (score >= config.normalMinScore) return 'normal';
  if (score >= config.grayMinScore) return 'gray';
  return 'suppressed';
}

export interface CatchAllEligibilityInput {
  state: EmailVerificationState;
  score: number;
  /** ISO 3166-1 alpha-2（大小写不敏感）。 */
  country: string | null | undefined;
}

export interface CatchAllEligibility {
  tier: CatchAllSendTier;
  /** 该地址在 catch-all 策略下是否允许进入发送（仍须合规门与发送开关）。 */
  eligible: boolean;
  reason:
    | 'valid_not_catch_all'
    | 'state_not_eligible'
    | 'score_suppressed'
    | 'country_not_whitelisted'
    | 'eligible_normal'
    | 'eligible_gray';
}

/**
 * catch-all 地址的分层与白名单判定（纯函数）：
 *  - VALID 地址不受 catch-all 策略约束（返回 tier=normal、reason=valid_not_catch_all）——
 *    是否可发由合规门/发送门决定；
 *  - UNKNOWN / INVALID 一律不可发（UNKNOWN 必须先验证，INVALID 永不发送）；
 *  - CATCH_ALL_RISKY：<40 抑制；40–69 灰度（仅白名单国家）；≥70 正常分层（同样仅白名单
 *    国家——冷邮件在 DE 无 B2B 豁免，catch-all 地址不享受「正常」例外）。
 */
export function evaluateCatchAllEligibility(
  input: CatchAllEligibilityInput,
  config: CatchAllSendPolicyConfig = DEFAULT_CATCH_ALL_SEND_POLICY,
): CatchAllEligibility {
  if (input.state === 'VALID') {
    return { tier: 'normal', eligible: true, reason: 'valid_not_catch_all' };
  }
  if (input.state !== 'CATCH_ALL_RISKY') {
    return { tier: 'suppressed', eligible: false, reason: 'state_not_eligible' };
  }
  const tier = catchAllSendTier(input.score, config);
  if (tier === 'suppressed') {
    return { tier, eligible: false, reason: 'score_suppressed' };
  }
  const country = (input.country ?? '').trim().toUpperCase();
  if (!config.grayCountries.includes(country)) {
    return { tier, eligible: false, reason: 'country_not_whitelisted' };
  }
  return {
    tier,
    eligible: true,
    reason: tier === 'normal' ? 'eligible_normal' : 'eligible_gray',
  };
}
