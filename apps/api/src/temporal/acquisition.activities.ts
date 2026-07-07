import { PrismaService } from '../prisma/prisma.service';
import { SourceAdapterRegistry } from '../acquisition/source-adapter';
import { AcquisitionService, AcquireResult } from '../acquisition/acquisition.service';

const DUE_LIMIT = 50;

/**
 * 采集活动（平台级、源无关）。listDueSources 找到期的自动源、acquireSource 跑一次增量。
 * 与 discovery.activities 并列在同一 worker/队列；平台表无 RLS，故不走 withWorkspace。
 */
export function createAcquisitionActivities(deps: { prisma: PrismaService; registry: SourceAdapterRegistry }) {
  const svc = new AcquisitionService({ prisma: deps.prisma, registry: deps.registry });
  return {
    /** 到期的自动源：ACTIVE + 有 cadence.everyMs>0 + (从未抓 或 nextFetchAt 到点)。手动源（无 cadence）不自动扫。
     *  cadence 过滤下推到 DB（JSON path）——否则大量手动源(nextFetchAt=null 排最前)会挤占 take、把真正到期的自动源饿死。 */
    async listDueSources(args?: { limit?: number }): Promise<{ sourceIds: string[] }> {
      const now = new Date();
      const limit = args?.limit ?? DUE_LIMIT;
      const rows = await deps.prisma.monitoredSource.findMany({
        where: {
          status: 'ACTIVE',
          // **正向**过滤：只扫本注册表有适配器的源。无适配器的源（如 web_watch，走独立 intentSweep）
          // 天然被排除——AcquisitionService.acquire 无 web_watch 适配器会抛错，且通用层不该按名字认识
          // 每个下游管线（黑名单式耦合脆弱）。新增非适配器管线无需再改这里。
          providerKey: { in: deps.registry.keys() },
          cadence: { path: ['everyMs'], gt: 0 },
          OR: [{ nextFetchAt: null }, { nextFetchAt: { lte: now } }],
        },
        select: { id: true },
        orderBy: [{ nextFetchAt: { sort: 'asc', nulls: 'first' } }],
        take: limit,
      });
      return { sourceIds: rows.map((r) => r.id) };
    },

    /** 对一个源跑一次 acquire（抓取→清洗→落库→增量）。幂等 by externalId，可安全重试。 */
    async acquireSource(args: { sourceId: string; limit?: number }): Promise<AcquireResult> {
      return svc.acquire(args.sourceId, args.limit ? { limit: args.limit } : undefined);
    },
  };
}

export type AcquisitionActivities = ReturnType<typeof createAcquisitionActivities>;
