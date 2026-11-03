/**
 * M1 配置驱动通用爬虫 v0。
 *
 * - 列表页 → itemSelector 抽条目 → itemUrlSelector 取详情 URL → detail.fields 抽字段（无详情则用列表条目）；
 * - 页面抓取经注入的 PageFetcher（生产是 Crawl4aiPageFetcher：ToolBroker + robots 强制检查）；
 * - 单域限速（默认 1 req/2s）、每轮页数上限、逐页失败计数；失败率由调用方落 source_channel_run 并驱动自动停用。
 */
import { crawlPageUrls, type ChannelCrawlConfig } from './channel-config';
import { selectAll, selectInNode, selectText, nodeText } from './html-select';

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
}

export interface CrawledRecord {
  name: string;
  website?: string;
  country?: string;
  industry?: string;
  products?: string[];
  keywords?: string[];
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

export async function crawlChannel(
  config: ChannelCrawlConfig,
  fetchPage: CrawlPageFetcher,
  options: CrawlRunOptions,
): Promise<CrawlRunResult> {
  const sleep = options.sleep ?? defaultSleep;
  const delayMs = Math.max(0, options.perRequestDelayMs ?? 2_000);
  const maxItems = Math.max(1, options.maxItemsPerPage ?? 50);

  const urls = crawlPageUrls(config, options.pageCap);
  const records: CrawledRecord[] = [];
  let pagesFetched = 0;
  let pageFailures = 0;
  let firstFetch = true;
  const fetchOnce = async (url: string): Promise<CrawledPage | null> => {
    if (!firstFetch && delayMs > 0) await sleep(delayMs);
    firstFetch = false;
    pagesFetched += 1;
    try {
      return await fetchPage(url);
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
    if (items.length === 0 && config.detail.enabled && Object.keys(config.detail.fields).length === 0) continue;

    for (const [index, item] of items.entries()) {
      // 详情页打开前检查页数预算：达到上限立即停止本轮（列表页已计入）。
      const itemHref = config.list.itemUrlSelector
        ? absolutize(selectInNode(item, config.list.itemUrlSelector), listUrl)
        : null;
      let detailHtml: string | null = null;
      let recordUrl = listUrl;
      void index;
      if (config.detail.enabled && itemHref && pagesFetched < options.pageCap) {
        const detail = await fetchOnce(itemHref);
        if (!detail) continue;
        detailHtml = detail.html;
        recordUrl = itemHref;
      }
      const html = detailHtml ?? page.html;
      const fields = config.detail.fields;
      const name = (fields.name ? selectText(html, fields.name) : null) ?? (detailHtml ? null : nodeText(item));
      if (!name || name.length < 2) continue;
      const websiteRaw = fields.website ? selectText(html, fields.website) : null;
      const record: CrawledRecord = {
        name: name.slice(0, 300),
        sourceUrl: recordUrl,
        ...(normalizeWebsite(websiteRaw) ? { website: normalizeWebsite(websiteRaw) } : {}),
        ...(fields.country && selectText(html, fields.country)
          ? { country: selectText(html, fields.country)!.slice(0, 100) }
          : {}),
        ...(fields.industry && selectText(html, fields.industry)
          ? { industry: selectText(html, fields.industry)!.slice(0, 200) }
          : {}),
        ...(fields.products && listValues(html, fields.products)
          ? { products: listValues(html, fields.products) }
          : {}),
        ...(fields.keywords && listValues(html, fields.keywords)
          ? { keywords: listValues(html, fields.keywords) }
          : {}),
      };
      records.push(record);
      if (records.length >= maxItems * Math.max(1, urls.length)) break outer;
    }
    if (pagesFetched >= options.pageCap) return { records, pagesFetched, pageFailures, truncatedByCap: true };
  }
  return { records, pagesFetched, pageFailures, truncatedByCap: pagesFetched >= options.pageCap };
}
