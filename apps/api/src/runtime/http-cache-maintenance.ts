/**
 * PR-B：过期缓存行清理（worker 启动时 + 每 6h）。
 *
 * 两表为 FORCE RLS 租户表；跨租户批量清理走上限定的 SECURITY DEFINER 函数
 * （只删 expires_at 已过的行，无读取面；见迁移 20261108120000_http_llm_cache）。
 * 清理失败只记日志，绝不影响 worker 就绪——缓存过期行滞留是空间问题，不是正确性问题。
 */

export const HTTP_CACHE_PURGE_BATCH = 5000;
export const HTTP_CACHE_PURGE_MAX_BATCHES = 10;
export const HTTP_CACHE_MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface HttpCacheMaintenanceDb {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<T>;
}

type PurgeFunction =
  | "purge_expired_url_content_cache_v1"
  | "purge_expired_llm_extraction_cache_v1";

async function runPurge(
  db: HttpCacheMaintenanceDb,
  purgeFunction: PurgeFunction,
): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < HTTP_CACHE_PURGE_MAX_BATCHES; batch += 1) {
    // Prisma 把数字参数绑成 bigint；函数形参是 INTEGER，显式 ::integer 收敛
    // （与 raw SQL 参数类型治理用例一致）。
    const rows =
      purgeFunction === "purge_expired_url_content_cache_v1"
        ? await db.$queryRaw<Array<{ deleted: number }>>`
            SELECT purge_expired_url_content_cache_v1(${HTTP_CACHE_PURGE_BATCH}::integer) AS deleted
          `
        : await db.$queryRaw<Array<{ deleted: number }>>`
            SELECT purge_expired_llm_extraction_cache_v1(${HTTP_CACHE_PURGE_BATCH}::integer) AS deleted
          `;
    const deleted = Number(rows[0]?.deleted ?? 0);
    total += deleted;
    if (deleted < HTTP_CACHE_PURGE_BATCH) break;
  }
  return total;
}

/** 一轮清理（两表各至多 10×5000 行）；导出供单测与运维脚本复用。 */
export async function purgeExpiredHttpCaches(
  db: HttpCacheMaintenanceDb,
  log: (message: string) => void = console.log,
): Promise<{ urlContent: number; llmExtraction: number }> {
  const urlContent = await runPurge(db, "purge_expired_url_content_cache_v1");
  const llmExtraction = await runPurge(db, "purge_expired_llm_extraction_cache_v1");
  if (urlContent > 0 || llmExtraction > 0) {
    log(
      `[http-cache] purged expired rows: url_content_cache=${urlContent} llm_extraction_cache=${llmExtraction}`,
    );
  }
  return { urlContent, llmExtraction };
}

/**
 * worker 启动时调用：立刻清一轮，然后每 6h 一轮。返回停止函数（测试/优雅停机用）。
 */
export function startHttpCacheMaintenance(
  db: HttpCacheMaintenanceDb,
  options: {
    intervalMs?: number;
    log?: (message: string) => void;
    warn?: (message: string) => void;
  } = {},
): () => void {
  const log = options.log ?? console.log;
  const warn = options.warn ?? console.warn;
  const run = (): void => {
    void purgeExpiredHttpCaches(db, log).catch((error) => {
      warn(`[http-cache] purge failed: ${String(error).slice(0, 200)}`);
    });
  };
  run();
  const timer = setInterval(run, options.intervalMs ?? HTTP_CACHE_MAINTENANCE_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
