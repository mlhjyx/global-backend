import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * ch08 §3.1.1 C1a：按窗口读回 workspace 的执行预算**实扣**（tool_budget_operation.charged_microusd）。
 *
 * 这是窗口花费的唯一权威口径：SaaS 侧 `cost_ledger` 只是 discovery 模型成本的事件镜像，
 * understanding / icp / contact / outreach / campaign / 工具费都不在其中（审计 C1/C3）。
 * SaaS 在签发 Grant 前调用本端点，以 max(cost_ledger, engine_charged) 判定窗口余额。
 *
 * 口径：
 *  - charged = SETTLED/RESULT_UNKNOWN 且 settled_at >= since 的实扣（microusd；cent 老行 ×10000）；
 *  - reserved = 仍在途（RESERVED）且 created_at >= since 的预留（在途占用的保守读数）；
 *  - byPurpose 按 execution_budget_authority.purpose 聚合（无 authority 的账户归 'unknown'）。
 */

export const EXECUTION_BUDGET_WINDOW_USAGE_SCHEMA = 'execution-budget-window-usage/v1' as const;

export interface ExecutionBudgetWindowUsage {
  readonly schemaVersion: typeof EXECUTION_BUDGET_WINDOW_USAGE_SCHEMA;
  readonly workspaceId: string;
  readonly since: string;
  readonly chargedMicrousd: string;
  readonly reservedMicrousd: string;
  readonly byPurpose: Record<string, string>;
}

interface TotalsRow {
  charged: bigint | null;
  reserved: bigint | null;
}

interface PurposeRow {
  purpose: string;
  charged: bigint | null;
}

@Injectable()
export class ExecutionBudgetWindowUsageService {
  constructor(private readonly prisma: PrismaService) {}

  async windowUsage(input: {
    workspaceId: string;
    since: Date;
  }): Promise<ExecutionBudgetWindowUsage> {
    const { workspaceId, since } = input;

    const [totals] = await this.prisma.$queryRaw<TotalsRow[]>(Prisma.sql`
      SELECT
        COALESCE(SUM(
          CASE
            WHEN o.status IN ('SETTLED', 'RESULT_UNKNOWN') AND o.settled_at >= ${since}
            THEN CASE
              WHEN o.amount_unit = 'microusd'
                THEN COALESCE(o.charged_microusd, o.reserved_microusd, 0)
              ELSE COALESCE(o.charged_cents, o.reserved_cents, 0) * 10000
            END
            ELSE 0
          END
        ), 0)::bigint AS charged,
        COALESCE(SUM(
          CASE
            WHEN o.status = 'RESERVED' AND o.created_at >= ${since}
            THEN CASE
              WHEN o.amount_unit = 'microusd' THEN COALESCE(o.reserved_microusd, 0)
              ELSE COALESCE(o.reserved_cents, 0) * 10000
            END
            ELSE 0
          END
        ), 0)::bigint AS reserved
      FROM tool_budget_operation o
      WHERE o.scope_key = ${workspaceId}
    `);

    const purposeRows = await this.prisma.$queryRaw<PurposeRow[]>(Prisma.sql`
      SELECT
        COALESCE(a.purpose::text, 'unknown') AS purpose,
        COALESCE(SUM(
          CASE
            WHEN o.status IN ('SETTLED', 'RESULT_UNKNOWN') AND o.settled_at >= ${since}
            THEN CASE
              WHEN o.amount_unit = 'microusd'
                THEN COALESCE(o.charged_microusd, o.reserved_microusd, 0)
              ELSE COALESCE(o.charged_cents, o.reserved_cents, 0) * 10000
            END
            ELSE 0
          END
        ), 0)::bigint AS charged
      FROM tool_budget_operation o
      LEFT JOIN tool_budget_account acct
        ON acct.id = o.account_id AND acct.scope_key = o.scope_key
      LEFT JOIN execution_budget_authority a ON a.id = acct.authority_id
      WHERE o.scope_key = ${workspaceId}
      GROUP BY 1
      ORDER BY 1
    `);

    const byPurpose: Record<string, string> = {};
    for (const row of purposeRows) {
      if (row.charged !== null && row.charged !== 0n) {
        byPurpose[row.purpose] = row.charged.toString();
      }
    }

    return {
      schemaVersion: EXECUTION_BUDGET_WINDOW_USAGE_SCHEMA,
      workspaceId,
      since: since.toISOString(),
      chargedMicrousd: (totals?.charged ?? 0n).toString(),
      reservedMicrousd: (totals?.reserved ?? 0n).toString(),
      byPurpose,
    };
  }
}
