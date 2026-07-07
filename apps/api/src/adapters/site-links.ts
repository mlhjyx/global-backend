/**
 * Deterministic same-site link extraction + key-subpage selection (PRD 5.2 系统动作:
 * 官网多页理解). Pure functions — deliberately NOT an AI task: which pages to crawl
 * is a bounded, auditable decision the deterministic system owns (AI 分层原则).
 */

/** Path keywords that mark high-value pages for company understanding, by priority. */
const KEY_PATH_PATTERNS: { pattern: RegExp; weight: number }[] = [
  { pattern: /product|produkt|catalog/i, weight: 100 },
  { pattern: /service|solution|capabilit|technolog/i, weight: 90 },
  { pattern: /about|company|profile|who-we-are|unternehmen/i, weight: 80 },
  { pattern: /certificat|quality|compliance|zertifi/i, weight: 75 },
  { pattern: /case|customer|client|reference|success|project/i, weight: 70 },
  { pattern: /contact|kontakt|impressum|imprint/i, weight: 65 },
  { pattern: /industr|application|market/i, weight: 50 },
];

/** Paths that never help understanding — skip regardless of other matches. */
const EXCLUDE_PATTERN =
  /\.(pdf|jpg|jpeg|png|gif|svg|webp|zip|mp4|css|js)([?#]|$)|\/(login|signin|signup|register|cart|checkout|privacy|cookie|terms|legal|blog\/|news\/|search|tag\/|category\/|wp-|feed|rss|sitemap)/i;

/** Extract absolute same-host links from Crawl4AI markdown output. */
export function extractSameSiteLinks(markdown: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const seen = new Set<string>();
  // markdown links [text](url) — Crawl4AI resolves most hrefs to absolute already.
  const re = /\]\(\s*(<[^>]+>|[^)\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const raw = m[1].replace(/^<|>$/g, '');
    if (raw.startsWith('mailto:') || raw.startsWith('tel:') || raw.startsWith('javascript:')) continue;
    try {
      const url = new URL(raw, base);
      if (url.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
      url.hash = '';
      url.search = '';
      const normalized = url.toString().replace(/\/$/, '');
      if (normalized && normalized !== baseUrl.replace(/\/$/, '')) seen.add(normalized);
    } catch {
      // unparseable href — ignore
    }
  }
  return [...seen];
}

/**
 * Pick the top `max` subpages worth crawling for understanding. Scoring is
 * keyword-based on the URL path; shallower paths win ties (a /products index
 * beats /products/x/y/z detail pages).
 */
export function selectKeySubpages(links: string[], max = 6): string[] {
  const scored = links
    .filter((l) => !EXCLUDE_PATTERN.test(l))
    .map((link) => {
      const path = new URL(link).pathname;
      const depth = path.split('/').filter(Boolean).length;
      let weight = 0;
      for (const { pattern, weight: w } of KEY_PATH_PATTERNS) {
        if (pattern.test(path)) {
          weight = Math.max(weight, w);
        }
      }
      return { link, weight, depth };
    })
    .filter((s) => s.weight > 0 && s.depth <= 3);

  scored.sort((a, b) => b.weight - a.weight || a.depth - b.depth || a.link.localeCompare(b.link));

  // At most one page per keyword-category to spread coverage, then fill remainder.
  const picked: string[] = [];
  const usedWeights = new Set<number>();
  for (const s of scored) {
    if (picked.length >= max) break;
    if (!usedWeights.has(s.weight)) {
      picked.push(s.link);
      usedWeights.add(s.weight);
    }
  }
  for (const s of scored) {
    if (picked.length >= max) break;
    if (!picked.includes(s.link)) picked.push(s.link);
  }
  return picked;
}
