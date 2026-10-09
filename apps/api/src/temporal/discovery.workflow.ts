import { ApplicationFailure, patched, proxyActivities } from '@temporalio/workflow';
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

/**
 * Discover 编排（PRD 5.5 / 7.4.8 Waterfall 的发现段）：
 * READY 计划 → 按 priority 逐源执行（单源失败不终止整个 run → PARTIAL）→
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
  let stage: DiscoveryRunStage = 'plan';

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
      } catch (err) {
        if (isExecutionControlError(err)) throw err;
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
    let websiteProfile: {
      profiled: number;
      matched: number;
      skippedSubjects?: number;
      budgetTruncated?: boolean;
      unclassified?: number;
    } = { profiled: 0, matched: 0 };
    if (patched(DISCOVERY_WEBSITE_PROFILE_PATCH)) {
      stage = 'websiteProfile';
      try {
        websiteProfile = await signalActs.profileWebsitesForRun({
          workspaceId,
          runId,
          icpId: input.icpId,
          ...authorityArgs,
        });
      } catch (error) {
        if (isExecutionControlError(error)) throw error;
        /* 画像是 Fit 的补充证据，失败时 Fit 仍按已有信息判定 */
      }
    }

    // ICP 资格门：判定本次归一出的公司是否为该 ICP 的真实目标客户（评测驱动）
    stage = 'fit';
    const fit = await modelActs.qualifyFitForRun({ workspaceId, runId, icpId: input.icpId, ...authorityArgs });

    // 富集（Waterfall 富化段）：只给过了本 run ICP fit 门的高价值公司补 GLEIF 法律身份 + 母子关系（快事实，2 分钟活动）
    stage = 'enrich';
    const enrich = await acts.enrichRun({ workspaceId, runId, icpId: input.icpId, ...authorityArgs });

    // 信号富集（数字足迹 + 结构化收割）：慢且时变，走独立长活动 + heartbeat；失败不拖垮整个 run
    let signals: {
      matched: number;
      enriched: number;
      provider: string | null;
      budgetTruncated?: boolean;
      skippedSubjects?: number;
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
    let watches: { candidates: number; registered: number; skippedSubjects?: number } = {
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
    let status = resolveRunStatus({
      failures,
      totalQueries: queries.length,
      budgetTruncated,
      skippedSubjects,
      // Absent in histories recorded before the counter existed: replays keep their status.
      fitUnjudged: fit.unjudged ?? 0,
    });
    if (usesRawGovernance && governanceDenied > 0) {
      status = acceptedRaw === 0 ? 'FAILED' : status === 'DONE' ? 'PARTIAL' : status;
    }
    outcome = {
      status,
      stats: {
        ...queryStats(),
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
    // BI-25：阶段失败（重试用尽或控制错误）不能让 run 永远停在 RUNNING。先记 FAILED 再抛原错误，
    // 工作流照旧失败、控制错误照旧可见。只在收尾之前的阶段生效：正常收尾本身失败时不再补写，
    // 免得覆盖一次可能已提交的结果。授权前的旧历史跳过（其 finalizeRun 会被 parked）；
    // patch 守卫让旧历史重放时命令序列不变，补写失败时以阶段错误为准。
    if (usesAuthority && patched(DISCOVERY_FAILURE_FINALIZE_PATCH)) {
      try {
        await finalize({
          status: 'FAILED',
          stats: {
            ...queryStats(),
            queries: queryCount,
            failures,
            failure: describeDiscoveryRunFailure(stage, error),
          },
        });
      } catch {
        /* 阶段错误才是要报告的结果，收尾写入失败不能顶替它 */
      }
    }
    throw error;
  }
  await finalize(outcome);
}
