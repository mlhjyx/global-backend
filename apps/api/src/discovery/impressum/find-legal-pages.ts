/**
 * A1（2026-11-08）：法律页（Impressum/联系页）发现的确定性规则。
 *
 * 两条来源：首页同站链接评分（保留站点原始形态，含非标准路径 `/ando-technik/impressum/`）
 * + 固定路径探测（DE/AT/CH 常见形态）。纯函数：抓不抓由调用方（provider）决定并受页数上限约束。
 */

export type LegalPageKind = 'impressum' | 'contact' | 'about';

export interface LegalPageCandidate {
  url: string;
  kind: LegalPageKind;
  score: number;
}

const PATH_RULES: { kind: LegalPageKind; pattern: RegExp; score: number }[] = [
  // 法定出版信息：Impressum（DE/AT/CH）/ imprint / legal notice / mentions légales。
  { kind: 'impressum', pattern: /impressum|imprint|legal-?notice|mentions-?l[ée]gales|rechtliches?/iu, score: 100 },
  { kind: 'contact', pattern: /kontakt|contact|contatti|contacto/iu, score: 80 },
  // about 只作兜底（有的小站把联系方式放在团队/公司页）。
  { kind: 'about', pattern: /ueber-uns|über-uns|about|unternehmen/iu, score: 40 },
];

/** 资产与低价值页面（隐私/条款页几乎没有联系方式，且不在 A1 口径内）。 */
const EXCLUDE = /\.(pdf|jpe?g|png|gif|svg|webp|css|js)([?#]|$)|\/(privacy|datenschutz|cookie|terms|agb|blog|news|search|tag)\b/iu;

/**
 * 固定路径探测候选；仅当首页链接没有对应 kind 时使用。两种 kind 交替排列——
 * 页数预算小时 impressum 与 contact 都有机会，单个变体 404 时也能在预算内试下一个变体
 *（/impressum 空壳、/impressum.html 才是真页面的站点很常见）。
 */
const FIXED_PATHS: { path: string; kind: LegalPageKind }[] = [
  { path: '/impressum', kind: 'impressum' },
  { path: '/kontakt', kind: 'contact' },
  { path: '/impressum/', kind: 'impressum' },
  { path: '/kontakt/', kind: 'contact' },
  { path: '/impressum.html', kind: 'impressum' },
  { path: '/imprint', kind: 'impressum' },
  { path: '/kontakt.html', kind: 'contact' },
  { path: '/legal-notice', kind: 'impressum' },
  { path: '/contact', kind: 'contact' },
];

/** 首页同站链接 → 按 kind/score 排序的法律页候选（同路径去重，保留带尾斜杠形态）。 */
export function rankLegalPageLinks(links: readonly string[]): LegalPageCandidate[] {
  const byKey = new Map<string, LegalPageCandidate>();
  for (const link of links) {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (EXCLUDE.test(url.pathname)) continue;
    let best: { kind: LegalPageKind; score: number } | undefined;
    for (const rule of PATH_RULES) {
      if (rule.pattern.test(url.pathname)) {
        if (!best || rule.score > best.score) best = { kind: rule.kind, score: rule.score };
      }
    }
    if (!best) continue;
    url.hash = '';
    url.search = '';
    const href = url.toString();
    const key = href.replace(/\/$/u, '');
    const existing = byKey.get(key);
    // 同一路径的两种写法都保留带尾斜杠的形态（站点对无斜杠回空壳的案例见 site-links.ts）。
    if (!existing || (href.endsWith('/') && !existing.url.endsWith('/'))) {
      byKey.set(key, { url: href, kind: best.kind, score: best.score });
    }
  }
  return [...byKey.values()].sort(
    (a, b) => b.score - a.score || a.url.localeCompare(b.url),
  );
}

/**
 * 法律页候选 = 首页链接（评分序）+ 固定路径补齐（首页缺该 kind 才追加）+ 每 kind 限量。
 * 总条数受 maxPages 约束；固定路径条目分数减半（低于任何首页真实链接）。
 */
export function legalPageCandidates(
  baseUrl: string,
  homepageLinks: readonly string[],
  opts?: { maxPages?: number },
): LegalPageCandidate[] {
  const maxPages = opts?.maxPages ?? 6;
  const base = new URL(baseUrl);
  const ranked = rankLegalPageLinks(homepageLinks).filter(
    (candidate) => new URL(candidate.url).hostname.replace(/^www\./u, '') === base.hostname.replace(/^www\./u, ''),
  );
  const out: LegalPageCandidate[] = [];
  const seenKeys = new Set<string>();
  const kindsSeen = new Set<LegalPageKind>();
  /** 首页链接已覆盖的 kind——固定路径只为缺失的 kind 追加（含全部变体，交给页数预算收敛）。 */
  const linkKinds = new Set<LegalPageKind>();
  const push = (candidate: LegalPageCandidate): boolean => {
    const key = candidate.url.replace(/\/$/u, '');
    if (seenKeys.has(key)) return false;
    if (out.length >= maxPages) return false;
    seenKeys.add(key);
    kindsSeen.add(candidate.kind);
    out.push(candidate);
    return true;
  };
  for (const candidate of ranked) {
    if (out.length >= maxPages) break;
    if (linkKinds.has(candidate.kind) && candidate.kind !== 'impressum') continue; // 每类最多一条
    if (push(candidate)) linkKinds.add(candidate.kind);
  }
  if (!linkKinds.has('impressum') || !linkKinds.has('contact')) {
    for (const fixed of FIXED_PATHS) {
      if (out.length >= maxPages) break;
      if (linkKinds.has(fixed.kind)) continue;
      const url = new URL(fixed.path, base).toString();
      push({ url, kind: fixed.kind, score: 50 });
    }
  }
  return out;
}
