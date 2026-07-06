/**
 * WebCrawlerProvider adapter — calls the self-hosted Crawl4AI service (PRD §10.18,
 * ADR-013). Activity/business code depends only on this contract, never on
 * Crawl4AI internals (OSG-003). Swapping to Firecrawl = reimplement this file.
 *
 * Crawl4AI provides SSRF protection (egress pinning) itself, so we don't.
 */
export interface CrawlResult {
  url: string;
  text: string;
}

export async function crawlUrl(url: string): Promise<CrawlResult> {
  const base = process.env.CRAWLER_URL ?? 'http://localhost:11235';
  const token = process.env.CRAWLER_TOKEN ?? '';
  const res = await fetch(`${base}/md`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    throw new Error(`crawler ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as { markdown?: string; success?: boolean };
  return { url, text: json.markdown ?? '' };
}
