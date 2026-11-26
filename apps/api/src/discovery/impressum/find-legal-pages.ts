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

const IMPRESSUM_SEGMENT_RE =
  /^(?:impressum|imprint|legal[-_]?notice|site[-_]?notice|mentions[-_]?l[ée]gales|rechtliches?|anbieterkennzeichnung|note[-_]?legali|dati[-_]?societari|aviso[-_]?legal|company[-_]?profile|corporate[-_]?profile|kaisha[-_]?gaiyou|gaiyou|会社概要|会社案内|企業情報)$/iu;

const PRIVACY_DISCLOSURE_SEGMENT_RE =
  /^(?:informativa[-_]?privacy|privacy(?:[-_]?policy|[-_]?notice)?|datenschutz|politique[-_]?de[-_]?confidentialite)$/iu;

const CONTACT_SEGMENT_RE =
  /^(?:kontakt|kontakte|kontaktformular|kontaktseite|kontaktaufnahme|kontaktieren|contact|contacts|contact[-_]?us|contactus|contact[-_]?form|get[-_]?in[-_]?touch|contatti|contatto|contattaci|contacto|contactenos|cont[áa]ctenos|contactez[-_]?nous|nous[-_]?contacter|contato|contatos|fale[-_]?conosco|contacteer[-_]?ons|iletisim|iletişim|anfrage|anfragen|anfrageformular)$/iu;

const CONTACT_FORM_CHILD_RE = /^(?:form|formular|inquiry|anfrage|message|send)$/iu;

const ABOUT_SEGMENT_RE =
  /^(?:ueber[-_]?uns|über[-_]?uns|uber[-_]?uns|about|about[-_]?us|unternehmen|company|chi[-_]?siamo|azienda|quienes[-_]?somos|qui[-_]?sommes[-_]?nous|sobre[-_]?nos|over[-_]?ons)$/iu;

const PAGE_EXT_RE = /\.(?:html?|php|aspx?|jsp|shtml)$/iu;

/** 资产、电商商品页与低价值页面（严格按路径段/扩展名排除，杜绝 phoenix-contact 等商品页误判为联系页）。 */
const EXCLUDE_ASSET_RE = /\.(?:pdf|jpe?g|png|gif|svg|webp|css|js|xml|json|zip)([?#]|$)/iu;
const EXCLUDE_SEGMENT_RE =
  /^(?:cookie|cookies|terms|terms[-_]?of[-_]?use|agb|blog|news|search|suche|tag|tags|product|products|prodotti|prodotto|produkte|produkt|shop|store|catalog|catalogo|katalog|accessori|accessories|brand|brands|marchi|category|categorie|kategorie|cart|warenkorb|checkout|login|signin|account|register)$/iu;

function decodePathSegments(pathname: string): string[] | null {
  const rawSegments = pathname.split('/').filter((segment) => segment.length > 0);
  const decoded: string[] = [];
  for (const segment of rawSegments) {
    try {
      decoded.push(decodeURIComponent(segment).trim());
    } catch {
      return null;
    }
  }
  return decoded;
}

function stripPageExt(segment: string): string {
  return segment.replace(PAGE_EXT_RE, '').toLowerCase();
}

function classifyLegalSegments(
  segments: readonly string[],
  includePrivacy = false,
): { kind: LegalPageKind; score: number } | null {
  if (segments.length === 0) return null;
  const cleaned = segments.map(stripPageExt);
  if (cleaned.some((seg) => EXCLUDE_SEGMENT_RE.test(seg))) return null;
  if (!includePrivacy && cleaned.some((seg) => PRIVACY_DISCLOSURE_SEGMENT_RE.test(seg))) {
    return null;
  }
  const last = cleaned.at(-1)!;
  const prev = cleaned.length >= 2 ? cleaned.at(-2)! : '';

  if (IMPRESSUM_SEGMENT_RE.test(last) || (cleaned.length <= 3 && cleaned.some((seg) => IMPRESSUM_SEGMENT_RE.test(seg)))) {
    return { kind: 'impressum', score: 100 };
  }
  if (
    includePrivacy &&
    (PRIVACY_DISCLOSURE_SEGMENT_RE.test(last) ||
      (cleaned.length <= 3 && cleaned.some((seg) => PRIVACY_DISCLOSURE_SEGMENT_RE.test(seg))))
  ) {
    return { kind: 'impressum', score: 70 };
  }
  if (
    cleaned.length <= 4 &&
    (CONTACT_SEGMENT_RE.test(last) || (CONTACT_FORM_CHILD_RE.test(last) && CONTACT_SEGMENT_RE.test(prev)))
  ) {
    return { kind: 'contact', score: 80 };
  }
  if (cleaned.length <= 3 && ABOUT_SEGMENT_RE.test(last)) {
    return { kind: 'about', score: 40 };
  }
  return null;
}

/** 严格校验 URL 是否为真正的站点联系页（完整路径段匹配 + 排除商品/分类/品牌路径）。 */
export function isStrictContactPageUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (EXCLUDE_ASSET_RE.test(url.pathname)) return false;
  const segments = decodePathSegments(url.pathname);
  if (!segments || segments.length === 0 || segments.length > 4) return false;
  const classified = classifyLegalSegments(segments);
  return classified?.kind === 'contact';
}

export function isStatutoryDisclosurePageUrl(url: string): boolean {
  return rankLegalPageLinks([url], { includePrivacy: true })[0]?.kind === 'impressum';
}

/** Only the site's own hostname and its www variant can supply official disclosure evidence. */
export function isCompanyWebsitePageUrl(url: string, domain: string): boolean {
  try {
    const parsed = new URL(url);
    const siteHost = domain.trim().toLowerCase().replace(/^www\./u, '').replace(/\.$/u, '');
    const pageHost = parsed.hostname.replace(/^www\./u, '').replace(/\.$/u, '');
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username && !parsed.password && !parsed.port && pageHost === siteHost;
  } catch {
    return false;
  }
}

function pathDepth(rawUrl: string): number {
  try {
    return new URL(rawUrl).pathname.split('/').filter(Boolean).length;
  } catch {
    return 99;
  }
}

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
export function rankLegalPageLinks(
  links: readonly string[],
  opts?: { includePrivacy?: boolean },
): LegalPageCandidate[] {
  const includePrivacy = opts?.includePrivacy === true;
  const byKey = new Map<string, LegalPageCandidate>();
  for (const link of links) {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (EXCLUDE_ASSET_RE.test(url.pathname)) continue;
    const segments = decodePathSegments(url.pathname);
    if (!segments) continue;
    const best = classifyLegalSegments(segments, includePrivacy);
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
    (a, b) => b.score - a.score || pathDepth(a.url) - pathDepth(b.url) || a.url.localeCompare(b.url),
  );
}

/**
 * 法律页候选 = 首页链接（评分序）+ 固定路径补齐（首页缺该 kind 才追加）+ 每 kind 限量。
 * 总条数受 maxPages 约束；固定路径条目分数减半（低于任何首页真实链接）。
 */
export function legalPageCandidates(
  baseUrl: string,
  homepageLinks: readonly string[],
  opts?: { maxPages?: number; includePrivacy?: boolean },
): LegalPageCandidate[] {
  const maxPages = opts?.maxPages ?? 6;
  const base = new URL(baseUrl);
  const ranked = rankLegalPageLinks(homepageLinks, { includePrivacy: opts?.includePrivacy }).filter(
    (candidate) => new URL(candidate.url).hostname.replace(/^www\./u, '') === base.hostname.replace(/^www\./u, ''),
  );
  const out: LegalPageCandidate[] = [];
  const seenKeys = new Set<string>();
  /** 首页链接已覆盖的 kind——固定路径只为缺失的 kind 追加（含全部变体，交给页数预算收敛）。 */
  const linkKinds = new Set<LegalPageKind>();
  const push = (candidate: LegalPageCandidate): boolean => {
    const key = candidate.url.replace(/\/$/u, '');
    if (seenKeys.has(key)) return false;
    if (out.length >= maxPages) return false;
    seenKeys.add(key);
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
