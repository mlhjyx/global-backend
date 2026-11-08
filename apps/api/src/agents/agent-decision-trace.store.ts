import { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * 决策轨迹的 append-only 写入层（设计 §3.1/§5，F2 字段组子集，无 PII）。
 *
 * - 唯一写入口 `record`：INSERT … ON CONFLICT ("workspace_id", "run_id", "step_type",
 *   "discriminator") DO NOTHING —— 活动重试（同回合重放）不翻行。
 * - 刻意**不提供** UPDATE / DELETE 方法；DB 侧 app_user 也无对应权限（负向测试 4）。
 * - 证据字段只许 URL + 抓取时间 + 支持关系；被否候选只许公司引用 id（PII 红线）。
 */

export type AgentStepType = "discovery.query" | "discovery.quick_scan";

export interface AgentDecisionTraceWrite {
  readonly workspaceId: string;
  readonly runId: string;
  readonly workflowId?: string | null;
  readonly parentTraceId?: string | null;
  readonly stepType: AgentStepType;
  readonly agentKey: string;
  readonly attempt?: number;
  readonly decisionType: string;
  /** 回合幂等键：source.route 用 queryKey；fit.judge 用批次内容哈希。 */
  readonly discriminator: string;
  readonly chosenOption?: unknown;
  readonly score?: number | null;
  readonly reasonCode?: string | null;
  readonly evidence?: unknown;
  readonly rejectedCandidates?: unknown;
  readonly costEstimatedMicros?: number | null;
  readonly costActualMicros?: number | null;
}

export interface AgentDecisionTraceStore {
  /** 幂等追加：同一 (workspace, run, stepType, discriminator) 重放不新增行。 */
  record(trace: AgentDecisionTraceWrite): Promise<void>;
}

type TransactionClient = Pick<Prisma.TransactionClient, "$executeRaw">;

const EMPTY_ARRAY = [] as const;

export class PrismaAgentDecisionTraceStore implements AgentDecisionTraceStore {
  constructor(private readonly prisma: Pick<PrismaService, "withWorkspace">) {}

  async record(trace: AgentDecisionTraceWrite): Promise<void> {
    const evidence = trace.evidence ?? EMPTY_ARRAY;
    const rejected = trace.rejectedCandidates ?? EMPTY_ARRAY;
    await this.prisma.withWorkspace(trace.workspaceId, async (tx: TransactionClient) => {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "agent_decision_trace"
          ("workspace_id", "run_id", "workflow_id", "parent_trace_id", "step_type", "agent_key",
           "actor_type", "attempt", "decision_type", "discriminator", "chosen_option", "score",
           "reason_code", "evidence", "rejected_candidates", "cost_estimated_micros",
           "cost_actual_micros")
        VALUES
          (${trace.workspaceId}::uuid, ${trace.runId}::uuid,
           ${trace.workflowId ?? null}, ${trace.parentTraceId ?? null}::uuid,
           ${trace.stepType}, ${trace.agentKey}, 'agent', ${trace.attempt ?? 1},
           ${trace.decisionType}, ${trace.discriminator},
           ${trace.chosenOption === undefined ? null : JSON.stringify(trace.chosenOption)}::jsonb,
           ${trace.score ?? null}, ${trace.reasonCode ?? null},
           ${JSON.stringify(evidence)}::jsonb, ${JSON.stringify(rejected)}::jsonb,
           ${trace.costEstimatedMicros ?? null}, ${trace.costActualMicros ?? null})
        ON CONFLICT ("workspace_id", "run_id", "step_type", "discriminator") DO NOTHING
      `);
    });
  }
}
