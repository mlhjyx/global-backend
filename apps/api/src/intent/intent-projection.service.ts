import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeDomain, companyIdentity } from '../discovery/identity';
import { fetchSitemapUrls, HttpGetFn } from '../discovery/providers/structured-harvest.provider';
import { PLATFORM_WORKSPACE } from '../discovery/provider-contract';
import type { HttpGetInput, HttpGetOutput } from '../tools/source-tools';
import type { ExecutionBroker } from '../tools/tool-contract';
import { PageKind, classifyPageKind } from './page-signals';
import { WEB_WATCH_KEY } from './website-watch.service';

const DEFAULT_CADENCE_MS = 24 * 60 * 60 * 1000; // 网站变更日级足够（研究：招聘/新闻日级、广告库月级）
const MAX_EVENTS_KEPT = 20; // 每公司 attributes.intent 保留的滚动事件数
const INTENT_CHANGE_TYPES = ['SOURCING_OPENED', 'HIRING_UP', 'HIRING_DOWN', 'NEW_PRODUCTS', 'NEWS_POSTED', 'PAGE_CHANGED'];

/** 各 intent 类型的基准强度（与 page-signals 对齐；projection 取 max 作 intent_score 提示，喂未来六维 Intent 维）。 */
const TYPE_STRENGTH: Record<string, number> = {
  SOURCING_OPENED: 1, HIRING_UP: 0.6, NEW_PRODUCTS: 0.7, NEWS_POSTED: 0.5, HIRING_DOWN: 0.2, PAGE_CHANGED: 0.3,
};

export interface RegisterWatchResult {
  sourceId: string;
  sourceKey: string;
  created: boolean;
  pages: number;
}

export interface ProjectIntentResult {
  companiesTouched: number;
  eventsProjected: number;
}

/**
 * 意图投影 + 监控注册（把网站变更 intent 引擎接进租户获客主线）。
 *  - registerWatch：把某租户的一家 canonical_company 加入**平台级**网站监控（web_watch monitored_source，
 *    dedup by 域名 → 多租户共享抓取）。默认监控页由域名推常见路径（首页/产品/招聘/供应商/新闻）。
 *  - projectIntent：把平台层新产生的 web_watch source_entity_change（intent 事件）按域名映射回**本租户**的
 *    canonical_company，写滚动 attributes.intent.*（喂未来 Intent 维评分）+ field_evidence 留痕（🟢公司事实/public）。
 * 平台采集一次、租户各自投影 —— 与 acquisition/TenantProjectionService 同一架构。
 */
export class IntentProjectionService {
  constructor(private readonly deps: { prisma: PrismaService; broker?: ExecutionBroker }) {}

  async registerWatch(
    workspaceId: string,
    canonicalCompanyId: string,
    opts?: { pages?: { url: string; kind?: PageKind }[]; cadenceMs?: number },
  ): Promise<RegisterWatchResult> {
    const { prisma } = this.deps;
    const company = await prisma.withWorkspace(workspaceId, (tx) =>
      tx.canonicalCompany.findUnique({ where: { id: canonicalCompanyId }, select: { name: true, domain: true, region: true } }),
    );
    if (!company) throw new Error(`canonical_company ${canonicalCompanyId} not found in workspace`);
    const domain = company.domain ? normalizeDomain(company.domain) ?? undefined : undefined;
    if (!domain) throw new Error(`company ${canonicalCompanyId} has no domain — cannot watch website`);

    const pages = (opts?.pages?.length ? opts.pages : await discoverWatchPages(domain, this.sitemapHttpGet())).slice(0, 12);
    const sourceKey = `${WEB_WATCH_KEY}:${domain}`;
    const config = { company: { name: company.name, domain }, pages } as unknown as Prisma.InputJsonValue;
    const cadence = { kind: 'fixed', everyMs: opts?.cadenceMs ?? DEFAULT_CADENCE_MS } as unknown as Prisma.InputJsonValue;

    // 平台级 upsert（无 RLS）：已存在则合并页集（并集），否则新建。
    const prior = await prisma.monitoredSource.findUnique({ where: { sourceKey }, select: { id: true, config: true } });
    if (prior) {
      const merged = mergePages(prior.config, pages);
      await prisma.monitoredSource.update({
        where: { id: prior.id },
        data: { config: { company: { name: company.name, domain }, pages: merged } as unknown as Prisma.InputJsonValue },
      });
      return { sourceId: prior.id, sourceKey, created: false, pages: merged.length };
    }
    const created = await prisma.monitoredSource.create({
      data: {
        providerKey: WEB_WATCH_KEY, sourceKey, label: `${company.name} 官网监控`,
        config, cadence, region: company.region ?? null, status: 'ACTIVE',
      },
    });
    return { sourceId: created.id, sourceKey, created: true, pages: pages.length };
  }

  /**
   * 把平台层新 intent 事件投影进本租户 canonical。按域名把 web_watch 源的变更映射到公司，
   * 写滚动 attributes.intent（last_change_at / intent_score / 近 N 条事件 / 各类型计数）+ field_evidence。
   */
  async projectIntent(workspaceId: string, opts?: { sinceMs?: number; limit?: number }): Promise<ProjectIntentResult> {
    const { prisma } = this.deps;
    const since = new Date(Date.now() - (opts?.sinceMs ?? 7 * 24 * 60 * 60 * 1000));

    // 平台层：取近窗口的 intent 变更 + 其源（拿公司身份）
    const rawChanges = await prisma.sourceEntityChange.findMany({
      where: { changeType: { in: INTENT_CHANGE_TYPES }, createdAt: { gte: since }, source: { providerKey: WEB_WATCH_KEY } },
      orderBy: { createdAt: 'desc' },
      take: opts?.limit ?? 2000,
      include: { source: { select: { config: true } } },
    });
    if (!rawChanges.length) return { companiesTouched: 0, eventsProjected: 0 };

    // 按**确定性身份键**（companyIdentity dedupeKey，域名优先）分组——与其它投影同一实体解析纪律，
    // 不用可空/非唯一的 raw domain findFirst（可能错配或漏配）。
    const byKey = new Map<string, typeof rawChanges>();
    for (const ch of rawChanges) {
      const co = companyOf(ch.source?.config);
      if (!co?.domain) continue;
      const dedupeKey = companyIdentity({ name: co.name, domain: co.domain }).dedupeKey;
      (byKey.get(dedupeKey) ?? byKey.set(dedupeKey, []).get(dedupeKey)!).push(ch);
    }

    let companiesTouched = 0, eventsProjected = 0;
    for (const [dedupeKey, changes] of byKey) {
      const touched = await prisma.withWorkspace(workspaceId, async (tx) => {
        const company = await tx.canonicalCompany.findUnique({
          where: { workspaceId_dedupeKey: { workspaceId, dedupeKey } },
          select: { id: true, attributes: true, status: true },
        });
        if (!company || company.status === 'SUPPRESSED') return false;

        const events = changes.map(toEvent);
        const existing = ((company.attributes as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
        const priorIntent = (existing.intent as IntentAttr | undefined) ?? undefined;
        const intent = mergeIntent(priorIntent, events);

        await tx.canonicalCompany.update({
          where: { id: company.id },
          data: { attributes: { ...existing, intent } as unknown as Prisma.InputJsonValue, version: { increment: 1 } },
        });
        await tx.fieldEvidence.create({
          data: {
            workspaceId, entityType: 'company', entityId: company.id, field: 'intent.website_change',
            value: intent as unknown as Prisma.InputJsonValue, providerKey: WEB_WATCH_KEY,
            confidence: 1, license: 'public',
            allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
          },
        });
        eventsProjected += events.length;
        return true;
      });
      if (touched) companiesTouched += 1;
    }
    return { companiesTouched, eventsProjected };
  }

  /**
   * 出网绑定（收口②）：sitemap/探测经 http.get 工具（SSRF 护栏在工具内权威强制）。平台级监控注册
   * 无租户 → PLATFORM_WORKSPACE 哨兵（只入工具 Trace/预算，绝不流入任何 AiContext）。
   * 无 broker = 不允许原始出网 → undefined（discoverWatchPages 跳过 sitemap/探测，退既有兜底页集）。
   */
  private sitemapHttpGet(): HttpGetFn | undefined {
    const broker = this.deps.broker;
    if (!broker) {
       
      console.warn('[intent-projection] broker unavailable — skip sitemap discovery (fail-closed, no raw egress)');
      return undefined;
    }
    return async (input) =>
      (
        await broker.invoke<HttpGetInput, HttpGetOutput>('http.get', input, {
          workspaceId: PLATFORM_WORKSPACE,
          correlationId: 'register-watch',
        })
      ).data;
  }
}

// ─────────────────────── intent 聚合 ───────────────────────

export interface IntentEvent { type: string; at: string; strength: number; page_kind?: string; page_url?: string; evidence?: unknown }
export interface IntentAttr {
  last_change_at: string;
  intent_score: number; // 近窗口最强信号强度（0..1）——喂未来六维 Intent 维的提示值
  counts: Record<string, number>;
  events: IntentEvent[];
  _ts: string;
}

function toEvent(ch: { changeType: string; createdAt: Date; detail: unknown }): IntentEvent {
  const detail = (ch.detail ?? {}) as Record<string, unknown>;
  const strength = typeof detail.strength === 'number' ? detail.strength : TYPE_STRENGTH[ch.changeType] ?? 0.3;
  return {
    type: ch.changeType,
    at: ch.createdAt.toISOString(),
    strength,
    page_kind: typeof detail.page_kind === 'string' ? detail.page_kind : undefined,
    page_url: typeof detail.url === 'string' ? detail.url : undefined,
    evidence: detail.evidence,
  };
}

/**
 * 合并后 intent 与既有是否**实质相同**（忽略每次都变的 _ts）——投影幂等门用，防同一信号每 sweep 复现时重复写。
 * 关键：既有 intent 来自 DB jsonb（Postgres **规范化对象键序**），新 intent 是内存对象（插入键序）——直接
 * JSON.stringify 会因键序不同误判「变了」（TED P3 实测抓到过此 bug）。故先 canonical 递归排序键再比。
 * 共享给 TED / openFDA intent 投影（DRY，勿各自复制）。
 */
export function sameIntent(a: IntentAttr, b: IntentAttr): boolean {
  const stripTs = ({ _ts, ...rest }: IntentAttr): unknown => rest;
  return JSON.stringify(canonicalize(stripTs(a))) === JSON.stringify(canonicalize(stripTs(b)));
}

/** 递归按键名排序（数组保序）——生成键序无关的规范形，供 jsonb 往返对象的稳定比较。 */
export function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    return Object.keys(v as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((o, k) => {
        o[k] = canonicalize((v as Record<string, unknown>)[k]);
        return o;
      }, {});
  }
  return v;
}

/** 合并已有 intent 与新事件：滚动保留近 N 条、累计类型计数、intent_score=近窗口最强强度。共享（web_watch + TED 招标 intent）。 */
export function mergeIntent(prev: IntentAttr | undefined, incoming: IntentEvent[]): IntentAttr {
  const seen = new Set<string>();
  const all = [...incoming, ...(prev?.events ?? [])]
    .filter((e) => {
      // 含页面 URL 区分：同一 sweep 里多页写的变更共享 createdAt，仅 type|at 会误并（如两页同为 PAGE_CHANGED）
      const k = `${e.type}|${e.at}|${e.page_url ?? e.page_kind ?? ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    // 新近优先降序；相等 at 返回 0 → 保留输入序（V8 稳定排序）。**不可**对相等 at 返回 ±1：会产生不一致
    // 比较器（同时判 a<b、b<a），令相等事件在重排后顺序不定 → canonicalize 保序比较误判「变了」→ 破幂等。
    // 本 provider 的 FDA_CLEARANCE 与 web_watch/TED 事件 at 格式不同（date-only vs full ISO），跨源同 at 罕见，
    // 但作为 3 子系统共享的幂等基石，比较器必须一致（防未来调用方输入序变动时静默重写）。
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, MAX_EVENTS_KEPT);
  const counts: Record<string, number> = {};
  for (const e of all) counts[e.type] = (counts[e.type] ?? 0) + 1;
  const intent_score = all.length ? Math.max(...all.map((e) => e.strength)) : 0;
  return { last_change_at: all[0]?.at ?? new Date().toISOString(), intent_score, counts, events: all, _ts: new Date().toISOString() };
}

/**
 * 由**站点 sitemap** 推意图承载页（复用 structured-harvest 的 fetchSitemapUrls + SSRF 护栏），
 * 每类（供应商/招聘/产品/新闻）取路径最短者 = 落地页 + 首页。
 * 真实站各站路径各异（TRUMPF `/en_INT/products/`、`/en_US/company/principles/suppliers/`…）——
 * 盲猜英文固定路径大多 404；从 sitemap 取真实 URL 才有效。sitemap 空时兜底只监控首页。
 * 出网经调用方绑定的 httpGet（http.get 工具）；无 httpGet（无 broker）→ 不出网，退兜底页集（仅首页）。
 */
export async function discoverWatchPages(domain: string, httpGet?: HttpGetFn): Promise<{ url: string; kind: PageKind }[]> {
  const pages: { url: string; kind: PageKind }[] = [{ url: `https://${domain}/`, kind: 'generic' }];
  if (!httpGet) return pages; // fail-closed：无出网函数 → 既有兜底页集
  const urls = await fetchSitemapUrls(domain, httpGet).catch(() => [] as string[]);
  const pathLen = (u: string) => {
    try {
      return new URL(u).pathname.length;
    } catch {
      return u.length;
    }
  };
  for (const kind of ['sourcing', 'careers', 'products', 'news'] as PageKind[]) {
    const best = urls.filter((u) => classifyPageKind(u) === kind).sort((a, b) => pathLen(a) - pathLen(b))[0];
    if (best) pages.push({ url: best, kind });
  }
  const seen = new Set<string>();
  return pages.filter((p) => (seen.has(p.url) ? false : (seen.add(p.url), true))).slice(0, 8);
}

function companyOf(config: unknown): { name: string; domain?: string } | undefined {
  const c = (config ?? {}) as Record<string, unknown>;
  const company = (c.company ?? {}) as Record<string, unknown>;
  const name = typeof company.name === 'string' ? company.name : '';
  const d = typeof company.domain === 'string' ? normalizeDomain(company.domain) ?? undefined : undefined;
  return d ? { name, domain: d } : undefined;
}

function mergePages(priorConfig: unknown, next: { url: string; kind?: PageKind }[]): { url: string; kind?: PageKind }[] {
  const c = (priorConfig ?? {}) as Record<string, unknown>;
  const prior = Array.isArray(c.pages) ? (c.pages as { url: string; kind?: PageKind }[]) : [];
  const byUrl = new Map<string, { url: string; kind?: PageKind }>();
  for (const p of [...prior, ...next]) if (p && typeof p.url === 'string') byUrl.set(p.url, { url: p.url, kind: p.kind });
  return [...byUrl.values()].slice(0, 20);
}
