import { ApplicationFailure } from '@temporalio/workflow';
import type { PrismaService } from '../prisma/prisma.service';
import type { ModelGateway } from '../model-gateway/model-gateway';
import type { RuntimeTelemetry } from '../model-runtime/types';
import { executeStructuredTaskWithRuntime } from '../model-runtime/structured-task-runtime-bridge';
import { getTask } from '../ai-tasks/task-registry';
import {
  judgeFitCompany,
  loadIcpBrief,
  type FitJudgeCompany,
} from '../discovery/fit-judge';
import { companyMayUseExternalProcessing } from '../discovery/company-suppression-gate';
import {
  QUICK_JUDGE_BATCH_SIZE,
  QUICK_JUDGE_OUTPUT_SCHEMA,
  QUICK_SCAN_POOL_LIMIT,
  buildQuickJudgePrompt,
  parseQuickJudgeBatch,
  prefilterCompany,
  type PrefilterCompany,
  type QuickVerdict,
} from '../discovery/run2/quick-scan';
import { appendRunEvent } from '../discovery/run2/run-events';
import {
  parseExecutionBudgetBinding,
  type ExecutionBudgetBinding,
} from '../execution-budget/execution-budget-binding';
import { ExecutionControlError } from '../execution-budget/execution-control-error';
import { BudgetExceededError, BudgetOperationReplayError, type BudgetStore, UnavailableBudgetStore } from '../tools/budget-store';

export interface Run2ActivityInput {
  workspaceId: string;
  runId: string;
  icpId: string;
  executionContractVersion?: number;
  executionBudget?: unknown;
}

const CHUNK = 50;

function isQuickVerdict(value: string | null | undefined): value is QuickVerdict {
  return value === 'match' || value === 'weak' || value === 'mismatch';
}

/** 一次 run 的快扫三段：规则预筛 → 批量粗判（8 家/次，逐家降级）→ 临时候选落库。 */
export function createRun2Activities(deps: {
  prisma: PrismaService;
  gateway: ModelGateway;
  runtimeTelemetry?: RuntimeTelemetry;
  budgetStore?: BudgetStore;
}) {
  const budgets =
    deps.budgetStore ?? new UnavailableBudgetStore('run2 activities require an authoritative BudgetStore');

  const ensureRunBudget = async (args: Run2ActivityInput): Promise<ExecutionBudgetBinding> => {
    let binding: ExecutionBudgetBinding;
    try {
      if (args.executionContractVersion !== 2) throw new Error('invalid version');
      binding = parseExecutionBudgetBinding(args.executionBudget, {
        scopeKey: args.workspaceId,
        purpose: 'discovery.run',
        subjectType: 'discovery_run',
      });
    } catch {
      throw ApplicationFailure.nonRetryable(
        'EXECUTION_BUDGET_LEGACY_HISTORY_PARKED',
        'EXECUTION_BUDGET_LEGACY_HISTORY_PARKED',
      );
    }
    await budgets.attestAuthorized({
      authorityId: binding.authorityId,
      scopeKey: binding.scopeKey,
      accountKey: binding.accountKey,
    });
    return binding;
  };

  const mayUseExternalProcessing = (workspaceId: string, companyId: string): Promise<boolean> =>
    deps.prisma.withWorkspace(workspaceId, (tx) =>
      companyMayUseExternalProcessing(tx, workspaceId, companyId),
    );

  return {
    /**
     * 规则预筛（确定性、零模型）：把公司池里「本 ICP 从未判定过」的公司分成
     * prefiltered_out 与 queued 两类写进 discovery_company_job，受 500 家/run 上限约束。
     */
    async prefilterPool(
      args: Run2ActivityInput & { limit?: number },
    ): Promise<{ poolSize: number; candidates: number; prefilteredOut: number }> {
      await ensureRunBudget(args);
      const limit = Math.min(Math.max(args.limit ?? QUICK_SCAN_POOL_LIMIT, 1), QUICK_SCAN_POOL_LIMIT);

      const { rules, poolSize, companies } = await deps.prisma.withWorkspace(
        args.workspaceId,
        async (tx) => {
          const rules = await tx.qualificationRule.findMany({
            where: { icpId: args.icpId },
            select: { id: true, kind: true, field: true, operator: true, value: true, weight: true },
          });
          const where = {
            status: { not: 'SUPPRESSED' as const },
            NOT: { leads: { some: { icpId: args.icpId, fitVerdict: { not: null } } } },
          };
          const poolSize = await tx.canonicalCompany.count({ where });
          const companies = await tx.canonicalCompany.findMany({
            where,
            orderBy: [{ lastSeenAt: { sort: 'desc' as const, nulls: 'last' as const } }, { createdAt: 'desc' as const }],
            take: limit,
            select: {
              id: true,
              name: true,
              domain: true,
              country: true,
              industry: true,
              employeeCount: true,
              revenueUsd: true,
              attributes: true,
            },
          });
          return { rules, poolSize, companies };
        },
      );

      let candidates = 0;
      let prefilteredOut = 0;
      for (let start = 0; start < companies.length; start += CHUNK) {
        const chunk = companies.slice(start, start + CHUNK);
        const decisions = chunk.map((company) => ({
          company,
          decision: prefilterCompany(rules, company as PrefilterCompany),
        }));
        await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
          for (const { company, decision } of decisions) {
            await tx.discoveryCompanyJob.upsert({
              where: {
                workspaceId_runId_canonicalCompanyId: {
                  workspaceId: args.workspaceId,
                  runId: args.runId,
                  canonicalCompanyId: company.id,
                },
              },
              update: {},
              create: {
                workspaceId: args.workspaceId,
                runId: args.runId,
                canonicalCompanyId: company.id,
                stage: decision.decision === 'candidate' ? 'queued' : 'prefiltered_out',
              },
            });
            if (decision.decision === 'candidate') {
              candidates += 1;
            } else {
              prefilteredOut += 1;
              await appendRunEvent(tx as never, {
                workspaceId: args.workspaceId,
                runId: args.runId,
                type: 'company_done',
                payload: {
                  companyId: company.id,
                  stage: 'prefiltered_out',
                  verdict: decision.verdict,
                },
              });
            }
          }
        });
      }

      await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        appendRunEvent(tx as never, {
          workspaceId: args.workspaceId,
          runId: args.runId,
          type: 'phase_started',
          payload: { phase: 'quick', poolSize, candidates, prefilteredOut },
        }),
      );

      return { poolSize, candidates, prefilteredOut };
    },

    /**
     * 批量粗判：8 家/次（flash），解析失败或单家缺失 → 逐家判定降级；
     * 模型整体不可用 → 规则兜底判 weak（名单照出，人工复核，Q20）。
     * 预算截断/控制错误照旧上抛，由工作流判 PARTIAL。
     */
    async quickJudgeBatch(args: Run2ActivityInput): Promise<{
      judged: number;
      verdicts: Record<string, number>;
      fallbackPerCompany: number;
      ruleFallback: number;
      failed: number;
      skipped: number;
    }> {
      const binding = await ensureRunBudget(args);
      const { jobs, companies, icpBrief } = await deps.prisma.withWorkspace(
        args.workspaceId,
        async (tx) => {
          const jobs = await tx.discoveryCompanyJob.findMany({
            where: { runId: args.runId, stage: 'queued' },
            orderBy: { createdAt: 'asc' },
            take: QUICK_SCAN_POOL_LIMIT,
            select: { id: true, canonicalCompanyId: true },
          });
          const ids = jobs.map((job) => job.canonicalCompanyId);
          const companies = ids.length
            ? await tx.canonicalCompany.findMany({
                where: { id: { in: ids } },
                select: {
                  id: true,
                  name: true,
                  domain: true,
                  country: true,
                  industry: true,
                  employeeCount: true,
                  revenueUsd: true,
                  attributes: true,
                },
              })
            : [];
          const icpBrief = ids.length ? await loadIcpBrief(tx, args.icpId) : {};
          return { jobs, companies, icpBrief };
        },
      );

      const companyById = new Map(companies.map((company) => [company.id, company]));
      const targets = jobs
        .map((job) => ({ job, company: companyById.get(job.canonicalCompanyId) }))
        .filter(
          (entry): entry is { job: (typeof jobs)[number]; company: (typeof companies)[number] } =>
            entry.company !== undefined,
        );

      const verdicts: Record<string, number> = {};
      let judged = 0;
      let fallbackPerCompany = 0;
      let ruleFallback = 0;
      let failed = 0;
      let skipped = 0;

      const task = getTask('discovery.qualify_fit')!;

      const judgeOne = async (
        company: (typeof companies)[number],
      ): Promise<QuickVerdict | null> => {
        const judgment = await judgeFitCompany(deps.gateway, args.workspaceId, icpBrief, company as FitJudgeCompany, {
          runId: binding.accountKey,
          runtimeTelemetry: deps.runtimeTelemetry,
          authorizeExternalAction: () => mayUseExternalProcessing(args.workspaceId, company.id),
        });
        return judgment?.verdict ?? null;
      };

      const settle = async (
        batch: Array<{ job: (typeof jobs)[number]; company: (typeof companies)[number] }>,
        outcomes: Map<string, { verdict: QuickVerdict; via: 'batch' | 'single' | 'rule_fallback' } | { skip: true }>,
      ): Promise<void> => {
        await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
          for (const { job, company } of batch) {
            const outcome = outcomes.get(company.id);
            if (!outcome) {
              failed += 1;
              await tx.discoveryCompanyJob.update({
                where: { id: job.id },
                data: { attempts: { increment: 1 }, lastErrorCode: 'QUICK_JUDGE_FAILED' },
              });
              await appendRunEvent(tx as never, {
                workspaceId: args.workspaceId,
                runId: args.runId,
                level: 'warn',
                type: 'company_failed',
                payload: { companyId: company.id, stage: 'quick_judged', error: 'QUICK_JUDGE_FAILED' },
              });
              continue;
            }
            if ('skip' in outcome) {
              skipped += 1;
              await tx.discoveryCompanyJob.update({
                where: { id: job.id },
                data: { stage: 'skipped', finishedAt: new Date() },
              });
              continue;
            }
            judged += 1;
            verdicts[outcome.verdict] = (verdicts[outcome.verdict] ?? 0) + 1;
            if (outcome.via === 'single') fallbackPerCompany += 1;
            if (outcome.via === 'rule_fallback') ruleFallback += 1;
            await tx.discoveryCompanyJob.update({
              where: { id: job.id },
              data: {
                stage: 'quick_judged',
                verdictQuick: outcome.verdict,
                attempts: { increment: 1 },
                finishedAt: new Date(),
              },
            });
            await appendRunEvent(tx as never, {
              workspaceId: args.workspaceId,
              runId: args.runId,
              type: 'company_done',
              payload: {
                companyId: company.id,
                stage: 'quick_judged',
                verdict: outcome.verdict,
                via: outcome.via,
              },
            });
          }
        });
      };

      for (let start = 0; start < targets.length; start += QUICK_JUDGE_BATCH_SIZE) {
        const batch = targets.slice(start, start + QUICK_JUDGE_BATCH_SIZE);
        const outcomes = new Map<
          string,
          { verdict: QuickVerdict; via: 'batch' | 'single' | 'rule_fallback' } | { skip: true }
        >();

        // 逐家外部处理闸门（禁联/主体失效）：不放行的直接 skipped，不进模型批量。
        const eligible: typeof batch = [];
        for (const entry of batch) {
          if (await mayUseExternalProcessing(args.workspaceId, entry.company.id)) {
            eligible.push(entry);
          } else {
            outcomes.set(entry.company.id, { skip: true });
          }
        }

        let batchVerdicts: Array<QuickVerdict | null> = [];
        const batchResolved = new Set<number>();
        if (eligible.length > 0) {
          if (eligible.length === 1) {
            // 单家批次不值得批量协议，直接走单家判定。
            batchVerdicts = [await judgeOne(eligible[0]!.company)];
          } else {
            try {
              const result = await executeStructuredTaskWithRuntime<{ judgments?: unknown }>(
                deps.gateway,
                {
                  task: task.id,
                  prompt: buildQuickJudgePrompt(icpBrief, eligible.map((entry) => entry.company as PrefilterCompany)),
                  system: task.description,
                  model: task.model,
                  schema: QUICK_JUDGE_OUTPUT_SCHEMA,
                },
                {
                  workspaceId: args.workspaceId,
                  runId: binding.accountKey,
                  // 批量协议暂无 durable 投影（逐家降级路径才带 fit-judgment/v1 回执）：
                  // 批量结果在活动内立即落库；活动崩溃重试至多重打一次这一批（≤8 家）的模型费用。
                  authorizeExternalAction: () => Promise.resolve(true),
                },
                { telemetry: deps.runtimeTelemetry },
              );
              batchVerdicts = parseQuickJudgeBatch(result.data, eligible.length);
              batchVerdicts.forEach((verdict, index) => {
                if (verdict) batchResolved.add(index);
              });
            } catch (error) {
              if (
                error instanceof BudgetExceededError ||
                error instanceof BudgetOperationReplayError ||
                error instanceof ExecutionControlError
              ) {
                throw error;
              }
              batchVerdicts = eligible.map(() => null); // 整批不可用 → 全批逐家降级
            }
          }
        }

        for (const [index, entry] of eligible.entries()) {
          const verdict = batchVerdicts[index] ?? null;
          if (verdict) {
            outcomes.set(entry.company.id, {
              verdict,
              via: batchResolved.has(index) ? 'batch' : 'single',
            });
            continue;
          }
          // 降级①：逐家判定（沿用同一四门 prompt 与预算账户）。
          try {
            const single = await judgeOne(entry.company);
            if (single) {
              outcomes.set(entry.company.id, { verdict: single, via: 'single' });
              continue;
            }
          } catch (error) {
            if (
              error instanceof BudgetExceededError ||
              error instanceof BudgetOperationReplayError ||
              error instanceof ExecutionControlError
            ) {
              throw error;
            }
          }
          // 降级②：模型不可用 → 规则兜底出名单（weak，人工复核）。
          outcomes.set(entry.company.id, { verdict: 'weak', via: 'rule_fallback' });
        }

        await settle(batch, outcomes);
      }

      await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        appendRunEvent(tx as never, {
          workspaceId: args.workspaceId,
          runId: args.runId,
          type: 'phase_completed',
          payload: { phase: 'quick', judged, verdicts, fallbackPerCompany, ruleFallback, failed, skipped },
        }),
      );

      return { judged, verdicts, fallbackPerCompany, ruleFallback, failed, skipped };
    },

    /** M0⑥：记录阶段时间戳到 discovery_run.phases（DB/活动时间，回放安全）。 */
    async markRunPhase(args: { workspaceId: string; runId: string;
      phase: 'quick_started' | 'quick_done' | 'deep_started' | 'deep_done';
    }): Promise<void> {
      await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const run = await tx.discoveryRun.findUnique({
          where: { id: args.runId },
          select: { phases: true },
        });
        if (!run) return;
        const phases =
          run.phases && typeof run.phases === 'object' && !Array.isArray(run.phases)
            ? { ...(run.phases as Record<string, unknown>) }
            : {};
        const phaseKey = {
          quick_started: 'quickStartedAt',
          quick_done: 'quickDoneAt',
          deep_started: 'deepStartedAt',
          deep_done: 'deepDoneAt',
        }[args.phase];
        phases[phaseKey] = new Date().toISOString();
        await tx.discoveryRun.update({
          where: { id: args.runId },
          data: { phases: phases as never },
        });
      });
    },

    /** M0⑥ 告警：run 从创建到现在的分钟数（DB 读数，活动返回值记录在历史里，回放安全）。 */
    async runElapsedMinutes(args: { workspaceId: string; runId: string }): Promise<{ minutes: number }> {
      return deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const run = await tx.discoveryRun.findUnique({
          where: { id: args.runId },
          select: { createdAt: true },
        });
        if (!run) return { minutes: 0 };
        return { minutes: Math.max(0, Math.round((Date.now() - run.createdAt.getTime()) / 60_000)) };
      });
    },

    /**
     * M0⑥ 影子对比：同一 run 上旧判定（legacy fit 写进 Lead 的 verdict，排除快扫占位）
     * vs 新快扫判定（discovery_company_job.verdict_quick）的召回与一致率。
     * 只存聚合计数；连续两轮 shadowPositive ≥ legacyPositive 才切默认（台账可查 run_shadow_diff）。
     */
    async recordRunShadowDiff(args: Run2ActivityInput & { shadowFallback: number }): Promise<{
      legacyJudged: number;
      legacyPositive: number;
      shadowJudged: number;
      shadowPositive: number;
      agreement: number;
      compared: number;
      recallNotLower: boolean;
    }> {
      const { leads, jobs } = await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const leads = await tx.lead.findMany({
          where: { icpId: args.icpId, fitVerdict: { not: null } },
          select: { canonicalCompanyId: true, fitVerdict: true, fitReasons: true },
        });
        const jobs = await tx.discoveryCompanyJob.findMany({
          where: { runId: args.runId, verdictQuick: { not: null } },
          select: { canonicalCompanyId: true, verdictQuick: true },
        });
        return { leads, jobs };
      });
      const isProvisional = (reasons: unknown): boolean =>
        Boolean(reasons && typeof reasons === 'object' && (reasons as { source?: unknown }).source === 'quick_scan');
      const legacy = leads.filter((lead) => !isProvisional(lead.fitReasons));
      const legacyByCompany = new Map(legacy.map((lead) => [lead.canonicalCompanyId, lead.fitVerdict]));
      const shadowByCompany = new Map(jobs.map((job) => [job.canonicalCompanyId, job.verdictQuick]));
      const positive = (verdict: string | null | undefined): boolean =>
        verdict === 'match' || verdict === 'weak';
      const comparedIds = [...legacyByCompany.keys()].filter((id) => shadowByCompany.has(id));
      const agreement = comparedIds.filter(
        (id) => legacyByCompany.get(id) === shadowByCompany.get(id),
      ).length;
      const summary = {
        legacyJudged: legacy.length,
        legacyPositive: legacy.filter((lead) => positive(lead.fitVerdict)).length,
        shadowJudged: jobs.length,
        shadowPositive: jobs.filter((job) => positive(job.verdictQuick)).length,
        agreement,
        compared: comparedIds.length,
        shadowFallback: Math.max(0, Math.trunc(args.shadowFallback)),
      };
      await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        tx.runShadowDiff.upsert({
          where: { runId: args.runId },
          create: { workspaceId: args.workspaceId, runId: args.runId, ...summary },
          update: summary,
        }),
      );
      return { ...summary, recallNotLower: summary.shadowPositive >= summary.legacyPositive };
    },

    /**
     * 临时候选物化：quick_judged 的 match/weak 幂等 upsert 成 Lead（queue=needs_review，
     * fitReasons.source=quick_scan）。深挖阶段（M0④）会用完整四门理由覆盖这条记录。
     */
    async materializeProvisionalLeads(
      args: Run2ActivityInput,
    ): Promise<{ leads: number }> {
      await ensureRunBudget(args);
      return deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const jobs = await tx.discoveryCompanyJob.findMany({
          where: { runId: args.runId, stage: 'quick_judged' },
          select: { canonicalCompanyId: true, verdictQuick: true },
        });
        let leads = 0;
        for (const job of jobs) {
          if (!isQuickVerdict(job.verdictQuick) || job.verdictQuick === 'mismatch') continue;
          const verdict = job.verdictQuick;
          await tx.lead.upsert({
            where: {
              workspaceId_icpId_canonicalCompanyId: {
                workspaceId: args.workspaceId,
                icpId: args.icpId,
                canonicalCompanyId: job.canonicalCompanyId,
              },
            },
            update: {
              fitVerdict: verdict,
              fitReasons: { source: 'quick_scan', tier: 'quick' } as never,
              version: { increment: 1 },
            },
            create: {
              workspaceId: args.workspaceId,
              icpId: args.icpId,
              canonicalCompanyId: job.canonicalCompanyId,
              fitVerdict: verdict,
              fitReasons: { source: 'quick_scan', tier: 'quick' } as never,
              queue: 'needs_review',
            },
          });
          leads += 1;
        }
        return { leads };
      });
    },
  };
}

export type Run2Activities = ReturnType<typeof createRun2Activities>;
