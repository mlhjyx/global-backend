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
    /** 到期的自动源：ACTIVE + 有 cadence.everyMs + (从未抓 或 nextFetchAt 到点)。手动源（无 cadence）不自动扫。 */
    async listDueSources(args?: { limit?: number }): Promise<{ sourceIds: string[] }> {
      const now = new Date();
      const limit = args?.limit ?? DUE_LIMIT;
      const rows = await deps.prisma.monitoredSource.findMany({
        where: { status: 'ACTIVE', OR: [{ nextFetchAt: null }, { nextFetchAt: { lte: now } }] },
        select: { id: true, cadence: true },
        orderBy: [{ nextFetchAt: { sort: 'asc', nulls: 'first' } }],
        take: limit * 4,
      });
      const due = rows
        .filter((r) => {
          const everyMs = (r.cadence as { everyMs?: number } | null)?.everyMs;
          return typeof everyMs === 'number' && everyMs > 0;
        })
        .slice(0, limit);
      return { sourceIds: due.map((r) => r.id) };
    },

    /** 对一个源跑一次 acquire（抓取→清洗→落库→增量）。幂等 by externalId，可安全重试。 */
    async acquireSource(args: { sourceId: string; limit?: number }): Promise<AcquireResult> {
      return svc.acquire(args.sourceId, args.limit ? { limit: args.limit } : undefined);
    },
  };
}

export type AcquisitionActivities = ReturnType<typeof createAcquisitionActivities>;
