import { Prisma, type PrismaClient } from "@prisma/client";
import { BUILTIN_AGENTS } from "./agent-catalog";

/**
 * agent 注册表播种（owner 连接、启动期幂等，沿用技能目录 seed 模式）。
 *
 * - 只同步代码侧定义字段（name / role_prompt_version / skill_keys / model_policy /
 *   memory_scope / loop_policy），**不覆盖 ops 手改的 status**（kill switch 优先）。
 * - 目录行缺失即补建（status=ACTIVE 默认）；并发安全：INSERT ON CONFLICT DO NOTHING 后复读校验。
 */

export interface AgentCatalogSeedResult {
  readonly profiles: number;
  readonly inserted: number;
  readonly updated: number;
}

interface IdRow {
  readonly id: string;
}

export async function seedAgentCatalog(db: PrismaClient): Promise<AgentCatalogSeedResult> {
  let inserted = 0;
  let updated = 0;

  for (const agent of BUILTIN_AGENTS) {
    await db.$transaction(async (tx) => {
      const created = await tx.$executeRaw(Prisma.sql`
        INSERT INTO "agent_profile"
          ("id", "agent_key", "name", "role_prompt_version", "skill_keys", "model_policy",
           "memory_scope", "loop_policy", "status")
        VALUES
          (gen_random_uuid(), ${agent.agentKey}, ${agent.name}, ${agent.rolePromptVersion},
           ${JSON.stringify(agent.skillKeys)}::jsonb, ${JSON.stringify(agent.modelPolicy)}::jsonb,
           ${agent.memoryScope}, ${JSON.stringify(agent.loopPolicy)}::jsonb, 'ACTIVE')
        ON CONFLICT ("agent_key") DO NOTHING
      `);
      const rows = await tx.$queryRaw<IdRow[]>(Prisma.sql`
        SELECT "id"::text AS "id"
        FROM "agent_profile"
        WHERE "agent_key" = ${agent.agentKey}
        LIMIT 1
      `);
      if (!rows[0]) {
        throw new Error(
          `AGENT_CATALOG_SEED_UNAVAILABLE: profile row missing after insert (${agent.agentKey})`,
        );
      }
      await tx.$executeRaw(Prisma.sql`
        UPDATE "agent_profile"
        SET "name" = ${agent.name},
            "role_prompt_version" = ${agent.rolePromptVersion},
            "skill_keys" = ${JSON.stringify(agent.skillKeys)}::jsonb,
            "model_policy" = ${JSON.stringify(agent.modelPolicy)}::jsonb,
            "memory_scope" = ${agent.memoryScope},
            "loop_policy" = ${JSON.stringify(agent.loopPolicy)}::jsonb,
            "updated_at" = now()
        WHERE "agent_key" = ${agent.agentKey}
      `);
      if (created === 1) {
        inserted += 1;
      } else {
        updated += 1;
      }
    });
  }

  return { profiles: BUILTIN_AGENTS.length, inserted, updated };
}
