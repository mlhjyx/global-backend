import { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * agent 注册表的持久化访问层（raw SQL，同 S0 技能注册表；不为新表扩 Prisma schema）。
 * `agent_profile` 是平台目录（无 workspace 维度），任何 workspace 上下文都可读；
 * 所有访问仍走 `withWorkspace`，与执行侧 RLS 上下文一致。
 */

export type AgentStatus = "ACTIVE" | "DISABLED";

export interface AgentProfileRow {
  readonly id: string;
  readonly agentKey: string;
  readonly name: string;
  readonly rolePromptVersion: string;
  readonly skillKeys: readonly string[];
  readonly modelPolicy: Record<string, unknown>;
  readonly memoryScope: string;
  readonly loopPolicy: Record<string, unknown>;
  readonly status: AgentStatus;
}

export interface AgentRegistryStore {
  loadProfile(workspaceId: string, agentKey: string): Promise<AgentProfileRow | null>;
}

type TransactionClient = Pick<Prisma.TransactionClient, "$queryRaw">;

interface ProfileDbRow {
  readonly id: string;
  readonly agentKey: string;
  readonly name: string;
  readonly rolePromptVersion: string;
  readonly skillKeys: unknown;
  readonly modelPolicy: unknown;
  readonly memoryScope: string;
  readonly loopPolicy: unknown;
  readonly status: string;
}

export class PrismaAgentRegistryStore implements AgentRegistryStore {
  constructor(private readonly prisma: Pick<PrismaService, "withWorkspace">) {}

  async loadProfile(workspaceId: string, agentKey: string): Promise<AgentProfileRow | null> {
    return this.prisma.withWorkspace(workspaceId, async (tx: TransactionClient) => {
      const rows = await tx.$queryRaw<ProfileDbRow[]>(Prisma.sql`
        SELECT "id"::text AS "id",
               "agent_key" AS "agentKey",
               "name",
               "role_prompt_version" AS "rolePromptVersion",
               "skill_keys" AS "skillKeys",
               "model_policy" AS "modelPolicy",
               "memory_scope" AS "memoryScope",
               "loop_policy" AS "loopPolicy",
               "status"
        FROM "agent_profile"
        WHERE "agent_key" = ${agentKey}
        LIMIT 1
      `);
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        agentKey: row.agentKey,
        name: row.name,
        rolePromptVersion: row.rolePromptVersion,
        skillKeys: stringArray(row.skillKeys),
        modelPolicy: recordOrEmpty(row.modelPolicy),
        memoryScope: row.memoryScope,
        loopPolicy: recordOrEmpty(row.loopPolicy),
        status: row.status as AgentStatus,
      };
    });
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
