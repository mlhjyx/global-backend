/**
 * GET /metrics/billing-reconciliation（获客 vNext W3 + Phase 2B 三账对齐）：
 * AI Trace ↔ 用量（usage_ledger）↔ 结算（tool_budget_operation）↔ 余额包络（tool_budget_account）对账视图。
 *
 * 四方权威口径（响应里逐项标注，不混用）：
 *   1. ai_trace：模型调用明细账（与 usage_ledger 共享同一 settledCost 口径）；
 *   2. usage_ledger：应用层已记费用账（AI tokens + 外部 provider 调用）；
 *   3. tool_budget_operation：工具与模型预留/实扣 microusd；额外拆出
 *      `externalSettledMicrousd` 与 `selfHostedExcludedMicrousd`，将历史自托管工具
 *      （crawl4ai.fetch / crawl4ai.render / social.fetch 等）的 1¢ 虚扣与真实外部支出分离；
 *   4. tool_budget_account：未关闭执行包络的累计快照（余额真值仍在 gain-saas 计费侧）。
 */
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** 自托管零外部边际成本工具的结果 schema 闭集，对账时单列剔除，不与外部付费调用混算。 */
export const SELF_HOSTED_FREE_RESULT_SCHEMAS = Object.freeze([
  "crawl4ai-fetch/v1",
  "crawl4ai-render/v1",
  "social-fetch/v1",
  "searxng-search/v1",
  "http-get/v1",
  "smtp-probe-verdict/v1",
] as const);

export class BillingReconciliationInputError extends Error {}

export interface BillingReconciliation {
  from: string | null;
  to: string | null;
  aiTrace: {
    rowCount: number;
    nullCostRowCount: number;
    totalMicrousd: number;
  };
  usage: {
    totalMicrousd: number;
    byResourceType: Array<{ resourceType: string; rows: number; microusd: number }>;
  };
  settled: {
    settledMicrousd: number;
    externalSettledMicrousd: number;
    selfHostedExcludedMicrousd: number;
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
  /** ai_trace − usage_ledger（同窗口）；统一记账口径后理想值为 0（仅允许跨表异步延迟）。 */
  deltaAiTraceMinusUsageMicrousd: number;
  /** usage − settled（同窗口全量，向后兼容既有字段）。 */
  deltaUsageMinusSettledMicrousd: number;
  /** usage − externalSettled（剔除历史自托管工具虚扣后的真实外部费用差额）。 */
  deltaUsageMinusExternalSettledMicrousd: number;
  sources: {
    aiTraceTable: "ai_trace";
    usageTable: "usage_ledger";
    settleTable: "tool_budget_operation";
    balanceTable: "tool_budget_account";
    note: string;
  };
}

/** 对账差额（纯函数，保持旧签名与返回结构 100% 兼容）。 */
export function reconcileSides(input: {
  usageMicrousd: number;
  settledMicrousd: number;
}): { deltaMicrousd: number } {
  return { deltaMicrousd: input.usageMicrousd - input.settledMicrousd };
}

/** 三账对账差额（纯函数：ai_trace ↔ usage_ledger ↔ external/full settled）。 */
export function reconcileThreeLedgers(input: {
  aiTraceMicrousd: number;
  usageMicrousd: number;
  settledMicrousd: number;
  externalSettledMicrousd: number;
}): {
  deltaUsageMinusSettledMicrousd: number;
  deltaAiTraceMinusUsageMicrousd: number;
  deltaUsageMinusExternalSettledMicrousd: number;
} {
  return {
    deltaUsageMinusSettledMicrousd: reconcileSides(input).deltaMicrousd,
    deltaAiTraceMinusUsageMicrousd: input.aiTraceMicrousd - input.usageMicrousd,
    deltaUsageMinusExternalSettledMicrousd:
      input.usageMicrousd - input.externalSettledMicrousd,
  };
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
      const [aiTraceRow] = await tx.$queryRaw<
        Array<{ row_count: number; null_cost_rows: number; cost_usd: number }>
      >(Prisma.sql`
        SELECT
          COUNT(*)::int AS row_count,
          COUNT(*) FILTER (WHERE cost_usd IS NULL)::int AS null_cost_rows,
          COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd
        FROM ai_trace
        WHERE workspace_id = ${input.workspaceId}::uuid
          AND (${from}::timestamptz IS NULL OR created_at >= ${from}::timestamptz)
          AND (${to}::timestamptz IS NULL OR created_at <= ${to}::timestamptz)
      `);

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
        Array<{
          purpose: string;
          settled: bigint;
          self_hosted_settled: bigint;
          in_flight: bigint;
        }>
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
              WHEN o.status IN ('SETTLED', 'RESULT_UNKNOWN')
                AND o.result_schema IN (
                  'crawl4ai-fetch/v1',
                  'crawl4ai-render/v1',
                  'social-fetch/v1',
                  'searxng-search/v1',
                  'http-get/v1',
                  'smtp-probe-verdict/v1'
                )
                AND (${from}::timestamptz IS NULL OR o.settled_at >= ${from}::timestamptz)
                AND (${to}::timestamptz IS NULL OR o.settled_at <= ${to}::timestamptz)
              THEN CASE
                WHEN o.amount_unit = 'microusd'
                  THEN COALESCE(o.charged_microusd, o.reserved_microusd, 0)
                ELSE COALESCE(o.charged_cents, o.reserved_cents, 0) * 10000
              END
              ELSE 0
            END
          ), 0)::bigint AS self_hosted_settled,
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

      const aiTraceMicrousd = Math.round((aiTraceRow?.cost_usd ?? 0) * 1e6);

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
      const selfHostedExcludedMicrousd = settleRows.reduce(
        (sum, row) => sum + Number(row.self_hosted_settled ?? 0n),
        0,
      );
      const externalSettledMicrousd = Math.max(
        0,
        settledMicrousd - selfHostedExcludedMicrousd,
      );
      const inFlightMicrousd = settleRows.reduce((sum, row) => sum + Number(row.in_flight), 0);

      const cap = Number(envelope?.cap_microusd ?? 0n);
      const charged = Number(envelope?.charged_microusd ?? 0n);
      const deltas = reconcileThreeLedgers({
        aiTraceMicrousd,
        usageMicrousd,
        settledMicrousd,
        externalSettledMicrousd,
      });

      return {
        from: input.from ?? null,
        to: input.to ?? null,
        aiTrace: {
          rowCount: aiTraceRow?.row_count ?? 0,
          nullCostRowCount: aiTraceRow?.null_cost_rows ?? 0,
          totalMicrousd: aiTraceMicrousd,
        },
        usage: { totalMicrousd: usageMicrousd, byResourceType },
        settled: {
          settledMicrousd,
          externalSettledMicrousd,
          selfHostedExcludedMicrousd,
          inFlightMicrousd,
          byPurpose,
        },
        envelope: {
          openAccounts: envelope?.open_accounts ?? 0,
          authorizedCapMicrousd: cap,
          chargedMicrousd: charged,
          reservedMicrousd: Number(envelope?.reserved_microusd ?? 0n),
          remainingMicrousd: cap - charged,
          lifetimeCumulative: true,
        },
        deltaAiTraceMinusUsageMicrousd: deltas.deltaAiTraceMinusUsageMicrousd,
        deltaUsageMinusSettledMicrousd: deltas.deltaUsageMinusSettledMicrousd,
        deltaUsageMinusExternalSettledMicrousd:
          deltas.deltaUsageMinusExternalSettledMicrousd,
        sources: {
          aiTraceTable: "ai_trace",
          usageTable: "usage_ledger",
          settleTable: "tool_budget_operation",
          balanceTable: "tool_budget_account",
          note: "余额=引擎执行包络（tool_budget_account，累计快照）；自托管免费工具（crawl4ai 等）已单独剔除于 externalSettledMicrousd；客户钱包余额真值在 gain-saas 计费侧。",
        },
      };
    });
  }
}
