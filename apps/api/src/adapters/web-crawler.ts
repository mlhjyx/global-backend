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
import { resolvePublicHttpUrl, type PublicUrlResolver } from "./url-guard";
import {
  PLATFORM_CRAWL4AI_ARTIFACT_MAX_BYTES,
  PLATFORM_JSON_TRANSPORT_RESPONSE_MAX_BYTES,
} from "../platform-authority/platform-execution-contract";
import {
  decodeJsonBytes,
  readFetchResponseBodyBounded,
} from "./bounded-fetch-response";

export const MAX_CRAWL4AI_RENDER_ARTIFACT_BYTES =
  PLATFORM_CRAWL4AI_ARTIFACT_MAX_BYTES;
export interface CrawlResult {
  url: string;
  text: string;
}

export async function crawlUrl(
  url: string,
  authorizeExternalAction?: () => Promise<void>,
  resolveUrl: PublicUrlResolver = resolvePublicHttpUrl,
  beforePhysicalWire?: () => Promise<void>,
): Promise<CrawlResult> {
  await authorizeExternalAction?.();
  const target = await resolveUrl(url);
  const base = process.env.CRAWLER_URL ?? "http://localhost:11235";
  const token = process.env.CRAWLER_TOKEN ?? "";
  await authorizeExternalAction?.();
  await beforePhysicalWire?.();
  const res = await fetch(`${base}/md`, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ url: target.url.toString() }),
    signal: AbortSignal.timeout(75_000),
  });
  const responseBytes = await readFetchResponseBodyBounded(
    res,
    PLATFORM_JSON_TRANSPORT_RESPONSE_MAX_BYTES,
    "CRAWL4AI_RESPONSE_TOO_LARGE",
  );
  if (!res.ok) throw new Error(`crawler ${res.status}`);
  const json = decodeJsonBytes<{ markdown?: string; success?: boolean }>(
    responseBytes,
    "CRAWL4AI_RESPONSE_INVALID",
  );
  return { url: target.url.toString(), text: json.markdown ?? "" };
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
export async function crawlHtml(
  url: string,
  authorizeExternalAction?: () => Promise<void>,
  resolveUrl: PublicUrlResolver = resolvePublicHttpUrl,
  beforePhysicalWire?: () => Promise<void>,
): Promise<CrawlHtmlResult> {
  await authorizeExternalAction?.();
  const target = await resolveUrl(url);
  const base = process.env.CRAWLER_URL ?? "http://localhost:11235";
  const token = process.env.CRAWLER_TOKEN ?? "";
  await authorizeExternalAction?.();
  await beforePhysicalWire?.();
  const res = await fetch(`${base}/crawl`, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      urls: [target.url.toString()],
      browser_config: { type: "BrowserConfig", params: { headless: true } },
      crawler_config: {
        type: "CrawlerRunConfig",
        params: {
          delay_before_return_html: 3.0,
          page_timeout: 45000,
          cache_mode: "BYPASS",
        },
      },
    }),
    signal: AbortSignal.timeout(75_000),
  });
  const responseBytes = await readFetchResponseBodyBounded(
    res,
    PLATFORM_JSON_TRANSPORT_RESPONSE_MAX_BYTES,
    "CRAWL4AI_RESPONSE_TOO_LARGE",
  );
  if (!res.ok) throw new Error(`crawler ${res.status}`);
  const data = decodeJsonBytes<{
    results?: { html?: string; response_headers?: Record<string, string> }[];
    detail?: unknown;
  }>(responseBytes, "CRAWL4AI_RESPONSE_INVALID");
  if (Array.isArray(data.results) && data.results.length > 1) {
    throw new Error("CRAWL4AI_RESPONSE_ITEM_BOUND_EXCEEDED");
  }
  const r = Array.isArray(data.results) ? data.results[0] : undefined;
  if (!r)
    throw new Error(
      `crawler /crawl: ${JSON.stringify(data.detail ?? data).slice(0, 160)}`,
    );
  const html = r.html ?? "";
  if (Buffer.byteLength(html, "utf8") > MAX_CRAWL4AI_RENDER_ARTIFACT_BYTES) {
    throw new Error("CRAWL4AI_RENDER_RESULT_TOO_LARGE");
  }
  return {
    url: target.url.toString(),
    html,
    headers: r.response_headers ?? {},
  };
}
