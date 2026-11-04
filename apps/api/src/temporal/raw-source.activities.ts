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

    /** 巡检（2026-11-04）：清收超时 RESERVED 的工具预算操作。孤儿预留既占住账户额度，又让同一
     *  operation_key 的重试活动撞 BudgetOperationReplayError。释放语义与 release 一致（不扣费）。 */
    async reconcileStaleToolBudgetOperations(args: {
      workspaceId: string;
      limit?: number;
      olderThanHours?: number;
    }): Promise<{ released: number; hasMore: boolean }> {
      const scopedWorkspaceId = workspaceId(args.workspaceId);
      const limit = boundedLimit(args.limit, 1000);
      const olderThanHours = Math.max(
        1,
        Math.min(
          Number.isSafeInteger(args.olderThanHours) ? args.olderThanHours! : 24,
          720,
        ),
      );
      return deps.prisma.withWorkspace(scopedWorkspaceId, async (tx) => {
        // 注意：pg 函数返回 INTEGER/BOOLEAN 实体列（不是 void）——#788 的教训是
        // $queryRaw 里 SELECT 返回 void 的函数会在真库反序列化失败。
        const rows = await tx.$queryRaw<
          Array<{ released: number; has_more: boolean }>
        >(Prisma.sql`SELECT released, has_more
          FROM reconcile_stale_tool_budget_operations_v1(
            ${scopedWorkspaceId}::uuid, ${olderThanHours}::integer, ${limit}::integer
          )`);
        const row = rows[0];
        if (
          !row ||
          !Number.isSafeInteger(row.released) ||
          row.released < 0 ||
          typeof row.has_more !== "boolean"
        ) {
          throw new Error("STALE_TOOL_RESERVATION_RECONCILE_RECEIPT_INVALID");
        }
        return { released: row.released, hasMore: row.has_more };
      });
    },
  };
}

export type RawSourceActivities = ReturnType<typeof createRawSourceActivities>;
