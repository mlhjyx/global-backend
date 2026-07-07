import { createHash } from 'node:crypto';
import { extractJsonLd } from '../discovery/providers/digital-footprint.provider';
import { isBuyingRole } from '../discovery/providers/structured-harvest.provider';

/**
 * 网站变更 = intent 引擎（v3.0 P0 #4）—— **纯解析层，不触网、可测**。
 *
 * 复用「内容哈希增量 diff」思路（同 acquisition/source_entity_change），但把锚点从
 * 「公司记录」换成「目标公司的一个意图承载页」：产品页 / 招聘页 / 「求供应商·RFQ」页 / 新闻页。
 * 从渲染后 HTML 抽**结构化意图信号**（招聘量/岗位、上新产品、开放供应商招募、新闻事件），
 * 算**只覆盖信号字段**的稳定指纹（signalHash，非原始 HTML 哈希 → cosmetic 变动不误触发），
 * 前后快照 diff 出**具体增量**（diffPageSignals）→ 每个增量 = 一条 intent 事件（写 source_entity_change）。
 *
 * 合规：全部取自公开公司页的🟢公司事实（岗位**职务**非人名、产品名、招募公告、新闻标题）——无个人数据。
 */

export type PageKind = 'careers' | 'products' | 'sourcing' | 'news' | 'generic';

export interface HiringSignal {
  open_roles: number;
  titles: string[];
  has_buying_role: boolean;
}

export interface SourcingSignal {
  /** 命中的招募/询价意图词（归一后去重排序 → 稳定，供 diff）。 */
  terms: string[];
}

export interface NewsSignal {
  /**
   * 近期新闻条目的**指纹哈希**（非标题原文），去重排序 → 新条目出现即 diff。
   * 🔴 合规：不存标题/正文原文——新闻稿标题可能含具名高管（个人数据），只存哈希 + 计数，
   * 事件证据也只给 new_count，绝不落人名到平台层 source_entity_change（无 RLS，跨租户共享）。
   */
  items: string[];
}

export interface PageSignals {
  kind: PageKind;
  hiring?: HiringSignal;
  /** JSON-LD Product 名（有则）。真实站多不发 Product JSON-LD → 主要靠 product_links。 */
  products?: string[];
  /** 产品/方案详情链接的归一路径集（真实站产品名多藏在锚点 URL/slug 里）——稳定、可 diff。 */
  product_links?: string[];
  sourcing?: SourcingSignal;
  news?: NewsSignal;
  /** 归一后可见正文指纹（catch-all 弱信号：无结构化增量但正文实质变化 → PAGE_CHANGED）。哈希，不含原文。 */
  textDigest?: string;
}

/** 一条 intent 增量（前后快照 diff 的产物）。一次抓取可产出多条（招聘变 + 上新 + 开放招募）。 */
export interface IntentDelta {
  changeType: IntentChangeType;
  /** 粗略强度 0..1，供下游 Intent 维度加权（SOURCING/买手招聘最高，PAGE_CHANGED 最低）。 */
  strength: number;
  evidence: Record<string, unknown>;
}

export type IntentChangeType =
  | 'SOURCING_OPENED' // 新出现供应商招募/RFQ/询价 —— 最强买家意图
  | 'HIRING_UP' // 开放岗位增加（含采购/供应链岗则更强）
  | 'HIRING_DOWN' // 开放岗位减少（弱负向）
  | 'NEW_PRODUCTS' // 上新产品（可能=新产线/新品类）
  | 'NEWS_POSTED' // 新新闻条目（扩产/建厂/融资/认证事件的入口）
  | 'PAGE_CHANGED'; // 正文实质变化，未归入以上具体类型（弱）

const STRENGTH: Record<IntentChangeType, number> = {
  SOURCING_OPENED: 1,
  HIRING_UP: 0.6,
  HIRING_DOWN: 0.2,
  NEW_PRODUCTS: 0.7,
  NEWS_POSTED: 0.5,
  PAGE_CHANGED: 0.3,
};

// ─────────────────────── 页面分类（路径启发式） ───────────────────────

// 词元均加**词边界**，避免子串误命中（impressum/compressor 含「press」、multimedia 含「media」、arrange 含「range」）。
// 顺序=优先级：sourcing > careers > products > news——products 先于 news，使 `/products/media-x` 归 products 而非 news。
const KIND_RE: { kind: PageKind; re: RegExp }[] = [
  {
    kind: 'sourcing',
    re: /\bsupplier|\bvendor|\bprocure|\bsourcing|\bpurchas|\brfq\b|\brfp\b|\btender|become-?a-?(supplier|vendor|partner)|\blieferant|\bzulieferer|\beinkauf|\bbeschaffung|供应商|采购|招标|询价/i,
  },
  { kind: 'careers', re: /\bcareers?\b|\bjobs?\b|\bvacanc|\bstellen\b|\bkarriere\b|join-?us|\brecruit|\bemplo|招聘|人才/i },
  { kind: 'products', re: /\bproducts?\b|\bsolutions?\b|\bcatalog(?:ue)?\b|\bportfolio\b|\bprodukte?\b|\bsortiment\b|产品|方案/i },
  { kind: 'news', re: /\bnews\b|\bnewsroom\b|\bpress(?:e|-?releases?|room)?\b|\bmedia\b|\bblog\b|\baktuelles\b|\bannouncements?\b|新闻|动态|资讯/i },
];

/** 由 URL 路径推断页面类型（sourcing > careers > news > products > generic）。 */
export function classifyPageKind(url: string): PageKind {
  let path: string;
  try {
    path = new URL(url).pathname;
    try {
      path = decodeURIComponent(path); // 非 ASCII 路径（如中文「供应商」）会被 URL 百分号编码 → 解码后再匹配
    } catch {
      /* 畸形转义序列 → 用编码后的原样匹配 */
    }
  } catch {
    path = url;
  }
  for (const { kind, re } of KIND_RE) if (re.test(path)) return kind;
  return 'generic';
}

// ─────────────────────── 信号抽取（纯，from HTML） ───────────────────────

// 供应商招募 / 询价意图词（=主动买家信号）。用**短语 + 词边界**而非单词，避免页脚「Suppliers」链接误命中。
// 覆盖实测真实措辞：Flex「become suppliers to…」「diverse supplier」、TRUMPF「Supplier portal / Registration / Onboarding」。
const SOURCING_SIGS: { term: string; re: RegExp }[] = [
  { term: 'become_a_supplier', re: /\bbecome\s+(a\s+)?(suppliers?|vendors?)\b|\bapply\s+to\s+(be|become)\s+a\s+(supplier|vendor)\b|\bregister\s+as\s+a\s+(supplier|vendor)\b|成为供应商|供应商注册/i },
  { term: 'supplier_program', re: /\bsupplier\s+(registration|information|onboarding|application|portal|diversity|management)\b|\bvendor\s+(registration|portal|onboarding)\b|供应商门户|供应商管理/i },
  { term: 'rfq', re: /\brequest\s+for\s+qu(?:ot(?:e|ation))?\b|\brfq\b|\brequest\s+a\s+quote\b|询价|求购/i },
  { term: 'rfp_tender', re: /\brequest\s+for\s+proposal\b|\brfp\b|\bcall\s+for\s+tenders?\b|\binvitation\s+to\s+tender\b|招标|投标邀请/i },
  { term: 'seeking_suppliers', re: /\blooking\s+for\s+(suppliers|vendors|sourcing\s+partners)\b|\bseeking\s+(suppliers|vendors)\b|\b(diverse\s+supplier|supplier\s+diversity)\b|寻找供应商|征集供应商/i },
];

/** 从 HTML 抽供应商招募/询价意图词（命中的短语类别，归一去重排序）。 */
export function extractSourcingTerms(html: string): string[] {
  const text = visibleText(html);
  const hits = SOURCING_SIGS.filter((s) => s.re.test(text)).map((s) => s.term);
  return [...new Set(hits)].sort();
}

// 产品/方案详情链接：路径含产品段 + 其后还有 slug（排除 listing 本身）。多语覆盖。
const PRODUCT_LINK_RE = /\/(products?|solutions?|produkte?|produkt|catalog(?:ue)?|portfolio|sortiment|machines?|systems?)\/[a-z0-9][a-z0-9%/_-]{2,}/i;
// 新闻/新闻稿详情链接：路径含新闻段 + 其后 slug/id。
const NEWS_LINK_RE = /\/(news|press(?:e)?|media|newsroom|releases?|blog|aktuelles|announcements?|stories|press-releases?)\/[a-z0-9][a-z0-9%/_-]{2,}/i;

/** 从 HTML 抽同域产品详情链接的归一路径集（真实站产品名藏在锚点 URL/slug 里 → 稳定可 diff）。 */
export function extractProductLinks(html: string, baseUrl?: string): string[] {
  return normalizedPaths(html, baseUrl, PRODUCT_LINK_RE).slice(0, 60);
}

/**
 * 近期新闻条目 → **指纹哈希**集（不存标题原文，防具名高管落库；见 NewsSignal 合规注）。
 * 来源①同域新闻详情链接路径；②JSON-LD Article 的 headline|date——均哈希后再存。
 */
export function extractNewsFingerprints(html: string, baseUrl?: string): string[] {
  const fps = new Set<string>();
  for (const p of normalizedPaths(html, baseUrl, NEWS_LINK_RE)) fps.add(fp(p));

  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    for (const n of flattenJsonLd(parsed)) {
      const types = ([] as unknown[]).concat(n['@type'] ?? []).map(String);
      if (!types.some((t) => /Article|NewsArticle|BlogPosting|PressRelease|Report/i.test(t))) continue;
      const headline = str(n.headline) ?? str(n.name);
      if (!headline) continue;
      const date = (str(n.datePublished) ?? str(n.dateCreated) ?? '').slice(0, 10);
      fps.add(fp(`${headline.trim().toLowerCase()}|${date}`)); // 只存哈希，标题原文不落库
    }
  }
  return [...fps].sort().slice(0, 40);
}

/** 短指纹（16 位 sha256 前缀）——供 diff 判「有无新条目」，不可逆、无原文。 */
function fp(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/** 抽**主内容**里的 <a href>（先去 nav/header/footer/aside，避免全局导航/页脚的产品/新闻链接每页都命中）
 *  → 解析为绝对 URL（相对用 baseUrl）→ **同站**（同被监控公司主机/其子域）→ 归一路径（去 query/hash）→ 命中 re 的去重。 */
function normalizedPaths(html: string, baseUrl: string | undefined, re: RegExp): string[] {
  const baseHost = bareHost(baseUrl); // 被监控页所在主机（去 www）——就是该公司域，无需近似「可注册域」
  const out = new Set<string>();
  const hrefRe = /<a\b[^>]*\bhref=["']([^"'#]+)["']/gi;
  html = stripBoilerplateSections(html);
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html))) {
    let u: URL;
    try {
      u = baseUrl ? new URL(m[1], baseUrl) : new URL(m[1]);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    // 同站判定：链接主机 == 监控主机 或 其子域。**不**用 slice(-2) 近似可注册域——那对多段公共后缀
    // （.co.uk / .com.cn / .co.jp…出海主战场）会退化成公共后缀本身，导致外链 fail-open 误入。
    if (baseHost && !isSameSite(u.hostname, baseHost)) continue;
    let path = u.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      /* keep encoded */
    }
    if (re.test(path)) out.add(path.replace(/\/+$/, '') || '/');
  }
  return [...out].sort();
}

/** URL 主机名（小写、去前导 www）。 */
function bareHost(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/** 链接主机是否与被监控主机同站（相等或为其子域）。以监控页主机为基准，无需公共后缀表。 */
function isSameSite(linkHost: string, baseHost: string): boolean {
  const l = linkHost.toLowerCase().replace(/^www\./, '');
  return l === baseHost || l.endsWith(`.${baseHost}`);
}

/**
 * 从渲染后 HTML 抽一个页面的意图信号。baseUrl 用于把相对链接解析成绝对 URL（产品/新闻链接抽取）。
 * kind 缺省不影响抽取（各信号独立探测）。真实站多不发 Product/Article JSON-LD → 产品/新闻主要靠链接。
 */
export function extractPageSignals(html: string, kind: PageKind = 'generic', baseUrl?: string): PageSignals {
  const jsonld = extractJsonLd(html);
  const out: PageSignals = { kind };

  if (jsonld.jobPostings.length) {
    const titles = [...new Set(jsonld.jobPostings.map((j) => j.title.trim()).filter(Boolean))].slice(0, 20);
    out.hiring = { open_roles: jsonld.jobPostings.length, titles, has_buying_role: titles.some(isBuyingRole) };
  }
  if (jsonld.products.length) out.products = jsonld.products.slice(0, 20);

  const productLinks = extractProductLinks(html, baseUrl);
  if (productLinks.length) out.product_links = productLinks;

  const sourcingTerms = extractSourcingTerms(html);
  if (sourcingTerms.length) out.sourcing = { terms: sourcingTerms };

  const news = extractNewsFingerprints(html, baseUrl);
  if (news.length) out.news = { items: news };

  const digest = textDigest(html);
  if (digest) out.textDigest = digest;
  return out;
}

/** 只覆盖**信号字段**的稳定指纹（非原始 HTML）→ cosmetic HTML 变动不改变它，避免误触发。 */
export function signalHash(s: PageSignals): string {
  const material = stableStringify({
    hiring: s.hiring ? { open_roles: s.hiring.open_roles, titles: s.hiring.titles, has_buying_role: s.hiring.has_buying_role } : null,
    products: s.products ?? null,
    product_links: s.product_links ?? null,
    sourcing: s.sourcing?.terms ?? null,
    news: s.news?.items ?? null,
    textDigest: s.textDigest ?? null,
  });
  return createHash('sha256').update(material).digest('hex');
}

// ─────────────────────── diff → intent 增量 ───────────────────────

/**
 * 前后信号快照 diff → intent 增量列表（每条一条 source_entity_change）。
 * 结构化增量（招聘/上新/开放招募/新闻）各自成条；无结构化增量但正文指纹变 → 单条 PAGE_CHANGED（弱）。
 * 返回空数组 = 无实质变化（不发事件）。
 */
export function diffPageSignals(prev: PageSignals, next: PageSignals): IntentDelta[] {
  const deltas: IntentDelta[] = [];

  // 供应商招募：出现新的招募/询价词 = 最强买家意图
  const prevTerms = new Set(prev.sourcing?.terms ?? []);
  const newTerms = (next.sourcing?.terms ?? []).filter((t) => !prevTerms.has(t));
  if (newTerms.length) deltas.push(mk('SOURCING_OPENED', { opened_terms: newTerms, all_terms: next.sourcing?.terms ?? [] }));

  // 招聘：开放岗位数变化（含采购/供应链岗则强化）
  const prevRoles = prev.hiring?.open_roles ?? 0;
  const nextRoles = next.hiring?.open_roles ?? 0;
  if (nextRoles > prevRoles) {
    const newTitles = (next.hiring?.titles ?? []).filter((t) => !(prev.hiring?.titles ?? []).includes(t));
    const buyingRole = newTitles.some(isBuyingRole) || (!prev.hiring?.has_buying_role && !!next.hiring?.has_buying_role);
    deltas.push(mk('HIRING_UP', { from: prevRoles, to: nextRoles, new_titles: newTitles.slice(0, 12), has_buying_role: buyingRole }, buyingRole ? 0.9 : undefined));
  } else if (nextRoles < prevRoles && prevRoles > 0) {
    deltas.push(mk('HIRING_DOWN', { from: prevRoles, to: nextRoles }));
  }

  // 上新产品：新 JSON-LD 产品名 或 新产品详情链接（真实站多只有后者）
  const prevProds = new Set(prev.products ?? []);
  const newProds = (next.products ?? []).filter((p) => !prevProds.has(p));
  const prevLinks = new Set(prev.product_links ?? []);
  const newLinks = (next.product_links ?? []).filter((p) => !prevLinks.has(p));
  if (newProds.length || newLinks.length) {
    deltas.push(
      mk('NEW_PRODUCTS', prune({
        new_products: newProds.length ? newProds.slice(0, 12) : undefined,
        new_product_links: newLinks.length ? newLinks.slice(0, 12) : undefined,
        added: newProds.length + newLinks.length,
      })),
    );
  }

  // 新新闻条目：只报**数量**（条目为指纹哈希，不落标题原文 → 无个人数据风险）
  const prevNews = new Set(prev.news?.items ?? []);
  const newNews = (next.news?.items ?? []).filter((n) => !prevNews.has(n));
  if (newNews.length) deltas.push(mk('NEWS_POSTED', { new_count: newNews.length }));

  // 无结构化增量但正文实质变化 → 弱 PAGE_CHANGED（textDigest 已归一，抑制 cosmetic 抖动）
  if (!deltas.length && next.textDigest && prev.textDigest && next.textDigest !== prev.textDigest) {
    deltas.push(mk('PAGE_CHANGED', { kind: next.kind }));
  }
  return deltas;
}

function mk(changeType: IntentChangeType, evidence: Record<string, unknown>, strength?: number): IntentDelta {
  return { changeType, strength: strength ?? STRENGTH[changeType], evidence };
}

// ─────────────────────── 正文归一（textDigest） ───────────────────────

/**
 * 归一可见正文 → 稳定指纹。剥离 script/style/svg/noscript/注释与标签，抽纯文本，
 * 抹掉高频波动片段（年份/时间/长数字/十六进制 nonce/货币数额），折叠空白、小写。
 * 目的：真正的内容改动才改变指纹；时间戳/CSRF token/购物车计数/轮播「相关产品」等抖动不改变它。
 */
export function textDigest(html: string): string | undefined {
  const text = visibleText(html);
  const normalized = text
    .replace(/\b\d{4}-\d{2}-\d{2}([t\s]\d{2}:\d{2}(:\d{2})?)?\b/g, ' ') // ISO 日期/时间
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ') // 时钟
    .replace(/\b(19|20)\d{2}\b/g, ' ') // 年份（版权年/发布年）
    // 相对时间（新闻/博客/招聘 teaser 列表里，「2 days ago」→「3 days ago」每天变 → 否则天天误报 PAGE_CHANGED）
    .replace(/\b\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?|sec|mins?|hrs?)\s+ago\b/gi, ' ')
    .replace(/\ban?\s+(second|minute|hour|day|week|month|year)\s+ago\b/gi, ' ')
    .replace(/\b\d+\s*[smhdw]\s+ago\b/gi, ' ') // 短写 5m ago / 2h ago / 3d ago
    .replace(/\b(just\s+now|yesterday|today|vor\s+\d+\s+\w+|前\d+\s*(天|小时|分钟))\b/gi, ' ')
    .replace(/\b[0-9a-f]{16,}\b/g, ' ') // 长十六进制（nonce/hash/token）
    .replace(/[€$£¥]\s?\d[\d.,]*/g, ' ') // 货币数额
    .replace(/\b\d[\d.,]{3,}\b/g, ' ') // 其它长数字串
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length < 40) return undefined; // 内容太少 → 不作为信号（避免空壳页误报）
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * 去**样板区块**：script/style/svg/noscript/head/template + **nav/header/footer/aside**，保留其余 HTML（含标签/href）。
 * 持久化导航/页脚里的「Become a supplier」链接、产品/新闻菜单、cookie 横幅、轮播促销不应喂信号检测——
 * 否则页脚措辞微调误触发 PAGE_CHANGED、全局导航里的产品链接每页都命中。
 * 注：只能去语义元素（<nav>/<footer>…）；`<div class="footer">` 这类无法用正则稳妥剥离，是已知局限。
 */
export function stripBoilerplateSections(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|svg|noscript|head|template|nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ');
}

/** 从 HTML 抽**主内容**可见文本：去样板区块 → 去标签 → 解常见实体 → 小写折叠空白。 */
export function visibleText(html: string): string {
  return stripBoilerplateSections(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&(lt|gt|quot|#39|apos);/gi, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

// ─────────────────────── helpers ───────────────────────

function flattenJsonLd(parsed: unknown): Record<string, unknown>[] {
  const graph =
    Array.isArray(parsed) ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>)['@graph'])
      ? ((parsed as Record<string, unknown>)['@graph'] as unknown[])
      : [parsed];
  return graph.filter((n): n is Record<string, unknown> => !!n && typeof n === 'object');
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function prune(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
}

function stableStringify(o: unknown): string {
  if (Array.isArray(o)) return `[${o.map(stableStringify).join(',')}]`;
  if (o && typeof o === 'object') {
    const keys = Object.keys(o as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${k}:${stableStringify((o as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(o ?? null);
}
