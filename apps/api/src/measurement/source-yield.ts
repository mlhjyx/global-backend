/**
 * GET /metrics/source-yield（获客 vNext W3）：按日/周聚合 source_yield_ledger 的
 * 源边际产出——记录数、新增合格数、实扣成本（microusd），并给出
 * 「每新增合格公司的美元成本」。季度砍源报表直接消费本端点。
 *
 * 口径：
 *   - 账本行由 finalizeRun 在 run 终结时写入（见 evaluation/source-yield-ledger.ts），
 *     历史 run 由 backfill-source-yield-ledger 脚本回填；
 *   - 桶 = computed_at（账本行计算时间）按 UTC 日/ISO 周截断（周桶=周一，与
 *     metric_rollup_weekly 同口径）；
 *   - cost_per_new_qualified_usd = cost_microusd / 1e6 / new_qualified_count；
 *     new_qualified_count = 0 时为 null（不写 0——「没产出的源成本/产出」无定义）。
 */
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PROVIDER_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;
const GRANULARITIES = ["day", "week"] as const;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export type SourceYieldGranularity = (typeof GRANULARITIES)[number];

export interface SourceYieldBucket {
  bucket: string;
  providerKey: string;
  recordCount: number;
  newQualifiedCount: number;
  costMicrousd: number;
  costPerNewQualifiedUsd: number | null;
}

export class SourceYieldInputError extends Error {}

/** 单桶派生值（纯函数，单测覆盖）：成本换算与零产出语义。 */
export function shapeSourceYieldBucket(row: {
  bucket: string;
  providerKey: string;
  recordCount: number;
  newQualifiedCount: number;
  costMicrousd: number;
}): SourceYieldBucket {
  return {
    ...row,
    costPerNewQualifiedUsd:
      row.newQualifiedCount === 0
        ? null
        : Math.round((row.costMicrousd / 1e6 / row.newQualifiedCount) * 1e6) / 1e6,
  };
}

@Injectable()
export class SourceYieldService {
  constructor(private readonly prisma: PrismaService) {}

  async byPeriod(input: {
    workspaceId: string;
    from?: string;
    to?: string;
    granularity?: string;
    providerKey?: string;
    limit?: number;
  }): Promise<SourceYieldBucket[]> {
    const granularity = (input.granularity ?? "week") as SourceYieldGranularity;
    if (!GRANULARITIES.includes(granularity)) {
      throw new SourceYieldInputError("granularity 必须是 day 或 week");
    }
    if (input.from !== undefined && !DAY.test(input.from)) {
      throw new SourceYieldInputError("from 必须是 YYYY-MM-DD");
    }
    if (input.to !== undefined && !DAY.test(input.to)) {
      throw new SourceYieldInputError("to 必须是 YYYY-MM-DD");
    }
    if (input.providerKey !== undefined && !PROVIDER_KEY.test(input.providerKey)) {
      throw new SourceYieldInputError("providerKey 格式不合法");
    }
    const limit = input.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new SourceYieldInputError(`limit 必须是 1..${MAX_LIMIT} 的整数`);
    }
    const from = input.from ? new Date(`${input.from}T00:00:00.000Z`) : null;
    const to = input.to ? new Date(`${input.to}T23:59:59.999Z`) : null;

    const rows = await this.prisma.withWorkspace(input.workspaceId, (tx) =>
      tx.$queryRaw<
        Array<{
          bucket: string;
          provider_key: string;
          record_count: bigint;
          new_qualified_count: bigint;
          cost_microusd: bigint;
        }>
      >(Prisma.sql`
        SELECT
          to_char(date_trunc(${granularity}::text, computed_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS bucket,
          provider_key,
          COALESCE(SUM(record_count), 0)::bigint AS record_count,
          COALESCE(SUM(new_qualified_count), 0)::bigint AS new_qualified_count,
          COALESCE(SUM(cost_microusd), 0)::bigint AS cost_microusd
        FROM source_yield_ledger
        WHERE workspace_id = ${input.workspaceId}::uuid
          AND (${from}::timestamptz IS NULL OR computed_at >= ${from}::timestamptz)
          AND (${to}::timestamptz IS NULL OR computed_at <= ${to}::timestamptz)
          AND (${input.providerKey ?? null}::text IS NULL OR provider_key = ${input.providerKey ?? null}::text)
        GROUP BY 1, 2
        ORDER BY 1 DESC, 2 ASC
        LIMIT ${limit}
      `),
    );

    return rows.map((row) =>
      shapeSourceYieldBucket({
        bucket: row.bucket,
        providerKey: row.provider_key,
        recordCount: Number(row.record_count),
        newQualifiedCount: Number(row.new_qualified_count),
        costMicrousd: Number(row.cost_microusd),
      }),
    );
  }
}
