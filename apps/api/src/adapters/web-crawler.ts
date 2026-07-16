/**
 * WebCrawlerProvider adapter — calls the self-hosted Crawl4AI service (PRD §10.18,
 * ADR-013). Activity/business code depends only on this contract, never on
 * Crawl4AI internals (OSG-003). Swapping to Firecrawl = reimplement this file.
 *
 * R1-safety enforces two layers of egress validation: this adapter rejects non-public seeds,
 * while the pinned Crawl4AI image revalidates seeds/redirects and makes Chromium connect
 * through its pinning proxy. Ubuntu fake-IP compatibility is an all-198.18/15-only DoH
 * fallback; the broad allow-internal switch is forbidden.
 */
import { resolvePublicHttpUrl } from './url-guard';
export interface CrawlResult {
  url: string;
  text: string;
}

export async function crawlUrl(url: string): Promise<CrawlResult> {
  const target = await resolvePublicHttpUrl(url);
  const base = process.env.CRAWLER_URL ?? 'http://localhost:11235';
  const token = process.env.CRAWLER_TOKEN ?? '';
  const res = await fetch(`${base}/md`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ url: target.url.toString() }),
    signal: AbortSignal.timeout(75_000),
  });
  if (!res.ok) {
    throw new Error(`crawler ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as { markdown?: string; success?: boolean };
  return { url: target.url.toString(), text: json.markdown ?? '' };
}

/** 渲染后的原始 HTML + 响应头（`/md` 只给 markdown，数字足迹/结构化收割需要原始 HTML）。 */
export interface CrawlHtmlResult {
  url: string;
  html: string;
  headers: Record<string, string>;
}

/**
 * 拉一个 URL 的渲染后原始 HTML + 响应头（走自托管 Crawl4AI `/crawl`）。
 * 供数字足迹（广告像素/技术栈/hreflang）与结构化收割（JSON-LD/JobPosting）解析。
 */
export async function crawlHtml(url: string): Promise<CrawlHtmlResult> {
  const target = await resolvePublicHttpUrl(url);
  const base = process.env.CRAWLER_URL ?? 'http://localhost:11235';
  const token = process.env.CRAWLER_TOKEN ?? '';
  const res = await fetch(`${base}/crawl`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      urls: [target.url.toString()],
      browser_config: { type: 'BrowserConfig', params: { headless: true } },
      crawler_config: {
        type: 'CrawlerRunConfig',
        params: { delay_before_return_html: 3.0, page_timeout: 45000, cache_mode: 'BYPASS' },
      },
    }),
    signal: AbortSignal.timeout(75_000),
  });
  if (!res.ok) {
    throw new Error(`crawler ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    results?: { html?: string; response_headers?: Record<string, string> }[];
    detail?: unknown;
  };
  const r = Array.isArray(data.results) ? data.results[0] : undefined;
  if (!r) throw new Error(`crawler /crawl: ${JSON.stringify(data.detail ?? data).slice(0, 160)}`);
  return { url: target.url.toString(), html: r.html ?? '', headers: r.response_headers ?? {} };
}
