import type { ExecutionBroker } from '../../tools/tool-contract';

/**
 * 品牌 web 研究（09 §2.4 / 合规 C1-C4）：站主自身公司的联网画像补充。
 * - 一切出网经 ToolBroker（allowedTools 白名单绑定 site_builder.brand_profile 契约）：
 *   SSRF（crawl4ai 容器 + net-guard）/ robots（crawl4ai.fetch execute 内强制）/
 *   限流 / 预算 / trace 全部复用，本模块零裸出网（C1/C3）。
 * - 搜索结果只取 title/snippet（第三方页面不搬运正文，竞品只做定位参考，C3）；
 *   自有官网整页抓取归 storefront 级证据。
 * - fail-safe：任一步失败 → degraded=true 返回已有内容，绝不阻断 brandProfile
 *   （researchDegraded 落库，仅凭 KB 出 Brief 的降级语义）。
 */

export type ResearchSourceType = 'storefront' | 'web_research';

export interface ResearchSource {
  sourceType: ResearchSourceType;
  url: string;
  title?: string;
  content: string;
  fetchedAt: string;
}

export interface BrandResearchArgs {
  workspaceId: string;
  runId?: string;
  companyName: string;
  industry?: string;
  websiteUrl?: string;
}

interface SearchResult {
  title?: string;
  url?: string;
  content?: string;
}

const TASK_CONTRACT_ID = 'site_builder.brand_profile';
const MAX_WEB_RESULTS = 5;
const STOREFRONT_MAX_CHARS = 20_000;
const SNIPPET_MAX_CHARS = 500;

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

export async function researchBrand(
  deps: { broker: ExecutionBroker },
  args: BrandResearchArgs,
): Promise<{ sources: ResearchSource[]; degraded: boolean }> {
  const ctx = {
    workspaceId: args.workspaceId,
    runId: args.runId,
    taskContractId: TASK_CONTRACT_ID,
    correlationId: args.runId,
    // searxng 声明 ['discovery']、crawl4ai 声明 ['discovery','enrichment']——多值=任一允许即放行
    purpose: ['discovery', 'enrichment'],
  };
  const sources: ResearchSource[] = [];
  let degraded = false;
  const now = () => new Date().toISOString();
  const ownHost = hostOf(args.websiteUrl);

  // ① 自有官网 → storefront 级证据（robots 禁抓时工具返回空文本=合规放弃，不算失败）
  if (args.websiteUrl) {
    try {
      const r = await deps.broker.invoke<
        { url: string; maxChars: number },
        { url: string; text: string }
      >('crawl4ai.fetch', { url: args.websiteUrl, maxChars: STOREFRONT_MAX_CHARS }, ctx);
      if (r.data.text.trim()) {
        sources.push({
          sourceType: 'storefront',
          url: args.websiteUrl,
          title: 'company website',
          content: r.data.text,
          fetchedAt: now(),
        });
      }
    } catch {
      degraded = true;
    }
  }

  // ② 元搜索 → web_research 级证据（snippet only；剔除自域名防与 storefront 重复计源）
  try {
    const q = [`"${args.companyName}"`, args.industry ?? ''].join(' ').trim();
    const r = await deps.broker.invoke<{ q: string; language: string; pages: number }, { results: SearchResult[] }>(
      'searxng.search',
      { q, language: 'en', pages: 1 },
      ctx,
    );
    const external = (r.data.results ?? [])
      .filter((item) => {
        const host = hostOf(item.url);
        return host !== null && (ownHost === null || host !== ownHost);
      })
      .slice(0, MAX_WEB_RESULTS);
    for (const item of external) {
      sources.push({
        sourceType: 'web_research',
        url: item.url as string,
        title: item.title,
        content: [item.title ?? '', item.content ?? ''].join(' — ').slice(0, SNIPPET_MAX_CHARS),
        fetchedAt: now(),
      });
    }
  } catch {
    degraded = true;
  }

  return { sources, degraded };
}
