import { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import { PERSONAL_DATA_ACCESS_RETENTION_DAYS } from "../compliance/personal-data-access-audit";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function boundedLimit(value: number | undefined, maximum: number): number {
  return Math.max(
    1,
    Math.min(Number.isSafeInteger(value) ? value! : maximum, maximum),
  );
}

function workspaceId(value: string): string {
  if (!UUID.test(value)) throw new Error("RAW_RETENTION_WORKSPACE_INVALID");
  return value;
}

/**
 * Least-privilege activities for the Raw retention workflow. Cross-workspace
 * discovery is an aggregate security-definer function returning UUIDs only;
 * mutation still runs inside PrismaService.withWorkspace().
 */
export function createRawSourceActivities(deps: { prisma: PrismaService }) {
  return {
    async listRawRetentionWorkspaces(args: {
      limit?: number;
      afterWorkspaceId?: string;
    }): Promise<{ workspaceIds: string[]; nextCursor: string | null }> {
      const limit = boundedLimit(args.limit, 500);
      const after = args.afterWorkspaceId
        ? workspaceId(args.afterWorkspaceId)
        : null;
      const rows = await deps.prisma.$queryRaw<Array<{ workspace_id: string }>>(
        Prisma.sql`SELECT workspace_id::text
          FROM list_due_raw_retention_workspaces_v1(${limit + 1}::integer, ${after}::uuid)`,
      );
      const valid = rows.map((row) => workspaceId(row.workspace_id));
      const page = valid.slice(0, limit);
      return {
        workspaceIds: page,
        nextCursor: valid.length > limit ? (page.at(-1) ?? null) : null,
      };
    },

    async expireRawSourceRecords(args: {
      workspaceId: string;
      limit?: number;
    }): Promise<{
      expired: number;
      deferredForConflict: number;
      hasMore: boolean;
    }> {
      const scopedWorkspaceId = workspaceId(args.workspaceId);
      const limit = boundedLimit(args.limit, 500);
      return deps.prisma.withWorkspace(scopedWorkspaceId, async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{
            expired: number;
            deferred_for_conflict: number;
            has_more: boolean;
          }>
        >(Prisma.sql`SELECT expired, deferred_for_conflict, has_more
          FROM expire_due_raw_source_records_v1(
            ${scopedWorkspaceId}::uuid, ${limit}::integer, NULL::timestamptz
          )`);
        const row = rows[0];
        if (
          !row ||
          !Number.isSafeInteger(row.expired) ||
          row.expired < 0 ||
          !Number.isSafeInteger(row.deferred_for_conflict) ||
          row.deferred_for_conflict < 0 ||
          typeof row.has_more !== "boolean"
        ) {
          throw new Error("RAW_RETENTION_RECEIPT_INVALID");
        }
        return {
          expired: row.expired,
          deferredForConflict: row.deferred_for_conflict,
          hasMore: row.has_more,
        };
      });
    },
    /**
     * Q25（2026-11-04）：个人数据访问审计的保留期清理。与 raw 记录清理同一安全模式——
     * 经 SECURITY DEFINER 函数按 workspace 分批删除超过保留期的行（app_user 无 DELETE 授权）。
     */
    async expirePersonalDataAccessAudit(args: {
      workspaceId: string;
      limit?: number;
      retentionDays?: number;
    }): Promise<{ expired: number; hasMore: boolean }> {
      const scopedWorkspaceId = workspaceId(args.workspaceId);
      const limit = boundedLimit(args.limit, 5000);
      const retentionDays = Math.max(
        1,
        Math.min(
          Number.isSafeInteger(args.retentionDays)
            ? args.retentionDays!
            : PERSONAL_DATA_ACCESS_RETENTION_DAYS,
          3650,
        ),
      );
      return deps.prisma.withWorkspace(scopedWorkspaceId, async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{ expired: number; has_more: boolean }>
        >(Prisma.sql`SELECT expired, has_more
          FROM expire_personal_data_access_audit_v1(
            ${scopedWorkspaceId}::uuid, ${retentionDays}::integer, ${limit}::integer
          )`);
        const row = rows[0];
        if (
          !row ||
          !Number.isSafeInteger(row.expired) ||
          row.expired < 0 ||
          typeof row.has_more !== "boolean"
        ) {
          throw new Error("PERSONAL_DATA_ACCESS_AUDIT_RETENTION_RECEIPT_INVALID");
        }
        return { expired: row.expired, hasMore: row.has_more };
      });
    },
  };
}

export type RawSourceActivities = ReturnType<typeof createRawSourceActivities>;
