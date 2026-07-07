import { crawlHtml } from '../adapters/web-crawler';
import { isAllowedByRobots } from '../adapters/robots';

/**
 * 抓一个被监控页面的渲染后 HTML（robots 门 + crawl4ai 的 egress/SSRF 防护）。
 * 抽象成注入点（PageFetcher）：WebsiteWatchService 依赖此接口，测试可注入假实现（不触网）。
 * fail-safe：robots 禁止 / 抓取失败 / 空内容 → 返回 null（单页失败不阻断其余页与其余源）。
 */
export interface FetchedPage {
  url: string;
  html: string;
}

export interface PageFetcher {
  fetch(url: string): Promise<FetchedPage | null>;
}

const MIN_HTML = 200; // 过短 = 抓空/被拦，视为 miss（不据此判页面消失）

export class Crawl4aiPageFetcher implements PageFetcher {
  async fetch(url: string): Promise<FetchedPage | null> {
    if (!/^https?:\/\//i.test(url)) return null;
    if (!(await isAllowedByRobots(url).catch(() => true))) return null; // 被 robots 禁 → 放弃（不硬闯）
    const page = await crawlHtml(url).catch(() => null);
    if (!page || !page.html || page.html.length < MIN_HTML) return null;
    return { url, html: page.html };
  }
}
