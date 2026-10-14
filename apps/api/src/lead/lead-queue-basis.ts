/**
 * 队列依据（queue basis）：一条 lead 的 `queue` 是谁定的。
 *
 *  - `fit_gate_preset`：fit 门建行时按 verdict 预置（mismatch→rejected、其余→needs_review，见
 *    discovery/fit-judge.ts upsertLeadFit），评分从未跑过——六维分为 NULL，制裁第五门也没筛过；
 *  - `score`：评分阶段（temporal/qualify.activities scoreCandidates）按六维总分 + Reachability 硬底
 *    + 制裁/禁联算出；
 *  - `human_accept`：accept 裁决写入 QUALIFIED/recommended，重评分不覆盖；
 *  - `human_reject`：reject 裁决写入 REJECTED/rejected。评分阶段自己也写 status=REJECTED，所以只凭状态
 *    分不出人工与评分，需要一条 reject 裁决作证；重评分若已把它改到别的状态，依据回到 score。
 *
 * 起因（2026-10-14）：xin 上 179 条 lead 六维分全 NULL，队列只是 fit 门的预置值，API 却把它们和
 * 评分得出的队列显示成一样。
 */
export const LEAD_QUEUE_BASES = ['fit_gate_preset', 'score', 'human_accept', 'human_reject'] as const;
export type LeadQueueBasis = (typeof LEAD_QUEUE_BASES)[number];

export interface LeadQueueBasisInput {
  status?: string | null;
  totalScore?: number | null;
}

/** 已评分 = total_score 非空（0 分也算）。 */
export function isLeadScored(lead: { totalScore?: number | null }): boolean {
  return typeof lead.totalScore === 'number';
}

/** @param humanRejected 这条 lead 存在 action=reject 的裁决。 */
export function leadQueueBasis(lead: LeadQueueBasisInput, humanRejected: boolean): LeadQueueBasis {
  if (lead.status === 'QUALIFIED') return 'human_accept';
  if (humanRejected && lead.status === 'REJECTED') return 'human_reject';
  return isLeadScored(lead) ? 'score' : 'fit_gate_preset';
}

/** 一行 = 一个 (queue, status) 组：总数与有分数的条数（Prisma groupBy `_count.totalScore` = COUNT(total_score)）。 */
export interface LeadQueueGroupRow {
  queue: string;
  status: string;
  _count: { _all: number; totalScore: number };
}

/** REJECTED 且有 reject 裁决的 lead：总数与有分数的条数。 */
export interface LeadHumanRejectCount {
  _all: number;
  totalScore: number;
}

export interface LeadQueueSummary {
  recommended: number;
  needs_review: number;
  rejected: number;
  suppressed: number;
  sanctions_hold: number;
  /** 每条 lead 都有 total_score（没有一条仍是预置）；空 ICP 为 false。 */
  scored: boolean;
  queueBasis: Record<LeadQueueBasis, number>;
}

/**
 * 五队列计数 + 按依据的计数。人工裁决的行从评分/预置里扣除，四种依据之和 = lead 总数。
 * 评分阶段的队列值是闭集（lead/scoring.ts），这里只认这五个。
 */
export function summarizeLeadQueues(
  rows: readonly LeadQueueGroupRow[],
  humanRejected: LeadHumanRejectCount,
): LeadQueueSummary {
  const queues: Record<string, number> = {};
  let total = 0;
  let scoredTotal = 0;
  let qualified = 0;
  let qualifiedScored = 0;
  for (const row of rows) {
    queues[row.queue] = (queues[row.queue] ?? 0) + row._count._all;
    total += row._count._all;
    scoredTotal += row._count.totalScore;
    if (row.status === 'QUALIFIED') {
      qualified += row._count._all;
      qualifiedScored += row._count.totalScore;
    }
  }
  const unscoredTotal = total - scoredTotal;
  const humanRejectUnscored = humanRejected._all - humanRejected.totalScore;
  return {
    recommended: queues.recommended ?? 0,
    needs_review: queues.needs_review ?? 0,
    rejected: queues.rejected ?? 0,
    suppressed: queues.suppressed ?? 0,
    sanctions_hold: queues.sanctions_hold ?? 0,
    scored: total > 0 && scoredTotal === total,
    queueBasis: {
      fit_gate_preset: unscoredTotal - (qualified - qualifiedScored) - humanRejectUnscored,
      score: scoredTotal - qualifiedScored - humanRejected.totalScore,
      human_accept: qualified,
      human_reject: humanRejected._all,
    },
  };
}
