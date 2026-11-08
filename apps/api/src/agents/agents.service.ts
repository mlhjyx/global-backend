import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { AgentStatus } from "./agent-registry.store";

/**
 * M2 步 9b agent 注册表 ops 面（列表 + 平台启停），复用 S0 ops 鉴权（ops:read / ops:write）。
 * 启停对执行侧的最迟生效时延 = worker agent 解析缓存的 TTL（默认 30s，见 agent-resolver.ts）。
 */

export type { AgentStatus };

export interface AgentProfileListRow {
  readonly id: string;
  readonly agentKey: string;
  readonly name: string;
  readonly rolePromptVersion: string;
  readonly skillKeys: unknown;
  readonly modelPolicy: unknown;
  readonly memoryScope: string;
  readonly loopPolicy: unknown;
  readonly status: AgentStatus;
  readonly statusReason: string | null;
  readonly statusUpdatedAt: Date | null;
  readonly statusUpdatedBy: string | null;
  readonly updatedAt: Date;
}

@Injectable()
export class AgentsService {
  constructor(private readonly prisma: PrismaService) {}

  async listAgents(operatorWorkspaceId: string): Promise<readonly AgentProfileListRow[]> {
    return this.prisma.withWorkspace(operatorWorkspaceId, (tx) =>
      tx.$queryRaw<AgentProfileListRow[]>(Prisma.sql`
        SELECT "id"::text AS "id",
               "agent_key" AS "agentKey",
               "name",
               "role_prompt_version" AS "rolePromptVersion",
               "skill_keys" AS "skillKeys",
               "model_policy" AS "modelPolicy",
               "memory_scope" AS "memoryScope",
               "loop_policy" AS "loopPolicy",
               "status",
               "status_reason" AS "statusReason",
               "status_updated_at" AS "statusUpdatedAt",
               "status_updated_by" AS "statusUpdatedBy",
               "updated_at" AS "updatedAt"
        FROM "agent_profile"
        ORDER BY "agent_key"
      `),
    );
  }

  async setStatus(
    operatorWorkspaceId: string,
    operatorUserId: string | undefined,
    agentKey: string,
    status: AgentStatus,
    reason: string | undefined,
  ) {
    return this.prisma.withWorkspace(operatorWorkspaceId, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        UPDATE "agent_profile"
        SET "status" = ${status},
            "status_reason" = ${reason ?? null},
            "status_updated_at" = now(),
            "status_updated_by" = ${operatorUserId ?? null},
            "updated_at" = now()
        WHERE "agent_key" = ${agentKey}
        RETURNING "id"::text AS "id"
      `);
      if (rows.length === 0) throw new NotFoundException(`agent not registered: ${agentKey}`);
      return { agentKey, status, reason: reason ?? null };
    });
  }
}
