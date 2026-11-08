import type {
  CatchAllClass,
  EmailVerificationState,
} from '../../discovery/contact-point-verification-state';

/**
 * P1-06（首波）：验证瀑布的纯策略面——投票裁决（双正规则）与 0–100 评分。
 *
 * 硬规则（计划 §2.3.5.2，全部单测覆盖）：
 *  - **单验证器不得判 VALID**：一家 deliverable 只记 UNKNOWN（pending second vote），
 *    第二家独立 deliverable 才升 VALID；
 *  - 任一验证器 undeliverable 且无 positive → INVALID；正负冲突（且负票不多数）→ UNKNOWN
 *    （冲突未决，绝不判 VALID）；负票多于正票 → INVALID（2:1）；
 *  - accept_all 标志优先：任何投票带 accept_all=true → 至多 CATCH_ALL_RISKY；
 *  - 反枚举域（unprobeable_provider）不得用 SMTP/单票结果判 VALID——由投票里的
 *    catchAllClass 携带，冲突即 UNKNOWN。
 *
 * 评分（§2.3.2.8）是排序与灰度分层的输入，不是可发性的判据。
 */

export const SCORE_TIER_THRESHOLDS = { aMin: 80, bMin: 40 } as const;
export type EmailPointScoreTier = 'A' | 'B' | 'C';

/** 分档：A ≥80（可进正常发送的候选，仍须 state=VALID+合规门）、B 40–79、C <40。 */
export function scoreTier(score: number): EmailPointScoreTier {
  if (score >= SCORE_TIER_THRESHOLDS.aMin) return 'A';
  if (score >= SCORE_TIER_THRESHOLDS.bMin) return 'B';
  return 'C';
}

export interface EmailPointScoreInput {
  state: EmailVerificationState;
  catchAllClass?: CatchAllClass | null;
  /** 独立验证器 positive 票数（0–3）。 */
  positiveVotes?: number;
  /** 同域已有真实样本学到的格式（learned:*）。 */
  patternLearned?: boolean;
  /** 供应商信心 0–100（如 Hunter confidence；无公开 confidence 的源传 undefined）。 */
  providerConfidence?: number;
  /** 最近一次验证时间（年龄衰减：每满 90 天 −5，最低到基础分 −15）。 */
  verifiedAt?: Date | null;
  now?: Date;
  /** 同一地址累计软退信次数（≥3 次 −10）。 */
  softBounceCount?: number;
  /** 投诉：状态不变但评分归 0（发送门另行移除 outreach）。 */
  complained?: boolean;
}

const DAY_MS = 24 * 3_600_000;

/** 四态 + 证据分量的 0–100 评分（纯函数）。 */
export function scoreEmailPoint(input: EmailPointScoreInput): number {
  if (input.complained) return 0;
  const base = (() => {
    switch (input.state) {
      case 'VALID':
        return 95;
      case 'CATCH_ALL_RISKY':
        return input.catchAllClass === 'unprobeable_provider' ? 55 : 60;
      case 'UNKNOWN':
        return 20;
      case 'INVALID':
        return 0;
    }
  })();
  if (input.state === 'INVALID') return 0;

  let score = base;
  const positiveVotes = Math.max(0, Math.min(3, input.positiveVotes ?? 0));
  if (positiveVotes >= 3) score += 8;
  else if (positiveVotes === 2) score += 5;
  if (input.patternLearned) score += 5;
  if (typeof input.providerConfidence === 'number' && Number.isFinite(input.providerConfidence)) {
    const confidence = Math.min(100, Math.max(0, input.providerConfidence));
    score += Math.min(10, Math.round(confidence * 0.1));
  }
  if (input.verifiedAt && input.now) {
    const fullPeriods = Math.max(
      0,
      Math.floor((input.now.getTime() - input.verifiedAt.getTime()) / (90 * DAY_MS)),
    );
    score -= Math.min(15, fullPeriods * 5);
  }
  if ((input.softBounceCount ?? 0) >= 3) score -= 10;
  return Math.max(0, Math.min(100, score));
}

export interface VerificationVote {
  providerKey: string;
  state: EmailVerificationState;
  catchAllClass: CatchAllClass;
  acceptAll?: boolean | null;
}

export interface ResolvedVerificationVotes {
  state: EmailVerificationState;
  catchAllClass: CatchAllClass;
  /** 机器可读的裁决原因（写事件账 detail）。 */
  reason: string;
}

/**
 * 投票矩阵（§2.3.5.2 的纯函数实现），优先级从高到低：
 *  1) 负票（INVALID，5xx 强否定）：无正票 → INVALID；负票多于正票 → INVALID；其余冲突 → UNKNOWN；
 *     ——负票优先于 accept_all：明确 5xx 拒收不能被「accept_all 域」救回；
 *  2) 任一 accept_all=true → 至多 CATCH_ALL_RISKY（即便供应商说 ok）；
 *  3) 正票 ≥2（**独立 provider**；同一 key 重复票不算）→ VALID；
 *  4) 正票 =1 → UNKNOWN（单票不得判 VALID，等第二票）；
 *  5) 有 catch-all 票 → CATCH_ALL_RISKY（子类取最强的 true_catch_all > unprobeable > inconclusive）；
 *  6) 其余 → UNKNOWN。
 */
export function resolveVerificationVotes(votes: VerificationVote[]): ResolvedVerificationVotes {
  if (votes.length === 0) {
    return { state: 'UNKNOWN', catchAllClass: 'unknown', reason: 'no_votes' };
  }
  const acceptAllVote = votes.find((vote) => vote.acceptAll === true);
  // 独立性纪律：同一 providerKey 的重复票不构成「第二票」（单验证器永不判 VALID 的红线）。
  const uniqueByProvider = (state: EmailVerificationState) => {
    const seen = new Set<string>();
    return votes.filter((vote) => {
      if (vote.state !== state || seen.has(vote.providerKey)) return false;
      seen.add(vote.providerKey);
      return true;
    });
  };
  const positives = uniqueByProvider('VALID');
  const negatives = uniqueByProvider('INVALID');
  const catchAllVotes = votes.filter((vote) => vote.state === 'CATCH_ALL_RISKY');

  const strongestCatchAllClass = (): CatchAllClass => {
    if (catchAllVotes.some((vote) => vote.catchAllClass === 'true_catch_all')) return 'true_catch_all';
    if (catchAllVotes.some((vote) => vote.catchAllClass === 'unprobeable_provider')) {
      return 'unprobeable_provider';
    }
    if (catchAllVotes.some((vote) => vote.catchAllClass === 'inconclusive')) return 'inconclusive';
    return 'unknown';
  };

  if (negatives.length > 0) {
    if (positives.length === 0) {
      return { state: 'INVALID', catchAllClass: 'unknown', reason: 'verifier_invalid' };
    }
    if (negatives.length > positives.length) {
      return { state: 'INVALID', catchAllClass: 'unknown', reason: 'verifier_conflict_negative_majority' };
    }
    return { state: 'UNKNOWN', catchAllClass: 'unknown', reason: 'verifier_conflict_unresolved' };
  }
  if (acceptAllVote) {
    // accept_all 优先：ok 也不得判 VALID（除非地址级解析器给出证据——该路径由
    // 解析器投票显式携带 catchAllClass='not_catch_all' 后再进矩阵，本层不猜）。
    return {
      state: 'CATCH_ALL_RISKY',
      catchAllClass: strongestCatchAllClass() === 'unknown' ? 'true_catch_all' : strongestCatchAllClass(),
      reason: 'accept_all_flag',
    };
  }
  if (positives.length >= 2) {
    return { state: 'VALID', catchAllClass: 'not_catch_all', reason: 'two_positive_votes' };
  }
  if (positives.length === 1) {
    return { state: 'UNKNOWN', catchAllClass: 'unknown', reason: 'single_positive_requires_second_vote' };
  }
  if (catchAllVotes.length > 0) {
    return { state: 'CATCH_ALL_RISKY', catchAllClass: strongestCatchAllClass(), reason: 'catch_all_domain' };
  }
  return { state: 'UNKNOWN', catchAllClass: 'unknown', reason: 'inconclusive_votes' };
}
