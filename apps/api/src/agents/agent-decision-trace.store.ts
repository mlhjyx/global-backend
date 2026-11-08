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

/** 轨迹的租户只读行（9b-4）：按 (created_at, id) 键集分页返回。 */
export interface AgentDecisionTraceRow {
  readonly id: string;
  readonly stepType: string;
  readonly agentKey: string;
  readonly actorType: string;
  readonly attempt: number;
  readonly decisionType: string;
  readonly chosenOption: unknown;
  readonly score: number | null;
  readonly reasonCode: string | null;
  readonly evidence: unknown;
  readonly rejectedCandidates: unknown;
  readonly costEstimatedMicros: string | null;
  readonly costActualMicros: string | null;
  readonly createdAt: Date;
}

export interface AgentDecisionTraceReader {
  /** 键集分页：`after` 为上一页最后一行的 (created_at, id)；按时间升序返回最多 `limit` 行。 */
  listRunTrace(
    workspaceId: string,
    runId: string,
    after: { readonly createdAt: Date; readonly id: string } | null,
    limit: number,
  ): Promise<AgentDecisionTraceRow[]>;
}

type TransactionClient = Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw">;

const EMPTY_ARRAY = [] as const;

export class PrismaAgentDecisionTraceStore
  implements AgentDecisionTraceStore, AgentDecisionTraceReader
{
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

  async listRunTrace(
    workspaceId: string,
    runId: string,
    after: { readonly createdAt: Date; readonly id: string } | null,
    limit: number,
  ): Promise<AgentDecisionTraceRow[]> {
    return this.prisma.withWorkspace(workspaceId, async (tx: TransactionClient) => {
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          stepType: string;
          agentKey: string;
          actorType: string;
          attempt: number;
          decisionType: string;
          chosenOption: unknown;
          score: number | null;
          reasonCode: string | null;
          evidence: unknown;
          rejectedCandidates: unknown;
          costEstimatedMicros: string | null;
          costActualMicros: string | null;
          createdAt: Date;
        }>
      >(Prisma.sql`
        SELECT "id"::text AS "id",
               "step_type" AS "stepType",
               "agent_key" AS "agentKey",
               "actor_type" AS "actorType",
               "attempt",
               "decision_type" AS "decisionType",
               "chosen_option" AS "chosenOption",
               "score",
               "reason_code" AS "reasonCode",
               "evidence",
               "rejected_candidates" AS "rejectedCandidates",
               "cost_estimated_micros"::text AS "costEstimatedMicros",
               "cost_actual_micros"::text AS "costActualMicros",
               "created_at" AS "createdAt"
        FROM "agent_decision_trace"
        WHERE "run_id" = ${runId}::uuid
          ${
            after
              ? Prisma.sql`AND ("created_at", "id") > (${after.createdAt}, ${after.id}::uuid)`
              : Prisma.empty
          }
        ORDER BY "created_at" ASC, "id" ASC
        LIMIT ${limit}
      `);
      return rows;
    });
  }
}
