import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { normalizeDomain } from '../discovery/identity';

/**
 * P1-18（2026-11-10）：社媒信号采集 —— changedetection 页面变更 + RSSHub 条目 → company_signal。
 *
 * 免费社媒信号栈（RUNBOOK §16）：changedetection.io 盯公开页面变更、RSSHub 聚合公开信息源；
 * 本模块**只读**这两类信号（http 拉取 → 解析 → 指纹去重 → 域名归因 → 入库），不做任何
 * 平台写操作自动化。纯元数据（标题/URL/摘要），不落页面正文、不含个人数据。
 *
 * 归因：条目/被监视 URL 的 hostname（去 www、小写）与 canonical_company.domain 做
 * 精确/子域/同注册域匹配；未匹配 company_id = null 照样落库（不丢信号）。
 * 幂等：fingerprint = sha256(provider|source_url|title|observed_at 秒)，
 * ingest_key = '<provider>:<fingerprint>'，唯一 (workspace_id, ingest_key) 上
 * createMany(skipDuplicates) 静默跳过重跑。
 *
 * RLS：本模块只接受调用方已按租户 scoped 的 Prisma 客户端（CLI 在 set_config
 * ('app.current_workspace_id') 事务里调用）；归因查询**同时**显式带 workspaceId，
 * 使超管连接（绕过 RLS）下也不会跨租户归因。
 */

export const PROVIDER_RSS = 'rss';
export const PROVIDER_CHANGEDETECTION = 'changedetection';

export type SignalKind = 'rss_item' | 'page_change';

export interface ParsedSignalItem {
  providerKey: string;
  signalKind: SignalKind;
  sourceUrl: string;
  title: string;
  excerpt: string | null;
  observedAt: Date;
}

export interface CompanySignalRow extends ParsedSignalItem {
  companyId: string | null;
  fingerprint: string;
  ingestKey: string;
}

export interface ParsedFeed {
  items: ParsedSignalItem[];
  /** 缺 title/link 等必填字段而丢弃的条目数（宽容解析：不让一条坏条目毁整批）。 */
  dropped: number;
}

export interface SignalCompanyRecord {
  id: string;
  domain: string | null;
}

export interface CompanySignalCreateInput {
  workspaceId: string;
  companyId: string | null;
  providerKey: string;
  signalKind: SignalKind;
  sourceUrl: string;
  title: string;
  excerpt: string | null;
  observedAt: Date;
  fingerprint: string;
  ingestKey: string;
}

/** company-signals 需要的最小 Prisma 表面（PrismaClient / TransactionClient / 测试替身都满足）。 */
export interface CompanySignalStore {
  canonicalCompany: {
    findMany(args: {
      where: {
        workspaceId: string;
        domain: { not: null };
        OR: Array<
          | { domain: { equals: string; mode: 'insensitive' } }
          | { domain: { endsWith: string; mode: 'insensitive' } }
        >;
      };
      select: { id: true; domain: true };
      take?: number;
      orderBy?: { id: 'asc' };
    }): Promise<SignalCompanyRecord[]>;
  };
  companySignal: {
    createMany(args: {
      data: CompanySignalCreateInput[];
      skipDuplicates: boolean;
    }): Promise<{ count: number }>;
  };
}

/** 与 Node 全局 fetch 兼容的最小签名（测试注入 fake，不触网）。 */
export type SignalFetch = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

// ── XML 解析（RSS2 / Atom） ────────────────────────────────────────────────
// ignoreAttributes=true 的默认配置会丢掉 Atom <link href> —— 显式关掉属性忽略。
// parseTagValue=false：标题/日期保持字符串（"2026" 不被解析成数字）。
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/** 取元素文本：字符串 | 数字 | { '#text': ... }（带属性/子元素时 fast-xml-parser 的形态）。 */
function textOf(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === 'string') return node.trim() || null;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  const record = asRecord(node);
  if (record) {
    const text = record['#text'];
    if (typeof text === 'string') return text.trim() || null;
    if (typeof text === 'number') return String(text);
  }
  return null;
}

/** Atom <link href="..."/>（优先 rel=alternate；RSS 的 <link> 是纯文本，走 textOf）。 */
function atomHref(node: unknown): string | null {
  const links = asArray(node)
    .map(asRecord)
    .filter((link): link is Record<string, unknown> => link !== null);
  const picked =
    links.find((link) => link['@_rel'] === 'alternate' || link['@_rel'] == null) ?? links[0];
  const href = picked?.['@_href'];
  return typeof href === 'string' && href.trim() ? href.trim() : null;
}

function parseDateValue(raw: string | null): Date | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** 无日期条目的稳定兜底：epoch 0（去重稳定、查询排序沉底，绝不随时间漂移）。 */
const UNDATED = new Date(0);

const HTML_TAG = /<[^>]*>/gu;
const WHITESPACE = /\s+/gu;

/** 描述/摘要去 HTML、解常见实体、截断（纯元数据；不落正文）。 */
export function stripHtml(raw: string, max = 500): string {
  const text = raw
    .replace(HTML_TAG, ' ')
    .replace(/&nbsp;|&#160;/giu, ' ')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#0*39;/gu, "'")
    .replace(/&amp;/giu, '&')
    .replace(WHITESPACE, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function excerptOf(node: Record<string, unknown>): string | null {
  const raw =
    textOf(node.description) ??
    textOf(node.summary) ??
    textOf(node['content:encoded']) ??
    textOf(node.content);
  if (!raw) return null;
  const text = stripHtml(raw);
  return text || null;
}

export function parseRssFeed(xml: string): ParsedFeed {
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch {
    // 非/坏 XML（错误页等）：不产生信号，由调用方按 parsed=0 观察，不炸整批。
    return { items: [], dropped: 0 };
  }
  const doc = asRecord(parsed);
  const rss = asRecord(doc?.rss);
  const atom = asRecord(doc?.feed);
  const items: ParsedSignalItem[] = [];
  let dropped = 0;

  if (rss) {
    const channel = asRecord(rss.channel);
    for (const node of asArray(channel?.item)) {
      const item = asRecord(node);
      const title = item ? textOf(item.title) : null;
      const link = item ? textOf(item.link) : null;
      if (!item || !title || !link) {
        dropped += 1;
        continue;
      }
      items.push({
        providerKey: PROVIDER_RSS,
        signalKind: 'rss_item',
        sourceUrl: link,
        title: stripHtml(title, 300),
        excerpt: excerptOf(item),
        observedAt:
          parseDateValue(textOf(item.pubDate) ?? textOf(item['dc:date']) ?? textOf(item.date)) ??
          UNDATED,
      });
    }
    return { items, dropped };
  }

  if (atom) {
    for (const node of asArray(atom.entry)) {
      const entry = asRecord(node);
      const title = entry ? textOf(entry.title) : null;
      const link = entry ? atomHref(entry.link) : null;
      if (!entry || !title || !link) {
        dropped += 1;
        continue;
      }
      items.push({
        providerKey: PROVIDER_RSS,
        signalKind: 'rss_item',
        sourceUrl: link,
        title: stripHtml(title, 300),
        excerpt: excerptOf(entry),
        observedAt:
          parseDateValue(textOf(entry.updated) ?? textOf(entry.published)) ?? UNDATED,
      });
    }
    return { items, dropped };
  }

  // 非 RSS/Atom 文档（错误页、JSON…）：不产生信号，也不算坏条目——由调用方看 parsed=0。
  return { items: [], dropped: 0 };
}

function parseEpoch(value: unknown): Date | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? new Date(value * 1000) : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 0 ? new Date(numeric * 1000) : null;
    return parseDateValue(value);
  }
  return null;
}

/**
 * changedetection `GET /api/v1/watch` 响应 → 信号。
 * 兼容两种形态：对象按 uuid 键（0.50.x 实测）与数组；`last_changed` 为 epoch 秒。
 * last_changed 缺失/<=0 = 从未变更，不是信号（静默跳过）；缺 url 的畸形成员计入 dropped。
 */
export function parseChangedetectionWatches(payload: unknown): ParsedFeed {
  const records: unknown[] = [];
  if (Array.isArray(payload)) {
    records.push(...payload);
  } else {
    const obj = asRecord(payload);
    if (obj) {
      const wrapped = obj.watches;
      if (Array.isArray(wrapped)) records.push(...wrapped);
      else records.push(...Object.values(obj));
    }
  }

  const items: ParsedSignalItem[] = [];
  let dropped = 0;
  for (const record of records) {
    const watch = asRecord(record);
    const url = watch && typeof watch.url === 'string' ? watch.url.trim() : '';
    if (!url) {
      if (watch) dropped += 1;
      continue;
    }
    const observedAt = parseEpoch(watch.last_changed);
    if (!observedAt) continue;
    const title = stripHtml(textOf(watch.title) ?? url, 300);
    items.push({
      providerKey: PROVIDER_CHANGEDETECTION,
      signalKind: 'page_change',
      sourceUrl: url,
      title,
      excerpt: null,
      observedAt,
    });
  }
  return { items, dropped };
}

// ── 指纹 / 归因 ─────────────────────────────────────────────────────────────

function epochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** sha256(provider|sourceUrl|title|observedAt 秒) —— 同一条目重拉必得同一指纹。 */
export function signalFingerprint(
  providerKey: string,
  sourceUrl: string,
  title: string,
  observedAt: Date,
): string {
  return createHash('sha256')
    .update(`${providerKey}|${sourceUrl}|${title}|${epochSeconds(observedAt)}`)
    .digest('hex');
}

export function ingestKeyFor(providerKey: string, fingerprint: string): string {
  return `${providerKey}:${fingerprint}`;
}

/** 公开后缀近似清单（非完整 PSL）：只影响 eTLD+1 取几段，匹配失败仍可走精确/后缀。 */
const TWO_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'net.uk', 'ltd.uk', 'plc.uk', 'me.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au',
  'co.nz', 'org.nz', 'net.nz', 'govt.nz', 'ac.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'com.hk', 'org.hk', 'net.hk', 'edu.hk', 'gov.hk',
  'com.sg', 'org.sg', 'net.sg', 'edu.sg', 'gov.sg',
  'com.tw', 'org.tw', 'net.tw', 'edu.tw', 'gov.tw',
  'com.my', 'org.my', 'net.my', 'gov.my', 'edu.my',
  'co.in', 'net.in', 'org.in', 'firm.in', 'gov.in',
  'com.mx', 'org.mx', 'gob.mx',
  'com.ar', 'net.ar', 'org.ar',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr',
  'com.pt', 'edu.pt', 'org.pt',
  'com.gr', 'com.ru', 'net.ru', 'org.ru',
  'co.za', 'org.za', 'net.za', 'gov.za',
  'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il',
  'co.ke', 'com.ng', 'org.ng', 'com.ua', 'net.ua', 'org.ua',
  'com.pl', 'net.pl', 'org.pl', 'gov.pl', 'edu.pl',
  'co.at', 'or.at', 'gv.at', 'ac.at',
]);

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

export function hostnameOfUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return normalizeDomain(url.hostname);
  } catch {
    return null;
  }
}

/** hostname → eTLD+1 近似（'shop.example.co.uk' → 'example.co.uk'）。 */
export function registrableDomain(hostname: string): string | null {
  const host = normalizeDomain(hostname);
  if (!host || !host.includes('.') || IPV4.test(host)) return null;
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return TWO_LEVEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

/**
 * 纯函数归因：在候选公司里挑一个最具体的匹配。
 * rank 0 精确（host === 公司域）> 1 信号 host 是公司域子域（news.example.de ↔ example.de）
 * > 2 同注册域（shop.example.de ↔ www.example.de）> 3 公司域比信号 host 更具体（兜底）。
 * 同级按域名段数降序、id 升序，保证确定性。
 */
export function chooseCompanyMatch(
  hostname: string,
  companies: readonly SignalCompanyRecord[],
): string | null {
  const host = normalizeDomain(hostname);
  if (!host) return null;
  const hostRegistrable = registrableDomain(host);
  const ranked: Array<{ id: string; rank: number; labels: number }> = [];

  for (const company of companies) {
    const domain = normalizeDomain(company.domain);
    if (!domain) continue;
    let rank: number | null = null;
    if (domain === host) rank = 0;
    else if (host.endsWith(`.${domain}`)) rank = 1;
    else if (hostRegistrable && registrableDomain(domain) === hostRegistrable) rank = 2;
    else if (domain.endsWith(`.${host}`)) rank = 3;
    if (rank === null) continue;
    ranked.push({ id: company.id, rank, labels: domain.split('.').length });
  }

  ranked.sort((a, b) => a.rank - b.rank || b.labels - a.labels || a.id.localeCompare(b.id));
  return ranked[0]?.id ?? null;
}

/** 候选域名（host、注册域、及 www. 变体）→ SQL 预过滤条件；精确比较在 chooseCompanyMatch 收口。 */
function domainCandidates(hostname: string): string[] {
  const host = normalizeDomain(hostname);
  if (!host) return [];
  const candidates = new Set<string>([host]);
  const registrable = registrableDomain(host);
  if (registrable) candidates.add(registrable);
  for (const candidate of [...candidates]) candidates.add(`www.${candidate}`);
  return [...candidates];
}

/**
 * 查公司并归因（RLS：调用方已 set_config；这里**同时**显式按 workspaceId 过滤，
 * 超管连接也不跨租户）。候选预过滤放宽（equals / endsWith），最终由 chooseCompanyMatch 收口。
 */
export async function attributeCompany(
  store: CompanySignalStore,
  workspaceId: string,
  hostname: string,
): Promise<string | null> {
  const candidates = domainCandidates(hostname);
  if (candidates.length === 0) return null;
  const rows = await store.canonicalCompany.findMany({
    where: {
      workspaceId,
      domain: { not: null },
      OR: candidates.flatMap((candidate) => [
        { domain: { equals: candidate, mode: 'insensitive' as const } },
        { domain: { endsWith: `.${candidate}`, mode: 'insensitive' as const } },
      ]),
    },
    select: { id: true, domain: true },
    take: 100,
    orderBy: { id: 'asc' },
  });
  return chooseCompanyMatch(hostname, rows);
}

// ── 落库 ────────────────────────────────────────────────────────────────────

export function buildSignalRow(item: ParsedSignalItem, companyId: string | null): CompanySignalRow {
  const fingerprint = signalFingerprint(
    item.providerKey,
    item.sourceUrl,
    item.title,
    item.observedAt,
  );
  return {
    ...item,
    companyId,
    fingerprint,
    ingestKey: ingestKeyFor(item.providerKey, fingerprint),
  };
}

const CREATE_CHUNK = 500;

export async function persistSignalRows(
  store: CompanySignalStore,
  workspaceId: string,
  rows: readonly CompanySignalRow[],
): Promise<{ inserted: number; skipped: number }> {
  // 批内去重（同指纹一条），再交给唯一约束兜底跨批/跨跑。
  const seen = new Set<string>();
  const unique = rows.filter((row) => {
    if (seen.has(row.ingestKey)) return false;
    seen.add(row.ingestKey);
    return true;
  });
  let inserted = 0;
  for (let index = 0; index < unique.length; index += CREATE_CHUNK) {
    const data = unique.slice(index, index + CREATE_CHUNK).map((row) => ({
      workspaceId,
      companyId: row.companyId,
      providerKey: row.providerKey,
      signalKind: row.signalKind,
      sourceUrl: row.sourceUrl,
      title: row.title,
      excerpt: row.excerpt,
      observedAt: row.observedAt,
      fingerprint: row.fingerprint,
      ingestKey: row.ingestKey,
    }));
    const result = await store.companySignal.createMany({ data, skipDuplicates: true });
    inserted += result.count;
  }
  return { inserted, skipped: rows.length - inserted };
}

// ── 编排（一次拉取 → 解析 → 归因 → 落库） ─────────────────────────────────

export interface IngestCompanySignalsOptions {
  store: CompanySignalStore;
  workspaceId: string;
  /** RSSHub 路由（'github/issue/x/y'）或完整 URL；空数组 = 不拉 RSS。 */
  rssRoutes?: readonly string[];
  /** 是否拉 changedetection watches（需要 changeDetectionApiKey）。 */
  includeWatchChanges?: boolean;
  rsshubUrl?: string;
  changeDetectionUrl?: string;
  changeDetectionApiKey?: string;
  fetchImpl?: SignalFetch;
  timeoutMs?: number;
}

export interface SignalSourceReport {
  source: string;
  parsed: number;
  dropped: number;
  inserted: number;
  skipped: number;
  /** 本批归因成功（companyId 非空）的条目数（含被唯一约束跳过的重复）。 */
  matched: number;
  error: string | null;
}

export interface CompanySignalIngestSummary {
  inserted: number;
  skipped: number;
  matched: number;
  sources: SignalSourceReport[];
}

export function resolveRssUrl(routeOrUrl: string, rsshubUrl: string): string {
  const trimmed = routeOrUrl.trim();
  if (/^https?:\/\//iu.test(trimmed)) return trimmed;
  return `${rsshubUrl.replace(/\/+$/u, '')}/${trimmed.replace(/^\/+/u, '')}`;
}

export async function ingestCompanySignals(
  options: IngestCompanySignalsOptions,
): Promise<CompanySignalIngestSummary> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as SignalFetch);
  const rsshubUrl = options.rsshubUrl ?? 'http://127.0.0.1:1200';
  const changeDetectionUrl = options.changeDetectionUrl ?? 'http://127.0.0.1:5055';
  const timeoutMs = options.timeoutMs ?? 20_000;
  const attributionCache = new Map<string, string | null>();

  const reportFor = async (
    source: string,
    load: () => Promise<ParsedFeed>,
  ): Promise<SignalSourceReport> => {
    const report: SignalSourceReport = {
      source,
      parsed: 0,
      dropped: 0,
      inserted: 0,
      skipped: 0,
      matched: 0,
      error: null,
    };
    let feed: ParsedFeed;
    try {
      feed = await load();
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
      return report;
    }
    report.parsed = feed.items.length;
    report.dropped = feed.dropped;

    const rows: CompanySignalRow[] = [];
    for (const item of feed.items) {
      const host = hostnameOfUrl(item.sourceUrl);
      let companyId: string | null = null;
      if (host) {
        if (!attributionCache.has(host)) {
          try {
            attributionCache.set(
              host,
              await attributeCompany(options.store, options.workspaceId, host),
            );
          } catch (error) {
            report.error = `归因查询失败：${error instanceof Error ? error.message : String(error)}`;
            attributionCache.set(host, null);
          }
        }
        companyId = attributionCache.get(host) ?? null;
      }
      rows.push(buildSignalRow(item, companyId));
    }
    report.matched = rows.filter((row) => row.companyId !== null).length;

    try {
      const persisted = await persistSignalRows(options.store, options.workspaceId, rows);
      report.inserted = persisted.inserted;
      report.skipped = feed.dropped + persisted.skipped;
    } catch (error) {
      report.error = `写入失败：${error instanceof Error ? error.message : String(error)}`;
      report.skipped = feed.dropped + rows.length;
    }
    return report;
  };

  const sources: SignalSourceReport[] = [];
  for (const route of options.rssRoutes ?? []) {
    const url = resolveRssUrl(route, rsshubUrl);
    sources.push(
      await reportFor(`rss:${route}`, async () => {
        const response = await fetchImpl(url, {
          headers: { accept: 'application/rss+xml, application/atom+xml, application/xml' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`RSS 拉取失败 HTTP ${response.status}: ${url}`);
        return parseRssFeed(await response.text());
      }),
    );
  }

  if (options.includeWatchChanges) {
    sources.push(
      await reportFor('changedetection', async () => {
        if (!options.changeDetectionApiKey) {
          throw new Error('CHANGE_DETECTION_API_KEY 未设置（changedetection 需要 x-api-key）');
        }
        const url = `${changeDetectionUrl.replace(/\/+$/u, '')}/api/v1/watch`;
        const response = await fetchImpl(url, {
          headers: { 'x-api-key': options.changeDetectionApiKey },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`changedetection /api/v1/watch 返回 HTTP ${response.status}`);
        return parseChangedetectionWatches(JSON.parse(await response.text()));
      }),
    );
  }

  return {
    inserted: sources.reduce((sum, source) => sum + source.inserted, 0),
    skipped: sources.reduce((sum, source) => sum + source.skipped, 0),
    matched: sources.reduce((sum, source) => sum + source.matched, 0),
    sources,
  };
}
