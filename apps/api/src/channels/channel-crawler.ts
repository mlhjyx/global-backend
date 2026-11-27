/**
 * M1 配置驱动通用爬虫 v0。
 *
 * - 列表页 → itemSelector 抽条目 → itemUrlSelector 取详情 URL → detail.fields 抽字段（无详情则用列表条目）；
 * - 页面抓取经注入的 PageFetcher（生产是 Crawl4aiPageFetcher：ToolBroker + robots 强制检查）；
 * - 单域限速（默认 1 req/2s）、每轮页数上限、逐页失败计数；失败率由调用方落 source_channel_run 并驱动自动停用。
 */
import { crawlPageUrls, type ChannelCrawlConfig } from './channel-config';
import { hostAllowed } from './connector/channel-manifest';
import { selectAll, selectAllInNode, selectInNode, selectText, nodeText, type HtmlNode } from './html-select';

export interface CrawledPage {
  url: string;
  html: string;
}

export type CrawlPageFetcher = (url: string) => Promise<CrawledPage | null>;

export interface CrawlRunOptions {
  /** 本轮最多抓多少页（试跑 1 页；正式运行 ≤ CHANNEL_RUN_MAX_PAGES 且受每日配额截断）。 */
  pageCap: number;
  /** 同一轮内两次抓取之间的最小间隔（毫秒，默认 2000；测试注入 0）。 */
  perRequestDelayMs?: number;
  /** 每页最多处理的条目数（默认 50）。 */
  maxItemsPerPage?: number;
  /** 每页最多打开的详情页数（默认 20）。 */
  sleep?: (ms: number) => Promise<void>;
  /** Stored manifest hosts. Legacy channel configs have no manifest host list. */
  allowedHosts?: readonly string[];
  /** Optional generic extractor fallback (e.g. LLM list extraction) when CSS selector yields 0 items. */
  extractGenericRecords?: (page: CrawledPage) => Promise<readonly CrawledRecord[]>;
}

export interface CrawledRecord {
  name: string;
  website?: string;
  country?: string;
  industry?: string;
  products?: string[];
  keywords?: string[];
  /** PII_PENDING_ENCRYPTION：联系人字段（OWNER-DECISION-2026-11-05 延后加密与审计）。只在详情页模式下抽取。 */
  contactName?: string;
  /** PII_PENDING_ENCRYPTION */
  contactTitle?: string;
  /** PII_PENDING_ENCRYPTION */
  email?: string;
  /** PII_PENDING_ENCRYPTION */
  phone?: string;
  /** 该条目的证据页（列表条目页或详情页）。 */
  sourceUrl: string;
  externalRef?: string;
}

export interface CrawlRunResult {
  records: CrawledRecord[];
  pagesFetched: number;
  pageFailures: number;
  truncatedByCap: boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function manifestAllowsUrl(raw: string, allowedHosts: readonly string[] | undefined): boolean {
  if (!allowedHosts) return true;
  const url = URL.parse(raw);
  return Boolean(url && url.protocol === 'https:' && !url.port && !url.username && !url.password &&
    hostAllowed(url.hostname, allowedHosts));
}

function absolutize(href: string | null, base: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, base);
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeEmail(value: string | null): string | undefined {
  const text = value?.trim().toLowerCase();
  if (!text || text.length > 320) return undefined;
  // 只做最小形态过滤：含 @ 且无空白；格式强校验交给下游使用方。
  return /^[^\s@]+@[^\s@]+$/u.test(text) ? text : undefined;
}

function normalizeWebsite(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(/^[a-z]+:\/\//iu.test(value) ? value : `https://${value}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    url.protocol = 'https:';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function listValues(html: string, selector: string): string[] | undefined {
  const values = selectAll(html, selector)
    .map((node) => nodeText(node))
    .filter((text) => text.length > 0)
    .slice(0, 20);
  return values.length > 0 ? values : undefined;
}

function listValuesInNode(item: HtmlNode, selector: string): string[] | undefined {
  const values = selectAllInNode(item, selector)
    .map((node) => nodeText(node))
    .filter((text) => text.length > 0)
    .slice(0, 20);
  return values.length > 0 ? values : undefined;
}

function extractCardFields(
  item: HtmlNode,
  detailHtml: string | null,
  fields: Record<string, string>,
  recordUrl: string,
): CrawledRecord | null {
  const readText = (selector?: string): string | null => {
    if (!selector) return null;
    return detailHtml !== null ? selectText(detailHtml, selector) : selectInNode(item, selector);
  };
  const readList = (selector?: string): string[] | undefined => {
    if (!selector) return undefined;
    return detailHtml !== null ? listValues(detailHtml, selector) : listValuesInNode(item, selector);
  };
  const name = readText(fields.name) ?? (detailHtml !== null ? null : nodeText(item));
  if (!name || name.length < 2) return null;
  const website = normalizeWebsite(readText(fields.website));
  const country = readText(fields.country);
  const industry = readText(fields.industry);
  const products = readList(fields.products);
  const keywords = readList(fields.keywords);
  return {
    name: name.slice(0, 300),
    sourceUrl: recordUrl,
    ...(website ? { website } : {}),
    ...(country ? { country: country.slice(0, 100) } : {}),
    ...(industry ? { industry: industry.slice(0, 200) } : {}),
    ...(products ? { products } : {}),
    ...(keywords ? { keywords } : {}),
  };
}

async function appendGenericPageRecords(
  page: CrawledPage,
  extractGenericRecords: CrawlRunOptions['extractGenericRecords'],
  maxItems: number,
  remainingSlots: number,
  records: CrawledRecord[],
): Promise<void> {
  if (!extractGenericRecords || remainingSlots <= 0) return;
  const extracted = await extractGenericRecords(page);
  for (const raw of extracted.slice(0, Math.min(maxItems, remainingSlots))) {
    const name = raw.name?.trim();
    if (!name || name.length < 2) continue;
    // 列表页通用抽取仅保留公开公司事实，绝不透传个人联系点 PII。
    const website = normalizeWebsite(raw.website ?? null);
    records.push({
      name: name.slice(0, 300),
      sourceUrl: raw.sourceUrl || page.url,
      ...(website ? { website } : {}),
      ...(raw.country?.trim() ? { country: raw.country.trim().slice(0, 100) } : {}),
      ...(raw.industry?.trim() ? { industry: raw.industry.trim().slice(0, 200) } : {}),
      ...(raw.products?.length ? { products: raw.products.slice(0, 20) } : {}),
      ...(raw.keywords?.length ? { keywords: raw.keywords.slice(0, 20) } : {}),
    });
  }
}

export async function crawlChannel(
  config: ChannelCrawlConfig,
  fetchPage: CrawlPageFetcher,
  options: CrawlRunOptions,
): Promise<CrawlRunResult> {
  const sleep = options.sleep ?? defaultSleep;
  const delayMs = Math.max(0, options.perRequestDelayMs ?? 2_000);
  const maxItems = Math.max(1, options.maxItemsPerPage ?? 50);

  const urls = crawlPageUrls(config, options.pageCap);
  const maxRecords = maxItems * Math.max(1, urls.length);
  const records: CrawledRecord[] = [];
  let pagesFetched = 0;
  let pageFailures = 0;
  let firstFetch = true;
  const fetchOnce = async (url: string): Promise<CrawledPage | null> => {
    if (!manifestAllowsUrl(url, options.allowedHosts)) return null;
    if (!firstFetch && delayMs > 0) await sleep(delayMs);
    firstFetch = false;
    pagesFetched += 1;
    try {
      const page = await fetchPage(url);
      return page && manifestAllowsUrl(page.url, options.allowedHosts) ? page : null;
    } catch {
      pageFailures += 1;
      return null;
    }
  };

  outer: for (const listUrl of urls) {
    const page = await fetchOnce(listUrl);
    // 空页（robots 拒绝/站点空响应/翻页到底）不计失败；失败率只反映抓取异常。
    if (!page) continue;
    const items = selectAll(page.html, config.list.itemSelector).slice(0, maxItems);
    if (items.length === 0) {
      await appendGenericPageRecords(page, options.extractGenericRecords, maxItems, maxRecords - records.length, records);
      if (records.length >= maxRecords) break outer;
      if (pagesFetched >= options.pageCap) return { records, pagesFetched, pageFailures, truncatedByCap: true };
      continue;
    }

    for (const [index, item] of items.entries()) {
      // 详情页打开前检查页数预算：达到上限立即停止本轮（列表页已计入）。
      const listEvidenceUrl = options.allowedHosts ? page.url : listUrl;
      const itemHref = config.list.itemUrlSelector
        ? absolutize(selectInNode(item, config.list.itemUrlSelector), listEvidenceUrl)
        : null;
      let detailHtml: string | null = null;
      let recordUrl = listEvidenceUrl;
      void index;
      if (config.detail.enabled && itemHref && manifestAllowsUrl(itemHref, options.allowedHosts) && pagesFetched < options.pageCap) {
        const detail = await fetchOnce(itemHref);
        if (!detail) continue;
        detailHtml = detail.html;
        recordUrl = options.allowedHosts ? detail.url : itemHref;
      }
      const base = extractCardFields(item, detailHtml, config.detail.fields, recordUrl);
      if (!base) continue;
      const fields = config.detail.fields;
      const record: CrawledRecord = {
        ...base,
        // 联系人字段（PII）双保险：只从详情页 HTML 抽取——列表页回退绝不抽取联系人字段。
        ...(detailHtml && fields.contactName && selectText(detailHtml, fields.contactName)
          ? { contactName: selectText(detailHtml, fields.contactName)!.slice(0, 200) }
          : {}),
        ...(detailHtml && fields.contactTitle && selectText(detailHtml, fields.contactTitle)
          ? { contactTitle: selectText(detailHtml, fields.contactTitle)!.slice(0, 200) }
          : {}),
        ...(detailHtml && fields.email && normalizeEmail(selectText(detailHtml, fields.email))
          ? { email: normalizeEmail(selectText(detailHtml, fields.email))! }
          : {}),
        ...(detailHtml && fields.phone && selectText(detailHtml, fields.phone)
          ? { phone: selectText(detailHtml, fields.phone)!.trim().slice(0, 64) }
          : {}),
      };
      records.push(record);
      if (records.length >= maxItems * Math.max(1, urls.length)) break outer;
    }
    if (pagesFetched >= options.pageCap) return { records, pagesFetched, pageFailures, truncatedByCap: true };
  }
  return { records, pagesFetched, pageFailures, truncatedByCap: pagesFetched >= options.pageCap };
}
