import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ModelGateway } from '../model-gateway/model-gateway';
import { DiscoveryProviderRegistry } from '../discovery/provider.registry';
import { EnrichmentResult } from '../discovery/provider-contract';
import { judgeFitCompany, loadIcpBrief } from '../discovery/fit-judge';
import { persistDiscoveredContacts } from '../discovery/contact-persist';
import { IntentProjectionService } from '../intent/intent-projection.service';
import { normalizeDomain } from '../discovery/identity';
import { WEB_WATCH_KEY } from '../intent/website-watch.service';

/**
 * 存量对账活动（backlog reconciliation）——漏斗总闸的解锁器。
 *
 * 为什么存在：qualifyFitForRun/enrichRun/enrichSignalsRun 都是 **run 前向取件**（只处理本 run
 * 归一出的公司）。经租户投影进来的公司（trade_fair/mapyourshow 平台采集→投影）从不属于任何 run，
 * 永远够不到 fit 门 → 实测 982/1040 家卡在 fitVerdict=null，漏斗断流。这组活动按 workspace 对
 * **存量**做同语义处理（判定/富集/信号/监控/联系人），由 backlogSweepWorkflow 编排 + Schedule 周期驱动。
 *
 * 工程纪律（与既有活动一致）：
 *  - 游标 = `id > cursor`（非 Prisma cursor）：行被处理后离开过滤集不影响分页，单 sweep 每行至多
 *    访问一次（防 LLM/抓取持续失败时的活锁）；跨 sweep 自然重试。
 *  - 网络调用（LLM/抓取）一律在事务外；每家命中单独短事务落库；单家失败不影响其余（§5 fail-safe）。
 *  - DAT-011：SUSPENDED 域名对抓取类（信号/联系人）一律跳过。
 *  - ownerDb 仅用于**平台级只读扫描**（跨租户列 ACTIVE ICP——RLS 下 app_user 不可见），
 *    与 OutboxRelayService 同一「受信系统扫描器」先例；租户数据读写仍走 withWorkspace。
 */

const SIGNAL_TTL_MS = 7 * 24 * 3600 * 1000; // 与 discovery.activities 的 SIGNAL_TTL_MS 对齐（信号时变，7 天刷新）

export interface BacklogPage {
  workspaceId: string;
  limit?: number;
  /** 上一批最后扫描到的公司 id；null/缺省 = 从头。 */
  cursor?: string | null;
}

export interface FitBacklogResult {
  scanned: number;
  judged: number;
  verdicts: Record<string, number>;
  nextCursor: string | null;
}
export interface EnrichBacklogResult {
  scanned: number;
  attempted: number;
  matched: number;
  nextCursor: string | null;
}
export interface WatchBacklogResult {
  scanned: number;
  registered: number;
  nextCursor: string | null;
}
export interface ContactBacklogResult {
  scanned: number;
  attempted: number;
  contactsCreated: number;
  nextCursor: string | null;
}

export function createBacklogActivities(deps: {
  prisma: PrismaService;
  providers: DiscoveryProviderRegistry;
  gateway: ModelGateway;
  /** owner 连接（DATABASE_URL）：仅跨租户只读扫描（列 ACTIVE ICP）。 */
  ownerDb: PrismaClient;
}) {
  const intentSvc = new IntentProjectionService({ prisma: deps.prisma });

  /** DAT-011：SUSPENDED 域名黑名单（平台治理表，无 RLS）。 */
  async function suspendedDomains(): Promise<Set<string>> {
    const rows = await deps.prisma.sourcePolicy.findMany({ where: { reviewStatus: 'SUSPENDED' }, select: { domain: true } });
    return new Set(rows.map((r) => r.domain.toLowerCase()));
  }

  return {
    /** 跨租户列 ACTIVE ICP（owner 只读扫描）→ backlog sweep 的处理目标。 */
    async listBacklogTargets(): Promise<{ targets: { workspaceId: string; icpId: string }[] }> {
      const icps = await deps.ownerDb.icpDefinition.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, workspaceId: true },
        orderBy: { createdAt: 'asc' },
      });
      return { targets: icps.map((i) => ({ workspaceId: i.workspaceId, icpId: i.id })) };
    },

    /**
     * 存量资格门：对 fitVerdict=null 的 canonical 公司跑四门判别（与 qualifyFitForRun 同核心）。
     * 这是解锁 920+ 家投影公司进漏斗的总闸。
     */
    async qualifyFitBacklog(args: BacklogPage & { icpId: string }): Promise<FitBacklogResult> {
      const limit = args.limit ?? 40;
      const { icpBrief, companies } = await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const icpBrief = await loadIcpBrief(tx, args.icpId);
        const companies = await tx.canonicalCompany.findMany({
          where: {
            fitVerdict: null,
            status: { not: 'SUPPRESSED' },
            ...(args.cursor ? { id: { gt: args.cursor } } : {}),
          },
          orderBy: { id: 'asc' },
          take: limit,
          select: { id: true, name: true, domain: true, country: true, industry: true, attributes: true },
        });
        return { icpBrief, companies };
      });

      const verdicts: Record<string, number> = { match: 0, weak: 0, mismatch: 0 };
      let judged = 0;
      for (const c of companies) {
        const judgment = await judgeFitCompany(deps.gateway, args.workspaceId, icpBrief, c);
        if (!judgment) continue; // 单家判别失败不影响其余；本 sweep 不重试（游标只前进），下个 sweep 再来
        verdicts[judgment.verdict] += 1;
        judged += 1;
        await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
          tx.canonicalCompany.update({
            where: { id: c.id },
            data: {
              fitVerdict: judgment.verdict,
              fitReasons: judgment.fitReasons as unknown as Prisma.InputJsonValue,
              status: judgment.verdict === 'match' ? 'ENRICHED' : undefined,
            },
          }),
        );
      }
      return {
        scanned: companies.length,
        judged,
        verdicts,
        nextCursor: companies.length === limit ? companies[companies.length - 1].id : null,
      };
    },

    /** 存量快事实富集（GLEIF/Wikidata）：fit=match 且缺任一源命名空间的公司（与 enrichRun 同语义）。 */
    async enrichBacklog(args: BacklogPage): Promise<EnrichBacklogResult> {
      const limit = args.limit ?? 25;
      const enrichers = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        deps.providers.routeEnrichment(tx as never),
      );
      if (!enrichers.length) return { scanned: 0, attempted: 0, matched: 0, nextCursor: null };

      const companies = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        tx.canonicalCompany.findMany({
          where: {
            fitVerdict: 'match',
            status: { not: 'SUPPRESSED' },
            ...(args.cursor ? { id: { gt: args.cursor } } : {}),
          },
          orderBy: { id: 'asc' },
          take: limit,
          select: { id: true, name: true, domain: true, country: true, region: true, attributes: true },
        }),
      );

      let attempted = 0;
      let matched = 0;
      for (const c of companies) {
        const existing = ((c.attributes as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
        const pending = enrichers.filter((e) => !existing[e.key]); // 已有该源命名空间 → 跳过（幂等）
        if (!pending.length) continue;
        attempted += 1;
        const hits: { key: string; result: EnrichmentResult }[] = [];
        for (const e of pending) {
          try {
            const r = await e.enrichCompany({
              name: c.name,
              domain: c.domain ?? undefined,
              country: c.country ?? undefined,
              region: c.region ?? undefined,
            });
            if (r.matched) hits.push({ key: e.key, result: r });
          } catch {
            /* 单富集源失败不影响其余 */
          }
        }
        if (!hits.length) continue;
        matched += 1;
        await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
          const merged: Record<string, unknown> = { ...existing };
          for (const h of hits) merged[h.key] = h.result.attributes;
          await tx.canonicalCompany.update({
            where: { id: c.id },
            data: { attributes: merged as never, version: { increment: 1 } },
          });
          for (const h of hits) {
            for (const [field, value] of Object.entries(h.result.attributes)) {
              if (value == null) continue;
              await tx.fieldEvidence.create({
                data: {
                  workspaceId: args.workspaceId,
                  entityType: 'company',
                  entityId: c.id,
                  field: `${h.key}.${field}`,
                  value: value as Prisma.InputJsonValue,
                  providerKey: h.key,
                  confidence: h.result.confidence,
                  license: 'public',
                  allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
                  ...(h.result.provenance ? { fetchedAt: new Date(h.result.provenance.fetchedAt) } : {}),
                },
              });
            }
          }
        });
      }
      return {
        scanned: companies.length,
        attempted,
        matched,
        nextCursor: companies.length === limit ? companies[companies.length - 1].id : null,
      };
    },

    /** 存量信号富集（digital_footprint/structured_harvest）：fit=match+域名，TTL 感知（与 enrichSignalsRun 同语义）。 */
    async enrichSignalsBacklog(args: BacklogPage): Promise<EnrichBacklogResult> {
      const limit = args.limit ?? 12;
      const enrichers = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        deps.providers.routeSignalEnrichment(tx as never),
      );
      if (!enrichers.length) return { scanned: 0, attempted: 0, matched: 0, nextCursor: null };
      const suspended = await suspendedDomains();

      const companies = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        tx.canonicalCompany.findMany({
          where: {
            fitVerdict: 'match',
            status: { not: 'SUPPRESSED' },
            domain: { not: null },
            ...(args.cursor ? { id: { gt: args.cursor } } : {}),
          },
          orderBy: { id: 'asc' },
          take: limit,
          select: { id: true, name: true, domain: true, country: true, region: true, attributes: true },
        }),
      );

      const nowMs = Date.now();
      let attempted = 0;
      let matched = 0;
      for (const c of companies) {
        if (c.domain && suspended.has(c.domain.toLowerCase())) continue; // DAT-011
        const existing = ((c.attributes as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
        const pending = enrichers.filter((e) => {
          const prev = existing[e.key] as { _ts?: string } | undefined;
          return !(prev?._ts && nowMs - Date.parse(prev._ts) < SIGNAL_TTL_MS); // TTL 新鲜 → 跳过
        });
        if (!pending.length) continue;
        attempted += 1;
        const hits: { key: string; result: EnrichmentResult }[] = [];
        for (const e of pending) {
          try {
            const r = await e.enrichCompany({
              name: c.name,
              domain: c.domain ?? undefined,
              country: c.country ?? undefined,
              region: c.region ?? undefined,
            });
            if (r.matched) hits.push({ key: e.key, result: r });
          } catch {
            /* 单信号源失败不影响其余 */
          }
        }
        if (!hits.length) continue;
        matched += 1;
        await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
          const merged: Record<string, unknown> = { ...existing };
          for (const h of hits) merged[h.key] = { ...h.result.attributes, _ts: new Date(nowMs).toISOString() };
          await tx.canonicalCompany.update({
            where: { id: c.id },
            data: { attributes: merged as never, version: { increment: 1 } },
          });
          for (const h of hits) {
            for (const [field, value] of Object.entries(h.result.attributes)) {
              if (value == null) continue;
              await tx.fieldEvidence.create({
                data: {
                  workspaceId: args.workspaceId,
                  entityType: 'company',
                  entityId: c.id,
                  field: `${h.key}.${field}`,
                  value: value as Prisma.InputJsonValue,
                  providerKey: h.key,
                  confidence: h.result.confidence,
                  license: 'public',
                  allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
                  ...(h.result.provenance ? { fetchedAt: new Date(h.result.provenance.fetchedAt) } : {}),
                },
              });
            }
          }
        });
      }
      return {
        scanned: companies.length,
        attempted,
        matched,
        nextCursor: companies.length === limit ? companies[companies.length - 1].id : null,
      };
    },

    /**
     * 存量网站监控注册：fit=match+域名且**尚无 web_watch 源**的公司（sourceKey 预查省掉对已注册
     * 域名的重复 sitemap 探测）。registerWatch 本身按域名 upsert（多租户共享抓取）。
     */
    async registerWatchesBacklog(args: BacklogPage): Promise<WatchBacklogResult> {
      const limit = args.limit ?? 12;
      const companies = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        tx.canonicalCompany.findMany({
          where: {
            fitVerdict: 'match',
            status: { not: 'SUPPRESSED' },
            domain: { not: null },
            ...(args.cursor ? { id: { gt: args.cursor } } : {}),
          },
          orderBy: { id: 'asc' },
          take: limit,
          select: { id: true, domain: true },
        }),
      );
      if (!companies.length) return { scanned: 0, registered: 0, nextCursor: null };

      // 平台级预查（无 RLS）：已有 web_watch 源的域名跳过
      const keyOf = (d: string) => `${WEB_WATCH_KEY}:${normalizeDomain(d) ?? d.toLowerCase()}`;
      const keys = companies.filter((c) => c.domain).map((c) => keyOf(c.domain!));
      const existing = new Set(
        (
          await deps.prisma.monitoredSource.findMany({ where: { sourceKey: { in: keys } }, select: { sourceKey: true } })
        ).map((s) => s.sourceKey),
      );

      let registered = 0;
      for (const c of companies) {
        if (!c.domain || existing.has(keyOf(c.domain))) continue;
        try {
          await intentSvc.registerWatch(args.workspaceId, c.id);
          registered += 1;
        } catch {
          /* 单家注册失败（sitemap 不可达/DAT-011）不影响其余 */
        }
      }
      return {
        scanned: companies.length,
        registered,
        nextCursor: companies.length === limit ? companies[companies.length - 1].id : null,
      };
    },

    /**
     * 存量联系人发现：fit=match+域名且**尚无任何联系人**的公司，走 registry 首选 adapter
     * （decision_maker：Impressum/管理层页具名决策人 → 买家角色分类）。🔴 具名人经
     * persistDiscoveredContacts 写 person.profile 证据（personal_data 标记，无 outreach 授权）。
     */
    async discoverContactsBacklog(args: BacklogPage & { icpId: string }): Promise<ContactBacklogResult> {
      const limit = args.limit ?? 8;
      const suspended = await suspendedDomains();

      const { adapter, sellerCtx, suppressedEmails, companies } = await deps.prisma.withWorkspace(
        args.workspaceId,
        async (tx) => {
          const adapters = await deps.providers.routeContactDiscovery(tx as never);
          const icp = await tx.icpDefinition.findUnique({
            where: { id: args.icpId },
            include: { company: true, roles: true },
          });
          const sellerCtx = icp
            ? {
                seller: icp.company?.name ?? undefined,
                targetRoles: icp.roles.map((r) => r.title ?? r.role),
                offering: icp.company?.summary ?? undefined,
              }
            : undefined;
          const suppressedEmails = new Set(
            (await tx.suppressionRecord.findMany({ where: { type: 'email' } })).map((s) => s.value.toLowerCase()),
          );
          const companies = await tx.canonicalCompany.findMany({
            where: {
              fitVerdict: 'match',
              status: { not: 'SUPPRESSED' },
              domain: { not: null },
              contacts: { none: {} },
              ...(args.cursor ? { id: { gt: args.cursor } } : {}),
            },
            orderBy: { id: 'asc' },
            take: limit,
            select: { id: true, name: true, domain: true, country: true, dedupeKey: true },
          });
          return { adapter: adapters[0], sellerCtx, suppressedEmails, companies };
        },
      );
      if (!adapter || !companies.length) return { scanned: companies.length, attempted: 0, contactsCreated: 0, nextCursor: null };

      let attempted = 0;
      let contactsCreated = 0;
      for (const c of companies) {
        if (c.domain && suspended.has(c.domain.toLowerCase())) continue; // DAT-011：联系人抓取同样遵守
        attempted += 1;
        let contacts;
        try {
          // 网络（抓多页 + LLM）在事务外
          const result = await adapter.discoverContacts(
            { name: c.name, domain: c.domain ?? undefined, country: c.country ?? undefined },
            sellerCtx,
          );
          contacts = result.contacts;
        } catch {
          continue; // 单家失败不影响其余
        }
        if (!contacts.length) continue;
        const { created } = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
          persistDiscoveredContacts(tx, {
            workspaceId: args.workspaceId,
            company: { id: c.id, dedupeKey: c.dedupeKey },
            adapterKey: adapter.key,
            contacts,
            suppressedEmails,
          }),
        );
        contactsCreated += created;
      }
      return {
        scanned: companies.length,
        attempted,
        contactsCreated,
        nextCursor: companies.length === limit ? companies[companies.length - 1].id : null,
      };
    },
  };
}

export type BacklogActivities = ReturnType<typeof createBacklogActivities>;
