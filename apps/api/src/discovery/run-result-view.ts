import type { Prisma } from '@prisma/client';
import { QUALIFICATION_BATCH_SCORED_EVENT } from './run2/run-events';

export { QUALIFICATION_BATCH_SCORED_EVENT } from './run2/run-events';

/**
 * Run 级结果视图（MP-0.3 / PR-06a，只读，无迁移）。
 *
 * 把三类事实分开呈现，**绝不把最新分解释为本 run 的评分**：
 *  - 候选集：本 run 物化的公司（discovery_company_job → canonical_company）；
 *  - 本轮评分：本 run 触发的评分批次留痕（run_event type=qualification_batch_scored，
 *    由 PR-06b 写入；本 PR 只读，历史 run 没有该事件时如实标「未评分」）；
 *  - 最新评分：lead 上的 ICP 级最新投影，单独字段并标注「不一定是本 run」。
 *
 * 边界：候选与评分明细各自封顶 CANDIDATE_LIMIT 条并回报 truncated；计数永远按全量算。
 */

export const RUN_RESULT_VIEW_LIMIT = 500;

export interface RunResultViewCandidate {
  companyId: string;
  name: string | null;
  domain: string | null;
  country: string | null;
  stage: string;
  verdictQuick: string | null;
  verdictDeep: string | null;
  lastErrorCode: string | null;
}

/** 本 run 评分批次里的一条公司结果（来自 run_event payload，不可变）。 */
export interface RunResultViewScoredItem {
  companyId: string;
  leadId: string | null;
  totalScore: number | null;
  scores: Record<string, unknown> | null;
  queue: string | null;
  fitVerdict: string | null;
  ruleVersion: string | null;
  candidateBatchRef: string | null;
  scoredAt: string | null;
}

/** lead 上的最新评分投影（ICP 级，可能来自其他触发）。 */
export interface RunResultViewLatestItem {
  companyId: string;
  leadId: string;
  status: string;
  queue: string;
  totalScore: number | null;
  scores: Record<string, unknown> | null;
  fitVerdict: string | null;
  scoredAt: string | null;
}

export interface RunResultView {
  runId: string;
  icpId: string;
  status: string;
  completedAt: string | null;
  candidates: {
    total: number;
    truncated: boolean;
    items: RunResultViewCandidate[];
  };
  scoring: {
    thisRun: {
      available: boolean;
      label: 'this_run' | 'not_scored_in_run';
      batches: number;
      scoredCompanies: number;
      truncated: boolean;
      scoredAt: string | null;
      items: RunResultViewScoredItem[];
    };
    latest: {
      label: 'latest_not_necessarily_this_run';
      items: RunResultViewLatestItem[];
    };
  };
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function scoreRecord(value: unknown): Record<string, unknown> | null {
  return plainRecord(value);
}

function scoredItem(raw: unknown): RunResultViewScoredItem | null {
  const item = plainRecord(raw);
  if (!item) return null;
  const companyId = stringOrNull(item.companyId);
  if (!companyId) return null;
  return {
    companyId,
    leadId: stringOrNull(item.leadId),
    totalScore: numberOrNull(item.totalScore),
    scores: scoreRecord(item.scores),
    queue: stringOrNull(item.queue),
    fitVerdict: stringOrNull(item.fitVerdict),
    ruleVersion: stringOrNull(item.ruleVersion),
    candidateBatchRef: stringOrNull(item.candidateBatchRef),
    scoredAt: stringOrNull(item.scoredAt),
  };
}

/** run_event.payload.items；坏形状按空处理（读模型不因历史脏数据整体失败）。 */
function scoredItemsFromPayload(payload: unknown): RunResultViewScoredItem[] {
  const record = plainRecord(payload);
  if (!record || !Array.isArray(record.items)) return [];
  return record.items
    .map(scoredItem)
    .filter((item): item is RunResultViewScoredItem => item !== null);
}

/**
 * 按 run 读结果视图。返回 null = run 不存在（调用方转 404）。
 * workspace 隔离由调用方的 withWorkspace（RLS）承担，本函数只按 runId 查询。
 */
export async function buildRunResultView(
  tx: Prisma.TransactionClient,
  args: { runId: string },
): Promise<RunResultView | null> {
  const run = await tx.discoveryRun.findUnique({
    where: { id: args.runId },
    select: { id: true, icpId: true, status: true, completedAt: true },
  });
  if (!run) return null;

  const [total, jobs] = await Promise.all([
    tx.discoveryCompanyJob.count({ where: { runId: run.id } }),
    tx.discoveryCompanyJob.findMany({
      where: { runId: run.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: RUN_RESULT_VIEW_LIMIT,
      select: {
        canonicalCompanyId: true,
        stage: true,
        verdictQuick: true,
        verdictDeep: true,
        lastErrorCode: true,
      },
    }),
  ]);
  const candidateIds = jobs.map((job) => job.canonicalCompanyId);

  const [companies, scoringEvents] = await Promise.all([
    candidateIds.length
      ? tx.canonicalCompany.findMany({
          where: { id: { in: candidateIds } },
          select: { id: true, name: true, domain: true, country: true },
        })
      : Promise.resolve([]),
    tx.runEvent.findMany({
      where: { runId: run.id, type: QUALIFICATION_BATCH_SCORED_EVENT },
      orderBy: { seq: 'asc' },
      select: { payload: true, at: true },
    }),
  ]);
  const companyById = new Map(companies.map((company) => [company.id, company]));

  // 本轮评分：按 seq 顺序回放；同一公司出现多次时后批覆盖（后批即该 run 内最新一次计分）。
  const thisRun = new Map<string, RunResultViewScoredItem>();
  let scoredAt: string | null = null;
  for (const event of scoringEvents) {
    const payload = plainRecord(event.payload);
    const at = stringOrNull(payload?.scoredAt) ?? event.at.toISOString();
    if (!scoredAt || at > scoredAt) scoredAt = at;
    for (const item of scoredItemsFromPayload(event.payload)) {
      thisRun.set(item.companyId, { ...item, scoredAt: item.scoredAt ?? at });
    }
  }
  const thisRunItems = [...thisRun.values()];

  // 最新评分：lead 是 ICP 级最新投影，单列展示；覆盖对象 = 本 run 候选 ∪ 本轮评分涉及的公司。
  const latestIds = [...new Set([...candidateIds, ...thisRunItems.map((item) => item.companyId)])];
  const leads = latestIds.length
    ? await tx.lead.findMany({
        where: { icpId: run.icpId, canonicalCompanyId: { in: latestIds } },
        select: {
          id: true,
          canonicalCompanyId: true,
          status: true,
          queue: true,
          totalScore: true,
          scores: true,
          fitVerdict: true,
          scoredAt: true,
        },
      })
    : [];
  const leadByCompany = new Map(leads.map((lead) => [lead.canonicalCompanyId, lead]));

  return {
    runId: run.id,
    icpId: run.icpId,
    status: run.status,
    completedAt: run.completedAt?.toISOString() ?? null,
    candidates: {
      total,
      truncated: total > jobs.length,
      items: jobs.map((job) => {
        const company = companyById.get(job.canonicalCompanyId);
        return {
          companyId: job.canonicalCompanyId,
          name: company?.name ?? null,
          domain: company?.domain ?? null,
          country: company?.country ?? null,
          stage: job.stage,
          verdictQuick: job.verdictQuick,
          verdictDeep: job.verdictDeep,
          lastErrorCode: job.lastErrorCode,
        };
      }),
    },
    scoring: {
      thisRun: {
        available: scoringEvents.length > 0,
        label: scoringEvents.length > 0 ? 'this_run' : 'not_scored_in_run',
        batches: scoringEvents.length,
        scoredCompanies: thisRun.size,
        truncated: thisRun.size > RUN_RESULT_VIEW_LIMIT,
        scoredAt,
        items: thisRunItems.slice(0, RUN_RESULT_VIEW_LIMIT),
      },
      latest: {
        label: 'latest_not_necessarily_this_run',
        items: latestIds.flatMap((companyId) => {
          const lead = leadByCompany.get(companyId);
          if (!lead) return [];
          return [
            {
              companyId,
              leadId: lead.id,
              status: lead.status,
              queue: lead.queue,
              totalScore: lead.totalScore,
              scores: scoreRecord(lead.scores),
              fitVerdict: lead.fitVerdict,
              scoredAt: lead.scoredAt?.toISOString() ?? null,
            },
          ];
        }),
      },
    },
  };
}
