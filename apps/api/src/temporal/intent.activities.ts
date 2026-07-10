import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ExecutionBroker } from '../tools/tool-contract';
import { PageFetcher } from '../intent/page-fetcher';
import { WebsiteWatchService, WatchResult, WEB_WATCH_KEY } from '../intent/website-watch.service';
import { IntentProjectionService, ProjectIntentResult } from '../intent/intent-projection.service';

const DUE_LIMIT = 50;
const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // web_watch intent 事件保留 90 天（可 arg 覆盖）

/**
 * 网站变更 intent 引擎的 Temporal 活动（平台级、源无关，无 RLS）。
 * listDueWatches 找到期的 web_watch 源、watchSource 跑一次页面 diff → intent 事件。
 * 与 acquisition 的通用 sweep **分离**（web_watch 不进 AcquisitionService，通用 listDueSources 已排除它）。
 * projectIntentAllWorkspaces 让 sweep 自动把新事件投影进各租户（loop 真收口——此前事件产出后
 * 无人调投影，永远流不到评分）；workspace 列表经 ownerDb 只读扫描（RLS 下 app_user 不可见），
 * 与 OutboxRelayService 同一「受信系统扫描器」先例，租户写仍走 withWorkspace。
 */
export function createIntentActivities(deps: {
  prisma: PrismaService;
  fetcher: PageFetcher;
  ownerDb?: PrismaClient;
  broker?: ExecutionBroker; // 收口②：registerWatch 的 sitemap 发现经 http.get 工具（无 broker → fail-closed 不出网）
}) {
  const watchSvc = new WebsiteWatchService({ prisma: deps.prisma, fetcher: deps.fetcher });
  const projSvc = new IntentProjectionService({ prisma: deps.prisma, broker: deps.broker });
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

    /** sweep 收尾：把近窗口新 intent 事件投影进**全部**租户（owner 只读列 workspace，逐租户 RLS 投影）。 */
    async projectIntentAllWorkspaces(args?: { sinceMs?: number }): Promise<{
      workspaces: number;
      companiesTouched: number;
      eventsProjected: number;
    }> {
      if (!deps.ownerDb) return { workspaces: 0, companiesTouched: 0, eventsProjected: 0 };
      const workspaces = await deps.ownerDb.workspace.findMany({ select: { id: true } });
      let companiesTouched = 0;
      let eventsProjected = 0;
      for (const ws of workspaces) {
        try {
          const r = await projSvc.projectIntent(ws.id, { sinceMs: args?.sinceMs ?? 7 * 24 * 60 * 60 * 1000 });
          companiesTouched += r.companiesTouched;
          eventsProjected += r.eventsProjected;
        } catch {
          /* 单租户投影失败不影响其余 */
        }
      }
      return { workspaces: workspaces.length, companiesTouched, eventsProjected };
    },

    /** 保留期清理：删除超期的 web_watch 变更事件（GDPR 存储限制）。sweep 每轮起始调一次。 */
    async purgeStaleIntentEvents(args?: { olderThanMs?: number }): Promise<{ deleted: number }> {
      return watchSvc.purgeStaleEvents(args?.olderThanMs ?? DEFAULT_RETENTION_MS);
    },
  };
}

export type IntentActivities = ReturnType<typeof createIntentActivities>;
