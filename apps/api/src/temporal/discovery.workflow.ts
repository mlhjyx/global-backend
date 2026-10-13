import {
  ApplicationFailure,
  CancellationScope,
  TemporalFailure,
  patched,
  proxyActivities,
} from '@temporalio/workflow';
import type { DiscoveryActivities, DiscoveryRunInput } from './discovery.activities';
import { resolveRunStatus } from './discovery.run-status';
import {
  describeDiscoveryRunFailure,
  type DiscoveryRunStage,
} from './discovery.run-failure';
import {
  parseExecutionBudgetBinding,
  type ExecutionBudgetBinding,
} from '../execution-budget/execution-budget-binding';
import { isExecutionControlError } from '../execution-budget/execution-control-error';
import type { DiscoveryQueryReceipt } from '../discovery/discovery-query-receipt';
import { DISCOVERY_QUERY_RECEIPT_MODE as QUERY_RECEIPT_MODE } from '../discovery/discovery-query-receipt-contract';
import {
  isDiscoveryQuerySkipReason,
  type DiscoveryQuerySkipReason,
} from '../discovery/discovery-query-skip';
import {
  EMPTY_RUN_MODEL_EXTRACTIONS,
  addQueryModelExtractions,
  type DiscoveryRunModelExtractions,
} from '../discovery/discovery-model-extractions';

export const DISCOVERY_AUTHORITY_PATCH = 'discovery-workspace-authority-v2';
export const DISCOVERY_RAW_GOVERNANCE_PATCH =
  'discovery-raw-governance-dispositions-v1';
export const DISCOVERY_QUERY_RECEIPT_PATCH = 'discovery-query-receipt-input-v1';
/** G3 5.4b: website profiling between canonicalization and fit. */
export const DISCOVERY_WEBSITE_PROFILE_PATCH = 'discovery-website-profile-v1';
/** BI-25: a stage failure records the run FAILED before the workflow fails. */
export const DISCOVERY_FAILURE_FINALIZE_PATCH = 'discovery-failure-finalize-v1';
export const DISCOVERY_QUERY_RECEIPT_MODE = QUERY_RECEIPT_MODE;
const EXECUTION_CONTRACT_VERSION = 2 as const;

interface DiscoveryRunOutcome {
  status: 'DONE' | 'PARTIAL' | 'FAILED';
  stats: Record<string, unknown>;
}

function invalidAuthorityInput(): never {
  throw ApplicationFailure.nonRetryable(
    'EXECUTION_BUDGET_WORKFLOW_INPUT_INVALID',
    'EXECUTION_BUDGET_WORKFLOW_INPUT_INVALID',
  );
}

const acts = proxyActivities<DiscoveryActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3 },
});

// Query execution and the per-company fit pass make deepseek-v4-pro calls one
// after another (extraction batches, taxonomy terms, one fit call per company),
// which outruns the 2-minute default and turns into replay failures on retry.
// The fit pass hands the companies it did not reach within its time box to the
// next activity, so 15 minutes bounds one activity, not the whole pass.
const modelActs = proxyActivities<DiscoveryActivities>({
  startToCloseTimeout: '15 minutes',
  retry: { maximumAttempts: 3 },
});

// 信号富集是**慢活动**（抓官网/sitemap，逐家数十秒）：单独长超时代理，绝不用上面的 2 分钟超时
// （否则会超时重试整段富集）。工作量有界（SIGNAL_ENRICH_LIMIT 家 × 逐家有 AbortSignal 超时），30 分钟足够。
const signalActs = proxyActivities<DiscoveryActivities>({
  startToCloseTimeout: '30 minutes',
  retry: { maximumAttempts: 2 },
});

interface FitTotals {
  judged?: number;
  verdicts: Record<string, number>;
  skippedForBudget?: number;
  unjudged?: number;
  unreplayable?: number;
}

/**
 * A query activity whose last attempt met an operation it cannot replay: an earlier attempt's
 * wire ran and left no durable result, so it is never sent again (D13). Temporal reports the
 * activity's error class as the failure type.
 */
function isUnreplayableActivityFailure(error: unknown): boolean {
  if (!(error instanceof TemporalFailure)) return false;
  return (error.cause as { type?: unknown } | undefined)?.type === 'BudgetOperationReplayError';
}

interface WebsiteProfileTotals {
  profiled: number;
  matched: number;
  skippedSubjects?: number;
  budgetTruncated?: boolean;
  unclassified?: number;
  unreplayable?: number;
}

interface EnrichTotals {
  enriched: number;
  matched: number;
  provider: string | null;
  budgetTruncated: boolean;
}

function addFitPass(total: FitTotals, pass: FitTotals): FitTotals {
  const verdicts = { ...total.verdicts };
  for (const [verdict, count] of Object.entries(pass.verdicts ?? {})) {
    verdicts[verdict] = (verdicts[verdict] ?? 0) + count;
  }
  return {
    judged: (total.judged ?? 0) + (pass.judged ?? 0),
    verdicts,
    skippedForBudget: (total.skippedForBudget ?? 0) + (pass.skippedForBudget ?? 0),
    unjudged: (total.unjudged ?? 0) + (pass.unjudged ?? 0),
    unreplayable: (total.unreplayable ?? 0) + (pass.unreplayable ?? 0),
  };
}

function addWebsiteProfilePass(total: WebsiteProfileTotals, pass: WebsiteProfileTotals): WebsiteProfileTotals {
  return {
    profiled: total.profiled + pass.profiled,
    matched: total.matched + pass.matched,
    skippedSubjects: (total.skippedSubjects ?? 0) + (pass.skippedSubjects ?? 0),
    budgetTruncated: (total.budgetTruncated ?? false) || (pass.budgetTruncated ?? false),
    unclassified: (total.unclassified ?? 0) + (pass.unclassified ?? 0),
    unreplayable: (total.unreplayable ?? 0) + (pass.unreplayable ?? 0),
  };
}

/** Joins the `+`-separated provider keys of two enrich activities without repeating one. */
function mergeProviders(left: string | null, right: string | null): string | null {
  const keys = [...new Set([left, right].flatMap((value) => (value ? value.split('+') : [])))];
  return keys.length ? keys.join('+') : null;
}

function addEnrichPass(total: EnrichTotals, pass: EnrichTotals): EnrichTotals {
  return {
    enriched: total.enriched + pass.enriched,
    matched: total.matched + pass.matched,
    provider: mergeProviders(total.provider, pass.provider),
    budgetTruncated: total.budgetTruncated || pass.budgetTruncated,
  };
}

/**
 * Discover 编排（PRD 5.5 / 7.4.8 Waterfall 的发现段）：
 * READY 计划 → 按 priority 逐源执行（单源失败不终止整个 run → PARTIAL；数据源已停用的查询
 * 跳过，stats.skippedQueries 按原因计数，run 至少 PARTIAL，BI-30）→
 * 归一 + 身份解析 + Suppression → 收尾（计划 EXECUTED + DiscoveryRunCompleted 事件）。
 * 任一阶段失败（重试用尽，或控制错误）时先把 run 记为 FAILED，stats.failure 写明阶段与错误类型、
 * 不含消息，计划保持 READY；之后照旧抛出原错误，让工作流失败（BI-25）。
 * 联系人发现/邮箱验证是后续按需步骤（仅对高价值企业，Waterfall 第 5/7 步），不在此。
 */
export async function discoveryWorkflow(input: DiscoveryRunInput): Promise<void> {
  const { workspaceId, runId, planId } = input;
  const usesAuthority = patched(DISCOVERY_AUTHORITY_PATCH);
  const usesRawGovernance = patched(DISCOVERY_RAW_GOVERNANCE_PATCH);
  const usesQueryReceipts = usesRawGovernance && patched(DISCOVERY_QUERY_RECEIPT_PATCH);
  let executionBudget: ExecutionBudgetBinding | undefined;
  if (usesAuthority) {
    if (input.executionContractVersion !== EXECUTION_CONTRACT_VERSION) {
      invalidAuthorityInput();
    }
    try {
      executionBudget = parseExecutionBudgetBinding(input.executionBudget, {
        scopeKey: workspaceId,
        purpose: 'discovery.run',
        subjectType: 'discovery_run',
      });
    } catch {
      invalidAuthorityInput();
    }
  }
  const authorityArgs = usesAuthority
    ? { executionContractVersion: EXECUTION_CONTRACT_VERSION, executionBudget: executionBudget! }
    : {};
  const perSource: Record<
    string,
    {
      rawCount: number;
      provider: string | null;
      providers?: string[];
      quarantinedCount?: number;
      rejectedCount?: number;
      governanceDenied?: number;
      duplicateCount?: number;
      usageQuantity?: number;
      costCents?: number;
      error?: string;
    }
  > = {};
  const perQuery: Record<string, DiscoveryQueryReceipt> = {};
  let failures = 0;
  let discoveryBudgetTruncated = false;
  let acceptedRaw = 0;
  let governanceDenied = 0;
  let quarantinedRaw = 0;
  let rejectedRaw = 0;
  let duplicateRaw = 0;
  let queryCount = 0;
  // Queries counted as failed because their retries met an operation they cannot replay.
  let unreplayableQueries = 0;
  let stage: DiscoveryRunStage = 'plan';
  // BI-30: plan queries that ran on no provider because their source was off, by reason.
  const skippedQueries: Partial<Record<DiscoveryQuerySkipReason, number>> = {};
  let skippedQueryCount = 0;
  // Counts only, and only when a query was skipped: runs without skips keep their stats shape.
  const skipStats = (): Record<string, unknown> =>
    skippedQueryCount > 0 ? { skippedQueries: { ...skippedQueries } } : {};
  // Company extractions the providers skipped after a failed model call (#638). Shown only when
  // one was skipped, so runs without a skip keep their stats shape.
  let modelExtractions: DiscoveryRunModelExtractions = EMPTY_RUN_MODEL_EXTRACTIONS;
  const extractionStats = (): Record<string, unknown> =>
    modelExtractions.failed > 0
      ? {
          modelExtractions: {
            ...modelExtractions,
            failedByReason: { ...modelExtractions.failedByReason },
          },
        }
      : {};

  // Query totals in the exact shape finalizeRun checks against the stored receipts.
  const queryStats = (): Record<string, unknown> => ({
    perSource,
    ...(usesQueryReceipts
      ? {
          perQuery,
          rawGovernance: {
            accepted: acceptedRaw,
            quarantined: quarantinedRaw,
            rejected: rejectedRaw,
            governanceDenied,
            duplicate: duplicateRaw,
            usageQuantity: Object.values(perQuery).reduce(
              (sum, receipt) => sum + receipt.usageQuantity,
              0,
            ),
            costCents: Object.values(perQuery).reduce(
              (sum, receipt) => sum + receipt.costCents,
              0,
            ),
          },
        }
      : usesRawGovernance
        ? {
            rawGovernance: {
              accepted: acceptedRaw,
              quarantined: quarantinedRaw,
              rejected: rejectedRaw,
              duplicate: duplicateRaw,
            },
          }
      : {}),
  });
  const finalize = (outcome: DiscoveryRunOutcome) =>
    acts.finalizeRun({
      workspaceId,
      runId,
      planId,
      icpId: input.icpId,
      status: outcome.status,
      stats: outcome.stats,
      ...authorityArgs,
    });

  let outcome: DiscoveryRunOutcome;
  try {
    if (!usesAuthority) {
      await acts.resetRunBudget({ workspaceId, runId });
    }
    const { queries } = await acts.loadPlanQueries({ workspaceId, planId, ...authorityArgs });
    queryCount = queries.length;
    stage = 'query';
    // A query whose retries met an operation they cannot replay counts as failed and the plan
    // goes on; a second such query in a row looks like an outage and still stops the run.
    let previousQueryUnreplayable = false;
    for (const [queryOrdinal, query] of queries.entries()) {
      try {
        const r = await modelActs.executeQuery(
          usesQueryReceipts
            ? {
                workspaceId,
                runId,
                planId,
                queryOrdinal,
                queryReceiptMode: DISCOVERY_QUERY_RECEIPT_MODE,
                query,
                ...authorityArgs,
              }
            : { workspaceId, runId, query, ...authorityArgs },
        );
        acceptedRaw += r.rawCount;
        if (usesQueryReceipts) {
          const receipt = r.queryReceipt;
          if (!receipt) {
            throw ApplicationFailure.nonRetryable(
              'DISCOVERY_QUERY_RECEIPT_MISSING',
              'DISCOVERY_QUERY_RECEIPT_MISSING',
            );
          }
          perQuery[receipt.queryKey] = receipt;
          quarantinedRaw += receipt.quarantined;
          rejectedRaw += receipt.rejected;
          duplicateRaw += receipt.duplicate;
          governanceDenied += receipt.governanceDenied;
          const prior = perSource[receipt.sourceClass];
          const providers = [
            ...new Set([
              ...(prior?.providers ?? []),
              ...receipt.providers,
            ]),
          ].sort();
          perSource[receipt.sourceClass] = {
            rawCount: (prior?.rawCount ?? 0) + receipt.accepted,
            quarantinedCount:
              (prior?.quarantinedCount ?? 0) + receipt.quarantined,
            rejectedCount: (prior?.rejectedCount ?? 0) + receipt.rejected,
            governanceDenied:
              (prior?.governanceDenied ?? 0) + receipt.governanceDenied,
            duplicateCount: (prior?.duplicateCount ?? 0) + receipt.duplicate,
            usageQuantity:
              (prior?.usageQuantity ?? 0) + receipt.usageQuantity,
            costCents: (prior?.costCents ?? 0) + receipt.costCents,
            providers,
            provider: providers.join('+') || null,
          };
        } else if (usesRawGovernance) {
          quarantinedRaw += r.quarantinedCount;
          rejectedRaw += r.rejectedCount;
          duplicateRaw += r.duplicateCount;
          governanceDenied += r.quarantinedCount + r.rejectedCount;
          perSource[query.source_class] = {
            rawCount: r.rawCount,
            quarantinedCount: r.quarantinedCount,
            rejectedCount: r.rejectedCount,
            duplicateCount: r.duplicateCount,
            provider: r.provider,
          };
        } else {
          perSource[query.source_class] = { rawCount: r.rawCount, provider: r.provider };
        }
        // 某源打穿 run 预算 → 记账截断（run 收尾判 PARTIAL，绝不假 DONE）。
        if (r.budgetTruncated) discoveryBudgetTruncated = true;
        // BI-30：数据源已停用、查询被跳过 → 按原因计数（run 至少 PARTIAL，但不算失败）。
        if (isDiscoveryQuerySkipReason(r.skipReason)) {
          skippedQueries[r.skipReason] = (skippedQueries[r.skipReason] ?? 0) + 1;
          skippedQueryCount += 1;
        }
        // Absent in histories recorded before the counter existed: replays keep their status.
        modelExtractions = addQueryModelExtractions(modelExtractions, r.modelExtractions);
        previousQueryUnreplayable = false;
      } catch (err) {
        const unreplayable: boolean = isUnreplayableActivityFailure(err) && !previousQueryUnreplayable;
        if (!unreplayable && isExecutionControlError(err)) throw err;
        previousQueryUnreplayable = unreplayable;
        if (unreplayable) unreplayableQueries += 1;
        failures += 1;
        if (!usesQueryReceipts) {
          perSource[query.source_class] = {
            rawCount: 0,
            provider: null,
            error: 'QUERY_EXECUTION_FAILED',
          };
        }
      }
    }

    stage = 'canonicalize';
    const { companies, suppressed } = await acts.canonicalizeRun({ workspaceId, runId, ...authorityArgs });

    // 官网画像（G3 5.4b）：Fit 之前以已建档公司为主体抓首页与 Impressum（慢 → 长活动）；
    // 尽力而为，失败不影响 run 状态，控制错误照旧上抛。patch 守卫：旧历史重放不产生新命令。
    let websiteProfile: WebsiteProfileTotals = { profiled: 0, matched: 0 };
    if (patched(DISCOVERY_WEBSITE_PROFILE_PATCH)) {
      stage = 'websiteProfile';
      try {
        const profileArgs = { workspaceId, runId, icpId: input.icpId, ...authorityArgs };
        // Each activity hands the companies it did not reach to the next one; a spent run budget
        // ends the stage. A result recorded before the hand-off has no index and ends it too.
        let profileContinuation: { startIndex: number; previousUnreplayable: boolean } | undefined;
        do {
          const pass = await signalActs.profileWebsitesForRun(
            profileContinuation === undefined ? profileArgs : { ...profileArgs, ...profileContinuation },
          );
          websiteProfile =
            profileContinuation === undefined ? pass : addWebsiteProfilePass(websiteProfile, pass);
          profileContinuation =
            typeof pass.nextIndex === 'number' && !pass.budgetTruncated
              ? { startIndex: pass.nextIndex, previousUnreplayable: pass.previousUnreplayable === true }
              : undefined;
        } while (profileContinuation !== undefined);
      } catch (error) {
        if (isExecutionControlError(error)) throw error;
        /* 画像是 Fit 的补充证据，失败时 Fit 仍按已有信息判定 */
      }
    }

    // ICP 资格门：判定本次归一出的公司是否为该 ICP 的真实目标客户（评测驱动）
    stage = 'fit';
    const fitArgs = { workspaceId, runId, icpId: input.icpId, ...authorityArgs };
    // Each activity hands the companies it did not reach to the next one. A result recorded
    // before the hand-off has no cursor, so replaying that history schedules nothing new.
    let fit: FitTotals | undefined;
    let fitContinuation: { afterCompanyId: string; previousCallCut: boolean } | undefined;
    do {
      const pass = await modelActs.qualifyFitForRun(
        fitContinuation === undefined ? fitArgs : { ...fitArgs, ...fitContinuation },
      );
      fit = fit === undefined ? pass : addFitPass(fit, pass);
      fitContinuation =
        typeof pass.nextCompanyId === 'string'
          ? { afterCompanyId: pass.nextCompanyId, previousCallCut: pass.previousCallCut === true }
          : undefined;
    } while (fitContinuation !== undefined);

    // 富集（Waterfall 富化段）：只给过了本 run ICP fit 门的高价值公司补 GLEIF 法律身份 + 母子关系（快事实，2 分钟活动）
    stage = 'enrich';
    const enrichArgs = { workspaceId, runId, icpId: input.icpId, ...authorityArgs };
    // Like the fit pass, each enrich activity hands the companies it did not reach to the next
    // one, and a spent run budget ends the stage.
    let enrich: EnrichTotals | undefined;
    let enrichIndex: number | undefined;
    do {
      const pass = await acts.enrichRun(
        enrichIndex === undefined ? enrichArgs : { ...enrichArgs, startIndex: enrichIndex },
      );
      enrich = enrich === undefined ? pass : addEnrichPass(enrich, pass);
      enrichIndex = typeof pass.nextIndex === 'number' && !pass.budgetTruncated ? pass.nextIndex : undefined;
    } while (enrichIndex !== undefined);

    // 信号富集（数字足迹 + 结构化收割）：慢且时变，走独立长活动 + heartbeat；失败不拖垮整个 run
    let signals: {
      matched: number;
      enriched: number;
      provider: string | null;
      budgetTruncated?: boolean;
      skippedSubjects?: number;
      unreplayable?: number;
    } = {
      matched: 0,
      enriched: 0,
      provider: null,
    };
    stage = 'signals';
    try {
      signals = await signalActs.enrichSignalsRun({ workspaceId, runId, icpId: input.icpId, ...authorityArgs });
    } catch (error) {
      if (isExecutionControlError(error)) throw error;
      /* 信号富集是尽力而为的富化，失败不影响 run 状态 */
    }

    // 从 ICP 短名单自动注册网站变更监控（#4 loop）：对本 run ICP fit=match 公司建 web_watch，交给 intentSweep 持续盯变更。
    // best-effort（每家一次 sitemap 探测，慢）→ 长活动；失败不影响 run 状态。
    let watches: {
      candidates: number;
      registered: number;
      skippedSubjects?: number;
      unreplayable?: number;
    } = {
      candidates: 0,
      registered: 0,
    };
    stage = 'watches';
    try {
      watches = await signalActs.registerWatchesForRun({ workspaceId, runId, icpId: input.icpId, ...authorityArgs });
    } catch (error) {
      if (isExecutionControlError(error)) throw error;
      /* 监控注册是尽力而为的收口，失败不影响 run 状态 */
    }

    // 专利缓存冷启动预热（scale-safe #89）：对本 run fit=match 公司 enqueue patent_lookup_request，populates 刷新队列。
    // cheap upsert（非慢活动）→ 走常规 2 分钟活动；best-effort，失败不影响 run 状态。
    let patentEnqueue: { candidates: number; enqueued: number } = { candidates: 0, enqueued: 0 };
    stage = 'patentEnqueue';
    try {
      patentEnqueue = await acts.enqueuePatentLookupsForRun({ workspaceId, runId, icpId: input.icpId, ...authorityArgs });
    } catch (error) {
      if (isExecutionControlError(error)) throw error;
      /* 专利预热是尽力而为的收口，失败不影响 run 状态 */
    }

    // 预算截断的 run 绝不假 DONE（复审 HIGH）：**任一**预算消耗阶段打穿 run 预算 → PARTIAL——
    // fit 漏判 / 发现阶段 / 富集 / 信号富集，均共享同一 run 预算账户，各自 wasExhausted 检出并上报，
    // 编排层聚合（绝不因某阶段被 provider 吞掉 BudgetExceededError 而假 DONE）。截断量进 stats 可观测。
    const budgetTruncated =
      (fit.skippedForBudget ?? 0) > 0 ||
      discoveryBudgetTruncated ||
      enrich.budgetTruncated ||
      (signals.budgetTruncated ?? false) ||
      (websiteProfile.budgetTruncated ?? false);
    // G3 5.5：按公司跳过的被拒主体（tombstone/SUPPRESSED/失效）意味着漏了活儿 → 至少 PARTIAL。
    const skippedSubjects =
      (websiteProfile.skippedSubjects ?? 0) +
      (signals.skippedSubjects ?? 0) +
      (watches.skippedSubjects ?? 0);
    // Queries and companies skipped because an operation could not be replayed. Absent in
    // results recorded before the counters existed.
    const unreplayableSkips = {
      queries: unreplayableQueries,
      websiteProfile: websiteProfile.unreplayable ?? 0,
      fit: fit.unreplayable ?? 0,
      signals: signals.unreplayable ?? 0,
      watches: watches.unreplayable ?? 0,
    };
    const unreplayableSkipCount = Object.values(unreplayableSkips).reduce((sum, count) => sum + count, 0);
    let status = resolveRunStatus({
      failures,
      totalQueries: queries.length,
      budgetTruncated,
      skippedSubjects,
      // Absent in histories recorded before the counter existed: replays keep their status.
      fitUnjudged: fit.unjudged ?? 0,
      skippedQueries: skippedQueryCount,
      droppedExtractions: modelExtractions.failed,
      unreplayableSkips: unreplayableSkipCount,
    });
    if (usesRawGovernance && governanceDenied > 0) {
      status = acceptedRaw === 0 ? 'FAILED' : status === 'DONE' ? 'PARTIAL' : status;
    }
    // Every extraction the run made failed and nothing was accepted: an upstream outage, not a
    // thin market. FAILED keeps the plan READY for another run (BI-25) instead of consuming it.
    if (
      modelExtractions.invoked > 0 &&
      modelExtractions.failed === modelExtractions.invoked &&
      acceptedRaw === 0
    ) {
      status = 'FAILED';
    }
    outcome = {
      status,
      stats: {
        ...queryStats(),
        ...skipStats(),
        ...extractionStats(),
        // Shown only when a company was skipped, so runs without a skip keep their stats shape.
        ...(unreplayableSkipCount > 0 ? { unreplayableSkips } : {}),
        companies,
        suppressed,
        fit: fit.verdicts,
        fitSkippedForBudget: fit.skippedForBudget ?? 0,
        fitUnjudged: fit.unjudged ?? 0,
        // 预算截断按阶段拆开可观测（哪一路耗预算阶段打穿了 run 预算）+ 聚合总判。
        discoveryBudgetTruncated,
        enrichBudgetTruncated: enrich.budgetTruncated,
        signalsBudgetTruncated: signals.budgetTruncated ?? false,
        budgetTruncated,
        skippedSubjects,
        websiteProfile: {
          profiled: websiteProfile.profiled,
          matched: websiteProfile.matched,
          unclassified: websiteProfile.unclassified ?? 0,
        },
        enrich: { matched: enrich.matched, of: enrich.enriched, provider: enrich.provider },
        signals: { matched: signals.matched, of: signals.enriched, provider: signals.provider },
        watches: { registered: watches.registered, of: watches.candidates },
        patentEnqueue: { enqueued: patentEnqueue.enqueued, of: patentEnqueue.candidates },
        queries: queries.length,
        failures,
      },
    };
  } catch (error) {
    // BI-25：阶段失败（重试用尽、控制错误、超时或取消）不能让 run 永远停在 RUNNING。先记 FAILED
    // 再抛原错误，工作流照旧失败、控制错误照旧可见。只处理 Temporal 上报的失败：工作流代码自身的
    // 缺陷让工作流任务失败并重试，修好的版本还能接着跑，不在这里收尾。只在收尾之前的阶段生效：
    // 正常收尾本身失败时不再补写，免得覆盖一次可能已提交的结果。授权前的旧历史跳过（其
    // finalizeRun 会被 parked）；patch 守卫让旧历史重放时命令序列不变。补写放在不可取消的作用域里，
    // 取消的 run 也能收尾；补写失败时以阶段错误为准。
    if (
      error instanceof TemporalFailure &&
      usesAuthority &&
      patched(DISCOVERY_FAILURE_FINALIZE_PATCH)
    ) {
      try {
        await CancellationScope.nonCancellable(() =>
          finalize({
            status: 'FAILED',
            stats: {
              ...queryStats(),
              ...skipStats(),
              ...extractionStats(),
              queries: queryCount,
              failures,
              failure: describeDiscoveryRunFailure(stage, error),
            },
          }),
        );
      } catch {
        /* 阶段错误才是要报告的结果，收尾写入失败不能顶替它 */
      }
    }
    throw error;
  }
  await finalize(outcome);
}
