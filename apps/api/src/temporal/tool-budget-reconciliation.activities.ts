import { Prisma, type PrismaClient } from '@prisma/client';
import { ApplicationFailure } from '@temporalio/activity';

import { PrismaService } from '../prisma/prisma.service';

/**
 * B4（审计 F1）：未结预算操作的独立清收活动。
 *
 * 与 raw-retention sweep 解耦：枚举直接看 tool_budget_operation（RESERVED/RESULT_UNKNOWN），
 * 不再依赖 raw_source_record 是否到期。两个 SINK 语义：
 *   - RESERVED（预留后未出网）：超过阈值释放回账户（既有函数 reconcile_stale_..._v1）；
 *   - RESULT_UNKNOWN（已出网结果未知）：超过阈值按预留额**保守结清**（新函数
 *     settle_unknown_tool_budget_operations_v1）。
 * 批内循环留在活动里（workflow 每 workspace 只调一次），workflow 重放不依赖循环边界常量。
 */
export interface ToolBudgetReconciliationActivitiesDeps {
  prisma: PrismaService | PrismaClient;
}

interface WorkspaceScopedPrisma {
  withWorkspace<T>(
    workspaceId: string,
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T>;
}

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function boundedHours(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 720
    ? (value as number)
    : fallback;
}

function boundedLimit(value: unknown, fallback: number, max: number): number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max
    ? (value as number)
    : fallback;
}

export function createToolBudgetReconciliationActivities(
  deps: ToolBudgetReconciliationActivitiesDeps,
) {
  const prisma = deps.prisma as WorkspaceScopedPrisma & {
    $queryRaw: PrismaClient['$queryRaw'];
  };

  return {
    /** 跨租户枚举「含未结预算操作」的 workspace（SECURITY DEFINER 函数）。 */
    async listWorkspacesWithUnresolvedToolBudget(args: {
      olderThanHours?: number;
      limit?: number;
      afterWorkspaceId?: string;
    }): Promise<{ workspaceIds: string[] }> {
      const olderThanHours = boundedHours(args.olderThanHours, 2);
      const limit = boundedLimit(args.limit, 50, 200);
      const afterWorkspaceId =
        typeof args.afterWorkspaceId === 'string' && WORKSPACE_ID.test(args.afterWorkspaceId)
          ? args.afterWorkspaceId
          : null;
      const rows = await prisma.$queryRaw<Array<{ workspace_id: string }>>(
        Prisma.sql`SELECT workspace_id::text
          FROM list_workspaces_with_unresolved_tool_budget_v1(
            ${olderThanHours}::integer, ${limit}::integer, ${afterWorkspaceId}::uuid
          )`,
      );
      return {
        workspaceIds: rows
          .map((row) => row.workspace_id)
          .filter((workspaceId) => WORKSPACE_ID.test(workspaceId)),
      };
    },

    /** 释放「预留后未出网」的超期 RESERVED（循环到无更多或达批上限）。 */
    async drainStaleToolBudgetReservations(args: {
      workspaceId: string;
      olderThanHours?: number;
      limit?: number;
      maxBatches?: number;
    }): Promise<{ released: number; remaining: boolean }> {
      const olderThanHours = boundedHours(args.olderThanHours, 2);
      const limit = boundedLimit(args.limit, 500, 1000);
      const maxBatches = boundedLimit(args.maxBatches, 5, 50);
      let released = 0;
      let remaining = false;
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const receipt = await prisma.withWorkspace(args.workspaceId, async (tx) => {
          const rows = await tx.$queryRaw<Array<{ released: number; has_more: boolean }>>(
            // v2：按 unresolved_since 判超期（D13 再预留会重置计时）、只碰 microusd 行、
            // 与在线路径同锁序（先账户 advisory 后行锁）。
            Prisma.sql`SELECT released, has_more
              FROM reconcile_stale_tool_budget_operations_v2(
                ${args.workspaceId}::uuid, ${olderThanHours}::integer, ${limit}::integer
              )`,
          );
          return rows[0];
        });
        if (
          !receipt ||
          !Number.isSafeInteger(Number(receipt.released)) ||
          Number(receipt.released) < 0 ||
          typeof receipt.has_more !== 'boolean'
        ) {
          // 控制面令牌必须用控制错误构造（静态结构门禁）：函数缺回执是部署缺陷，不可重试。
          throw ApplicationFailure.nonRetryable(
            'TOOL_BUDGET_RECONCILE_NO_RECEIPT',
            'TOOL_BUDGET_RECONCILE_NO_RECEIPT',
          );
        }
        released += Number(receipt.released);
        remaining = receipt.has_more;
        if (!remaining) break;
      }
      return { released, remaining };
    },

    /** 按预留额保守结清超期 RESULT_UNKNOWN（循环到无更多或达批上限）。 */
    async settleUnknownToolBudgetOperations(args: {
      workspaceId: string;
      olderThanHours?: number;
      limit?: number;
      maxBatches?: number;
    }): Promise<{ settled: number; remaining: boolean }> {
      const olderThanHours = boundedHours(args.olderThanHours, 2);
      const limit = boundedLimit(args.limit, 500, 1000);
      const maxBatches = boundedLimit(args.maxBatches, 5, 50);
      let settled = 0;
      let remaining = false;
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const receipt = await prisma.withWorkspace(args.workspaceId, async (tx) => {
          const rows = await tx.$queryRaw<Array<{ settled: number; has_more: boolean }>>(
            Prisma.sql`SELECT settled, has_more
              FROM settle_unknown_tool_budget_operations_v1(
                ${args.workspaceId}::uuid, ${olderThanHours}::integer, ${limit}::integer
              )`,
          );
          return rows[0];
        });
        if (
          !receipt ||
          !Number.isSafeInteger(Number(receipt.settled)) ||
          Number(receipt.settled) < 0 ||
          typeof receipt.has_more !== 'boolean'
        ) {
          throw ApplicationFailure.nonRetryable(
            'TOOL_BUDGET_UNKNOWN_SETTLE_NO_RECEIPT',
            'TOOL_BUDGET_UNKNOWN_SETTLE_NO_RECEIPT',
          );
        }
        settled += Number(receipt.settled);
        remaining = receipt.has_more;
        if (!remaining) break;
      }
      return { settled, remaining };
    },
  };
}

export type ToolBudgetReconciliationActivities = ReturnType<
  typeof createToolBudgetReconciliationActivities
>;
