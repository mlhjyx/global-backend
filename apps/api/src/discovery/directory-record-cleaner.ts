/**
 * 名录抽取结果数据清洗与跨名录去重模块（directory → raw_source_record → canonical_company）。
 *
 * 纯函数无 IO：
 *  1. 公司名规范化（去列表编号前缀、会员等级/赞助商/CTA 后缀标签、排版与尾标点规范化）；
 *  2. 剔除协会自身、赞助商、导航栏/页脚/按钮及基础设施噪声条目；
 *  3. 官网域名规范化（剥离 tracking 参数与无效路径，拦截非 HTTP 协议/IP/社媒/CDN/来源站自身域名）；
 *  4. 按抽取位置或名录所属国回填缺失 ISO2 国别（泛欧名录不猜国）；
 *  5. 跨名录同域名 / 同规范公司名去重（有域名记录优先升级并补齐缺失国别，保持 lineage 归属一致）。
 */
import {
  associationDirectoryCountryIso,
  findAssociationDirectoryByDomain,
} from './association-directory-catalog';
import { normalizeCompanyNameTypography } from './company-name-format';
import { normalizeCountryValue } from './company-normalization';
import { normalizeCompanyName, normalizeDomain } from './identity';
import type { ProviderCompanyRecord } from './provider-contract';

/** 名录里绝非目标公司官网的社媒/电商/建站/CDN/分析噪声域。 */
export const DIRECTORY_WEBSITE_NOISE_DOMAINS: readonly string[] = Object.freeze([
  'wikipedia.org', 'youtube.com', 'youtu.be', 'facebook.com', 'fb.com',
  'linkedin.com', 'instagram.com', 'x.com', 'twitter.com', 'xing.com',
  'tiktok.com', 'bsky.app', 'threads.net', 'pinterest.com', 'vimeo.com',
  'amazon.com', 'ebay.com', 'alibaba.com', 'aliexpress.com', 'made-in-china.com',
  'globalsources.com', 'indiamart.com', 'yelp.com', 'trustpilot.com',
  'indeed.com', 'stepstone.de', 'google.com', 'goo.gl', 'gstatic.com',
  'googleapis.com', 'googletagmanager.com', 'google-analytics.com',
  'wordpress.org', 'wordpress.com', 'wp.me', 'wp.com', 'elementor.com',
  'w3.org', 'gmpg.org', 'browsehappy.com', 'gravatar.com', 'cloudflare.com',
  'cookiebot.com', 'cookiedatabase.org', 'iubenda.com', 'typekit.net',
  'fontawesome.com', 'bootstrapcdn.com', 'jsdelivr.net', 'cdnjs.cloudflare.com',
  'unpkg.com', 'cleantalk.org', 'hubspot.com', 'wixstatic.com',
  'squarespace.com', 'squarespace-cdn.com', 'sharepoint.com', 'paypal.com',
  'wa.me', 't.me', 'zoom.us', 'mailchimp.com', 'typeform.com',
]);

/** 常见外链追踪参数前缀/键名（解析 URL 时剥离）。 */
const TRACKING_QUERY_RE =
  /^(?:utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|yclid|mc_cid|mc_eid|ref|ref_src|referrer|source|trk|tracking|_ga|_gl|hsCtaTracking|hsmi|_hsenc|_hsmi|__hsfp|__hssc|__hstc)$/iu;

/** 明显非公司官网主页/介绍页的无效资源或跳转路径。 */
const INVALID_WEBSITE_PATH_RE =
  /(?:\.(?:pdf|png|jpe?g|gif|svg|webp|ico|css|js|zip|docx?|xlsx?|pptx?)$|\/(?:wp-admin|wp-login\.php|wp-content\/uploads|intent\/tweet|sharer(?:\.php)?|share\.php|404)(?:\/|$))/iu;

const VALID_PUBLIC_DOMAIN_RE =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/u;

/** 列表编号或项目符号前缀（如 "1. ", "12) ", "• ", "- ", "#12 - "）。 */
const LIST_ITEM_PREFIX_RE = /^(?:(?:#?\d{1,4}\s*[.)\-–—:]\s+)|(?:[•·▪▫▸►‣⁃\-*+]+\s+))/u;

/** 括号或分隔符包裹的会员等级/赞助商/按钮尾注（仅剥离明确标签，不误伤正常公司名）。 */
const MEMBER_BADGE_SUFFIX_RE =
  /(?:\s*[\[(]\s*(?:(?:gold|silver|bronze|platinum|diamond|executive|premium|standard|essential|small business|corporate|founding|associate|full|ordinary|honorary|startup|start-up)\s+)?(?:member|partner|sponsor|supporter|exhibitor|verified|certified)\s*[\])]|\s*[-–—|]\s*(?:visit\s+website|view\s+profile|read\s+more|learn\s+more|more\s+info|website|(?:gold|silver|bronze|platinum|diamond|principal|media|event)\s+(?:sponsor|partner|supporter)|(?:executive|premium|standard|essential|small business|corporate|founding)\s+member))\s*$/iu;

/** 导航栏/页脚/赞助商/CTA 精确短语（规范化为小写单空格后匹配）。 */
const NOISE_EXACT_NAMES: ReadonlySet<string> = new Set([
  'home', 'homepage', 'start', 'startseite', 'ana sayfa', 'inicio', 'início',
  'about', 'about us', 'over ons', 'über uns', 'ueber uns', 'quem somos', 'hakkımızda',
  'contact', 'contact us', 'kontakt', 'iletisim', 'iletişim', 'contato', 'contatti',
  'members', 'our members', 'all members', 'current members', 'member directory',
  'members directory', 'business member directory', 'industry directory', 'directory',
  'mitglieder', 'unsere mitglieder', 'mitgliedersuche', 'mitgliederbereich', 'mitglied werden',
  'leden', 'alle leden', 'onze leden', 'lid worden', 'deelnemers',
  'associados', 'nossos associados', 'associadas', 'associe-se', 'portal do associado',
  'üyeler', 'üyelerimiz', 'kurumsal üyeler', 'küme üyelerimiz', 'üyelik', 'üye girişi',
  'sponsors', 'our sponsors', 'partners', 'our partners', 'media partners', 'supporters',
  'gold sponsor', 'silver sponsor', 'bronze sponsor', 'platinum sponsor', 'diamond sponsor',
  'platinum partner', 'gold partner', 'media partner', 'strategic partner', 'event sponsor',
  'become a member', 'join us', 'join today', 'apply now', 'membership', 'membership benefits',
  'member login', 'login', 'log in', 'sign in', 'register', 'my account', 'member area',
  'privacy', 'privacy policy', 'cookie policy', 'cookies', 'terms', 'terms of use',
  'terms and conditions', 'legal', 'legal notice', 'disclaimer', 'impressum', 'datenschutz',
  'visit website', 'website', 'visitar site', 'read more', 'learn more', 'view more',
  'view profile', 'more info', 'show all', 'filter', 'search', 'reset', 'clear',
  'next', 'next page', 'previous', 'previous page', 'back to top', 'skip to content',
  'skip to main content', 'download pdf', 'pdf download', 'news', 'events', 'blog',
  'careers', 'jobs', 'press', 'board of directors', 'working groups', 'committees',
  'facebook', 'linkedin', 'twitter', 'instagram', 'youtube', 'xing', 'tiktok', 'whatsapp',
]);

/** 赞助商/导航/CTA 整条模式（仅当整条名称都是这类标签时剔除，避免误伤真公司名）。 */
const NOISE_NAME_PATTERN_RE =
  /^(?:(?:gold|silver|bronze|platinum|diamond|principal|founding|strategic|official|media|event|premium|corporate)\s+(?:sponsors?|partners?|supporters?|patrons?|members?)|(?:become|join)\s+(?:a\s+)?member|visit\s+(?:our\s+)?website|click\s+here|page\s+\d+(?:\s+of\s+\d+)?|showing\s+\d+|filter\s+by\b|sort\s+by\b|search\s+for\b|skip\s+to\b|all\s+rights\s+reserved|copyright\s+©?)/iu;

const MAX_CLEAN_NAME_BYTES = 160;
const MAX_CLEAN_NAME_WORDS = 16;

function isNoiseHost(host: string): boolean {
  return DIRECTORY_WEBSITE_NOISE_DOMAINS.some(
    (noise) => host === noise || host.endsWith(`.${noise}`),
  );
}

function isSourceHost(host: string, sourceDirectoryDomain?: string): boolean {
  const source = normalizeDomain(sourceDirectoryDomain);
  if (!source) return false;
  if (host === source || host.endsWith(`.${source}`)) return true;
  const entry = findAssociationDirectoryByDomain(source);
  if (!entry) return false;
  const ownDomains = [entry.domain, ...(entry.selfRelatedDomains ?? [])];
  return ownDomains.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * 规范化名录抽取的公司名：
 *  - 剥离列表编号前缀、会员等级/赞助商/CTA 尾注；
 *  - 套用全局排版归一（去 ™/®/引号、折叠破折号与空白、NFKC）；
 *  - 清理尾随孤立标点（`,`、`;`、`|`、`-`）；
 *  - 过短（<2 字符）、纯数字/符号或超界返回 null。
 */
export function cleanDirectoryCompanyName(raw?: string | null): string | null {
  if (typeof raw !== 'string') return null;
  let cleaned = raw.trim();
  if (!cleaned) return null;
  cleaned = cleaned
    .replace(LIST_ITEM_PREFIX_RE, '')
    .replace(/[-–—|:;,\s]+$/u, '')
    .trim();
  // 连续剥离多层尾部徽章（如 "Acme Solar (Gold Member) | Visit Website"）
  for (let pass = 0; pass < 3; pass += 1) {
    const next = cleaned
      .replace(MEMBER_BADGE_SUFFIX_RE, '')
      .replace(/[-–—|:;,\s]+$/u, '')
      .trim();
    if (next === cleaned) break;
    cleaned = next;
  }
  cleaned = normalizeCompanyNameTypography(cleaned)
    .replace(/^[-–—|:;,.\s]+/u, '')
    .replace(/[-–—|:;,\s]+$/u, '')
    .trim();
  if (cleaned.length < 2) return null;
  if (!/\p{L}/u.test(cleaned)) return null;
  if (
    Buffer.byteLength(cleaned, 'utf8') > MAX_CLEAN_NAME_BYTES ||
    cleaned.split(/\s+/u).length > MAX_CLEAN_NAME_WORDS
  ) {
    return null;
  }
  return cleaned;
}

/**
 * 规范化名录抽取的公司官网域名：
 *  - 拒绝非 http(s) 协议（mailto:/tel:/javascript:/data:/file:）、带认证信息、IP/localhost；
 *  - 剥离 tracking query（utm_* / fbclid / gclid / ref 等）与锚点；
 *  - 拦截明显无效资源路径（.pdf/.png/wp-admin/sharer 等）；
 *  - 拦截社媒/CDN/建站噪声域及名录来源协会自身域名；
 *  - 返回小写、无 www.、无尾点的规范主域名。
 */
export function normalizeDirectoryWebsiteDomain(
  rawWebsite?: string | null,
  sourceDirectoryDomain?: string,
): string | null {
  if (typeof rawWebsite !== 'string') return null;
  const trimmed = rawWebsite.trim().replace(/^[<("'\s]+|[>)"'\s]+$/gu, '');
  if (!trimmed) return null;
  if (/^(?:mailto|tel|javascript|data|ftp|file|sms|whatsapp):/iu.test(trimmed)) {
    return null;
  }
  const withScheme = /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    return null;
  }
  // 剥离 tracking 参数与 hash，便于统一检查剩余路径合法性
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_QUERY_RE.test(key)) parsed.searchParams.delete(key);
  }
  parsed.hash = '';
  if (INVALID_WEBSITE_PATH_RE.test(parsed.pathname)) {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./u, '').replace(/\.+$/u, '');
  if (!VALID_PUBLIC_DOMAIN_RE.test(host)) return null;
  if (isNoiseHost(host) || isSourceHost(host, sourceDirectoryDomain)) return null;
  return host;
}

/**
 * 判定名录抽取条目是否为协会自身、赞助商或导航栏/页脚/按钮噪声。
 */
export function isDirectoryNoiseEntry(input: {
  name: string;
  domain?: string | null;
  sourceDirectoryDomain: string;
}): boolean {
  const cleanedName = cleanDirectoryCompanyName(input.name);
  if (!cleanedName) return true;

  const lower = cleanedName.toLowerCase().replace(/\s+/gu, ' ').trim();
  if (NOISE_EXACT_NAMES.has(lower) || NOISE_NAME_PATTERN_RE.test(lower)) {
    return true;
  }

  const normalizedDomain = normalizeDomain(input.domain);
  if (normalizedDomain && (isNoiseHost(normalizedDomain) || isSourceHost(normalizedDomain, input.sourceDirectoryDomain))) {
    return true;
  }

  // 协会自身识别：对比名录登记表中的协会名与全部别名
  const entry = findAssociationDirectoryByDomain(input.sourceDirectoryDomain);
  if (entry) {
    const candidateKey = normalizeCompanyName(cleanedName);
    const selfNames = [entry.name, ...entry.aliases];
    for (const selfName of selfNames) {
      if (lower === selfName.toLowerCase()) return true;
      const selfKey = normalizeCompanyName(selfName);
      if (selfKey && candidateKey === selfKey) return true;
    }
  }
  return false;
}

/**
 * 解析名录公司国别（ISO 3166-1 alpha-2 大写）：
 *  1. 优先从公司抽取的 location 字段解析（整串或末尾段，如 "Munich, Germany" → "DE"）；
 *  2. 缺失或仅含城市时，按名录所属国回填（仅限单国协会名录，泛欧 EU 返回 undefined）。
 */
export function resolveDirectoryCompanyCountry(input: {
  location?: string | null;
  pageUrl?: string | null;
  sourceDirectoryDomain?: string | null;
}): string | undefined {
  if (typeof input.location === 'string' && input.location.trim()) {
    const direct = normalizeCountryValue(input.location);
    if (direct) return direct;
    const segments = input.location
      .split(/[,/|()–—-]+/u)
      .map((part) => part.trim())
      .filter(Boolean)
      .reverse();
    for (const segment of segments) {
      const iso = normalizeCountryValue(segment);
      if (iso) return iso;
    }
  }
  return (
    associationDirectoryCountryIso(input.pageUrl) ??
    associationDirectoryCountryIso(input.sourceDirectoryDomain)
  );
}

export interface DedupeDirectoryRecordItem<C = unknown> {
  readonly record: ProviderCompanyRecord;
  readonly collector: C;
}

function normalizedNameDedupeKey(name: string): string {
  return normalizeCompanyName(name) || name.toLowerCase().trim();
}

function countriesCompatible(left?: string, right?: string): boolean {
  if (!left || !right) return true;
  return left.toUpperCase() === right.toUpperCase();
}

function mergeRecordBackfill(
  primary: ProviderCompanyRecord,
  secondary: ProviderCompanyRecord,
): ProviderCompanyRecord {
  const country = primary.country ?? secondary.country;
  if (country === primary.country) return primary;
  return { ...primary, country };
}

/**
 * 跨名录同域名 / 同公司名去重：
 *  - 同规范域名直接归并（后到记录若补齐缺失 country 则回填到保留记录）；
 *  - 同规范公司名（去多国法律后缀）且国别兼容（同国或一方缺国）归并：
 *    - 若已有记录无域名而新记录有域名，升级为新记录（连同其 collector 一起替换，确保 lineage 与 provenance 一致）；
 *    - 否则保留先到记录并补齐缺失国别。
 */
export function dedupeDirectoryRecords<C>(
  items: readonly DedupeDirectoryRecordItem<C>[],
): readonly DedupeDirectoryRecordItem<C>[] {
  const kept: Array<DedupeDirectoryRecordItem<C>> = [];
  const indexByDomain = new Map<string, number>();
  const indexesByName = new Map<string, number[]>();

  const findNameMatchIndex = (nameKey: string, country?: string): number | undefined => {
    const candidates = indexesByName.get(nameKey);
    if (!candidates) return undefined;
    return candidates.find((idx) => countriesCompatible(kept[idx]!.record.country, country));
  };

  for (const item of items) {
    const domain = item.record.domain?.toLowerCase();
    const nameKey = normalizedNameDedupeKey(item.record.name);
    const domainIdx = domain ? indexByDomain.get(domain) : undefined;
    const nameIdx = findNameMatchIndex(nameKey, item.record.country);
    const matchIdx = domainIdx ?? nameIdx;

    if (matchIdx === undefined) {
      const nextIdx = kept.length;
      kept.push(item);
      if (domain) indexByDomain.set(domain, nextIdx);
      const list = indexesByName.get(nameKey) ?? [];
      list.push(nextIdx);
      indexesByName.set(nameKey, list);
      continue;
    }

    const existing = kept[matchIdx]!;
    // 先到无域名、后到有域名：升级为带域名记录（连同 collector 保持血缘一致）
    if (!existing.record.domain && domain) {
      kept[matchIdx] = Object.freeze({
        record: mergeRecordBackfill(item.record, existing.record),
        collector: item.collector,
      });
      indexByDomain.set(domain, matchIdx);
      continue;
    }
    // 否则保留先到记录，仅按需补齐缺失国别
    const merged = mergeRecordBackfill(existing.record, item.record);
    if (merged !== existing.record) {
      kept[matchIdx] = Object.freeze({ record: merged, collector: existing.collector });
    }
  }
  return kept;
}
