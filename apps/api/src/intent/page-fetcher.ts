import { isAllowedByRobots } from '../adapters/robots';
import type { CrawlHtmlResult } from '../adapters/web-crawler';
import { PLATFORM_WORKSPACE } from '../discovery/provider-contract';
import type { ExecutionBroker } from '../tools/tool-contract';

/**
 * 抓一个被监控页面的渲染后 HTML（robots 合规门 + Crawl4AI）。
 * 当前 Ubuntu dev 的 broad allow-internal 不是 SSRF 防护；R1-safety 须同时覆盖本工具
 * 与 robots 直连路径。完成前调用方只能提供开发者可信的公开 URL。
 * 抽象成注入点（PageFetcher）：WebsiteWatchService 依赖此接口，测试可注入假实现（不触网）。
 * fail-safe：robots 禁止 / 抓取失败 / 空内容 → 返回 null（单页失败不阻断其余页与其余源）。
 * 收口②：原始出网改经 ExecutionBroker 的 crawl4ai.render 工具（robots 在工具内权威强制，
 * 此处 isAllowedByRobots 仅作省一次工具调用的前置快查）；无 broker = 不允许直连（fail-closed 不出网）。
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
  private warnedNoBroker = false;

  constructor(private readonly broker?: ExecutionBroker) {}

  async fetch(url: string): Promise<FetchedPage | null> {
    if (!/^https?:\/\//i.test(url)) return null;
    if (!(await isAllowedByRobots(url).catch(() => true))) return null; // 被 robots 禁 → 放弃（不硬闯）
    if (!this.broker) {
      // 无闸门 = 不允许原始出网（绝不绕过 ToolBroker）→ 视同抓取失败降级（fail-closed），只警一次。
      if (!this.warnedNoBroker) {
        this.warnedNoBroker = true;
         
        console.warn('[web_watch] broker unavailable — skip page fetch (fail-closed, no raw egress)');
      }
      return null;
    }
    // 平台级 sweep 无租户 → PLATFORM_WORKSPACE 哨兵（只入工具 Trace/预算，绝不流入任何 AiContext）。
    const page = await this.broker
      .invoke<{ url: string }, CrawlHtmlResult & { robotsBlocked?: boolean }>(
        'crawl4ai.render',
        { url },
        { workspaceId: PLATFORM_WORKSPACE, correlationId: 'intent-sweep' },
      )
      .then((r) => r.data)
      .catch(() => null);
    if (!page || page.robotsBlocked) return null; // 工具内 robots 权威判定 → 走原 robots 禁抓路径
    if (!page.html || page.html.length < MIN_HTML) return null;
    return { url, html: page.html };
  }
}
