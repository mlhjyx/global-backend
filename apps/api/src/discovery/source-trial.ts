import type { Prisma } from '@prisma/client';
import {
  sourceQueryBudgetConfig,
  type SourceQueryBudgetConfig,
} from './plan-query-sources';

/**
 * Q33② 新源试跑判定的纯函数部分：把「每个 provider 历史上用过几次 run」的计数行，
 * 映射为仍处于试跑期的 provider 集合（run 数 < trialMaxRuns）。计数只增不减，
 * 因此同一 run 重放不会把源提前推过试跑期。
 */
export function trialProvidersFromCounts(
  rows: ReadonlyArray<{ provider_key: string; runs: unknown }>,
  maxRuns: number,
): ReadonlySet<string> {
  const trial = new Set<string>();
  for (const row of rows) {
    // count(*)::int 正常返回 number；bigint/数字字符串兼容；null/其它非法值按「不可判定」处理，
    // 不把源误判成试跑期。
    const runs =
      typeof row.runs === 'number'
        ? row.runs
        : typeof row.runs === 'string'
          ? Number(row.runs)
          : Number.NaN;
    if (typeof row.provider_key === 'string' && Number.isFinite(runs) && runs < maxRuns) {
      trial.add(row.provider_key);
    }
  }
  return trial;
}

type TrialDb = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * 读取本工作空间各 provider 的历史 run 数，返回仍在试跑期的源集合。
 * 租户表 `raw_source_record` 经 RLS 限定在当前工作空间；任何查询失败都按「无试跑源」
 * 降级（宁可少限，不阻塞规划），错误不吞掉运行——规划随后按结构化默认预算继续。
 */
export async function trialSourceProviders(
  db: TrialDb,
  workspaceId: string,
  config: SourceQueryBudgetConfig = sourceQueryBudgetConfig(),
): Promise<ReadonlySet<string>> {
  try {
    const rows = await db.$queryRaw<Array<{ provider_key: string; runs: unknown }>>`
      SELECT provider_key, count(DISTINCT run_id)::int AS runs
      FROM raw_source_record
      WHERE workspace_id = ${workspaceId}::uuid
        AND run_id IS NOT NULL
      GROUP BY provider_key
    `;
    return trialProvidersFromCounts(rows, config.trialMaxRuns);
  } catch {
    return new Set();
  }
}
