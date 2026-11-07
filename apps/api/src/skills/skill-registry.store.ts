import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import { SKILL_RESOLVER_VERSION, type ResolvedSkillDescriptor } from "./skill-runtime";
import type { SkillManifest } from "./skill-manifest";

/**
 * 技能注册表的持久化访问层（S0 用 raw SQL，避免为四张新表扩 Prisma schema）。
 * 所有租户表操作都经 `withWorkspace`（RLS 上下文）；平台目录行（workspace_id IS NULL）
 * 对任何 workspace 上下文可读。
 */

export interface SkillPackageRow {
  readonly id: string;
  readonly status: "ACTIVE" | "DISABLED";
  readonly packType: string;
}

export interface SkillVersionRow {
  readonly id: string;
  readonly version: string;
  readonly manifest: SkillManifest;
  readonly manifestDigest: string;
  readonly taskContractId: string;
  readonly taskContractDigest: string;
}

export interface SkillSnapshotWrite {
  readonly skillKey: string;
  readonly packageId: string;
  readonly versionId: string;
  readonly descriptor: ResolvedSkillDescriptor;
  readonly descriptorDigest: string;
}

export interface SkillRegistryStore {
  loadPlatformPackage(workspaceId: string, skillKey: string): Promise<SkillPackageRow | null>;
  loadCurrentVersion(workspaceId: string, packageId: string): Promise<SkillVersionRow | null>;
  /** null = 没有覆盖行（跟随平台默认 = 启用）。 */
  loadEnablement(workspaceId: string, packageId: string): Promise<boolean | null>;
  /** 内容寻址、append-only；重复写入静默跳过。 */
  insertSnapshot(workspaceId: string, snapshot: SkillSnapshotWrite): Promise<void>;
}

type TransactionClient = Pick<
  Prisma.TransactionClient,
  "$queryRaw" | "$executeRaw"
>;

export class PrismaSkillRegistryStore implements SkillRegistryStore {
  constructor(private readonly prisma: Pick<PrismaService, "withWorkspace">) {}

  async loadPlatformPackage(workspaceId: string, skillKey: string): Promise<SkillPackageRow | null> {
    return this.prisma.withWorkspace(workspaceId, async (tx: TransactionClient) => {
      const rows = await tx.$queryRaw<
        { id: string; status: string; packType: string }[]
      >(Prisma.sql`
        SELECT "id"::text AS "id", "status", "pack_type" AS "packType"
        FROM "skill_package"
        WHERE "skill_key" = ${skillKey}
          AND "scope" = 'platform'
          AND "workspace_id" IS NULL
        LIMIT 1
      `);
      const row = rows[0];
      if (!row) return null;
      return { id: row.id, status: row.status as SkillPackageRow["status"], packType: row.packType };
    });
  }

  async loadCurrentVersion(workspaceId: string, packageId: string): Promise<SkillVersionRow | null> {
    return this.prisma.withWorkspace(workspaceId, async (tx: TransactionClient) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          version: string;
          manifest: SkillManifest;
          manifestDigest: string;
          taskContractId: string;
          taskContractDigest: string;
        }[]
      >(Prisma.sql`
        SELECT "id"::text AS "id",
               "version",
               "manifest",
               "manifest_digest" AS "manifestDigest",
               "task_contract_id" AS "taskContractId",
               "task_contract_digest" AS "taskContractDigest"
        FROM "skill_version"
        WHERE "package_id" = ${packageId}::uuid
        ORDER BY "created_at" DESC, "id" DESC
        LIMIT 1
      `);
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        version: row.version,
        manifest: row.manifest,
        manifestDigest: row.manifestDigest,
        taskContractId: row.taskContractId,
        taskContractDigest: row.taskContractDigest,
      };
    });
  }

  async loadEnablement(workspaceId: string, packageId: string): Promise<boolean | null> {
    return this.prisma.withWorkspace(workspaceId, async (tx: TransactionClient) => {
      const rows = await tx.$queryRaw<{ enabled: boolean }[]>(Prisma.sql`
        SELECT "enabled"
        FROM "skill_enablement"
        WHERE "workspace_id" = ${workspaceId}::uuid
          AND "package_id" = ${packageId}::uuid
        LIMIT 1
      `);
      return rows.length === 0 ? null : rows[0].enabled;
    });
  }

  async insertSnapshot(workspaceId: string, snapshot: SkillSnapshotWrite): Promise<void> {
    await this.prisma.withWorkspace(workspaceId, async (tx: TransactionClient) => {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "skill_resolution_snapshot"
          ("id", "workspace_id", "skill_key", "package_id", "version_id", "descriptor", "descriptor_digest", "resolver_version")
        VALUES
          (${randomUUID()}::uuid, ${workspaceId}::uuid, ${snapshot.skillKey},
           ${snapshot.packageId}::uuid, ${snapshot.versionId}::uuid,
           ${JSON.stringify(snapshot.descriptor)}::jsonb, ${snapshot.descriptorDigest}, ${SKILL_RESOLVER_VERSION})
        ON CONFLICT ("workspace_id", "skill_key", "descriptor_digest") DO NOTHING
      `);
    });
  }
}
