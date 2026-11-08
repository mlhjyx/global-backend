import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { RequestContext } from "../auth/request-context";
import {
  PrismaAgentDecisionTraceStore,
  type AgentDecisionTraceRow,
} from "./agent-decision-trace.store";

/**
 * M2 步 9b-4：run 决策轨迹的租户只读面（前端「过程」时间线的数据源）。
 *
 * - 跨租户一律 404（与 discovery 既有读端点同口径：RLS 先隐藏，再按 run 判存在性）；
 * - 键集分页（created_at, id 升序），cursor 为不透明串；limit 默认 100、上限 200；
 * - 只读取轨迹表，不做任何写入或聚合改写。
 */

export const RUN_TRACE_DEFAULT_LIMIT = 100;
export const RUN_TRACE_MAX_LIMIT = 200;

export interface RunTraceCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export function encodeRunTraceCursor(row: Pick<AgentDecisionTraceRow, "createdAt" | "id">): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

/** 不合法（非 base64url、缺分隔、时间或 UUID 非法）返回 null，由调用方转 400。 */
export function decodeRunTraceCursor(cursor: string): RunTraceCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.indexOf("|");
  if (separator <= 0) return null;
  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime())) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id)) return null;
  return { createdAt, id };
}

@Injectable()
export class RunTraceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly traces: PrismaAgentDecisionTraceStore,
  ) {}

  async listRunTrace(
    ctx: RequestContext,
    runId: string,
    opts: { readonly limit: number; readonly cursor?: string },
  ) {
    const limit = Math.min(Math.max(opts.limit, 1), RUN_TRACE_MAX_LIMIT);
    const after = opts.cursor === undefined ? null : decodeRunTraceCursor(opts.cursor);
    if (opts.cursor !== undefined && after === null) {
      throw new BadRequestException({
        error: { code: "VALIDATION_ERROR", message: "cursor is invalid" },
      });
    }
    const run = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.discoveryRun.findUnique({ where: { id: runId }, select: { id: true } }),
    );
    if (!run) {
      throw new NotFoundException({ error: { code: "NOT_FOUND", message: "run not found" } });
    }
    const rows = await this.traces.listRunTrace(ctx.workspaceId, runId, after, limit + 1);
    const page = rows.slice(0, limit);
    return {
      data: page.map((row) => ({
        id: row.id,
        stepType: row.stepType,
        agentKey: row.agentKey,
        actorType: row.actorType,
        attempt: row.attempt,
        decisionType: row.decisionType,
        chosenOption: (row.chosenOption ?? null) as Record<string, unknown> | null,
        score: row.score,
        reasonCode: row.reasonCode,
        evidence: (row.evidence ?? []) as unknown[],
        rejectedCandidates: (row.rejectedCandidates ?? []) as unknown[],
        costEstimatedMicros: row.costEstimatedMicros,
        costActualMicros: row.costActualMicros,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length > limit ? encodeRunTraceCursor(page[page.length - 1]!) : null,
      hasMore: rows.length > limit,
    };
  }
}
