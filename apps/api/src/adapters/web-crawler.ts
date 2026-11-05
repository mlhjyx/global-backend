/**
 * WebCrawlerProvider adapter — calls the self-hosted Crawl4AI service (PRD §10.18,
 * ADR-013). Activity/business code depends only on this contract, never on
 * Crawl4AI internals (OSG-003). Swapping to Firecrawl = reimplement this file.
 *
 * R1-safety enforces two layers of egress validation: this adapter rejects non-public seeds,
 * while the pinned Crawl4AI image revalidates seeds/redirects and makes Chromium connect
 * through its pinning proxy. Ubuntu fake-IP compatibility is a DoH fallback taken only when
 * every answer is a mihomo fake IP (198.18/15, or fdfe:dcba:9876::/64 with IPv6 on); the
 * broad allow-internal switch is forbidden.
 */
import type { DispatchPhysicalWire } from "./guarded-http";
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
/** How long one crawl4ai page read (crawl or render) may take before it is aborted. */
export const CRAWL4AI_REQUEST_TIMEOUT_MS = 75_000;

/**
 * 渲染请求的 settle 延迟（秒）：env `CRAWLER_RENDER_DELAY_MS`，默认 500ms。
 * 2026-11-04 前硬编码 3.0 秒——每页白等 3 秒（主计划 §3.5b）。
 */
export function renderDelaySeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CRAWLER_RENDER_DELAY_MS;
  if (raw === undefined || raw.trim() === "") return 0.5;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed / 1000 : 0.5;
}

/**
 * 页面缓存模式：env `CRAWLER_CACHE_MODE`（ENABLED|BYPASS|READ_ONLY|WRITE_ONLY|DISABLED），
 * 默认 ENABLED。换抓取配置（如渲染参数）时手动设 BYPASS 验证一次。
 */
export function renderCacheMode(env: NodeJS.ProcessEnv = process.env): string {
  const value = (env.CRAWLER_CACHE_MODE ?? "").trim().toUpperCase();
  return ["ENABLED", "BYPASS", "READ_ONLY", "WRITE_ONLY", "DISABLED"].includes(value)
    ? value
    : "ENABLED";
}

/**
 * 单页导航超时（毫秒）：env `CRAWLER_PAGE_TIMEOUT_MS`，默认 45000，钳制在 5s–180s。
 * 慢站（1MB+ 服务端渲染页）实测 25–45s 贴边，需要时抬高而不是改代码重新发版。
 */
export function pageTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CRAWLER_PAGE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return 45_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 45_000;
  return Math.min(180_000, Math.max(5_000, Math.round(parsed)));
}
export interface CrawlResult {
  url: string;
  text: string;
}

export async function crawlUrl(
  url: string,
  authorizeExternalAction?: () => Promise<void>,
  resolveUrl: PublicUrlResolver = resolvePublicHttpUrl,
  beforePhysicalWire?: () => Promise<void>,
  dispatchPhysicalWire?: DispatchPhysicalWire,
): Promise<CrawlResult> {
  await authorizeExternalAction?.();
  const target = await resolveUrl(url);
  const base = process.env.CRAWLER_URL ?? "http://localhost:11235";
  const token = process.env.CRAWLER_TOKEN ?? "";
  await authorizeExternalAction?.();
  await beforePhysicalWire?.();
  const executePhysicalWire = async () => {
    const res = await fetch(`${base}/md`, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ url: target.url.toString() }),
      signal: AbortSignal.timeout(CRAWL4AI_REQUEST_TIMEOUT_MS),
    });
    const responseBytes = await readFetchResponseBodyBounded(
      res,
      PLATFORM_JSON_TRANSPORT_RESPONSE_MAX_BYTES,
      "CRAWL4AI_RESPONSE_TOO_LARGE",
    );
    return { res, responseBytes };
  };
  const { res, responseBytes } = dispatchPhysicalWire
    ? await dispatchPhysicalWire(executePhysicalWire)
    : await executePhysicalWire();
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
  dispatchPhysicalWire?: DispatchPhysicalWire,
): Promise<CrawlHtmlResult> {
  await authorizeExternalAction?.();
  const target = await resolveUrl(url);
  const base = process.env.CRAWLER_URL ?? "http://localhost:11235";
  const token = process.env.CRAWLER_TOKEN ?? "";
  await authorizeExternalAction?.();
  await beforePhysicalWire?.();
  const executePhysicalWire = async () => {
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
            delay_before_return_html: renderDelaySeconds(),
            page_timeout: pageTimeoutMs(),
            cache_mode: renderCacheMode(),
          },
        },
      }),
      signal: AbortSignal.timeout(CRAWL4AI_REQUEST_TIMEOUT_MS),
    });
    const responseBytes = await readFetchResponseBodyBounded(
      res,
      PLATFORM_JSON_TRANSPORT_RESPONSE_MAX_BYTES,
      "CRAWL4AI_RESPONSE_TOO_LARGE",
    );
    return { res, responseBytes };
  };
  const { res, responseBytes } = dispatchPhysicalWire
    ? await dispatchPhysicalWire(executePhysicalWire)
    : await executePhysicalWire();
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
