/**
 * source_yield_ledger 的生产写入（获客 vNext W3 边际产出会计）。
 *
 * 写入点：temporal/discovery.activities.ts 的 finalizeRun —— run 终结的同一事务
 * 内、DiscoveryRunCompleted 事件之前调用 writeSourceYieldLedger(tx, …)，只在
 * 「本次调用真正完成了状态迁移」的分支执行（alreadyRecorded 重试路径不再写）。
 * 历史 run 用 apps/api/scripts/backfill-source-yield-ledger.mts 回填（同一段 SQL）。
 *
 * 口径（逐 (run, provider, query) 一行）：
 *   - record_count：discovery_query_operation_attempt.provider_record_count 之和
 *     （provider 自报产出的记录数，含重试；与成本同口径——花了多少就得算多少记录）；
 *   - cost_microusd：关联 ToolBudgetOperation 的实扣。SETTLED/RESULT_UNKNOWN 取
 *     charged（缺失回退 observed/reserved；cent 计价的旧行 ×10000），仍 RESERVED
 *     的取 reserved（finalize 时理论上查询已全部结束，这只是兜底），RELEASED 记 0。
 *     与 execution-budget-window-usage 的 charged 口径一致；
 *   - new_qualified_count：「本 run 新发现且判定合格」的公司数。新发现 =
 *     materialization outcome 为 CANONICALIZED 且 mutation_class=CREATED（公司在本
 *     run 首次进入本 workspace）；合格 = 本 run 的 judgment_record 对该 (workspace,
 *     ICP) 判定 FIT。同一公司出现在多条查询/多个源时，按 (query_ordinal,
 *     record_index, provider) 归给它**最早**的那条产出，避免重复计数——这样
 *     「每源每美元新增合格公司」的分母（成本）与分子（唯一公司数）都无重复。
 *
 * 幂等：唯一键 (workspace_id, run_id, provider_key, query_key)，ON CONFLICT DO
 * NOTHING —— finalize 重试、脚本回填重复执行都不会写第二行。
 */
import { Prisma } from "@prisma/client";

export interface SourceYieldLedgerScope {
  readonly workspaceId: string;
  readonly runId: string;
}

/** 只要有 $executeRaw 就能写：finalizeRun 传事务客户端，回填脚本传 owner 客户端。 */
type RawExecutor = Pick<Prisma.TransactionClient, "$executeRaw">;

/**
 * 为一个 run 写入账本行；返回实际插入的行数（重复执行时为 0）。
 * 必须在已设置 app.current_workspace_id 的事务内（或 owner 连接）调用。
 */
export async function writeSourceYieldLedger(
  db: RawExecutor,
  scope: SourceYieldLedgerScope,
): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    WITH per_provider AS (
      SELECT
        a.workspace_id,
        a.run_id,
        a.provider_key,
        a.query_key,
        SUM(a.provider_record_count)::bigint AS record_count,
        COALESCE(SUM(
          CASE
            WHEN o.status IN ('SETTLED', 'RESULT_UNKNOWN') THEN
              CASE
                WHEN o.amount_unit = 'microusd'
                  THEN COALESCE(o.charged_microusd, o.observed_microusd, o.reserved_microusd, 0)
                ELSE COALESCE(o.charged_cents, o.observed_cents, o.reserved_cents, 0) * 10000
              END
            WHEN o.status = 'RESERVED' THEN
              CASE
                WHEN o.amount_unit = 'microusd' THEN COALESCE(o.reserved_microusd, 0)
                ELSE COALESCE(o.reserved_cents, 0) * 10000
              END
            ELSE 0
          END
        ), 0)::bigint AS cost_microusd
      FROM discovery_query_operation_attempt a
      LEFT JOIN tool_budget_operation o
        ON o.scope_key = a.scope_key AND o.id = a.operation_id
      WHERE a.workspace_id = ${scope.workspaceId}::uuid
        AND a.run_id = ${scope.runId}::uuid
      GROUP BY a.workspace_id, a.run_id, a.provider_key, a.query_key
    ),
    new_qualified AS (
      SELECT provider_key, query_key, COUNT(*)::bigint AS n
      FROM (
        SELECT DISTINCT ON (mo.canonical_company_id)
          mo.provider_key,
          mo.query_key
        FROM discovery_company_materialization_outcome mo
        JOIN judgment_record j
          ON j.workspace_id = mo.workspace_id
         AND j.run_id = mo.run_id
         AND j.canonical_company_id = mo.canonical_company_id
         AND j.verdict = 'FIT'
        WHERE mo.workspace_id = ${scope.workspaceId}::uuid
          AND mo.run_id = ${scope.runId}::uuid
          AND mo.outcome = 'CANONICALIZED'
          AND mo.mutation_class = 'CREATED'
          AND mo.canonical_company_id IS NOT NULL
        ORDER BY
          mo.canonical_company_id,
          mo.query_ordinal ASC,
          mo.record_index ASC,
          mo.provider_key ASC
      ) first_seen
      GROUP BY provider_key, query_key
    )
    INSERT INTO source_yield_ledger
      (workspace_id, run_id, provider_key, query_key, record_count, new_qualified_count, cost_microusd)
    SELECT
      p.workspace_id,
      p.run_id,
      p.provider_key,
      p.query_key,
      p.record_count,
      COALESCE(q.n, 0),
      p.cost_microusd
    FROM per_provider p
    LEFT JOIN new_qualified q
      ON q.provider_key = p.provider_key AND q.query_key = p.query_key
    ON CONFLICT (workspace_id, run_id, provider_key, query_key) DO NOTHING
  `);
}
