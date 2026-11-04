/**
 * HTTP-first 抓取（主计划 §3.5b PR-A）：先用受治理的普通 HTTP 拿 HTML，在进程内用
 * readability 抽正文并转 Markdown，只有可疑页面（薄页/非 HTML/失败）才回落到
 * Crawl4AI 浏览器渲染。基准（独立 181 页语料）：无浏览器抽取 F1 0.955 vs 渲染链路
 * 0.790，且渲染路径慢 24–35 倍。
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
/** 单页 HTTP 抓取上限：15s / 3MB（与 http.get 产物上限一致）。 */
const HTTP_FIRST_TIMEOUT_MS = 15_000;
const HTTP_FIRST_MAX_BYTES = 3_000_000;
const HTTP_FIRST_MAX_REDIRECTS = 5;

export interface HttpFirstHtmlResponse {
  contentType: string | null;
  body: Buffer;
}

export type HttpFirstHtmlFetcher = (url: string) => Promise<HttpFirstHtmlResponse | null>;

export interface HttpFirstPage {
  markdown: string;
  title: string | null;
  contentHash: string;
}

export interface HttpFirstOptions {
  fetchHtml?: HttpFirstHtmlFetcher;
  minChars?: number;
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
  return async (url) => {
    const res = await requestPublicHttp(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": HTTP_FIRST_UA,
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        },
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
    if (res.status < 200 || res.status >= 300) return null;
    return {
      contentType: res.headers["content-type"] ?? null,
      body: res.body,
    };
  };
}

function turndown(): TurndownService {
  return new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
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
  let fetched: HttpFirstHtmlResponse | null = null;
  try {
    const fetcher = options.fetchHtml ?? defaultFetchHtml(options.hooks);
    fetched = await fetcher(url);
  } catch {
    return null;
  }
  if (!fetched) return null;
  const contentType = fetched.contentType?.toLowerCase() ?? "";
  if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    return null;
  }
  try {
    const html = decodeHtml(fetched.body, fetched.contentType);
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
  } catch {
    return null;
  }
}

