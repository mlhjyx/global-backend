import { createHash } from 'node:crypto';
import type { EvidenceSourceRole } from '@global/contracts';
import type { ExecutionBroker } from '../../tools/tool-contract';

/**
 * 品牌 web 研究（09 §2.4 / 合规 C1-C4）：站主自身公司的联网画像补充。
 * - 一切出网经 ToolBroker（allowedTools 白名单绑定 site_builder.brand_profile 契约）：
 *   robots（crawl4ai.fetch execute 内强制）/ 限流 / 预算 / trace 全部复用，本模块零裸出网（C1/C3）。
 *   R1-safety 的 API + crawler 双层 egress gate 已落地：global-unicast 校验、连接 pinning、
 *   redirect 逐跳重验与 fake-IP-only 窄回退均由下层统一强制。
 * - 搜索结果只保留按站主公司名 + 外部 origin 生成的最小 research hint；上游
 *   title/snippet/path/query/fragment 一律不持久化，避免第三方具名个人进入冻结语料（C3/C4）；
 *   自有官网整页抓取归 storefront 级证据。
 * - fail-safe：任一步失败 → degraded=true 返回已有内容，绝不阻断 brandProfile
 *   （researchDegraded 落库，仅凭 KB 出 Brief 的降级语义）。
 */

export type ResearchSourceType = 'storefront' | 'web_research';

export interface ResearchSource {
  sourceType: ResearchSourceType;
  sourceRole: EvidenceSourceRole;
  url: string;
  title?: string;
  content: string;
  fetchedAt: string;
  upstreamContentHash: string;
  providerContentHash?: string;
  parserVersion: string;
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

const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.origin}/`;
  } catch {
    return null;
  }
}

/** 去 www. 前缀（自域名判定用；www.acme.com 与 acme.com 视为同一站，Codex #5）。 */
const baseHost = (host: string | null): string | null => host?.replace(/^www\./, '') ?? null;

/** 两个 host 是否属同一公司站点（含 www 变体与子域）——防站主自有域被误当外部研究源。 */
function isSameSite(a: string | null, b: string | null): boolean {
  const na = baseHost(a);
  const nb = baseHost(b);
  if (!na || !nb) return false;
  return na === nb || na.endsWith(`.${nb}`) || nb.endsWith(`.${na}`);
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
    // 改动 4：本次出网用途=站点建设。searxng/crawl4ai 均已声明 site_builder（crawl4ai 是 advisory 门，
    // effective = 调用purpose ∩ 工具allowedPurpose，故必须声明；searxng 是 sourcePolicy=none 短路放行）。
    purpose: ['site_builder'],
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
        { url: string; text: string; contentHash: string }
      >('crawl4ai.fetch', { url: args.websiteUrl, maxChars: STOREFRONT_MAX_CHARS }, ctx);
      if (r.data.text.trim()) {
        sources.push({
          sourceType: 'storefront',
          sourceRole: 'fact_candidate',
          url: args.websiteUrl,
          title: 'company website',
          content: r.data.text,
          fetchedAt: r.provenance?.fetchedAt ?? now(),
          // The legacy tool currently exposes a 24-hex digest prefix. A1 must
          // bind a complete SHA-256 and retain the provider value only as metadata.
          upstreamContentHash: sha256(r.data.text),
          providerContentHash:
            r.provenance?.contentHash ?? r.data.contentHash ?? undefined,
          parserVersion: r.provenance?.parserVersion ?? 'crawl4ai/1',
        });
      }
    } catch {
      degraded = true;
    }
  }

  // ② 元搜索 → web_research 级 hint。只保留公司自有名称 + external origin；
  // 上游 title/snippet/path/query/fragment 可能含具名个人，C4 要求一律不落库。
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
        // 剔除站主自有域（含 www 变体/子域，Codex #5）——否则自站被误当外部 web_research 源，
        // 且认证类断言的门槛 storefront≠web_research，分类错误会误伤。
        return host !== null && !isSameSite(host, ownHost);
      })
      .slice(0, MAX_WEB_RESULTS);
    const seenOrigins = new Set<string>();
    for (const item of external) {
      const origin = originOf(item.url);
      if (!origin || seenOrigins.has(origin)) continue;
      seenOrigins.add(origin);
      const content = `Search index references ${args.companyName} at external origin ${new URL(origin).host}. Raw third-party page metadata omitted by policy.`;
      sources.push({
        sourceType: 'web_research',
        sourceRole: 'research_hint',
        url: origin,
        content,
        fetchedAt: now(),
        upstreamContentHash: sha256(content),
        parserVersion: 'searxng-origin-hint/1',
      });
    }
  } catch {
    degraded = true;
  }

  return { sources, degraded };
}
