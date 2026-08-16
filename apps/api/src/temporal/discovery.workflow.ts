import { log, patched, proxyActivities } from '@temporalio/workflow';
import type {
  DiscoveryActivities,
  DiscoveryRunInput,
  ProviderExecutionStats,
} from './discovery.activities';
import { resolveRunStatus } from './discovery.run-status';
import type { ProviderIdentityQuality } from '../discovery/provider-identity-quality';

const acts = proxyActivities<DiscoveryActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3 },
});

// 信号富集是**慢活动**（抓官网/sitemap，逐家数十秒）：单独长超时代理，绝不用上面的 2 分钟超时
// （否则会超时重试整段富集）。工作量有界（SIGNAL_ENRICH_LIMIT 家 × 逐家有 AbortSignal 超时），30 分钟足够。
const signalActs = proxyActivities<DiscoveryActivities>({
  startToCloseTimeout: '30 minutes',
  retry: { maximumAttempts: 2 },
});

// Run terminalization must outlive ordinary activity retries. If a transient
// database/control-plane incident exhausts a business activity, this activity
// keeps retrying long enough to persist the domain terminal state once storage
// is available again.
const terminalActs = proxyActivities<DiscoveryActivities>({
  startToCloseTimeout: '2 minutes',
  scheduleToCloseTimeout: '30 minutes',
  retry: {
    maximumAttempts: 20,
    initialInterval: '1 second',
    maximumInterval: '1 minute',
  },
});

type FatalStage =
  | 'reset_run_budget'
  | 'expire_raw_source_records'
  | 'load_plan_queries'
  | 'canonicalize_run'
  | 'enrich_fit_evidence'
  | 'qualify_fit'
  | 'enrich_run';

type DiscoveryOutcome = {
  status: 'DONE' | 'PARTIAL' | 'FAILED';
  stats: Record<string, unknown>;
};

function emptyProviderExecutionStats(): ProviderExecutionStats {
  return {
    attemptedCount: 0,
    successCount: 0,
    zeroResultCount: 0,
    failureCount: 0,
    rawCount: 0,
    quarantinedCount: 0,
    rejectedCount: 0,
    duplicateCount: 0,
  };
}

function addProviderExecutionStats(
  target: Record<string, ProviderExecutionStats>,
  additions: Record<string, ProviderExecutionStats> | undefined,
): void {
  for (const [providerKey, next] of Object.entries(additions ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const total = target[providerKey] ?? emptyProviderExecutionStats();
    target[providerKey] = total;
    total.attemptedCount += next.attemptedCount;
    total.successCount += next.successCount;
    total.zeroResultCount += next.zeroResultCount;
    total.failureCount += next.failureCount;
    total.rawCount += next.rawCount;
    total.quarantinedCount += next.quarantinedCount;
    total.rejectedCount += next.rejectedCount;
    total.duplicateCount += next.duplicateCount;
  }
}

function addProviderIdentityQuality(
  target: Record<string, ProviderIdentityQuality>,
  additions: Record<string, ProviderIdentityQuality> | undefined,
): void {
  for (const [providerKey, next] of Object.entries(additions ?? {})) {
    const current = target[providerKey];
    if (!current) {
      target[providerKey] = { ...next };
      continue;
    }
    for (const key of [
      'acceptedRows', 'namedRows', 'domainRows', 'authorityIdentifierRows',
      'officialRegistrationRows', 'boundRows', 'conflictRows', 'suppressedRows',
      'replayedRows',
    ] as const) {
      current[key] += next[key];
    }
    // The directory Raw and its submissions observation intentionally bind
    // the same company, so summing per-phase distinct counts would overstate
    // the number of organizations reached.
    current.uniqueCompanies = Math.max(current.uniqueCompanies, next.uniqueCompanies);
  }
}

function safeFailureIdentity(error: unknown): {
  errorType: string;
  errorCode: string | null;
} {
  let current: unknown = error;
  let errorType = 'UnknownError';
  let errorCode: string | null = null;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (typeof candidate.name === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u.test(candidate.name)) {
      errorType = candidate.name;
    }
    if (typeof candidate.code === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u.test(candidate.code)) {
      errorCode = candidate.code;
    }
    current = candidate.cause;
  }
  return { errorType, errorCode };
}

/**
 * Discover 编排（PRD 5.5 / 7.4.8 Waterfall 的发现段）：
 * READY 计划 → 按 priority 逐源执行（单源失败不终止整个 run → PARTIAL）→
 * 归一 + 身份解析 + Suppression → 收尾（计划 EXECUTED + DiscoveryRunCompleted 事件）。
 * 联系人发现/邮箱验证是后续按需步骤（仅对高价值企业，Waterfall 第 5/7 步），不在此。
 */
export async function discoveryWorkflow(input: DiscoveryRunInput): Promise<void> {
  let stage: FatalStage = 'reset_run_budget';
  let outcome: DiscoveryOutcome;
  try {
    outcome = await executeDiscovery(input, (next) => {
      stage = next;
    });
  } catch (error) {
    const failure = { stage, ...safeFailureIdentity(error) };
    log.error('discovery workflow failed before normal finalization', {
      workspaceId: input.workspaceId,
      runId: input.runId,
      ...failure,
    });
    await terminalActs.finalizeRun({
      workspaceId: input.workspaceId,
      runId: input.runId,
      planId: input.planId,
      icpId: input.icpId,
      status: 'FAILED',
      stats: { failure },
    });
    return;
  }

  await terminalActs.finalizeRun({
    workspaceId: input.workspaceId,
    runId: input.runId,
    planId: input.planId,
    icpId: input.icpId,
    status: outcome.status,
    stats: outcome.stats,
  });
}

async function executeDiscovery(
  input: DiscoveryRunInput,
  setStage: (stage: FatalStage) => void,
): Promise<DiscoveryOutcome> {
  const { workspaceId, runId, planId } = input;
  const perSource: Record<
    string,
    {
      rawCount: number;
      quarantinedCount: number;
      rejectedCount: number;
      duplicateCount: number;
      provider: string | null;
      failedProviderCount: number;
      paginationTruncated: boolean;
      error?: string;
    }
  > = {};
  const perProvider: Record<string, ProviderExecutionStats> = {};
  let failures = 0;
  let discoveryBudgetTruncated = false;
  let dataQualityBlocked = false;
  // Keep replay of histories created before provider-keyed execution facts
  // byte-for-byte compatible at the terminal finalize activity boundary.
  const providerExecutionStatsEnabled = patched('provider-execution-stats-v1');

  // 起始清账：同 runId 重试时，清除上次崩溃 attempt 残留的预算账户/打穿标记（否则首个 executeQuery 误报截断）。
  setStage('reset_run_budget');
  await acts.resetRunBudget({ runId });

  // New histories sweep bounded expired Raw payloads. The patch keeps replay of
  // pre-v2 workflow histories deterministic (their command sequence is unchanged).
  let rawRetention = { expired: 0, deferredForConflict: 0 };
  if (patched('raw-source-v2-retention-v1')) {
    setStage('expire_raw_source_records');
    rawRetention = await acts.expireRawSourceRecords({
      workspaceId,
      limit: 200,
    });
  }

  setStage('load_plan_queries');
  const { queries } = await acts.loadPlanQueries({ workspaceId, planId });
  for (const query of queries) {
    try {
      const r = await acts.executeQuery({ workspaceId, runId, query });
      perSource[query.source_class] = {
        rawCount: r.rawCount,
        quarantinedCount: r.quarantinedCount,
        rejectedCount: r.rejectedCount,
        duplicateCount: r.duplicateCount,
        provider: r.provider,
        failedProviderCount: r.failedProviderCount ?? 0,
        paginationTruncated: r.paginationTruncated ?? false,
      };
      if (providerExecutionStatsEnabled) addProviderExecutionStats(perProvider, r.perProvider);
      if (r.quarantinedCount > 0 || r.rejectedCount > 0) dataQualityBlocked = true;
      if ((r.failedProviderCount ?? 0) > 0) {
        // 本 query 一条都没拿到且有 Provider 失败：按 query 失败计，唯一源时最终 FAILED。
        // 其他 Provider 仍返回了数据：保留部分结果，但运行只能是 PARTIAL。
        if (r.rawCount === 0) failures += 1;
        else dataQualityBlocked = true;
      }
      if (r.paginationTruncated) dataQualityBlocked = true;
      // 某源打穿 run 预算 → 记账截断（run 收尾判 PARTIAL，绝不假 DONE）。
      if (r.budgetTruncated) discoveryBudgetTruncated = true;
    } catch (err) {
      failures += 1;
      perSource[query.source_class] = {
        rawCount: 0,
        quarantinedCount: 0,
        rejectedCount: 0,
        duplicateCount: 0,
        provider: null,
        failedProviderCount: 1,
        paginationTruncated: false,
        error: String(err).slice(0, 200),
      };
    }
  }

  setStage('canonicalize_run');
  const canonicalized = await acts.canonicalizeRun({
    workspaceId,
    runId,
  });
  const {
    companies,
    suppressed,
    manualFollowup = 0,
  } = canonicalized;
  const identityQuality = Object.fromEntries(
    Object.entries(canonicalized.identityQuality ?? {}).map(([key, value]) => [key, { ...value }]),
  ) as Record<string, ProviderIdentityQuality>;

  // 新历史先用 Wikidata + 官网结构化数据补一层低成本公开事实，再让 fit 判定。旧 Temporal 历史没有这个
  // activity command，必须用 patch 保持 replay 确定性；默认 enrichRun 仍是 fit 后深度富集。
  let fitEvidence: {
    matched: number;
    enriched: number;
    provider: string | null;
    budgetTruncated: boolean;
    dataQualityBlocked?: boolean;
    perProvider?: Record<string, ProviderExecutionStats>;
    identityQuality?: Record<string, ProviderIdentityQuality>;
  } = {
    matched: 0,
    enriched: 0,
    provider: null as string | null,
    budgetTruncated: false,
  };
  if (patched('discovery-prefit-evidence-v1')) {
    setStage('enrich_fit_evidence');
    // 官网渲染最慢可达 75s，用现有信号长活动代理，不被普通 2m 活动误判超时。
    fitEvidence = await signalActs.enrichRun({
      workspaceId,
      runId,
      icpId: input.icpId,
      phase: 'pre_fit_evidence',
    });
    if (providerExecutionStatsEnabled) addProviderExecutionStats(perProvider, fitEvidence.perProvider);
    addProviderIdentityQuality(identityQuality, fitEvidence.identityQuality);
    if (fitEvidence.dataQualityBlocked) dataQualityBlocked = true;
  }

  // ICP 资格门：判定本次归一出的公司是否为该 ICP 的真实目标客户（评测驱动）
  setStage('qualify_fit');
  const fit = await acts.qualifyFitForRun({
    workspaceId,
    runId,
    icpId: input.icpId,
  });
  // 单家 fit 失败是可恢复的部分失败：已获取的 Raw/Canonical 仍保留，
  // 但 run 必须显式 PARTIAL，绝不能用 DONE + failures=0 伪装完整闭环。
  const fitFailures = fit.failed ?? 0;

  // 富集（Waterfall 富化段）：只给过了本 run ICP fit 门的高价值公司补 GLEIF 法律身份 + 母子关系（快事实，2 分钟活动）
  setStage('enrich_run');
  const enrich = await acts.enrichRun({
    workspaceId,
    runId,
    icpId: input.icpId,
  });
  if (providerExecutionStatsEnabled) addProviderExecutionStats(perProvider, enrich.perProvider);
  addProviderIdentityQuality(identityQuality, enrich.identityQuality);
  if (enrich.dataQualityBlocked) dataQualityBlocked = true;

  // 信号富集（数字足迹 + 结构化收割）：慢且时变，走独立长活动 + heartbeat；失败不拖垮整个 run
  let signals: {
    matched: number;
    enriched: number;
    provider: string | null;
    budgetTruncated?: boolean;
  } = {
    matched: 0,
    enriched: 0,
    provider: null,
  };
  try {
    signals = await signalActs.enrichSignalsRun({
      workspaceId,
      runId,
      icpId: input.icpId,
    });
  } catch {
    /* 信号富集是尽力而为的富化，失败不影响 run 状态 */
  }

  // 从 ICP 短名单自动注册网站变更监控（#4 loop）：对本 run ICP fit=match 公司建 web_watch，交给 intentSweep 持续盯变更。
  // best-effort（每家一次 sitemap 探测，慢）→ 长活动；失败不影响 run 状态。
  let watches: { candidates: number; registered: number } = {
    candidates: 0,
    registered: 0,
  };
  try {
    watches = await signalActs.registerWatchesForRun({
      workspaceId,
      runId,
      icpId: input.icpId,
    });
  } catch {
    /* 监控注册是尽力而为的收口，失败不影响 run 状态 */
  }

  // 专利缓存冷启动预热（scale-safe #89）：对本 run fit=match 公司 enqueue patent_lookup_request，populates 刷新队列。
  // cheap upsert（非慢活动）→ 走常规 2 分钟活动；best-effort，失败不影响 run 状态。
  let patentEnqueue: { candidates: number; enqueued: number } = {
    candidates: 0,
    enqueued: 0,
  };
  try {
    patentEnqueue = await acts.enqueuePatentLookupsForRun({
      workspaceId,
      runId,
      icpId: input.icpId,
    });
  } catch {
    /* 专利预热是尽力而为的收口，失败不影响 run 状态 */
  }

  // 预算截断的 run 绝不假 DONE（复审 HIGH）：**任一**预算消耗阶段打穿 run 预算 → PARTIAL——
  // fit 漏判 / 发现阶段 / 富集 / 信号富集，均共享同一 run 预算账户，各自 wasExhausted 检出并上报，
  // 编排层聚合（绝不因某阶段被 provider 吞掉 BudgetExceededError 而假 DONE）。截断量进 stats 可观测。
  const budgetTruncated =
    (fit.skippedForBudget ?? 0) > 0 ||
    discoveryBudgetTruncated ||
    fitEvidence.budgetTruncated ||
    enrich.budgetTruncated ||
    (signals.budgetTruncated ?? false);
  const status = resolveRunStatus({
    failures,
    totalQueries: queries.length,
    budgetTruncated,
    dataQualityBlocked: dataQualityBlocked || fitFailures > 0 || manualFollowup > 0,
  });
  const totalFailures = failures + fitFailures;
  return {
    status,
    stats: {
      perSource,
      ...(providerExecutionStatsEnabled
        ? {
            perProvider: Object.fromEntries(
              Object.entries(perProvider).sort(([left], [right]) =>
                left < right ? -1 : left > right ? 1 : 0,
              ),
            ),
          }
        : {}),
      companies,
      suppressed,
      manualFollowup,
      identityQuality,
      fit: fit.verdicts,
      fitSkippedForBudget: fit.skippedForBudget ?? 0,
      // 预算截断按阶段拆开可观测（哪一路耗预算阶段打穿了 run 预算）+ 聚合总判。
      discoveryBudgetTruncated,
      fitEvidenceBudgetTruncated: fitEvidence.budgetTruncated,
      enrichBudgetTruncated: enrich.budgetTruncated,
      signalsBudgetTruncated: signals.budgetTruncated ?? false,
      budgetTruncated,
      dataQualityBlocked,
      rawRetention,
      fitEvidence: {
        matched: fitEvidence.matched,
        of: fitEvidence.enriched,
        provider: fitEvidence.provider,
      },
      enrich: {
        matched: enrich.matched,
        of: enrich.enriched,
        provider: enrich.provider,
      },
      signals: {
        matched: signals.matched,
        of: signals.enriched,
        provider: signals.provider,
      },
      watches: { registered: watches.registered, of: watches.candidates },
      patentEnqueue: {
        enqueued: patentEnqueue.enqueued,
        of: patentEnqueue.candidates,
      },
      queries: queries.length,
      sourceFailures: failures,
      fitFailures,
      failures: totalFailures,
    },
  };
}
