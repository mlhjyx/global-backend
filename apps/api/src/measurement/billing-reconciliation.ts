/**
 * GET /metrics/billing-reconciliation（获客 vNext W3）：用量 ↔ 结算 ↔ 余额三方对账视图。
 *
 * 三方的权威口径（响应里逐项标注，不混用）：
 *   1. 用量（usage）：usage_ledger 的 cost_usd 记账（Float USD，AI tokens 与
 *      provider 调用按 resource_type 分行）。它是应用层「发生过的花费」账；
 *   2. 结算（settled）：tool_budget_operation 的实扣 microusd，口径与
 *      ExecutionBudgetWindowUsageService 完全一致——SETTLED/RESULT_UNKNOWN 且
 *      settled_at 落在窗口内取 charged（缺失回退 reserved；cent 计价旧行 ×10000），
 *      仍在途（RESERVED 且 created_at 在窗口内）的 reserved 单列。这是**窗口花费的
 *      唯一权威口径**（ch08 §3.1.1 C1a）；
 *   3. 余额（envelope）：tool_budget_account（未关闭账户）的授权包络状态——
 *      authorized_cap / charged / reserved。**余额来源表 = tool_budget_account**，
 *      它是引擎侧执行包络，不是客户钱包；客户余额与充值以 gain-saas 计费侧为准，
 *      本引擎不持有该真值。账户侧是累计快照，不与窗口口径直接相减。
 *
 * 对账信号 = usage − settled（同窗口）：非零不代表错误（usage_ledger 覆盖模型调用、
 * 结算可能跨窗口落到下一期），它是「何时需要人看一眼」的指针。
 */
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class BillingReconciliationInputError extends Error {}

export interface BillingReconciliation {
  from: string | null;
  to: string | null;
  usage: {
    totalMicrousd: number;
    byResourceType: Array<{ resourceType: string; rows: number; microusd: number }>;
  };
  settled: {
    settledMicrousd: number;
    inFlightMicrousd: number;
    byPurpose: Array<{ purpose: string; settledMicrousd: number }>;
  };
  envelope: {
    openAccounts: number;
    authorizedCapMicrousd: number;
    chargedMicrousd: number;
    reservedMicrousd: number;
    remainingMicrousd: number;
    /** 账户侧是累计快照（charged 为 lifetime），不与窗口用量直接相减。 */
    lifetimeCumulative: true;
  };
  /** usage − settled（同窗口）；正 = 记了账但未结算（或结算跨期），负 = 结算多于记账。 */
  deltaUsageMinusSettledMicrousd: number;
  sources: {
    usageTable: "usage_ledger";
    settleTable: "tool_budget_operation";
    balanceTable: "tool_budget_account";
    note: string;
  };
}

/** 对账差额（纯函数，单测覆盖）。 */
export function reconcileSides(input: {
  usageMicrousd: number;
  settledMicrousd: number;
}): { deltaMicrousd: number } {
  return { deltaMicrousd: input.usageMicrousd - input.settledMicrousd };
}

@Injectable()
export class BillingReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  async view(input: {
    workspaceId: string;
    from?: string;
    to?: string;
  }): Promise<BillingReconciliation> {
    if (input.from !== undefined && !DAY.test(input.from)) {
      throw new BillingReconciliationInputError("from 必须是 YYYY-MM-DD");
    }
    if (input.to !== undefined && !DAY.test(input.to)) {
      throw new BillingReconciliationInputError("to 必须是 YYYY-MM-DD");
    }
    const from = input.from ? new Date(`${input.from}T00:00:00.000Z`) : null;
    const to = input.to ? new Date(`${input.to}T23:59:59.999Z`) : null;

    return this.prisma.withWorkspace(input.workspaceId, async (tx) => {
      const usageRows = await tx.$queryRaw<
        Array<{ resource_type: string; row_count: number; cost_usd: number }>
      >(Prisma.sql`
        SELECT resource_type, COUNT(*)::int AS row_count, COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd
        FROM usage_ledger
        WHERE workspace_id = ${input.workspaceId}::uuid
          AND (${from}::timestamptz IS NULL OR created_at >= ${from}::timestamptz)
          AND (${to}::timestamptz IS NULL OR created_at <= ${to}::timestamptz)
        GROUP BY 1
        ORDER BY 1
      `);

      const settleRows = await tx.$queryRaw<
        Array<{ purpose: string; settled: bigint; in_flight: bigint }>
      >(Prisma.sql`
        SELECT
          COALESCE(a.purpose::text, 'unknown') AS purpose,
          COALESCE(SUM(
            CASE
              WHEN o.status IN ('SETTLED', 'RESULT_UNKNOWN')
                AND (${from}::timestamptz IS NULL OR o.settled_at >= ${from}::timestamptz)
                AND (${to}::timestamptz IS NULL OR o.settled_at <= ${to}::timestamptz)
              THEN CASE
                WHEN o.amount_unit = 'microusd'
                  THEN COALESCE(o.charged_microusd, o.reserved_microusd, 0)
                ELSE COALESCE(o.charged_cents, o.reserved_cents, 0) * 10000
              END
              ELSE 0
            END
          ), 0)::bigint AS settled,
          COALESCE(SUM(
            CASE
              WHEN o.status = 'RESERVED'
                AND (${from}::timestamptz IS NULL OR o.created_at >= ${from}::timestamptz)
                AND (${to}::timestamptz IS NULL OR o.created_at <= ${to}::timestamptz)
              THEN CASE
                WHEN o.amount_unit = 'microusd' THEN COALESCE(o.reserved_microusd, 0)
                ELSE COALESCE(o.reserved_cents, 0) * 10000
              END
              ELSE 0
            END
          ), 0)::bigint AS in_flight
        FROM tool_budget_operation o
        LEFT JOIN tool_budget_account acct
          ON acct.id = o.account_id AND acct.scope_key = o.scope_key
        LEFT JOIN execution_budget_authority a ON a.id = acct.authority_id
        WHERE o.scope_key = ${input.workspaceId}
        GROUP BY 1
        ORDER BY 1
      `);

      const [envelope] = await tx.$queryRaw<
        Array<{
          open_accounts: number;
          cap_microusd: bigint;
          charged_microusd: bigint;
          reserved_microusd: bigint;
        }>
      >(Prisma.sql`
        SELECT
          COUNT(*)::int AS open_accounts,
          COALESCE(SUM(COALESCE(authorized_cap_microusd, cap_cents * 10000)), 0)::bigint AS cap_microusd,
          COALESCE(SUM(charged_microusd), 0)::bigint AS charged_microusd,
          COALESCE(SUM(reserved_microusd), 0)::bigint AS reserved_microusd
        FROM tool_budget_account
        WHERE scope_key = ${input.workspaceId}
          AND closed_at IS NULL
      `);

      const byResourceType = usageRows.map((row) => ({
        resourceType: row.resource_type,
        rows: row.row_count,
        microusd: Math.round(row.cost_usd * 1e6),
      }));
      const usageMicrousd = byResourceType.reduce((sum, row) => sum + row.microusd, 0);

      const byPurpose = settleRows
        .map((row) => ({ purpose: row.purpose, settledMicrousd: Number(row.settled) }))
        .filter((row) => row.settledMicrousd !== 0);
      const settledMicrousd = byPurpose.reduce((sum, row) => sum + row.settledMicrousd, 0);
      const inFlightMicrousd = settleRows.reduce((sum, row) => sum + Number(row.in_flight), 0);

      const cap = Number(envelope?.cap_microusd ?? 0n);
      const charged = Number(envelope?.charged_microusd ?? 0n);

      return {
        from: input.from ?? null,
        to: input.to ?? null,
        usage: { totalMicrousd: usageMicrousd, byResourceType },
        settled: { settledMicrousd, inFlightMicrousd, byPurpose },
        envelope: {
          openAccounts: envelope?.open_accounts ?? 0,
          authorizedCapMicrousd: cap,
          chargedMicrousd: charged,
          reservedMicrousd: Number(envelope?.reserved_microusd ?? 0n),
          remainingMicrousd: cap - charged,
          lifetimeCumulative: true,
        },
        deltaUsageMinusSettledMicrousd: reconcileSides({
          usageMicrousd,
          settledMicrousd,
        }).deltaMicrousd,
        sources: {
          usageTable: "usage_ledger",
          settleTable: "tool_budget_operation",
          balanceTable: "tool_budget_account",
          note: "余额=引擎执行包络（tool_budget_account，累计快照）；客户钱包余额真值在 gain-saas 计费侧，不在本引擎。",
        },
      };
    });
  }
}
