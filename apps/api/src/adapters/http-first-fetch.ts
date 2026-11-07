/**
 * HTTP-first 抓取（主计划 §3.5b PR-A）：先用受治理的普通 HTTP 拿 HTML，在进程内用
 * readability 抽正文并转 Markdown，只有可疑页面（薄页/非 HTML/失败）才回落到
 * Crawl4AI 浏览器渲染。基准（独立 181 页语料）：无浏览器抽取 F1 0.955 vs 渲染链路
 * 0.790，且渲染路径慢 24–35 倍。
 *
 * PR-B（缓存层）：可选注入 {@link HttpFirstCachePort}。命中未过期缓存行时带
 * If-None-Match / If-Modified-Since 条件请求；304 直接复用缓存 markdown（不读 body、
 * 不重做抽取），200 时把新正文与校验头写回。缓存读写失败一律退化为普通抓取。
 *
 * 出网治理与 http.get 完全一致：requestPublicHttp 逐跳公网 IP 钉扎，透传 broker 的
 * authorizeExternalAction / beforePhysicalWire 钩子，SSRF 与物理出口观测不削弱。
 */
import { createHash } from "node:crypto";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { requestPublicHttp } from "./guarded-http";

/** 诚实 UA：不做指纹伪装（curl-impersonate 类方案在观察名单，另行决策）。 */
export const HTTP_FIRST_UA =
  "Mozilla/5.0 (compatible; GlobalBot/1.0; +https://global-backend.example/bot)";

/** 可读正文最小字符数（低于此判为薄页 → 回落渲染）。env：HTTP_FIRST_MIN_CHARS。 */
export const DEFAULT_HTTP_FIRST_MIN_CHARS = 200;
/**
 * 缓存写入的 markdown 字符上限：抓取工具单次最多消费 100k 字符（`boundedCrawl4aiFetchChars`），
 * 200k 足够覆盖且把缓存行大小压到有界（3MB HTML 的正文可能远超此值）。
 */
export const DEFAULT_HTTP_FIRST_CACHE_MAX_CHARS = 200_000;
/** 单页 HTTP 抓取上限：15s / 3MB（与 http.get 产物上限一致）。 */
const HTTP_FIRST_TIMEOUT_MS = 15_000;
const HTTP_FIRST_MAX_BYTES = 3_000_000;
const HTTP_FIRST_MAX_REDIRECTS = 5;

export interface HttpFirstHtmlResponse {
  contentType: string | null;
  body: Buffer;
  /** HTTP 状态码；缺省按 200 处理（既有测试注入器不带此字段）。 */
  status?: number;
  etag?: string | null;
  lastModified?: string | null;
}

/** 条件请求的有效期校验器：来自缓存行的 ETag / Last-Modified。 */
export interface HttpFirstRequestValidators {
  ifNoneMatch?: string | null;
  ifModifiedSince?: string | null;
}

export type HttpFirstHtmlFetcher = (
  url: string,
  validators?: HttpFirstRequestValidators,
) => Promise<HttpFirstHtmlResponse | null>;

export interface HttpFirstPage {
  markdown: string;
  title: string | null;
  contentHash: string;
  /** 304 命中缓存时标记来源；普通抓取不带此字段。 */
  fromCache?: "conditional-304";
}

/** 缓存端口（PR-B）：未过期行为唯一可复用来源；实现负责 TTL 与过期过滤。 */
export interface HttpFirstCachedPage {
  markdown: string;
  contentHash: string;
  etag: string | null;
  lastModified: string | null;
}

export interface HttpFirstCacheWrite {
  markdown: string;
  contentHash: string;
  etag: string | null;
  lastModified: string | null;
}

export interface HttpFirstCachePort {
  get(workspaceId: string, url: string): Promise<HttpFirstCachedPage | null>;
  put(workspaceId: string, url: string, page: HttpFirstCacheWrite): Promise<void>;
}

export interface HttpFirstCacheOptions {
  /** 租户作用域（RLS 表键）；非 UUID（如平台作用域）由端口实现 no-op。 */
  workspaceId: string;
  port: HttpFirstCachePort;
}

export interface HttpFirstOptions {
  fetchHtml?: HttpFirstHtmlFetcher;
  minChars?: number;
  cache?: HttpFirstCacheOptions;
  /** 缓存写入截断上限（默认 {@link DEFAULT_HTTP_FIRST_CACHE_MAX_CHARS}）；主要供测试注入。 */
  cacheMaxChars?: number;
  /** 与 ToolContext / guarded-http 同签名：出网授权与逐跳物理出口观测。 */
  hooks?: {
    authorizeExternalAction?: () => Promise<boolean>;
    beforePhysicalWire?: () => Promise<void>;
  };
}

function defaultMinChars(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.HTTP_FIRST_MIN_CHARS ?? "");
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.trunc(parsed)
    : DEFAULT_HTTP_FIRST_MIN_CHARS;
}

function decodeHtml(body: Buffer, contentType: string | null): string {
  const head = body.subarray(0, 2_048).toString("latin1");
  const label =
    /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  if (label && !/^utf-?8$/i.test(label)) {
    try {
      return new TextDecoder(label, { fatal: false }).decode(body);
    } catch {
      // 未知编码标签：按 UTF-8 尽力解码。
    }
  }
  return body.toString("utf8");
}

function defaultFetchHtml(hooks?: HttpFirstOptions["hooks"]): HttpFirstHtmlFetcher {
  return async (url, validators) => {
    const headers: Record<string, string> = {
      "User-Agent": HTTP_FIRST_UA,
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
    };
    if (validators?.ifNoneMatch) headers["If-None-Match"] = validators.ifNoneMatch;
    if (validators?.ifModifiedSince) headers["If-Modified-Since"] = validators.ifModifiedSince;
    const res = await requestPublicHttp(
      url,
      {
        method: "GET",
        headers,
        timeoutMs: HTTP_FIRST_TIMEOUT_MS,
        maxBytes: HTTP_FIRST_MAX_BYTES,
        maxRedirects: HTTP_FIRST_MAX_REDIRECTS,
      },
      hooks
        ? {
            authorizeExternalAction: hooks.authorizeExternalAction,
            beforePhysicalWire: hooks.beforePhysicalWire,
          }
        : undefined,
    );
    const etag = res.headers.etag ?? null;
    const lastModified = res.headers["last-modified"] ?? null;
    // 304 无 location：guarded-http 以 ok:false 原样返回，必须先于 2xx 判定处理。
    if (res.status === 304) {
      return {
        contentType: res.headers["content-type"] ?? null,
        body: Buffer.alloc(0),
        status: 304,
        etag,
        lastModified,
      };
    }
    if (res.status < 200 || res.status >= 300) return null;
    return {
      contentType: res.headers["content-type"] ?? null,
      body: res.body,
      status: res.status,
      etag,
      lastModified,
    };
  };
}

function turndown(): TurndownService {
  return new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
}

function extractPage(html: string, minChars: number): HttpFirstPage | null {
  if (!/<html|<body|<p|<div|<article/i.test(html.slice(0, 65_536))) return null;
  const { document } = parseHTML(html);
  const article = new Readability(document as unknown as Document).parse();
  if (!article) return null;
  const text = (article.textContent ?? "").trim();
  if (text.length < minChars) return null;
  const markdown = turndown().turndown(article.content ?? text).trim();
  if (!markdown) return null;
  return {
    markdown,
    title: article.title?.trim() || null,
    contentHash: createHash("sha256").update(markdown, "utf8").digest("hex"),
  };
}

/**
 * 抓一页并抽成 Markdown。返回 null 表示「应回落浏览器渲染」：
 * 非 HTML、非 2xx、抓取失败、或可读正文低于阈值。任何异常都不向上抛（fail-safe）。
 */
export async function fetchPageHttpFirst(
  url: string,
  options: HttpFirstOptions = {},
): Promise<HttpFirstPage | null> {
  const minChars = options.minChars ?? defaultMinChars();
  const cache = options.cache;
  let cached: HttpFirstCachedPage | null = null;
  if (cache) {
    try {
      cached = await cache.port.get(cache.workspaceId, url);
    } catch {
      cached = null;
    }
  }
  const validators: HttpFirstRequestValidators | undefined = cached
    ? { ifNoneMatch: cached.etag, ifModifiedSince: cached.lastModified }
    : undefined;
  const sendValidators =
    validators && (validators.ifNoneMatch || validators.ifModifiedSince)
      ? validators
      : undefined;

  let fetched: HttpFirstHtmlResponse | null = null;
  try {
    const fetcher = options.fetchHtml ?? defaultFetchHtml(options.hooks);
    fetched = await fetcher(url, sendValidators);
  } catch {
    return null;
  }
  if (!fetched) return null;
  if (fetched.status === 304) {
    if (!cached) return null;
    return {
      markdown: cached.markdown,
      title: null,
      contentHash: cached.contentHash,
      fromCache: "conditional-304",
    };
  }
  const contentType = fetched.contentType?.toLowerCase() ?? "";
  if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    return null;
  }
  try {
    const html = decodeHtml(fetched.body, fetched.contentType);
    const page = extractPage(html, minChars);
    if (!page) return null;
    if (cache) {
      try {
        const cacheMaxChars = options.cacheMaxChars ?? DEFAULT_HTTP_FIRST_CACHE_MAX_CHARS;
        const cachedMarkdown = page.markdown.slice(0, cacheMaxChars);
        await cache.port.put(cache.workspaceId, url, {
          markdown: cachedMarkdown,
          contentHash:
            cachedMarkdown === page.markdown
              ? page.contentHash
              : createHash("sha256").update(cachedMarkdown, "utf8").digest("hex"),
          etag: fetched.etag ?? null,
          lastModified: fetched.lastModified ?? null,
        });
      } catch {
        // 缓存写失败不影响本次抓取结果。
      }
    }
    return page;
  } catch {
    return null;
  }
}
