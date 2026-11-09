import { createHash } from 'node:crypto';
import { Context } from '@temporalio/activity';
import { CancelledFailure } from '@temporalio/common';
import { ApplicationFailure } from '@temporalio/workflow';
import { FAILURE_CODES, type FailureCode } from '../discovery/judgment/failure-codes';
import { classifyPipelineFailure } from './pipeline-failure-taxonomy';
import { AGENT_KEYS } from '../agents/agent-catalog';
import { AGENT_DECISION_TYPES } from '../agents/agent-runtime';
import {
  resolveAgentRound,
  verifyAgentSkills,
  type AgentRoundRuntime,
} from '../agents/agent-round';
import type { PrismaService } from '../prisma/prisma.service';
import type { ModelGateway } from '../model-gateway/model-gateway';
import type { RuntimeTelemetry } from '../model-runtime/types';
import { getTask } from '../ai-tasks/task-registry';
import {
  judgeFitCompany,
  loadIcpBrief,
  persistJudgmentRecordInTransaction,
  type FitJudgeCompany,
} from '../discovery/fit-judge';
import { judgeContractMode } from '../discovery/fit-judge-v2';
import {
  evaluateL0Gates,
  quickScanGateBlock,
  type GateBlock,
} from '../discovery/judgment/gate-chain';
import {
  executeSkillWithRuntime,
  SkillUnavailableError,
  STATIC_SKILL_RESOLVER,
  type SkillResolver,
} from '../skills/skill-runtime';
import {
  companyMayUseExternalProcessing,
  companyMayUseExternalProcessingMany,
} from '../discovery/company-suppression-gate';
import { ExternalActionDeniedError } from '../model-gateway/providers/provider-output-error';
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

/**
 * P3 J02 W4：快扫活动的心跳/取消门。
 * 单元测试与脚本会直接调用工厂返回的活动函数（没有 Temporal 活动上下文），
 * 此时 `Context.current()` 抛 `Activity context not initialized` —— 返回 null，
 * 心跳与取消检查跳过，行为与旧版一致。
 */
function currentActivityContext(): Context | null {
  try {
    return Context.current();
  } catch {
    return null;
  }
}

/** 取消了就抛 CancelledFailure：worker 在 cancellationSignal.aborted 时把活动记为 CANCELLED。 */
function throwIfActivityCancelled(context: Context | null): void {
  if (context?.cancellationSignal.aborted) {
    throw new CancelledFailure('QUICK_JUDGE_CANCELLED');
  }
}

/** 快扫一家公司的判定结局：模型判定 / 外部处理拦截 / L0 门拦截（进补数队列或 NOT_FIT）。 */
type QuickOutcome =
  | {
      verdict: QuickVerdict;
      via: 'batch' | 'single' | 'rule_fallback';
      /** P3 J07：该公司评估时制裁名单 yellow/red（不拦截，只随结果标记）。 */
      sanctionsStale?: 'yellow' | 'red';
    }
  | { skip: true }
  | { gateBlock: GateBlock };

/** 一次 run 的快扫三段：规则预筛 → 批量粗判（8 家/次，逐家降级）→ 临时候选落库。 */
export function createRun2Activities(deps: {
  prisma: PrismaService;
  gateway: ModelGateway;
  runtimeTelemetry?: RuntimeTelemetry;
  budgetStore?: BudgetStore;
  /** S0 技能运行时：生产由 worker 注入 DB resolver；缺省为内置目录直通。 */
  skills?: SkillResolver;
  /** M2 步 9b：资格判定员角色（注册表 + 技能子集校验 + 轨迹）。缺省保持旧行为。 */
  agentRuntime?: AgentRoundRuntime;
  /**
   * P3 J08：域名存活校验结果（P2 域名解析流水线的接入缝）。未注入 = 没有存活证据，
   * 不视为 DEAD（gates.ts 的语义）；P2 侧尚无生产者，消费者留待其后续波次接线。
   */
  domainStatusFor?: (companyId: string) => Promise<'ALIVE' | 'DEAD' | 'UNKNOWN' | null>;
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

  /** 批量 wire-time 闸门（ch08 §3.1.5）：单事务、单策略锁、单次禁联读取。 */
  const mayUseExternalProcessingMany = (
    workspaceId: string,
    companyIds: readonly string[],
  ): Promise<Set<string>> =>
    deps.prisma.withWorkspace(workspaceId, (tx) =>
      companyMayUseExternalProcessingMany(tx, workspaceId, companyIds),
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
      /** P3 J07/J08：被 L0 门链拦下（G5 进补数队列 / enforce 下 FAIL）未送模型的公司数。 */
      gated: number;
    }> {
      const binding = await ensureRunBudget(args);
      // P3 J02 W4：池子最多 500 家 × 8 家/批，活动远超 15 分钟 startToClose（2026-11-08 审计
      // 实测 27.8 分钟）。每批后 heartbeat()，配合 proxyActivities 的 heartbeatTimeout 续命；
      // 每批前检查取消，父工作流 RequestCancel 时不再把整池判完。
      const activity = currentActivityContext();
      activity?.heartbeat({ phase: 'quick_judge', batches: 0 });
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
      let gated = 0;
      let batchesDone = 0;
      // P3 J07/J03b：判定契约模式（off/shadow/enforce）与 L0 门链协同，按事实写进 run 事件。
      const judgeMode = judgeContractMode();
      /** P3 J02 W4：批量协议失败的分类码（该批逐家降级的兜底归因）。 */
      let batchFailureCode: FailureCode | undefined;
      /** P3 J02 W4：逐家判定异常的分类码（取代 QUICK_JUDGE_FAILED 聚合码）。 */
      const failureCodeByCompany = new Map<string, FailureCode>();
      const capturedFailureCode = (companyId: string): FailureCode | undefined =>
        failureCodeByCompany.get(companyId) ?? batchFailureCode;

      // P3 W5：批量粗筛用独立的 L1 契约（flash 档、provisional），不再借用 L2 终判
      // `discovery.qualify_fit`——否则一条 task 级 override 会同时改写深判的模型。
      // 单家降级路径（judgeOne → judgeFitCompany）仍走 L2 qualify_fit，不动。
      const task = getTask('discovery.quick_judge')!;

      // M2 步 9b：资格判定员回合门。未接线 agentRuntime 时保持旧行为；技能子集经 S0 resolver
      // 校验，任一不可用即落轨迹（reason_code=技能失败码）后原样上抛——不降级、不吞成空判。
      if (deps.agentRuntime) {
        const qualifier = await resolveAgentRound(
          deps.agentRuntime.agents,
          AGENT_KEYS.qualifier,
          args.workspaceId,
        );
        try {
          await verifyAgentSkills(deps.skills, qualifier, args.workspaceId);
        } catch (error) {
          if (error instanceof SkillUnavailableError) {
            await deps.agentRuntime.traces.record({
              workspaceId: args.workspaceId,
              runId: args.runId,
              stepType: 'discovery.quick_scan',
              agentKey: AGENT_KEYS.qualifier,
              decisionType: AGENT_DECISION_TYPES.fitJudge,
              discriminator: 'skill-gate',
              reasonCode: error.reason,
            });
          }
          throw error;
        }
      }

      const judgeOne = async (
        company: (typeof companies)[number],
      ): Promise<QuickVerdict | null> => {
        const judgment = await judgeFitCompany(deps.gateway, args.workspaceId, icpBrief, company as FitJudgeCompany, {
          runId: binding.accountKey,
          runtimeTelemetry: deps.runtimeTelemetry,
          authorizeExternalAction: () => mayUseExternalProcessing(args.workspaceId, company.id),
          skills: deps.skills,
          judgeContractMode: judgeMode,
        });
        // P3 J03b：L1 快扫的单家降级没有 Lead 投影，v2 记录单独落库（shadow 容忍失败）。
        if (judgment?.judgmentRecord) {
          await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
            persistJudgmentRecordInTransaction(tx, args.icpId, judgment),
          );
        }
        return judgment?.verdict ?? null;
      };

      const settle = async (
        batch: Array<{ job: (typeof jobs)[number]; company: (typeof companies)[number] }>,
        outcomes: Map<string, QuickOutcome>,
      ): Promise<void> => {
        await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
          for (const { job, company } of batch) {
            const outcome = outcomes.get(company.id);
            if (!outcome) {
              failed += 1;
              // P3 J02 W4：聚合码拆成分类后的具体 cause（批量/逐家异常 → 版本化失败码）。
              const failureCode = capturedFailureCode(company.id) ?? 'UNKNOWN_UPSTREAM';
              await tx.discoveryCompanyJob.update({
                where: { id: job.id },
                data: { attempts: { increment: 1 }, lastErrorCode: failureCode },
              });
              await appendRunEvent(tx as never, {
                workspaceId: args.workspaceId,
                runId: args.runId,
                level: 'warn',
                type: 'company_failed',
                payload: {
                  companyId: company.id,
                  stage: 'quick_judged',
                  error: failureCode,
                  failureStage: FAILURE_CODES[failureCode].stage,
                },
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
            if ('gateBlock' in outcome) {
              // P3 J07/J08：门链拦截——G5 UNKNOWN 已由 evaluateGates 写 gate_enrichment_task
              // （queued），这里只把 job 停在 skipped 并留下拦截原因；enforce 的 FAIL 同理。
              gated += 1;
              await tx.discoveryCompanyJob.update({
                where: { id: job.id },
                data: {
                  stage: 'skipped',
                  lastErrorCode: outcome.gateBlock.reasonCode,
                  finishedAt: new Date(),
                },
              });
              await appendRunEvent(tx as never, {
                workspaceId: args.workspaceId,
                runId: args.runId,
                type: 'company_done',
                payload: {
                  companyId: company.id,
                  stage: 'gate_blocked',
                  gateId: outcome.gateBlock.gateId,
                  reasonCode: outcome.gateBlock.reasonCode,
                  verdict: outcome.gateBlock.verdict,
                },
              });
              continue;
            }
            judged += 1;
            verdicts[outcome.verdict] = (verdicts[outcome.verdict] ?? 0) + 1;
            if (outcome.via === 'single') fallbackPerCompany += 1;
            if (outcome.via === 'rule_fallback') ruleFallback += 1;
            // 规则兜底的公司不是 failed，但批量/逐家判定的失败原因仍要可追溯。
            const fallbackCode =
              outcome.via === 'rule_fallback' ? capturedFailureCode(company.id) : undefined;
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
                ...(outcome.sanctionsStale ? { sanctionsStale: outcome.sanctionsStale } : {}),
                ...(fallbackCode
                  ? { failureCode: fallbackCode, failureStage: FAILURE_CODES[fallbackCode].stage }
                  : {}),
              },
            });
          }
        });
      };

      for (let start = 0; start < targets.length; start += QUICK_JUDGE_BATCH_SIZE) {
        // P3 J02 W4：批间取消检查（取消经 heartbeat 送达；worker 会把取消记为 CANCELLED）。
        throwIfActivityCancelled(activity);
        // 批量失败码是逐批事实，不得把上一批的分类带到下一批。
        batchFailureCode = undefined;
        const batch = targets.slice(start, start + QUICK_JUDGE_BATCH_SIZE);
        const outcomes = new Map<string, QuickOutcome>();

        // 逐家外部处理闸门（禁联/主体失效）：不放行的直接 skipped，不进模型批量。
        // P3 J08（W9）：随后接 L0 门链（G5 域名门等）——无域名/DEAD 的公司写补数队列后
        // 不送 LLM；P3 J07（W8）：enforce 下 G1 制裁命中等 FAIL 同样拦截（off/shadow 只记录）。
        const eligible: typeof batch = [];
        const staleByCompany = new Map<string, 'yellow' | 'red'>();
        for (const entry of batch) {
          if (!(await mayUseExternalProcessing(args.workspaceId, entry.company.id))) {
            outcomes.set(entry.company.id, { skip: true });
            continue;
          }
          const domainStatus = deps.domainStatusFor
            ? await deps.domainStatusFor(entry.company.id)
            : null;
          const gateSummary = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
            evaluateL0Gates(tx, {
              workspaceId: args.workspaceId,
              icpId: args.icpId,
              companyId: entry.company.id,
              now: new Date(),
              domainStatus,
            }),
          );
          const gateBlock = quickScanGateBlock(judgeMode, gateSummary);
          if (gateBlock) {
            outcomes.set(entry.company.id, { gateBlock });
            continue;
          }
          if (gateSummary.sanctions.staleMarker) {
            staleByCompany.set(entry.company.id, gateSummary.sanctions.staleMarker);
          }
          eligible.push(entry);
        }

        let batchVerdicts: Array<QuickVerdict | null> = [];
        const batchResolved = new Set<number>();
        if (eligible.length > 0) {
          if (eligible.length === 1) {
            // 单家批次不值得批量协议，直接走单家判定（带真实 gate；wire 前被拒 → 下方逐家循环标 skipped）。
            try {
              batchVerdicts = [await judgeOne(eligible[0]!.company)];
            } catch (error) {
              if (!(error instanceof ExternalActionDeniedError)) throw error;
              batchVerdicts = [null];
            }
          } else {
            const eligibleIds = eligible.map((entry) => entry.company.id);
            try {
              const result = await executeSkillWithRuntime<{ judgments?: unknown }>(
                deps.skills ?? STATIC_SKILL_RESOLVER,
                deps.gateway,
                'discovery.quick_judge',
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
                  // ch08 §3.1.5：wire-time 逐家重校验（预检与 wire 之间新增的禁联/DSR 撤权不得送模型）。
                  // 任一家不再 allowed → 整批返回 false → 网关拒绝 → 下方 catch 整批降级逐家判。
                  authorizeExternalAction: async () => {
                    const allowed = await mayUseExternalProcessingMany(
                      args.workspaceId,
                      eligibleIds,
                    );
                    return eligibleIds.every((id) => allowed.has(id));
                  },
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
                error instanceof ExecutionControlError ||
                error instanceof SkillUnavailableError
              ) {
                // 技能不可用是运维策略，不是上游抖动：不得降级成逐家/规则兜底继续跑。
                throw error;
              }
              // P3 J02 W4：批量协议失败也留类型化归因（逐家降级后仍失败/兜底时可回指）。
              batchFailureCode = classifyPipelineFailure(error).code;
              batchVerdicts = eligible.map(() => null); // 整批不可用 → 全批逐家降级
            }
          }
        }

        for (const [index, entry] of eligible.entries()) {
          const verdict = batchVerdicts[index] ?? null;
          const staleMarker = staleByCompany.get(entry.company.id);
          if (verdict) {
            outcomes.set(entry.company.id, {
              verdict,
              via: batchResolved.has(index) ? 'batch' : 'single',
              ...(staleMarker ? { sanctionsStale: staleMarker } : {}),
            });
            continue;
          }
          // 降级①：逐家判定（沿用同一四门 prompt 与预算账户）。
          try {
            const single = await judgeOne(entry.company);
            if (single) {
              outcomes.set(entry.company.id, {
                verdict: single,
                via: 'single',
                ...(staleMarker ? { sanctionsStale: staleMarker } : {}),
              });
              continue;
            }
          } catch (error) {
            // P3 J02 W4：逐家失败也记分类码（不再落到 QUICK_JUDGE_FAILED 聚合码）。
            failureCodeByCompany.set(entry.company.id, classifyPipelineFailure(error).code);
            if (error instanceof ExternalActionDeniedError) {
              // wire-time 闸门拒绝（禁联/主体失效/DSR 撤权）：标 skipped，不落任何判定。
              outcomes.set(entry.company.id, { skip: true });
              continue;
            }
            if (
              error instanceof BudgetExceededError ||
              error instanceof BudgetOperationReplayError ||
              error instanceof ExecutionControlError ||
              error instanceof SkillUnavailableError
            ) {
              // 停用/未登记/契约漂移不得落入规则兜底（那会绕过 kill switch）。
              throw error;
            }
          }
          // 降级②：模型不可用 → 规则兜底出名单（weak，人工复核）。
          outcomes.set(entry.company.id, {
            verdict: 'weak',
            via: 'rule_fallback',
            ...(staleMarker ? { sanctionsStale: staleMarker } : {}),
          });
        }

        await settle(batch, outcomes);
        // P3 J02 W4：批后心跳（每批 ≤8 家；详情可用于重试续跑定位）。
        batchesDone += 1;
        activity?.heartbeat({
          phase: 'quick_judge',
          batches: batchesDone,
          judged,
          failed,
          skipped,
        });

        // M2 步 9b：资格判定员回合的批量判定轨迹（chosen=批次汇总；rejected=被否/跳过/失败候选）。
        // 同一个批次内容重放不翻行（discriminator=批次 job id 的内容哈希）。
        if (deps.agentRuntime) {
          const verdictCounts: Record<string, number> = {};
          const rejectedCandidates: Array<{
            candidateRef: string;
            rejectReason: string;
            revivable: boolean;
          }> = [];
          let judgedInBatch = 0;
          for (const { company } of batch) {
            const outcome = outcomes.get(company.id);
            if (!outcome) {
              rejectedCandidates.push({
                candidateRef: company.id,
                // P3 J02 W4：轨迹里同样写具体 cause，而不是聚合码。
                rejectReason: capturedFailureCode(company.id) ?? 'UNKNOWN_UPSTREAM',
                revivable: true,
              });
              continue;
            }
            if ('skip' in outcome) {
              rejectedCandidates.push({
                candidateRef: company.id,
                rejectReason: 'EXTERNAL_PROCESSING_BLOCKED',
                revivable: true,
              });
              continue;
            }
            if ('gateBlock' in outcome) {
              // P3 J07/J08：门链拦截（补数后可重评）——原因码直接落轨迹。
              rejectedCandidates.push({
                candidateRef: company.id,
                rejectReason: outcome.gateBlock.reasonCode,
                revivable: true,
              });
              continue;
            }
            judgedInBatch += 1;
            verdictCounts[outcome.verdict] = (verdictCounts[outcome.verdict] ?? 0) + 1;
            if (outcome.verdict === 'mismatch') {
              rejectedCandidates.push({
                candidateRef: company.id,
                rejectReason: 'VERDICT_MISMATCH',
                revivable: true,
              });
            }
          }
          await deps.agentRuntime.traces.record({
            workspaceId: args.workspaceId,
            runId: args.runId,
            stepType: 'discovery.quick_scan',
            agentKey: AGENT_KEYS.qualifier,
            decisionType: AGENT_DECISION_TYPES.fitJudge,
            discriminator: `batch:${createHash('sha256')
              .update(batch.map((entry) => entry.job.id).sort().join(','))
              .digest('hex')
              .slice(0, 40)}`,
            chosenOption: {
              batchSize: batch.length,
              judged: judgedInBatch,
              verdicts: verdictCounts,
            },
            rejectedCandidates,
          });
        }
      }

      await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        appendRunEvent(tx as never, {
          workspaceId: args.workspaceId,
          runId: args.runId,
          type: 'phase_completed',
          payload: { phase: 'quick', judged, verdicts, fallbackPerCompany, ruleFallback, failed, skipped, gated },
        }),
      );

      return { judged, verdicts, fallbackPerCompany, ruleFallback, failed, skipped, gated };
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
      // 召回不降的判定只在**两侧都判过的公司**上比较：老路径判整个 canonicalized
      // 池、影子只判预筛后的候选集，池子天然不等（2026-11-04 验收实况 66 vs 27），
      // 按总数比会把「覆盖差异」误读成「召回下降」。summary 仍保留两侧各自的覆盖数。
      const legacyPositiveCompared = comparedIds.filter((id) =>
        positive(legacyByCompany.get(id)),
      ).length;
      const shadowPositiveCompared = comparedIds.filter((id) =>
        positive(shadowByCompany.get(id)),
      ).length;
      return { ...summary, recallNotLower: shadowPositiveCompared >= legacyPositiveCompared };
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
