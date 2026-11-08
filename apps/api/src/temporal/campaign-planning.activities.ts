import { ApplicationFailure, Context } from '@temporalio/activity';
import { PrismaService } from '../prisma/prisma.service';
import { ModelGateway } from '../model-gateway/model-gateway';
import { getTask } from '../ai-tasks/task-registry';
import { TaskOutputValidationError } from '../model-gateway/providers/provider-output-error';
import type { RuntimeTelemetry } from '../model-runtime/types';
import {
  executeSkillWithRuntime,
  SkillUnavailableError,
  STATIC_SKILL_RESOLVER,
  type SkillResolver,
} from '../skills/skill-runtime';
import {
  type BudgetStore,
  UnavailableBudgetStore,
} from '../tools/budget-store';
import {
  parseExecutionBudgetBinding,
  type ExecutionBudgetBinding,
} from '../execution-budget/execution-budget-binding';
import {
  applyDomainAckConsumerTransaction,
} from '../durable-results/domain-ack-consumer-bindings';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';
import { MemoryQueryService } from '../memory/memory-query.service';
import {
  CampaignControlPlaneError,
  createHttpCampaignControlPlane,
  type CampaignControlPlane,
  type CampaignPlanIssue,
} from './campaign-control-plane.client';

/**
 * M2.1 受限 Campaign 规划器的活动层（设计 `2026-11-08-campaign-planner-m2-1` §3/§4.1/§5）。
 *
 * 工作流只做编排；本文件三类活动：
 *  1. `assembleCampaignPlanInputs`：只读输入装配白名单（ICP / 卖家档案与已批准事实 /
 *     公司池聚合计数 / 记忆 brief / 上限提示）——不写任何业务表；
 *  2. `generateCampaignPlan`：经 S0 技能运行时解析 `campaign.plan`（零工具）并做一次
 *     有界结构化调用；技能停用/漂移 fail-closed（SKILL_PLATFORM_DISABLED 等，零模型调用）；
 *  3. `deliverCampaignPlanRevision` / `reportCampaignPlanJobFailure`：把原始计划 JSON
 *     回调 gain-saas（plan_hash 单一权威在 gain-saas，D-M2.1-b）或失败回写 job。
 */

export const CAMPAIGN_PLAN_SKILL_KEY = 'campaign.plan' as const;
export const CAMPAIGN_PLAN_DURABLE_SCHEMA = 'campaign-plan/v1' as const;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ICP_CANDIDATES = 20;
const MAX_APPROVED_CLAIMS = 40;
const MAX_OFFERINGS = 10;
const MAX_POOL_GROUPS = 10;

export interface CampaignPlanAvailableIcp {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly targetMarkets: readonly string[];
  readonly companyAttributes: unknown;
}

export interface CampaignPlanInputBundle {
  readonly objective: string;
  readonly availableIcps: readonly CampaignPlanAvailableIcp[];
  readonly seller: {
    readonly name: string | null;
    readonly website: string | null;
    readonly industry: string | null;
    readonly summary: string | null;
    readonly targetMarkets: readonly string[];
    readonly approvedClaims: readonly { type: string; statement: string }[];
    readonly offerings: readonly { name: string; description: string | null }[];
  } | null;
  readonly poolStats: {
    readonly totalCompanies: number;
    readonly byCountry: readonly { key: string; count: number }[];
    readonly byIndustry: readonly { key: string; count: number }[];
  };
  readonly memoryBrief: { readonly text: string; readonly truncated: boolean };
  readonly limits: {
    readonly audienceSizeCap?: number;
    readonly budgetCapMicros?: number;
    /** M2.2 有界重规划预算（0–2）；规划器必须把它原样写进 decisionPolicy.maxReplans。 */
    readonly maxReplans: number;
  };
}

/** CampaignPlan v0 的引擎侧最小类型（与 gain-saas zod 契约逐字段一致）。 */
export interface CampaignPlanOutput {
  schemaVersion: 'campaign-plan/v0';
  goal: { objective: string; successMetric?: string };
  audience: { icpIds: string[]; sizeCap: number };
  motions: { type: 'discovery'; icpIds: string[] }[];
  budget: { capMicros?: number; currency: 'USD' };
  approvalPolicy: { required: true };
  decisionPolicy: { maxReplans: 0 | 1 | 2 };
}

export interface AssembleCampaignPlanInputsArgs {
  workspaceId: string;
  objective: string;
  icpId?: string;
  audienceSizeCap?: number;
  budgetCapMicros?: number;
  /** M2.2：本 job 允许的自动重规划轮数（0–2，缺省 0）。 */
  maxReplans?: number;
}

export type CampaignPlanReplanReason = 'VALIDATOR_ISSUES' | 'HUMAN_DECLINE';

/** 单轮生成的重规划上下文（round 0 可为人工拒绝重生成；后续轮为校验问题反馈）。 */
export interface CampaignPlanReplanContext {
  readonly reasonCode: CampaignPlanReplanReason;
  readonly issues?: readonly CampaignPlanIssue[];
  readonly previousPlan?: unknown;
  readonly detail?: string;
}

export interface GenerateCampaignPlanArgs {
  workspaceId: string;
  jobId: string;
  bundle: CampaignPlanInputBundle;
  executionBudget?: ExecutionBudgetBinding;
  /** 轮次（0 = 首轮；1..2 = 重规划轮），用于提示与审计。 */
  round?: number;
  replan?: CampaignPlanReplanContext;
}

export interface GeneratedCampaignPlan {
  plan: CampaignPlanOutput;
  durableReceipt?: DurableExecutionReceipt;
}

/** 单轮生成结果：`issues` = 本轮产出未过 schema/语义硬门，由工作流决定是否重规划或转人工。 */
export type CampaignPlanRoundResult =
  | { status: 'ok'; plan: CampaignPlanOutput; durableReceipt?: DurableExecutionReceipt }
  | { status: 'issues'; issues: readonly CampaignPlanIssue[] };

export interface CampaignPlanReplanEntry {
  readonly round: number;
  readonly reasonCode: CampaignPlanReplanReason;
  readonly issues?: readonly CampaignPlanIssue[];
}

export interface DeliverCampaignPlanRevisionArgs {
  workspaceId: string;
  campaignId: string;
  jobId: string;
  plan: CampaignPlanOutput;
  durableReceipt?: DurableExecutionReceipt;
  /** 成功交付前的重规划历史（gain-saas 落 campaign.replan 轨迹行）。 */
  replanHistory?: readonly CampaignPlanReplanEntry[];
}

export interface ReportCampaignPlanJobFailureArgs {
  workspaceId: string;
  jobId: string;
  error: string;
  issues?: readonly CampaignPlanIssue[];
  /** NEEDS_HUMAN = 重规划轮次耗尽/成本上限；FAILED = 其它终态失败（缺省）。 */
  state?: 'FAILED' | 'NEEDS_HUMAN';
  replanHistory?: readonly CampaignPlanReplanEntry[];
}

export interface CampaignPlanningActivities {
  assembleCampaignPlanInputs(
    args: AssembleCampaignPlanInputsArgs,
  ): Promise<CampaignPlanInputBundle>;
  generateCampaignPlan(
    args: GenerateCampaignPlanArgs,
  ): Promise<CampaignPlanRoundResult>;
  deliverCampaignPlanRevision(
    args: DeliverCampaignPlanRevisionArgs,
  ): Promise<void>;
  reportCampaignPlanJobFailure(
    args: ReportCampaignPlanJobFailureArgs,
  ): Promise<void>;
}

/** 与 understanding 的预算操作键同一构造：run/activity/attempt 各自一个账户。 */
function attemptCorrelationId(): string | undefined {
  try {
    const info = Context.current().info;
    const runId = info.workflowExecution?.runId;
    const activityId = info.activityId;
    const attempt = info.attempt;
    if (typeof runId !== 'string' || runId.length === 0) return undefined;
    if (typeof activityId !== 'string' || activityId.length === 0) return undefined;
    if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) {
      return undefined;
    }
    return `${runId}:${activityId}:a${attempt}`;
  } catch {
    return undefined;
  }
}

function nonRetryable(code: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(code, code);
}

/** control-plane 客户端的失败 → Temporal 失败（无控制面配置/拒绝不重试）。 */
function controlPlaneFailure(error: unknown): never {
  if (error instanceof CampaignControlPlaneError) {
    if (error.code === 'CAMPAIGN_CONTROL_PLANE_UNAVAILABLE') throw error;
    throw ApplicationFailure.nonRetryable(error.code, error.code);
  }
  throw error;
}

/**
 * 计划语义后检（schema 之外的确定性约束）：ICP 只能来自提示列表、motion ⊆ audience、
 * 不超过调用方给的受众/预算上限。违反即 CAMPAIGN_PLAN_INVALID，不回写任何业务表。
 */
export function campaignPlanSemanticIssues(
  plan: CampaignPlanOutput,
  bundle: Pick<CampaignPlanInputBundle, 'availableIcps' | 'limits'>,
): CampaignPlanIssue[] {
  const issues: CampaignPlanIssue[] = [];
  const allowed = new Set(bundle.availableIcps.map((icp) => icp.id));
  const audience = new Set<string>();
  plan.audience.icpIds.forEach((icpId, index) => {
    if (!UUID.test(icpId) || !allowed.has(icpId)) {
      issues.push({
        path: `audience.icpIds.${index}`,
        message: 'ICP 不在提示给出的可用列表内',
      });
    }
    audience.add(icpId);
  });
  plan.motions.forEach((motion, motionIndex) => {
    motion.icpIds.forEach((icpId, index) => {
      if (!audience.has(icpId)) {
        issues.push({
          path: `motions.${motionIndex}.icpIds.${index}`,
          message: 'motion 的 ICP 必须是 audience.icpIds 的子集',
        });
      }
    });
  });
  if (
    bundle.limits.audienceSizeCap !== undefined &&
    plan.audience.sizeCap > bundle.limits.audienceSizeCap
  ) {
    issues.push({
      path: 'audience.sizeCap',
      message: `sizeCap 不得超过 ${bundle.limits.audienceSizeCap}`,
    });
  }
  if (
    bundle.limits.budgetCapMicros !== undefined &&
    plan.budget.capMicros !== undefined &&
    plan.budget.capMicros > bundle.limits.budgetCapMicros
  ) {
    issues.push({
      path: 'budget.capMicros',
      message: `capMicros 不得超过 ${bundle.limits.budgetCapMicros}`,
    });
  }
  if (plan.decisionPolicy.maxReplans !== bundle.limits.maxReplans) {
    issues.push({
      path: 'decisionPolicy.maxReplans',
      message: `maxReplans 必须等于提示给出的重规划预算 ${bundle.limits.maxReplans}`,
    });
  }
  return issues;
}

/** 重规划预算：缺省 0；仅接受 0/1/2。 */
function replanBudget(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 2) {
    throw nonRetryable('CAMPAIGN_PLAN_INPUT_INVALID');
  }
  return value;
}

function positiveInteger(
  value: unknown,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw nonRetryable('CAMPAIGN_PLAN_INPUT_INVALID');
  }
  return value as number;
}

export function createCampaignPlanningActivities(deps: {
  prisma: PrismaService;
  gateway: ModelGateway;
  runtimeTelemetry?: RuntimeTelemetry;
  budgetStore?: BudgetStore;
  /** S0 技能运行时：生产由 worker 注入 DB resolver；缺省为内置目录直通（测试/未接线）。 */
  skills?: SkillResolver;
  memory?: MemoryQueryService;
  controlPlane?: CampaignControlPlane;
}): CampaignPlanningActivities {
  const budgets =
    deps.budgetStore ??
    new UnavailableBudgetStore(
      'campaign planning activities require an authoritative BudgetStore',
    );
  const memory = deps.memory ?? new MemoryQueryService(deps.prisma);
  const controlPlane =
    deps.controlPlane ?? createHttpCampaignControlPlane();

  const requireAuthority = (
    workspaceId: string,
    executionBudget: ExecutionBudgetBinding | undefined,
  ): ExecutionBudgetBinding => {
    let binding: ExecutionBudgetBinding;
    try {
      binding = parseExecutionBudgetBinding(executionBudget, {
        scopeKey: workspaceId,
        purpose: 'campaign.plan',
        subjectType: 'campaign',
      });
    } catch {
      throw nonRetryable('EXECUTION_BUDGET_WORKFLOW_INPUT_INVALID');
    }
    return binding;
  };

  async function reportFailure(
    args: ReportCampaignPlanJobFailureArgs,
  ): Promise<void> {
    await controlPlane.reportJobFailure(args);
  }

  return {
    async assembleCampaignPlanInputs(
      args: AssembleCampaignPlanInputsArgs,
    ): Promise<CampaignPlanInputBundle> {
      if (
        typeof args.workspaceId !== 'string' ||
        !UUID.test(args.workspaceId) ||
        typeof args.objective !== 'string' ||
        args.objective.trim().length === 0 ||
        args.objective.length > 500
      ) {
        throw nonRetryable('CAMPAIGN_PLAN_INPUT_INVALID');
      }
      const audienceSizeCap = positiveInteger(args.audienceSizeCap, 1000);
      let budgetCapMicros: number | undefined;
      if (args.budgetCapMicros !== undefined) {
        if (
          !Number.isSafeInteger(args.budgetCapMicros) ||
          args.budgetCapMicros < 0
        ) {
          throw nonRetryable('CAMPAIGN_PLAN_INPUT_INVALID');
        }
        budgetCapMicros = args.budgetCapMicros;
      }
      if (args.icpId !== undefined && !UUID.test(args.icpId)) {
        throw nonRetryable('CAMPAIGN_PLAN_INPUT_INVALID');
      }

      const { icps, sellerCompanyId } = await deps.prisma.withWorkspace(
        args.workspaceId,
        async (tx) => {
          if (args.icpId !== undefined) {
            const icp = await tx.icpDefinition.findFirst({
              where: { id: args.icpId },
            });
            if (!icp) throw nonRetryable('CAMPAIGN_PLAN_ICP_NOT_FOUND');
            return {
              icps: [icp],
              sellerCompanyId: icp.companyId,
            };
          }
          const candidates = await tx.icpDefinition.findMany({
            where: { status: { in: ['ACTIVE', 'HYPOTHESIS', 'VALIDATING'] } },
            orderBy: { updatedAt: 'desc' },
            take: MAX_ICP_CANDIDATES,
          });
          if (candidates.length === 0) {
            throw nonRetryable('CAMPAIGN_PLAN_NO_ICP');
          }
          return {
            icps: candidates,
            sellerCompanyId: candidates[0]?.companyId ?? null,
          };
        },
      );

      const seller = await deps.prisma.withWorkspace(
        args.workspaceId,
        async (tx) => {
          const company =
            sellerCompanyId !== null
              ? await tx.companyProfile.findFirst({
                  where: { id: sellerCompanyId },
                })
              : await tx.companyProfile.findFirst({
                  orderBy: { createdAt: 'asc' },
                });
          if (!company) return null;
          const [claims, offerings] = await Promise.all([
            tx.claim.findMany({
              where: { companyId: company.id, status: 'APPROVED' },
              orderBy: { updatedAt: 'desc' },
              take: MAX_APPROVED_CLAIMS,
              select: { type: true, statement: true },
            }),
            tx.offering.findMany({
              where: { companyId: company.id },
              orderBy: [{ confidence: 'desc' }, { name: 'asc' }],
              take: MAX_OFFERINGS,
              select: { name: true, description: true },
            }),
          ]);
          return {
            name: company.name,
            website: company.website ?? null,
            industry: company.industry ?? null,
            summary: company.summary ?? null,
            targetMarkets: company.targetMarkets,
            approvedClaims: claims.map((claim) => ({
              type: claim.type,
              statement: claim.statement.slice(0, 500),
            })),
            offerings: offerings.map((offering) => ({
              name: offering.name,
              description: offering.description?.slice(0, 500) ?? null,
            })),
          };
        },
      );

      const poolStats = await deps.prisma.withWorkspace(
        args.workspaceId,
        async (tx) => {
          const [totalCompanies, byCountry, byIndustry] = await Promise.all([
            tx.canonicalCompany.count(),
            tx.canonicalCompany.groupBy({
              by: ['country'],
              _count: { _all: true },
              orderBy: { _count: { country: 'desc' } },
              take: MAX_POOL_GROUPS,
            }),
            tx.canonicalCompany.groupBy({
              by: ['industry'],
              _count: { _all: true },
              orderBy: { _count: { industry: 'desc' } },
              take: MAX_POOL_GROUPS,
            }),
          ]);
          return {
            totalCompanies,
            byCountry: groupCounts(byCountry, 'country'),
            byIndustry: groupCounts(byIndustry, 'industry'),
          };
        },
      );

      const maxReplans = replanBudget(args.maxReplans);

      const brief = await memory.buildMemoryBrief(args.workspaceId, {
        workflowType: 'campaign.plan',
        scopes: [{ type: 'workspace', key: args.workspaceId }],
        maxTokens: 1500,
      });

      return {
        objective: args.objective,
        availableIcps: icps.map((icp) => ({
          id: icp.id,
          name: icp.name,
          status: icp.status,
          targetMarkets: Array.isArray(icp.targetMarkets)
            ? icp.targetMarkets.filter(
                (market): market is string => typeof market === 'string',
              )
            : [],
          companyAttributes: icp.companyAttributes,
        })),
        seller,
        poolStats,
        memoryBrief: { text: brief.text, truncated: brief.truncated },
        limits: {
          ...(audienceSizeCap !== undefined ? { audienceSizeCap } : {}),
          ...(budgetCapMicros !== undefined ? { budgetCapMicros } : {}),
          maxReplans,
        },
      };
    },

    async generateCampaignPlan(
      args: GenerateCampaignPlanArgs,
    ): Promise<CampaignPlanRoundResult> {
      const binding = requireAuthority(
        args.workspaceId,
        args.executionBudget,
      );
      await budgets.attestAuthorized({
        authorityId: binding.authorityId,
        scopeKey: binding.scopeKey,
        accountKey: binding.accountKey,
      });
      const contract = getTask('campaign.plan');
      if (!contract) throw nonRetryable('CAMPAIGN_PLAN_TASK_NOT_REGISTERED');
      const round = campaignPlanRound(args.round);
      const replanPrompt = campaignPlanReplanPrompt(args.replan, round);

      // 语义后检作为任务确定性硬门：schema 通过后执行；本轮内仍有一次修复重试
      // （repairTaskOutput）。仍不合法时**不在这里终结 job**——返回 issues 交给工作流
      // 决定重规划（≤ maxReplans 轮）或转 NEEDS_HUMAN（M2.2，设计 §3）。
      let lastIssues: CampaignPlanIssue[] = [];
      let result;
      try {
        result = await executeSkillWithRuntime<CampaignPlanOutput>(
          deps.skills ?? STATIC_SKILL_RESOLVER,
          deps.gateway,
          CAMPAIGN_PLAN_SKILL_KEY,
          {
            task: 'campaign.plan',
            prompt: JSON.stringify(
              replanPrompt === undefined
                ? { ...args.bundle, round }
                : { ...args.bundle, round, replan: replanPrompt },
            ),
            system: contract.description,
            model: contract.model,
            schema: contract.outputSchema,
            validateOutput: (data) => {
              lastIssues = campaignPlanSemanticIssues(
                data as CampaignPlanOutput,
                args.bundle,
              );
              if (lastIssues.length > 0) {
                throw new TaskOutputValidationError(
                  `CAMPAIGN_PLAN_INVALID: ${lastIssues
                    .map((issue) => `${issue.path} ${issue.message}`)
                    .join('; ')}`,
                );
              }
            },
            repairTaskOutput: true,
          },
          {
            workspaceId: args.workspaceId,
            runId: binding.accountKey,
            correlationId: attemptCorrelationId(),
            durableResultSchema: CAMPAIGN_PLAN_DURABLE_SCHEMA,
          },
          { telemetry: deps.runtimeTelemetry },
        );
      } catch (error) {
        if (error instanceof SkillUnavailableError) {
          // 技能停用/漂移发生在任何模型调用之前；原因回写 job（无 issues）。
          await reportFailure({
            workspaceId: args.workspaceId,
            jobId: args.jobId,
            error: error.reason,
          }).catch(() => undefined);
          throw ApplicationFailure.nonRetryable(error.reason, error.reason);
        }
        if (error instanceof TaskOutputValidationError) {
          return {
            status: 'issues',
            issues:
              lastIssues.length > 0
                ? lastIssues
                : [
                    {
                      path: 'data',
                      message:
                        '模型输出不符合 CampaignPlan v0 schema（含一次修复重试）',
                    },
                  ],
          };
        }
        throw error;
      }

      return {
        status: 'ok',
        plan: result.data,
        ...(result.durableReceipt
          ? { durableReceipt: result.durableReceipt }
          : {}),
      };
    },

    async deliverCampaignPlanRevision(
      args: DeliverCampaignPlanRevisionArgs,
    ): Promise<void> {
      try {
        await controlPlane.deliverRevision({
          jobId: args.jobId,
          workspaceId: args.workspaceId,
          campaignId: args.campaignId,
          plan: args.plan,
          ...(args.replanHistory !== undefined
            ? { replanHistory: args.replanHistory }
            : {}),
        });
      } catch (error) {
        if (
          error instanceof CampaignControlPlaneError &&
          error.code === 'CAMPAIGN_PLAN_INVALID'
        ) {
          // gain-saas 的 zod 校验失败（契约漂移）：issues 落 job，然后以 nonRetryable 结束。
          await reportFailure({
            workspaceId: args.workspaceId,
            jobId: args.jobId,
            error: 'CAMPAIGN_PLAN_INVALID',
            ...(error.options.issues ? { issues: error.options.issues } : {}),
          }).catch(() => undefined);
          throw nonRetryable('CAMPAIGN_PLAN_INVALID');
        }
        controlPlaneFailure(error);
      }

      // 计划已在 gain-saas 落成 DRAFT revision：在本侧把付费操作回执收口（无额外业务写）。
      if (args.durableReceipt) {
        await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
          await applyDomainAckConsumerTransaction({
            transaction: tx,
            producerId: 'campaign.plan',
            receipt: args.durableReceipt,
            domainAckKey: args.jobId,
            domainRevision:
              args.durableReceipt?.resultDigest ??
              'campaign-plan-revision-delivered',
            apply: async () => undefined,
          });
        });
      }
    },

    async reportCampaignPlanJobFailure(
      args: ReportCampaignPlanJobFailureArgs,
    ): Promise<void> {
      try {
        await controlPlane.reportJobFailure(args);
      } catch (error) {
        controlPlaneFailure(error);
      }
    },
  };
}

function campaignPlanRound(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 2) {
    throw nonRetryable('CAMPAIGN_PLAN_INPUT_INVALID');
  }
  return value;
}

/** 重规划上下文进提示词：只作生成输入，审计以工作流的 replanHistory 为准。 */
function campaignPlanReplanPrompt(
  replan: CampaignPlanReplanContext | undefined,
  round: number,
): Record<string, unknown> | undefined {
  if (replan === undefined) return undefined;
  if (round === 0 && replan.reasonCode !== 'HUMAN_DECLINE') {
    throw nonRetryable('CAMPAIGN_PLAN_INPUT_INVALID');
  }
  if (round > 0 && replan.reasonCode !== 'VALIDATOR_ISSUES') {
    throw nonRetryable('CAMPAIGN_PLAN_INPUT_INVALID');
  }
  const detail =
    typeof replan.detail === 'string' ? replan.detail.slice(0, 500) : undefined;
  return {
    reasonCode: replan.reasonCode,
    ...(detail !== undefined ? { detail } : {}),
    ...(replan.issues !== undefined
      ? {
          issues: replan.issues.slice(0, 50).map((issue) => ({
            path: String(issue.path).slice(0, 200),
            message: String(issue.message).slice(0, 300),
          })),
        }
      : {}),
    ...(replan.previousPlan !== undefined ? { previousPlan: replan.previousPlan } : {}),
  };
}

function groupCounts(
  rows: readonly unknown[],
  key: 'country' | 'industry',
): { key: string; count: number }[] {
  const counts: { key: string; count: number }[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const rawKey = record[key];
    const rawCount = (record._count as { _all?: unknown } | undefined)?._all;
    if (typeof rawCount !== 'number' || !Number.isSafeInteger(rawCount)) continue;
    counts.push({
      key: typeof rawKey === 'string' && rawKey.length > 0 ? rawKey.slice(0, 120) : 'unknown',
      count: rawCount,
    });
  }
  return counts;
}
