import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MISS_THRESHOLD, computeNextFetchAt } from '../acquisition/monitored-source.lifecycle';
import { PageFetcher } from './page-fetcher';
import { classifyPageKind, extractPageSignals, signalHash, diffPageSignals, PageKind, PageSignals } from './page-signals';

const PARSER_VERSION = 'web-watch/v1';
const WEB_WATCH_KEY = 'web_watch';

/** monitored_source.config 的 web_watch 形态。 */
export interface WebWatchConfig {
  company: { name: string; domain: string };
  pages: { url: string; kind?: PageKind }[];
}

export interface WatchResult {
  sourceId: string;
  status: 'DONE' | 'FAILED' | 'SKIPPED';
  pagesFetched: number;
  pagesMissed: number;
  added: number;
  changed: number; // 有实质变化的页数
  intentEvents: number; // 产出的 intent 事件条数（可 > changed，一页多增量）
  reason?: string;
}

/**
 * 网站变更 = intent 引擎（v3.0 P0 #4）。**复用** acquisition 的「内容哈希增量 diff + source_entity_change」
 * 机制，但锚点从「公司记录」换成「目标公司的一个意图承载页」：对一个 web_watch monitored_source 的每个页，
 * 抓渲染后 HTML → 抽结构化意图信号（page-signals，纯）→ signalHash（只覆盖信号，cosmetic 抖动不触发）→
 * 与上次快照 diff → 每条增量写一条 source_entity_change（changeType=SOURCING_OPENED/HIRING_UP/NEW_PRODUCTS/…，
 * detail=具体证据+强度）= 一条可喂 Intent 维度的时机信号。
 *
 * 平台级共享（同 acquisition，无 RLS）：一家公司的公开页变化对所有租户是同一事实，抓一次共享；
 * 租户按 ICP 把公司加入监控（registerWatch，dedup by domain），并把 intent 事件投影进自己的 canonical（IntentProjectionService）。
 * 合规：全部🟢公司公开事实（岗位职务/产品/招募公告/新闻标题），无个人数据；抓取守 robots + crawl4ai egress 防护。
 *
 * ⚠️ web_watch 源**不进** acquisition 的通用 sweep（AcquisitionService.acquire 无 web_watch 适配器会抛错）——
 *   通用 listDueSources 已排除 providerKey='web_watch'，本引擎走独立 intentSweep + 独立 Schedule。
 */
export class WebsiteWatchService {
  constructor(private readonly deps: { prisma: PrismaService; fetcher: PageFetcher }) {}

  async watch(sourceId: string): Promise<WatchResult> {
    const { prisma, fetcher } = this.deps;
    const source = await prisma.monitoredSource.findUnique({ where: { id: sourceId } });
    if (!source) throw new Error(`monitored_source ${sourceId} not found`);
    if (source.providerKey !== WEB_WATCH_KEY) throw new Error(`source ${sourceId} is not a web_watch source (providerKey=${source.providerKey})`);
    if (source.status !== 'ACTIVE') {
      return { sourceId, status: 'SKIPPED', pagesFetched: 0, pagesMissed: 0, added: 0, changed: 0, intentEvents: 0, reason: `status=${source.status}` };
    }

    const config = parseConfig(source.config);
    if (!config || !config.pages.length) {
      return { sourceId, status: 'SKIPPED', pagesFetched: 0, pagesMissed: 0, added: 0, changed: 0, intentEvents: 0, reason: 'no pages in config' };
    }
    const companyName = config.company.name || source.label;
    const companyDomain = config.company.domain || undefined;

    // DAT-011：平台级 source_policy SUSPENDED 域名黑名单——与 enrichSignalsRun/public-web 一致，
    // 抓取前跳过（本引擎是唯一定时对外抓取路径，必须接同一个爬取 kill-switch）。
    if (companyDomain) {
      const suspended = await prisma.sourcePolicy.findFirst({
        where: { domain: companyDomain, reviewStatus: 'SUSPENDED' },
        select: { id: true },
      });
      if (suspended) {
        return { sourceId, status: 'SKIPPED', pagesFetched: 0, pagesMissed: 0, added: 0, changed: 0, intentEvents: 0, reason: 'domain SUSPENDED (DAT-011)' };
      }
    }

    const fetchRow = await prisma.sourceFetch.create({ data: { sourceId, status: 'RUNNING', parserVersion: PARSER_VERSION } });

    const existing = await prisma.sourceEntity.findMany({ where: { sourceId } });
    const existingByUrl = new Map(existing.map((e) => [e.externalId, e]));
    const now = new Date();
    const changes: Prisma.SourceEntityChangeCreateManyInput[] = [];

    let pagesFetched = 0, pagesMissed = 0, added = 0, changed = 0;
    const seen = new Set<string>();

    // 逐页处理（网络在事务外，fail-safe：单页失败不影响其余）
    for (const p of config.pages) {
      const url = normalizeUrl(p.url);
      if (!url || seen.has(url)) continue; // 去 config 内重复 URL：否则第二次 prev 落空 → 二次 create 撞 (sourceId,externalId) 唯一约束
      seen.add(url);
      const kind = p.kind ?? classifyPageKind(url);

      const page = await fetcher.fetch(url).catch(() => null);
      const prev = existingByUrl.get(url);

      if (!page) {
        // miss：连续缺席累计到阈值才判页面下线（防临时抓取失败误杀）
        pagesMissed += 1;
        if (prev && !prev.withdrawnAt) {
          const miss = prev.missCount + 1;
          if (miss >= MISS_THRESHOLD) {
            await prisma.sourceEntity.update({ where: { id: prev.id }, data: { withdrawnAt: now, missCount: MISS_THRESHOLD } });
            changes.push({ sourceId, fetchId: fetchRow.id, externalId: url, changeType: 'REMOVED', detail: { page_kind: kind } as Prisma.InputJsonValue });
          } else {
            await prisma.sourceEntity.update({ where: { id: prev.id }, data: { missCount: miss } });
          }
        }
        continue;
      }

      pagesFetched += 1;
      const signals = extractPageSignals(page.html, kind, url);
      const hash = signalHash(signals);
      const cleaned = { page_kind: kind, url, ...signals } as unknown as Prisma.InputJsonValue;

      if (!prev) {
        // 首见页 = 基线快照（不发 intent 事件，避免初次监控刷屏；当前态存 cleaned 供 projection 读）
        await prisma.sourceEntity.create({
          data: {
            sourceId, externalId: url, entityKind: 'web_page',
            name: companyName, domain: companyDomain ?? null, country: source.region ?? null,
            cleaned, contentHash: hash, firstSeenAt: now, lastSeenAt: now,
          },
        });
        added += 1;
        changes.push({ sourceId, fetchId: fetchRow.id, externalId: url, changeType: 'ADDED', detail: { page_kind: kind, baseline: signalSummary(signals) } as Prisma.InputJsonValue });
        continue;
      }

      if (!prev.withdrawnAt && prev.contentHash === hash) {
        await prisma.sourceEntity.update({ where: { id: prev.id }, data: { lastSeenAt: now, missCount: 0 } });
        continue;
      }

      // 变化：diff 出具体 intent 增量（页面复活 withdrawnAt→回归，视作 ADDED 基线不发增量）
      if (prev.withdrawnAt) {
        changes.push({ sourceId, fetchId: fetchRow.id, externalId: url, changeType: 'ADDED', detail: { page_kind: kind, revived: true, baseline: signalSummary(signals) } as Prisma.InputJsonValue });
      } else {
        const prevSignals = pageSignalsOf(prev.cleaned);
        for (const d of diffPageSignals(prevSignals, signals)) {
          changes.push({
            sourceId, fetchId: fetchRow.id, externalId: url,
            changeType: d.changeType,
            detail: { page_kind: kind, url, strength: d.strength, evidence: d.evidence, company: companyName } as Prisma.InputJsonValue,
          });
        }
        changed += 1;
      }
      await prisma.sourceEntity.update({
        where: { id: prev.id },
        data: { cleaned, contentHash: hash, name: companyName, domain: companyDomain ?? prev.domain, lastSeenAt: now, withdrawnAt: null, missCount: 0 },
      });
    }

    // 从 config 移除的旧页（不再监控）→ 标退出（不发 REMOVED intent，纯清理）
    for (const e of existing) {
      if (seen.has(e.externalId) || e.withdrawnAt) continue;
      await prisma.sourceEntity.update({ where: { id: e.id }, data: { withdrawnAt: now } });
    }

    const intentEvents = changes.filter((c) => c.changeType !== 'ADDED' && c.changeType !== 'REMOVED').length;
    if (changes.length) await prisma.sourceEntityChange.createMany({ data: changes });

    await prisma.sourceFetch.update({
      where: { id: fetchRow.id },
      data: { status: 'DONE', total: pagesFetched, added, updated: changed, finishedAt: now },
    });
    await prisma.monitoredSource.update({
      where: { id: sourceId },
      data: { lastFetchAt: now, nextFetchAt: computeNextFetchAt(source.cadence, now) },
    });

    return { sourceId, status: 'DONE', pagesFetched, pagesMissed, added, changed, intentEvents };
  }

  /**
   * 保留期清理：删除超过窗口的 web_watch 变更事件（GDPR Art.5(1)(e) 存储限制）。
   * 平台层 source_entity_change 无 RLS，不应无限累积——即便本引擎已把人名类原文挡在库外，
   * 定期清理仍是纵深防御。intentSweep 每轮起始调一次（全局、廉价）。
   */
  async purgeStaleEvents(olderThanMs: number): Promise<{ deleted: number }> {
    const { prisma } = this.deps;
    const cutoff = new Date(Date.now() - olderThanMs);
    const sources = await prisma.monitoredSource.findMany({ where: { providerKey: WEB_WATCH_KEY }, select: { id: true } });
    if (!sources.length) return { deleted: 0 };
    const res = await prisma.sourceEntityChange.deleteMany({
      where: { sourceId: { in: sources.map((s) => s.id) }, createdAt: { lt: cutoff } },
    });
    return { deleted: res.count };
  }
}

// ─────────────────────── helpers ───────────────────────

function parseConfig(raw: unknown): WebWatchConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const company = (o.company ?? {}) as Record<string, unknown>;
  const pages = Array.isArray(o.pages) ? o.pages : [];
  const cleanPages = pages
    .map((p) => (p && typeof p === 'object' ? (p as Record<string, unknown>) : null))
    .filter((p): p is Record<string, unknown> => !!p && typeof p.url === 'string')
    .map((p) => ({ url: String(p.url), kind: typeof p.kind === 'string' ? (p.kind as PageKind) : undefined }));
  return { company: { name: String(company.name ?? ''), domain: String(company.domain ?? '') }, pages: cleanPages };
}

function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/** source_entity.cleaned (Json) → PageSignals（读回上次快照做 diff）。 */
function pageSignalsOf(cleaned: unknown): PageSignals {
  const c = (cleaned ?? {}) as Record<string, unknown>;
  return {
    kind: (typeof c.page_kind === 'string' ? c.page_kind : 'generic') as PageKind,
    hiring: c.hiring as PageSignals['hiring'],
    products: Array.isArray(c.products) ? (c.products as string[]) : undefined,
    product_links: Array.isArray(c.product_links) ? (c.product_links as string[]) : undefined,
    sourcing: c.sourcing as PageSignals['sourcing'],
    news: c.news as PageSignals['news'],
    textDigest: typeof c.textDigest === 'string' ? c.textDigest : undefined,
  };
}

/** 基线/复活时存的信号概要（不含 textDigest 指纹，人读友好）。 */
function signalSummary(s: PageSignals): Record<string, unknown> {
  return prune({
    hiring: s.hiring?.open_roles,
    has_buying_role: s.hiring?.has_buying_role,
    products: (s.products?.length ?? 0) + (s.product_links?.length ?? 0) || undefined,
    sourcing: s.sourcing?.terms,
    news: s.news?.items.length,
  });
}

function prune(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
}

export { WEB_WATCH_KEY };
