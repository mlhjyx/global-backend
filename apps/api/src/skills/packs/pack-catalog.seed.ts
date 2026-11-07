import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { canonicalDigest } from "../../model-runtime/context-engine";
import { BUILTIN_PACKS } from "./generated/builtin-pack-catalog";

/**
 * Pack 目录播种（owner 连接、启动期幂等，与 skill / sanctions seed 同模式）。
 * - package upsert：只更新 pack_type，不覆盖 ops 手改的 status。
 * - version 只增不改：同 (package, version) 摘要不一致 → 大声失败。
 * - 激活：只为「尚无平台激活」的包插入默认激活（不覆盖后续 ops 的激活/回滚）。
 */

export class PackCatalogSeedDriftError extends Error {
  readonly code = "PACK_VERSION_IMMUTABLE_DRIFT";

  constructor(detail: string) {
    super(`${detail} changed without a version bump (update pack.json version)`);
    this.name = "PackCatalogSeedDriftError";
  }
}

export interface PackCatalogSeedResult {
  readonly packages: number;
  readonly versionsInserted: number;
  readonly versionsUnchanged: number;
  readonly activationsInserted: number;
}

interface IdRow {
  readonly id: string;
}

interface VersionDigestRow {
  readonly id: string;
  readonly manifestDigest: string;
  readonly contentDigest: string;
}

export async function seedPackCatalog(db: PrismaClient): Promise<PackCatalogSeedResult> {
  let versionsInserted = 0;
  let versionsUnchanged = 0;
  let activationsInserted = 0;

  for (const record of BUILTIN_PACKS) {
    const manifest = record.manifest;
    const packKey = manifest.packKey;
    const version = manifest.version;
    const manifestDigest = canonicalDigest(manifest);
    const contentDigest = record.contentDigest;

    await db.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "pack_package" ("id", "pack_key", "pack_type", "status")
        VALUES (${randomUUID()}::uuid, ${packKey}, ${manifest.packType}, 'ACTIVE')
        ON CONFLICT ("pack_key") DO NOTHING
      `);
      const packages = await tx.$queryRaw<IdRow[]>(Prisma.sql`
        SELECT "id"::text AS "id" FROM "pack_package" WHERE "pack_key" = ${packKey} LIMIT 1
      `);
      const packageId = packages[0]?.id;
      if (!packageId) {
        throw new Error(`PACK_CATALOG_SEED_UNAVAILABLE: package row missing after insert (${packKey})`);
      }
      await tx.$executeRaw(Prisma.sql`
        UPDATE "pack_package"
        SET "pack_type" = ${manifest.packType}, "updated_at" = now()
        WHERE "id" = ${packageId}::uuid
      `);

      const inserted = await tx.$executeRaw(Prisma.sql`
        INSERT INTO "pack_version"
          ("id", "package_id", "version", "manifest", "content", "manifest_digest", "content_digest")
        VALUES
          (${randomUUID()}::uuid, ${packageId}::uuid, ${version},
           ${JSON.stringify(manifest)}::jsonb, ${record.content},
           ${manifestDigest}, ${contentDigest})
        ON CONFLICT ("package_id", "version") DO NOTHING
      `);
      const versions = await tx.$queryRaw<VersionDigestRow[]>(Prisma.sql`
        SELECT "id"::text AS "id",
               "manifest_digest" AS "manifestDigest",
               "content_digest" AS "contentDigest"
        FROM "pack_version"
        WHERE "package_id" = ${packageId}::uuid AND "version" = ${version}
        LIMIT 1
      `);
      const stored = versions[0];
      if (!stored) {
        throw new Error(`PACK_CATALOG_SEED_UNAVAILABLE: version row missing after insert (${packKey}@${version})`);
      }
      if (stored.manifestDigest !== manifestDigest || stored.contentDigest !== contentDigest) {
        throw new PackCatalogSeedDriftError(`${packKey}@${version}`);
      }
      if (inserted === 1) {
        versionsInserted += 1;
      } else {
        versionsUnchanged += 1;
      }

      const activations = await tx.$queryRaw<IdRow[]>(Prisma.sql`
        SELECT "id"::text AS "id"
        FROM "pack_activation"
        WHERE "package_id" = ${packageId}::uuid AND "scope" = 'platform'
        LIMIT 1
      `);
      if (activations.length === 0) {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "pack_activation"
            ("id", "package_id", "version_id", "scope", "canary", "activated_by")
          VALUES
            (${randomUUID()}::uuid, ${packageId}::uuid, ${stored.id}::uuid, 'platform', false, 'seed')
        `);
        activationsInserted += 1;
      }
    });
  }

  return {
    packages: BUILTIN_PACKS.length,
    versionsInserted,
    versionsUnchanged,
    activationsInserted,
  };
}
