import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

/**
 * S0 ops 技能管理（列表/详情/平台启停/workspace 覆盖）。
 *
 * 平台目录与版本是 RLS 允许跨空间只读的表；workspace 覆盖是租户表，读写都经
 * `withWorkspace(目标 workspace)`（RLS 保证只能落到该空间）。
 * 启停对执行侧的最迟生效时延 = worker 解析缓存的 TTL（默认 30s，见 skill-resolver.ts）。
 */

export type SkillStatus = "ACTIVE" | "DISABLED";

export interface SkillCatalogListRow {
  readonly id: string;
  readonly skillKey: string;
  readonly status: SkillStatus;
  readonly packType: string;
  readonly displayName: string;
  readonly statusReason: string | null;
  readonly statusUpdatedAt: Date | null;
  readonly statusUpdatedBy: string | null;
  readonly currentVersion: string | null;
  readonly currentVersionCreatedAt: Date | null;
}

export interface SkillVersionRow {
  readonly id: string;
  readonly version: string;
  readonly manifest: unknown;
  readonly bodyMarkdown: string;
  readonly manifestDigest: string;
  readonly bodyDigest: string;
  readonly taskContractId: string;
  readonly taskContractDigest: string;
  readonly createdAt: Date;
}

export interface PackageIdentityRow {
  readonly id: string;
  readonly status: SkillStatus;
}

export interface EnablementRow {
  readonly enabled: boolean;
  readonly reason: string | null;
  readonly updatedAt: Date;
}

@Injectable()
export class SkillsService {
  constructor(private readonly prisma: PrismaService) {}

  async listSkills(operatorWorkspaceId: string): Promise<readonly SkillCatalogListRow[]> {
    return this.prisma.withWorkspace(operatorWorkspaceId, (tx) =>
      tx.$queryRaw<SkillCatalogListRow[]>(Prisma.sql`
        SELECT p."id"::text AS "id",
               p."skill_key" AS "skillKey",
               p."status",
               p."pack_type" AS "packType",
               p."display_name" AS "displayName",
               p."status_reason" AS "statusReason",
               p."status_updated_at" AS "statusUpdatedAt",
               p."status_updated_by" AS "statusUpdatedBy",
               v."version" AS "currentVersion",
               v."created_at" AS "currentVersionCreatedAt"
        FROM "skill_package" p
        LEFT JOIN LATERAL (
          SELECT "version", "created_at"
          FROM "skill_version"
          WHERE "package_id" = p."id"
          ORDER BY "created_at" DESC, "id" DESC
          LIMIT 1
        ) v ON TRUE
        WHERE p."workspace_id" IS NULL
        ORDER BY p."skill_key"
      `),
    );
  }

  async getSkill(operatorWorkspaceId: string, skillKey: string) {
    return this.prisma.withWorkspace(operatorWorkspaceId, async (tx) => {
      const rows = await tx.$queryRaw<SkillCatalogListRow[]>(Prisma.sql`
        SELECT p."id"::text AS "id",
               p."skill_key" AS "skillKey",
               p."status",
               p."pack_type" AS "packType",
               p."display_name" AS "displayName",
               p."status_reason" AS "statusReason",
               p."status_updated_at" AS "statusUpdatedAt",
               p."status_updated_by" AS "statusUpdatedBy",
               NULL::text AS "currentVersion",
               NULL::timestamp AS "currentVersionCreatedAt"
        FROM "skill_package" p
        WHERE p."skill_key" = ${skillKey} AND p."workspace_id" IS NULL
        LIMIT 1
      `);
      const pkg = rows[0];
      if (!pkg) throw new NotFoundException(`skill not registered: ${skillKey}`);
      const versions = await tx.$queryRaw<SkillVersionRow[]>(Prisma.sql`
        SELECT "id"::text AS "id",
               "version",
               "manifest",
               "body_markdown" AS "bodyMarkdown",
               "manifest_digest" AS "manifestDigest",
               "body_digest" AS "bodyDigest",
               "task_contract_id" AS "taskContractId",
               "task_contract_digest" AS "taskContractDigest",
               "created_at" AS "createdAt"
        FROM "skill_version"
        WHERE "package_id" = ${pkg.id}::uuid
        ORDER BY "created_at" DESC, "id" DESC
      `);
      return { ...pkg, versions };
    });
  }

  async setStatus(
    operatorWorkspaceId: string,
    operatorUserId: string | undefined,
    skillKey: string,
    status: SkillStatus,
    reason: string | undefined,
  ) {
    return this.prisma.withWorkspace(operatorWorkspaceId, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        UPDATE "skill_package"
        SET "status" = ${status},
            "status_reason" = ${reason ?? null},
            "status_updated_at" = now(),
            "status_updated_by" = ${operatorUserId ?? null},
            "updated_at" = now()
        WHERE "skill_key" = ${skillKey} AND "workspace_id" IS NULL
        RETURNING "id"::text AS "id"
      `);
      if (rows.length === 0) throw new NotFoundException(`skill not registered: ${skillKey}`);
      return { skillKey, status, reason: reason ?? null };
    });
  }

  async getWorkspaceEnablement(targetWorkspaceId: string, skillKey: string) {
    return this.prisma.withWorkspace(targetWorkspaceId, async (tx) => {
      const pkg = await this.platformPackage(tx, skillKey);
      const rows = await tx.$queryRaw<EnablementRow[]>(Prisma.sql`
        SELECT "enabled", "reason", "updated_at" AS "updatedAt"
        FROM "skill_enablement"
        WHERE "workspace_id" = ${targetWorkspaceId}::uuid AND "package_id" = ${pkg.id}::uuid
        LIMIT 1
      `);
      const override = rows[0] ?? null;
      return {
        skillKey,
        workspaceId: targetWorkspaceId,
        platformStatus: pkg.status,
        override,
        enabled: pkg.status === "ACTIVE" && (override?.enabled ?? true),
      };
    });
  }

  async setWorkspaceEnablement(
    targetWorkspaceId: string,
    operatorUserId: string | undefined,
    skillKey: string,
    enabled: boolean,
    reason: string | undefined,
  ) {
    return this.prisma.withWorkspace(targetWorkspaceId, async (tx) => {
      const pkg = await this.platformPackage(tx, skillKey);
      const rows = await tx.$queryRaw<EnablementRow[]>(Prisma.sql`
        INSERT INTO "skill_enablement"
          ("id", "workspace_id", "package_id", "enabled", "reason", "updated_by")
        VALUES
          (gen_random_uuid(), ${targetWorkspaceId}::uuid, ${pkg.id}::uuid, ${enabled},
           ${reason ?? null}, ${operatorUserId ?? null})
        ON CONFLICT ("workspace_id", "package_id") DO UPDATE
          SET "enabled" = EXCLUDED."enabled",
              "reason" = EXCLUDED."reason",
              "updated_by" = EXCLUDED."updated_by",
              "updated_at" = now()
        RETURNING "enabled", "reason", "updated_at" AS "updatedAt"
      `);
      return { skillKey, workspaceId: targetWorkspaceId, ...rows[0] };
    });
  }

  async clearWorkspaceEnablement(targetWorkspaceId: string, skillKey: string) {
    return this.prisma.withWorkspace(targetWorkspaceId, async (tx) => {
      const pkg = await this.platformPackage(tx, skillKey);
      const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        DELETE FROM "skill_enablement"
        WHERE "workspace_id" = ${targetWorkspaceId}::uuid AND "package_id" = ${pkg.id}::uuid
        RETURNING "id"::text AS "id"
      `);
      return { skillKey, workspaceId: targetWorkspaceId, removed: rows.length > 0 };
    });
  }

  private async platformPackage(
    tx: Pick<Prisma.TransactionClient, "$queryRaw">,
    skillKey: string,
  ): Promise<PackageIdentityRow> {
    const rows = await tx.$queryRaw<PackageIdentityRow[]>(Prisma.sql`
      SELECT "id"::text AS "id", "status"
      FROM "skill_package"
      WHERE "skill_key" = ${skillKey} AND "workspace_id" IS NULL
      LIMIT 1
    `);
    const pkg = rows[0];
    if (!pkg) throw new NotFoundException(`skill not registered: ${skillKey}`);
    return pkg;
  }
}
