/**
 * monitored_source 采集生命周期的**共享原语**（单一真源）。
 * AcquisitionService（全量集合 diff）与 WebsiteWatchService（逐页信号 diff）两条管线都用这里的
 * 缺席防误杀阈值与 cadence→nextFetchAt 计算，避免两处各自拷贝、日后一处改动另一处漏改（drift）。
 */

/** 连续缺席 N 次才判退出（防单次抓取失败/临时 5xx 误杀）。两条管线统一。 */
export const MISS_THRESHOLD = 2;

/** 由 cadence 与本次抓取时刻算下次到期时间；无 everyMs（手动源）返回 null（不自动扫）。 */
export function computeNextFetchAt(cadence: unknown, now: Date): Date | null {
  const everyMs = (cadence as { everyMs?: number } | null)?.everyMs;
  return everyMs && everyMs > 0 ? new Date(now.getTime() + everyMs) : null;
}
