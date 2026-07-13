import { Prisma } from '@prisma/client';

/**
 * 站内下一版本号 = max(version)+1（09 §2.1）。
 * M0 的 count+1 在「清理过 building 残留行 / 多 run 并发」下会重发已用号，
 * 撞 @@unique(siteId, version)；max+1 单调不回收，天然避开。
 */
export async function allocateNextSiteVersion(
  tx: Prisma.TransactionClient,
  siteId: string,
): Promise<number> {
  const agg = await tx.siteVersion.aggregate({ where: { siteId }, _max: { version: true } });
  return (agg._max.version ?? 0) + 1;
}
