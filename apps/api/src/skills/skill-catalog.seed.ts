import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { canonicalDigest } from "../model-runtime/context-engine";
import { BUILTIN_SKILLS } from "./generated/builtin-skill-catalog";

/**
 * 技能目录播种（owner 连接、启动期幂等，沿 sanctions / data_provider seed 模式）。
 *
 * - package upsert：只更新 pack_type / display_name，**不覆盖 ops 手改的 status**。
 * - version 只增不改：同 (package, version) 已存在且 manifest/正文摘要一致 → no-op；
 *   任一不一致 → 抛错（要求 SKILL.md 版本号 +1，杜绝静默漂移）。
 * - 并发安全：worker 与 relay 可能同时启动，INSERT 一律 ON CONFLICT DO NOTHING 后复读校验。
 */

export class SkillCatalogSeedDriftError extends Error {
  readonly code = "SKILL_VERSION_IMMUTABLE_DRIFT";

  constructor(detail: string) {
    super(`${detail} changed without a version bump (update SKILL.md platform.version)`);
    this.name = "SkillCatalogSeedDriftError";
  }
}

export interface SkillCatalogSeedResult {
  readonly packages: number;
  readonly versionsInserted: number;
  readonly versionsUnchanged: number;
}

interface PackageIdRow {
  readonly id: string;
}

interface VersionDigestRow {
  readonly id: string;
  readonly manifestDigest: string;
  readonly bodyDigest: string;
}

export async function seedSkillCatalog(db: PrismaClient): Promise<SkillCatalogSeedResult> {
  let versionsInserted = 0;
  let versionsUnchanged = 0;

  for (const record of BUILTIN_SKILLS) {
    const manifest = record.manifest;
    const skillKey = manifest.platform.skillKey;
    const version = manifest.platform.version;
    const manifestDigest = canonicalDigest(manifest);
    const bodyDigest = createHash("sha256").update(record.body, "utf8").digest("hex");

    await db.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "skill_package"
          ("id", "skill_key", "scope", "workspace_id", "pack_type", "display_name", "status")
        VALUES
          (${randomUUID()}::uuid, ${skillKey}, 'platform', NULL,
           ${manifest.platform.packType}, ${manifest.name}, 'ACTIVE')
        ON CONFLICT ("skill_key") WHERE "workspace_id" IS NULL DO NOTHING
      `);
      const packages = await tx.$queryRaw<PackageIdRow[]>(Prisma.sql`
        SELECT "id"::text AS "id"
        FROM "skill_package"
        WHERE "skill_key" = ${skillKey} AND "workspace_id" IS NULL
        LIMIT 1
      `);
      const packageId = packages[0]?.id;
      if (!packageId) {
        throw new Error(
          `SKILL_CATALOG_SEED_UNAVAILABLE: package row missing after insert (${skillKey})`,
        );
      }
      await tx.$executeRaw(Prisma.sql`
        UPDATE "skill_package"
        SET "pack_type" = ${manifest.platform.packType},
            "display_name" = ${manifest.name},
            "updated_at" = now()
        WHERE "id" = ${packageId}::uuid
      `);

      const inserted = await tx.$executeRaw(Prisma.sql`
        INSERT INTO "skill_version"
          ("id", "package_id", "workspace_id", "version", "manifest", "body_markdown",
           "manifest_digest", "body_digest", "task_contract_id", "task_contract_digest",
           "service_handler")
        VALUES
          (${randomUUID()}::uuid, ${packageId}::uuid, NULL, ${version},
           ${JSON.stringify(manifest)}::jsonb, ${record.body},
           ${manifestDigest}, ${bodyDigest},
           ${manifest.platform.taskContractId ?? null}, ${manifest.platform.taskContractDigest ?? null},
           ${manifest.platform.serviceHandler ?? null})
        ON CONFLICT ("package_id", "version") DO NOTHING
      `);
      const versions = await tx.$queryRaw<VersionDigestRow[]>(Prisma.sql`
        SELECT "id"::text AS "id",
               "manifest_digest" AS "manifestDigest",
               "body_digest" AS "bodyDigest"
        FROM "skill_version"
        WHERE "package_id" = ${packageId}::uuid AND "version" = ${version}
        LIMIT 1
      `);
      const stored = versions[0];
      if (!stored) {
        throw new Error(
          `SKILL_CATALOG_SEED_UNAVAILABLE: version row missing after insert (${skillKey}@${version})`,
        );
      }
      if (stored.manifestDigest !== manifestDigest || stored.bodyDigest !== bodyDigest) {
        throw new SkillCatalogSeedDriftError(`${skillKey}@${version}`);
      }
      if (inserted === 1) {
        versionsInserted += 1;
      } else {
        versionsUnchanged += 1;
      }
    });
  }

  return { packages: BUILTIN_SKILLS.length, versionsInserted, versionsUnchanged };
}
