/**
 * L0/L1 跨源 Reciprocal Rank Fusion (RRF) 与源质量加权（Batch 1.4-B）：
 *
 * 将多引擎搜索命中（SearXNG / Serper / Brave / Exa / Google Places）按标准 RRF 公式
 * `score = Σ weight(source) / (k + rank)` 融合排序，让多个独立引擎共同命中的真实 B2B 企业
 * 自动排到 `MAX_PUBLIC_WEB_DOMAINS_PER_QUERY` 上限之前，减少单引擎噪声占坑。
 * 纯函数、零 I/O。
 */

export interface RankedSearchHit {
  readonly url: string;
  readonly title?: string;
}

export interface SearchSourceBucket {
  readonly source: string;
  readonly hits: readonly RankedSearchHit[];
}

/** 各数据源在 RRF 融合中的基础信任权重（确定性先验；后续 Phase 3 可接入 yield ledger 动态调权）。 */
export const SOURCE_QUALITY_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  channel_catalog: 1.5,
  registry_frame: 1.4,
  companies_house_registry: 1.4,
  gleif: 1.4,
  ted: 1.35,
  openfda: 1.35,
  trade_fair: 1.3,
  directory: 1.2,
  google_places: 1.25,
  exa: 1.2,
  serper: 1.15,
  brave: 1.1,
  searxng: 1.0,
});

const DEFAULT_RRF_K = 60;

function hostKeyOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return url.toLowerCase();
  }
}

/**
 * 跨引擎 RRF 融合：
 * - 单引擎输入退化为保序去重（与历史行为完全兼容）；
 * - 多引擎输入时，同时累计 URL 级与域名级 RRF 分数，多源共识域排在最前。
 */
export function fuseSearchEngineHits(
  buckets: readonly SearchSourceBucket[],
  opts?: { k?: number; maxResults?: number },
): RankedSearchHit[] {
  const nonEmpty = buckets.filter((b) => b.hits.length > 0);
  if (nonEmpty.length === 0) return [];
  const k = opts?.k ?? DEFAULT_RRF_K;
  const maxResults = opts?.maxResults ?? 80;

  if (nonEmpty.length === 1) {
    const seen = new Set<string>();
    const out: RankedSearchHit[] = [];
    for (const hit of nonEmpty[0]!.hits) {
      if (!hit.url || seen.has(hit.url)) continue;
      seen.add(hit.url);
      out.push(hit);
      if (out.length >= maxResults) break;
    }
    return out;
  }

  const domainScore = new Map<string, number>();
  const urlEntry = new Map<
    string,
    { hit: RankedSearchHit; urlScore: number; domain: string; firstOrder: number }
  >();
  let order = 0;

  for (const bucket of nonEmpty) {
    const weight = SOURCE_QUALITY_WEIGHTS[bucket.source] ?? 1.0;
    const seenInBucket = new Set<string>();
    const seenDomainInBucket = new Set<string>();
    let rank = 0;
    for (const hit of bucket.hits) {
      if (!hit.url || seenInBucket.has(hit.url)) continue;
      seenInBucket.add(hit.url);
      rank += 1;
      const contrib = weight / (k + rank);
      const domain = hostKeyOf(hit.url);
      if (!seenDomainInBucket.has(domain)) {
        seenDomainInBucket.add(domain);
        domainScore.set(domain, (domainScore.get(domain) ?? 0) + contrib);
      }
      const existing = urlEntry.get(hit.url);
      if (existing) {
        existing.urlScore += contrib;
        if (!existing.hit.title && hit.title) {
          existing.hit = { url: existing.hit.url, title: hit.title };
        }
      } else {
        urlEntry.set(hit.url, { hit, urlScore: contrib, domain, firstOrder: order });
        order += 1;
      }
    }
  }

  return [...urlEntry.values()]
    .sort((left, right) => {
      const leftTotal = left.urlScore + (domainScore.get(left.domain) ?? 0);
      const rightTotal = right.urlScore + (domainScore.get(right.domain) ?? 0);
      if (rightTotal !== leftTotal) return rightTotal - leftTotal;
      return left.firstOrder - right.firstOrder;
    })
    .slice(0, maxResults)
    .map((entry) => entry.hit);
}
