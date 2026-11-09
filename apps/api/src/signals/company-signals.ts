import { createHash } from 'node:crypto';
import { domainToUnicode } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { normalizeDomain } from '../discovery/identity';
import { stripHtml as stripHtmlToText } from '../discovery/impressum/impressum-extract';
import { canonicalDomain } from '../registry/domain/domain-resolver';

/**
 * P1-18（2026-11-10）：社媒信号采集 —— changedetection 页面变更 + RSSHub 条目 → company_signal。
 *
 * 免费社媒信号栈（RUNBOOK §16）：changedetection.io 盯公开页面变更、RSSHub 聚合公开信息源；
 * 本模块**只做**解析 → 指纹去重 → 域名归因 → 入库的纯逻辑，**不做任何网络 I/O**——
 * 拉取在运营 CLI（apps/api/scripts/signals/ingest-signals.mts）里完成并经 net-guard 校验，
 * 因此编译进镜像的源码不引入未受治理的出网路径。不做任何平台写操作自动化；
 * 纯元数据（标题/URL/摘要），不落页面正文、不含个人数据。
 *
 * 两段式：拉取+解析在 CLI（事务外，遵循 packages/db/src/tenant.ts「网络调用必须在事务外」）；
 * `persistCollectedSource` 只做归因+落库（调用方用 withWorkspace/app_user + set_config 提供 scoped 事务）。
 *
 * 归因：条目/被监视 URL 的 hostname（canonicalDomain 归一：去 www/端口/尾点）与
 * canonical_company.domain 做精确/子域/同注册域匹配；未匹配 company_id = null 照样落库。
 * 幂等：fingerprint = sha256(provider|source_url|title|observed_at 秒)，
 * ingest_key = '<provider>:<fingerprint>'，唯一 (workspace_id, ingest_key) 上
 * createMany(skipDuplicates) 静默跳过重跑。
 *
 * RLS：落库只接受调用方已按租户 scoped 的客户端（app_user + set_config 事务；CLI 用
 * PrismaService.withWorkspace 逐源开短事务）；归因查询**同时**显式带 workspaceId 作纵深防御。
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
  /** 根元素是 RSS/Atom（false = 响应其实是错误页/JSON 等，调用方应记为源级错误）。 */
  recognized: boolean;
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

/**
 * 描述/摘要去 HTML、解实体、截断（纯元数据；不落正文）。
 * 复用 Impressum 抽取的 stripHtml（script/style/注释先剥、数字实体解码，CodeQL 加固），
 * 这里只加截断口径。
 */
export function stripHtml(raw: string, max = 500): string {
  const text = stripHtmlToText(raw).trim();
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
    // 非/坏 XML（错误页等）：不产生信号，由调用方记为源级错误（不炸整批）。
    return { items: [], dropped: 0, recognized: false };
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
    return { items, dropped, recognized: true };
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
    return { items, dropped, recognized: true };
  }

  // 非 RSS/Atom 文档（错误页、JSON…）：不产生信号；recognized=false 让调用方记源级错误。
  return { items: [], dropped: 0, recognized: false };
}

function parseEpoch(value: unknown): Date | null {
  const fromSeconds = (seconds: number): Date | null => {
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const date = new Date(seconds * 1000);
    // 超出 Date 范围（如 last_changed: 1e20）得到 Invalid Date——必须显式拦截，
    // 否则指纹会退化成 "...|NaN" 并在 createMany 时报 Invalid time value。
    return Number.isNaN(date.getTime()) ? null : date;
  };
  if (typeof value === 'number') return fromSeconds(value);
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return fromSeconds(numeric);
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
    if (!watch) continue;
    const url = typeof watch.url === 'string' ? watch.url.trim() : '';
    if (!url) {
      dropped += 1;
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
  return { items, dropped, recognized: true };
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

/**
 * 通用二级标签（co.id / com.vn / com.es / com.pe… 这些未收录的两段后缀的第二段）。
 * 未收录后缀时按「两段后缀 + 1」取三段：宁可少匹配（rank 2 退化为 null），
 * 绝不把整片 ccTLD 坍缩成同一个「注册域」而错归因。
 */
const GENERIC_SECOND_LEVEL = new Set([
  'com', 'net', 'org', 'co', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob',
  'mil', 'sch', 'ltd', 'plc', 'me', 'firm', 'asn', 'gen', 'web', 'biz',
  'info', 'nom', 'grp', 'gv', 'nic',
]);

/**
 * 多租户托管后缀：同一个「注册域」下面是互不相关的组织（acme.wordpress.com 与
 * evil.wordpress.com 毫无关系），这类 host 禁用 rank 2（同注册域兄弟子域）与 rank 3
 * （公司域比 host 更具体）匹配，只保留精确/子域（谁控制父域谁控制子域）。
 */
const MULTI_TENANT_HOSTING = new Set([
  'github.io', 'githubusercontent.com', 'gitlab.io', 'wordpress.com', 'wpcomstaging.com',
  'blogspot.com', 'substack.com', 'medium.com', 'wixsite.com', 'webflow.io',
  'netlify.app', 'vercel.app', 'pages.dev', 'workers.dev', 'herokuapp.com',
  'azurewebsites.net', 'appspot.com', 'cloudfront.net', 'myshopify.com', 'bigcartel.com',
  'tilda.ws', 'jimdo.com', 'webnode.page', 'notion.site', 'gitbook.io', 'readthedocs.io',
  'carrd.co', 'godaddysites.com', 'business.site', 'squarespace.com', 'weebly.com',
  'wordpress.org', 'web.app', 'firebaseapp.com',
]);

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

export function hostnameOfUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^https?:\/\//iu.test(trimmed)) return null;
  // 复用域名解析器的归一（小写、去端口/尾点/www，拒绝 IP 与无点主机）。
  return canonicalDomain(trimmed);
}

/** hostname → eTLD+1 近似（'shop.example.co.uk' → 'example.co.uk'）。 */
export function registrableDomain(hostname: string): string | null {
  const host = normalizeDomain(hostname);
  if (!host || !host.includes('.') || IPV4.test(host)) return null;
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  if (TWO_LEVEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join('.');
  // 未收录的两段后缀（co.id / com.vn / com.es…）：第二段是通用 SLD 词元时按三段取，
  // 避免把公共后缀本身当归一域（那会让同 ccTLD 的不同公司互相错归因）。
  if (GENERIC_SECOND_LEVEL.has(labels[labels.length - 2]!)) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
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
  // host 的形态变体（punycode 与 Unicode；空白差异在域比较里视为同一主机）。
  const hostVariants = [host];
  const unicodeHost = unicodeVariant(host);
  if (unicodeHost) hostVariants.push(unicodeHost);
  const ranked: Array<{ id: string; rank: number; labels: number }> = [];

  for (const company of companies) {
    const domain = normalizeDomain(company.domain);
    if (!domain) continue;
    let rank: number | null = null;
    for (const variant of hostVariants) {
      const variantRegistrable = registrableDomain(variant);
      // 多租户托管（wordpress.com/github.io…）：同注册域下的兄弟子域属于不同组织，不许做
      // rank 2/3 近似；只保留精确（rank 0）与父子域（rank 1）。
      const sharedApexUnsafe =
        variantRegistrable !== null && MULTI_TENANT_HOSTING.has(variantRegistrable);
      let candidate: number | null = null;
      if (domain === variant) candidate = 0;
      else if (variant.endsWith(`.${domain}`)) candidate = 1;
      else if (!sharedApexUnsafe && variantRegistrable && registrableDomain(domain) === variantRegistrable) candidate = 2;
      else if (!sharedApexUnsafe && domain.endsWith(`.${variant}`)) candidate = 3;
      if (candidate !== null && (rank === null || candidate < rank)) rank = candidate;
    }
    if (rank === null) continue;
    ranked.push({ id: company.id, rank, labels: domain.split('.').length });
  }

  ranked.sort((a, b) => a.rank - b.rank || b.labels - a.labels || a.id.localeCompare(b.id));
  return ranked[0]?.id ?? null;
}

/**
 * IDN 存储兼容：`new URL().hostname` 返回 punycode，而 canonical_company.domain 可能以
 * Unicode 原样存储（normalizeDomain 只做小写/去 www）。比较时两端都试。
 */
function unicodeVariant(value: string): string | null {
  try {
    const unicode = domainToUnicode(value);
    return unicode && unicode !== value ? unicode : null;
  } catch {
    return null;
  }
}

/** 候选域名（host、注册域、IDN Unicode 变体、www. 变体）→ SQL 预过滤；精确比较在 chooseCompanyMatch 收口。 */
function domainCandidates(hostname: string): string[] {
  const host = normalizeDomain(hostname);
  if (!host) return [];
  const candidates = new Set<string>([host]);
  const registrable = registrableDomain(host);
  if (registrable) candidates.add(registrable);
  for (const candidate of [...candidates]) {
    const unicode = unicodeVariant(candidate);
    if (unicode) candidates.add(unicode);
  }
  for (const candidate of [...candidates]) candidates.add(`www.${candidate}`);
  return [...candidates];
}

/**
 * 查公司并归因（RLS：调用方已 set_config；这里**同时**显式按 workspaceId 过滤，
 * 超管连接也不跨租户）。
 *
 * 两段查询：先按候选域精确查（rank 0/1 的来源，结果不可能被后缀命中的截断挤掉），
 * 无果再走 endsWith 后缀兜底（rank 1/2/3）。单条 OR + LIMIT 会按 id 截断，
 * 候选多时可能把精确匹配挤出窗口。
 */
export async function attributeCompany(
  store: CompanySignalStore,
  workspaceId: string,
  hostname: string,
): Promise<string | null> {
  const candidates = domainCandidates(hostname);
  if (candidates.length === 0) return null;

  const exactRows = await store.canonicalCompany.findMany({
    where: {
      workspaceId,
      domain: { not: null },
      OR: candidates.map((candidate) => ({
        domain: { equals: candidate, mode: 'insensitive' as const },
      })),
    },
    select: { id: true, domain: true },
    take: 100,
    orderBy: { id: 'asc' },
  });
  const exact = chooseCompanyMatch(hostname, exactRows);
  if (exact) return exact;

  const suffixRows = await store.canonicalCompany.findMany({
    where: {
      workspaceId,
      domain: { not: null },
      OR: candidates.map((candidate) => ({
        domain: { endsWith: `.${candidate}`, mode: 'insensitive' as const },
      })),
    },
    select: { id: true, domain: true },
    take: 100,
    orderBy: { id: 'asc' },
  });
  return chooseCompanyMatch(hostname, suffixRows);
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

// ── 归因 + 落库（本文件不做任何网络 I/O；scoped 事务由调用方提供） ──────────

/**
 * 一个已采集源（拉取/解析在 src 之外完成——运营 CLI 负责出网；本模块保持纯函数边界，
 * 因此可以被 API/Worker 编译进镜像而不引入未受治理的出网路径）。
 */
export interface CollectedSignalSource {
  /** 源标签（'rss:<route>' / 'changedetection'）。 */
  source: string;
  items: ParsedSignalItem[];
  dropped: number;
  /** 拉取/解析失败（无条目可落）。 */
  error: string | null;
}

export interface SignalSourceReport {
  source: string;
  parsed: number;
  dropped: number;
  inserted: number;
  /** 唯一约束跳过（重复信号）。 */
  skipped: number;
  /** 本批条目归因成功（companyId 非空）的条数——含被唯一约束跳过的重复，不是新增行数。 */
  matched: number;
  error: string | null;
}

export interface CompanySignalIngestSummary {
  inserted: number;
  skipped: number;
  matched: number;
  sources: SignalSourceReport[];
}

/** 汇总逐源报告（CLI 逐源短事务后聚合用）。 */
export function summarizeSignalReports(
  sources: readonly SignalSourceReport[],
): CompanySignalIngestSummary {
  return {
    inserted: sources.reduce((sum, source) => sum + source.inserted, 0),
    skipped: sources.reduce((sum, source) => sum + source.skipped, 0),
    matched: sources.reduce((sum, source) => sum + source.matched, 0),
    sources: [...sources],
  };
}

/**
 * 归因 + 落库一个已采集源。调用方必须提供按租户 scoped 的事务客户端
 * （app_user + set_config；CLI 用 PrismaService.withWorkspace 逐源开短事务），
 * 且网络拉取必须已在事务外完成（packages/db/src/tenant.ts：回调里只放 DB 操作）。
 * attributionCache 可跨源共享（同一个 host 只查一次公司）。
 */
export async function persistCollectedSource(
  store: CompanySignalStore,
  workspaceId: string,
  collected: CollectedSignalSource,
  attributionCache: Map<string, string | null> = new Map(),
): Promise<SignalSourceReport> {
  const report: SignalSourceReport = {
    source: collected.source,
    parsed: collected.items.length,
    dropped: collected.dropped,
    inserted: 0,
    skipped: 0,
    matched: 0,
    error: collected.error,
  };
  if (collected.error) return report;

  const rows: CompanySignalRow[] = [];
  for (const item of collected.items) {
    const host = hostnameOfUrl(item.sourceUrl);
    let companyId: string | null = null;
    if (host) {
      if (!attributionCache.has(host)) {
        try {
          attributionCache.set(host, await attributeCompany(store, workspaceId, host));
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

  // 写失败必须向上抛：调用方的 scoped 事务要整体回滚（吞掉会提交已插入的分块，
  // 报告与库内真实状态不一致）。CLI 在逐源 try/catch 里记录该源的失败。
  const persisted = await persistSignalRows(store, workspaceId, rows);
  report.inserted = persisted.inserted;
  report.skipped = persisted.skipped;
  return report;
}
