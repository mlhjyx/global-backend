import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../../prisma/prisma.service";
import type { PackManifest, PackType } from "./pack-manifest";

/**
 * Pack 注册表持久化访问层（raw SQL；与 S0 技能注册表同一模式）。
 * 平台表在任意 workspace 上下文可读；启用覆盖与策略快照按当前 workspace 隔离。
 */

export interface PackPackageRow {
  readonly id: string;
  readonly packKey: string;
  readonly packType: PackType;
  readonly status: "ACTIVE" | "DISABLED";
}

export interface PackVersionRow {
  readonly id: string;
  readonly packageId: string;
  readonly version: string;
  readonly manifest: PackManifest;
  readonly content: string;
  readonly manifestDigest: string;
  readonly contentDigest: string;
}

export interface StrategySnapshotWrite {
  readonly skillKey: string;
  readonly descriptor: unknown;
  readonly descriptorDigest: string;
  readonly resolverVersion: string;
}

export interface PackRegistryStore {
  listActivePackages(workspaceId: string): Promise<readonly PackPackageRow[]>;
  /** 生效版本：workspace 激活优先，否则平台激活；都没有则 null。 */
  loadEffectiveVersion(workspaceId: string, packageId: string): Promise<PackVersionRow | null>;
  /** null = 无覆盖（跟随平台默认）。 */
  loadEnablement(workspaceId: string, packageId: string): Promise<boolean | null>;
  /** 策略快照：内容寻址、append-only、重复写入静默跳过。 */
  insertStrategySnapshot(workspaceId: string, snapshot: StrategySnapshotWrite): Promise<void>;
}

type TransactionClient = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

export class PrismaPackRegistryStore implements PackRegistryStore {
  constructor(private readonly prisma: Pick<PrismaService, "withWorkspace">) {}

  async listActivePackages(workspaceId: string): Promise<readonly PackPackageRow[]> {
    return this.prisma.withWorkspace(workspaceId, async (tx: TransactionClient) => {
      const rows = await tx.$queryRaw<
        { id: string; packKey: string; packType: string; status: string }[]
      >(Prisma.sql`
        SELECT "id"::text AS "id", "pack_key" AS "packKey", "pack_type" AS "packType", "status"
        FROM "pack_package"
        WHERE "status" = 'ACTIVE'
        ORDER BY "pack_key"
      `);
      return rows.map((row) => ({
        id: row.id,
        packKey: row.packKey,
        packType: row.packType as PackType,
        status: row.status as PackPackageRow["status"],
      }));
    });
  }

  async loadEffectiveVersion(workspaceId: string, packageId: string): Promise<PackVersionRow | null> {
    return this.prisma.withWorkspace(workspaceId, async (tx: TransactionClient) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          packageId: string;
          version: string;
          manifest: PackManifest;
          content: string;
          manifestDigest: string;
          contentDigest: string;
        }[]
      >(Prisma.sql`
        SELECT v."id"::text AS "id",
               v."package_id"::text AS "packageId",
               v."version",
               v."manifest",
               v."content",
               v."manifest_digest" AS "manifestDigest",
               v."content_digest" AS "contentDigest"
        FROM "pack_version" v
        JOIN "pack_activation" a ON a."version_id" = v."id" AND a."package_id" = v."package_id"
        WHERE a."package_id" = ${packageId}::uuid
          AND (
            (a."scope" = 'workspace' AND a."workspace_id" = ${workspaceId}::uuid)
            OR a."scope" = 'platform'
          )
        ORDER BY (CASE WHEN a."scope" = 'workspace' THEN 0 ELSE 1 END), a."created_at" DESC, a."id" DESC
        LIMIT 1
      `);
      return rows[0] ?? null;
    });
  }

  async loadEnablement(workspaceId: string, packageId: string): Promise<boolean | null> {
    return this.prisma.withWorkspace(workspaceId, async (tx: TransactionClient) => {
      const rows = await tx.$queryRaw<{ enabled: boolean }[]>(Prisma.sql`
        SELECT "enabled"
        FROM "pack_enablement"
        WHERE "workspace_id" = ${workspaceId}::uuid AND "package_id" = ${packageId}::uuid
        LIMIT 1
      `);
      return rows.length === 0 ? null : rows[0].enabled;
    });
  }

  async insertStrategySnapshot(workspaceId: string, snapshot: StrategySnapshotWrite): Promise<void> {
    await this.prisma.withWorkspace(workspaceId, async (tx: TransactionClient) => {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "strategy_resolution_snapshot"
          ("id", "workspace_id", "skill_key", "descriptor", "descriptor_digest", "resolver_version")
        VALUES
          (${randomUUID()}::uuid, ${workspaceId}::uuid, ${snapshot.skillKey},
           ${JSON.stringify(snapshot.descriptor)}::jsonb, ${snapshot.descriptorDigest},
           ${snapshot.resolverVersion})
        ON CONFLICT ("workspace_id", "skill_key", "descriptor_digest") DO NOTHING
      `);
    });
  }
}
