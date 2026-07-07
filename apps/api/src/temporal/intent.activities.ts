import { PrismaService } from '../prisma/prisma.service';
import { PageFetcher } from '../intent/page-fetcher';
import { WebsiteWatchService, WatchResult, WEB_WATCH_KEY } from '../intent/website-watch.service';
import { IntentProjectionService, ProjectIntentResult } from '../intent/intent-projection.service';

const DUE_LIMIT = 50;
const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // web_watch intent 事件保留 90 天（可 arg 覆盖）

/**
 * 网站变更 intent 引擎的 Temporal 活动（平台级、源无关，无 RLS）。
 * listDueWatches 找到期的 web_watch 源、watchSource 跑一次页面 diff → intent 事件。
 * 与 acquisition 的通用 sweep **分离**（web_watch 不进 AcquisitionService，通用 listDueSources 已排除它）。
 * projectIntentForWorkspace 供按租户投影（不进自动 sweep —— 无全局 workspace 注册表，投影按需触发）。
 */
export function createIntentActivities(deps: { prisma: PrismaService; fetcher: PageFetcher }) {
  const watchSvc = new WebsiteWatchService({ prisma: deps.prisma, fetcher: deps.fetcher });
  const projSvc = new IntentProjectionService({ prisma: deps.prisma });
  return {
    /** 到期的 web_watch 自动源（ACTIVE + cadence.everyMs>0 + nextFetchAt 到期）。cadence 过滤下推 DB。 */
    async listDueWatches(args?: { limit?: number }): Promise<{ sourceIds: string[] }> {
      // 引擎级 kill-switch：data_provider 'web_watch' 非 ENABLED → 全局停抓（ops 一键关闭定时对外抓取）。
      const provider = await deps.prisma.dataProvider.findUnique({ where: { key: WEB_WATCH_KEY }, select: { status: true } });
      if (provider && provider.status !== 'ENABLED') return { sourceIds: [] };

      const now = new Date();
      const rows = await deps.prisma.monitoredSource.findMany({
        where: {
          providerKey: WEB_WATCH_KEY,
          status: 'ACTIVE',
          cadence: { path: ['everyMs'], gt: 0 },
          OR: [{ nextFetchAt: null }, { nextFetchAt: { lte: now } }],
        },
        select: { id: true },
        orderBy: [{ nextFetchAt: { sort: 'asc', nulls: 'first' } }],
        take: args?.limit ?? DUE_LIMIT,
      });
      return { sourceIds: rows.map((r) => r.id) };
    },

    /** 对一个 web_watch 源跑一次页面监控（抓每页→抽信号→diff→写 intent 事件）。幂等 by (source,url)。 */
    async watchSource(args: { sourceId: string }): Promise<WatchResult> {
      return watchSvc.watch(args.sourceId);
    },

    /** 把平台层新 intent 事件投影进某租户 canonical（attributes.intent.* + field_evidence）。按需触发。 */
    async projectIntentForWorkspace(args: { workspaceId: string; sinceMs?: number }): Promise<ProjectIntentResult> {
      return projSvc.projectIntent(args.workspaceId, args.sinceMs ? { sinceMs: args.sinceMs } : undefined);
    },

    /** 保留期清理：删除超期的 web_watch 变更事件（GDPR 存储限制）。sweep 每轮起始调一次。 */
    async purgeStaleIntentEvents(args?: { olderThanMs?: number }): Promise<{ deleted: number }> {
      return watchSvc.purgeStaleEvents(args?.olderThanMs ?? DEFAULT_RETENTION_MS);
    },
  };
}

export type IntentActivities = ReturnType<typeof createIntentActivities>;
