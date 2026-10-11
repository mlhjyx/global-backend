import { isStableSafeHttpsUrl } from '../raw-source-provider-normalizer';
import { canonicalizeSuppressionValue } from '../suppression-value';

/**
 * BI-14 company contact paths: links to a company's own contact, Impressum and
 * supplier pages and to its own LinkedIn and X pages, found among the links of the
 * homepage the website profile has already fetched, and whether its rendered contact
 * page carries a contact form. Pure and deterministic: no network, no model.
 *
 * Only links are stored as contact points, never page text. (The pages themselves, the
 * homepage and Impressum fetches and the contact-page render, are the tools' durable
 * results: PERSONAL_DATA artifacts kept for 24 hours and covered by DSR erasure, like every
 * website-profile fetch.) No email address, phone number or person name is parsed,
 * normalised or stored by this module: a same-site link is kept only on the bare
 * company domain or its `www.` host and only when every path segment consists of
 * known words or short numbers (at most six digits in the whole path), so a stored
 * link cannot carry free text from the page; a social link must match its exact
 * company-page pattern and be recognisably the company's own.
 */
export const COMPANY_CONTACT_POINT_KINDS = Object.freeze([
  'contact_page',
  'impressum_page',
  'contact_form',
  'supplier_page',
  'linkedin_company_page',
  'x_company_account',
] as const);
export type CompanyContactPointKind = (typeof COMPANY_CONTACT_POINT_KINDS)[number];
export type CompanyContactLinkKind = Exclude<CompanyContactPointKind, 'contact_form'>;
/** Every kind read from homepage links; `contact_form` comes from the rendered contact page. */
export const COMPANY_CONTACT_LINK_KINDS: readonly CompanyContactLinkKind[] = Object.freeze(
  COMPANY_CONTACT_POINT_KINDS.filter(
    (kind): kind is CompanyContactLinkKind => kind !== 'contact_form',
  ),
);

/** At most one link per kind; null when the homepage links have none. */
export interface CompanyContactLinks {
  readonly contactPage: string | null;
  readonly impressumPage: string | null;
  readonly supplierPage: string | null;
  readonly linkedinCompanyPage: string | null;
  readonly xCompanyAccount: string | null;
}

const NO_LINKS: CompanyContactLinks = Object.freeze({
  contactPage: null,
  impressumPage: null,
  supplierPage: null,
  linkedinCompanyPage: null,
  xCompanyAccount: null,
});

const MAX_LINKS = 600;
const MAX_LABEL_CHARS = 120;
const MAX_TARGET_CHARS = 2_048;
const MAX_PATH_SEGMENTS = 3;
/** Markdown link targets: `](url)` or `](<url>)`. */
const LINK_TARGET = /\]\(\s*(<[^>\n]{1,2048}>|[^)\s]{1,2048})/gu;
const PAGE_EXTENSION = /\.(?:html?|php|aspx?|jsp|shtml)$/u;
const SHORT_NUMBER = /^\d{1,6}$/u;
/** Digits in a whole stored path: a phone number split over segments or `_` stays out. */
const MAX_PATH_DIGITS = 6;

/**
 * The words a stored same-site path may consist of: language and country codes,
 * common section names, and the contact, Impressum and supplier cue words.
 */
const PATH_WORDS: ReadonlySet<string> = new Set([
  // language and country codes
  'de', 'en', 'fr', 'it', 'es', 'nl', 'pl', 'cs', 'cz', 'da', 'dk', 'sv', 'se', 'no', 'nb', 'fi',
  'pt', 'tr', 'ru', 'zh', 'cn', 'ja', 'jp', 'ko', 'hu', 'ro', 'sk', 'sl', 'si', 'hr', 'bg', 'el',
  'gr', 'at', 'ch', 'be', 'lu', 'li', 'us', 'gb', 'uk', 'eu', 'int', 'intl', 'global',
  // section names
  'home', 'start', 'startseite', 'index', 'default', 'main', 'seite', 'seiten', 'page', 'pages',
  'site', 'sites', 'web', 'cms', 'content', 'node', 'p', 'id', 'info', 'infos', 'information',
  'informationen', 'service', 'services', 'kundenservice', 'support', 'hilfe', 'help',
  'unternehmen', 'company', 'firma', 'about', 'ueber', 'über', 'uber', 'wir', 'uns', 'our',
  'unsere', 'unser', 'footer', 'meta', 'rechtliches', 'rechtlich', 'legal', 'notice', 'einkauf',
  'purchasing', 'procurement', 'beschaffung', 'partner', 'partners', 'partnerschaft', 'haendler',
  'händler', 'dealer', 'dealers', 'reseller', 'vertrieb', 'sales', 'hersteller', 'manufacturer',
  'manufacturers', 'portal', 'program', 'programm', 'programme', 'werden', 'become', 'a', 'and',
  'und', 'sie', 'ihre', 'ihr', 'mit', 'for', 'fuer', 'für', 'get', 'in', 'touch', 'form',
  'formular', 'anfahrt',
  // cue words
  'kontakt', 'kontakte', 'kontaktformular', 'kontaktieren', 'kontaktaufnahme', 'kontaktseite',
  'contact', 'contacts', 'contactus', 'anfrage', 'anfragen', 'anfrageformular', 'impressum',
  'imprint', 'anbieterkennzeichnung', 'lieferant', 'lieferanten', 'lieferantenportal', 'supplier',
  'suppliers', 'partnerprogramm',
]);

const CONTACT_WORDS = new Set([
  'kontakt', 'kontakte', 'kontaktformular', 'kontaktieren', 'kontaktaufnahme', 'kontaktseite',
  'contact', 'contacts', 'contactus', 'anfrage', 'anfragen', 'anfrageformular',
]);
const IMPRESSUM_WORDS = new Set(['impressum', 'imprint', 'anbieterkennzeichnung']);
const SUPPLIER_WORDS = new Set([
  'lieferant', 'lieferanten', 'lieferantenportal', 'supplier', 'suppliers', 'partnerprogramm',
]);
const BECOME_WORDS = new Set(['werden', 'become']);
const INVITED_ROLES = new Set([
  'partner', 'haendler', 'händler', 'hersteller', 'dealer', 'reseller',
]);
const PROGRAM_WORDS = new Set(['program', 'programm', 'programme']);

const CONTACT_LABEL =
  /^(?:kontakt(?:formular|seite|aufnahme)?|kontakte|kontaktieren(?: sie uns)?|kontakt (?:&|und) anfahrt|contact(?: us| form)?|contacts|anfrage(?:formular)?|get in touch)$/u;
const IMPRESSUM_LABEL = /^(?:impressum|imprint|legal notice|site notice|anbieterkennzeichnung)$/u;
const SUPPLIER_LABEL =
  /^(?:lieferant(?:en)?(?: werden)?|lieferanten[ -]?portal|f(?:ü|ue)r lieferanten|partner werden|h(?:ä|ae)ndler werden|hersteller werden|become a (?:supplier|partner)|supplier portal|suppliers?|for suppliers|partner ?program(?:m|me)?)$/u;

type SameSiteKind = 'contact_page' | 'impressum_page' | 'supplier_page';

const SAME_SITE_RULES: ReadonlyArray<{
  kind: SameSiteKind;
  path: (tokens: readonly string[]) => boolean;
  label: RegExp;
}> = [
  {
    kind: 'contact_page',
    path: (tokens) =>
      tokens.some((token) => CONTACT_WORDS.has(token)) ||
      tokens.join('-').includes('get-in-touch'),
    label: CONTACT_LABEL,
  },
  {
    kind: 'impressum_page',
    path: (tokens) =>
      tokens.some((token) => IMPRESSUM_WORDS.has(token)) ||
      (tokens.includes('legal') && tokens.includes('notice')),
    label: IMPRESSUM_LABEL,
  },
  {
    kind: 'supplier_page',
    path: (tokens) =>
      tokens.some((token) => SUPPLIER_WORDS.has(token)) ||
      (tokens.some((token) => BECOME_WORDS.has(token)) &&
        tokens.some((token) => INVITED_ROLES.has(token))) ||
      (tokens.includes('partner') && tokens.some((token) => PROGRAM_WORDS.has(token))),
    label: SUPPLIER_LABEL,
  },
];

interface MarkdownLink {
  readonly target: string;
  readonly label: string;
}

/** Link targets in document order, each with its plain label (empty for nested markup). */
function markdownLinks(markdown: string): MarkdownLink[] {
  const found: MarkdownLink[] = [];
  for (const match of markdown.matchAll(LINK_TARGET)) {
    if (found.length >= MAX_LINKS) break;
    const close = match.index ?? 0;
    const open = markdown.lastIndexOf('[', close);
    const rawLabel = open >= 0 && close - open - 1 <= MAX_LABEL_CHARS ? markdown.slice(open + 1, close) : '';
    found.push({
      target: match[1]!.replace(/^<|>$/gu, ''),
      label: /[[\]\n]/u.test(rawLabel) ? '' : rawLabel,
    });
  }
  return found;
}

function normalizedLabel(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[*_`#]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** A path of at most three segments made of known words; null otherwise, and for the root. */
function vocabularyPath(
  pathname: string,
): { pathname: string; depth: number; lastTokens: readonly string[] } | null {
  const trimmed = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (!trimmed.startsWith('/') || trimmed.length < 2) return null;
  const segments = trimmed.slice(1).split('/');
  if (segments.length > MAX_PATH_SEGMENTS) return null;
  let lastTokens: string[] = [];
  let pathDigits = 0;
  for (const segment of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    pathDigits += decoded.replace(/\D/gu, '').length;
    if (pathDigits > MAX_PATH_DIGITS) return null;
    const word = decoded.normalize('NFC').toLowerCase().replace(PAGE_EXTENSION, '');
    if (!word) return null;
    const tokens = word.split(/[-_.]/u);
    if (!tokens.every((token) => PATH_WORDS.has(token) || SHORT_NUMBER.test(token))) return null;
    lastTokens = tokens;
  }
  return { pathname: trimmed, depth: segments.length, lastTokens };
}

interface SameSitePage {
  readonly url: string;
  readonly depth: number;
  readonly lastTokens: readonly string[];
  readonly hadQuery: boolean;
}

/**
 * A link on the bare company domain or its `www.` host, as https without query or fragment.
 * Other subdomain labels are free text chosen by the site and are not stored.
 */
function sameSitePage(target: string, base: URL, domain: string): SameSitePage | null {
  const trimmed = target.trim();
  if (!trimmed || trimmed.length > MAX_TARGET_CHARS) return null;
  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname;
  if (host !== domain && host !== `www.${domain}`) return null;
  const path = vocabularyPath(url.pathname);
  if (!path) return null;
  const value = `https://${host}${path.pathname}`;
  if (!isStableSafeHttpsUrl(value)) return null;
  return { url: value, depth: path.depth, lastTokens: path.lastTokens, hadQuery: url.search !== '' };
}

function absoluteWebUrl(target: string): URL | null {
  const trimmed = target.trim();
  if (!trimmed || trimmed.length > MAX_TARGET_CHARS) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.port) return null;
  return url;
}

const LINKEDIN_HOST = /^(?:(?:www|[a-z]{2})\.)?linkedin\.com$/u;
const LINKEDIN_PAGE = /^\/(company|showcase)\/([^/]+)\/?$/u;
const LINKEDIN_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u;

/** https://www.linkedin.com/company/<slug> (or /showcase/<slug>); every other LinkedIn path is dropped. */
function linkedinCompanyPage(target: string): string | null {
  const url = absoluteWebUrl(target);
  if (!url || !LINKEDIN_HOST.test(url.hostname)) return null;
  const page = LINKEDIN_PAGE.exec(url.pathname);
  if (!page) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(page[2]!).toLowerCase();
  } catch {
    return null;
  }
  if (!LINKEDIN_SLUG.test(slug)) return null;
  const value = `https://www.linkedin.com/${page[1]}/${slug}`;
  return isStableSafeHttpsUrl(value) ? value : null;
}

const X_HOSTS: ReadonlySet<string> = new Set([
  'x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com',
]);
const X_ACCOUNT = /^\/([A-Za-z0-9_]{1,15})\/?$/u;
/** Single-segment X paths that are features, not accounts. */
const X_RESERVED: ReadonlySet<string> = new Set([
  'home', 'explore', 'search', 'share', 'intent', 'hashtag', 'i', 'login', 'logout', 'signup',
  'settings', 'notifications', 'messages', 'compose', 'tos', 'privacy', 'about', 'help',
  'account', 'download', 'jobs', 'lists', 'topics', 'following', 'followers',
]);
const GENERIC_SECOND_LEVEL: ReadonlySet<string> = new Set([
  'co', 'com', 'net', 'org', 'gov', 'ac', 'edu', 'or', 'ne', 'go',
]);

/** The company's name label in its domain (`pumpen-handel.de` → `pumpenhandel`), or null. */
function domainNameLabel(domain: string): string | null {
  const labels = domain.split('.');
  labels.pop();
  while (labels.length > 1 && GENERIC_SECOND_LEVEL.has(labels.at(-1)!)) labels.pop();
  const label = labels.at(-1);
  if (!label || label.startsWith('xn--')) return null;
  const name = label.replaceAll('-', '');
  return name.length >= 3 ? name : null;
}

/**
 * https://x.com/<handle> for an x.com or twitter.com account link. A handle is not
 * known to belong to a company, so it is kept only when it carries the company's
 * domain name; status, intent, share, search and hashtag URLs are dropped.
 */
function xCompanyAccount(target: string, domain: string): string | null {
  const url = absoluteWebUrl(target);
  if (!url || !X_HOSTS.has(url.hostname)) return null;
  const account = X_ACCOUNT.exec(url.pathname);
  if (!account) return null;
  const handle = account[1]!.toLowerCase();
  if (X_RESERVED.has(handle)) return null;
  const name = domainNameLabel(domain);
  if (!name || !handle.replaceAll('_', '').includes(name)) return null;
  const value = `https://x.com/${handle}`;
  return isStableSafeHttpsUrl(value) ? value : null;
}

/**
 * The company's own LinkedIn page among the distinct ones its homepage links: the first whose
 * slug carries the company domain name, otherwise the only one. Several other pages (partners,
 * customers, associations) leave it unknown rather than storing another company's page.
 */
function ownLinkedinPage(pages: readonly string[], domain: string): string | null {
  const name = domainNameLabel(domain);
  const named = name
    ? pages.find((page) => page.slice(page.lastIndexOf('/') + 1).replaceAll('-', '').includes(name))
    : undefined;
  if (named) return named;
  return pages.length === 1 ? pages[0]! : null;
}

function companyDomain(raw: unknown): string | null {
  return typeof raw === 'string' ? canonicalizeSuppressionValue('domain', raw) : null;
}

/** rank: a path match before a label-only match, then the shallower path, then document order. */
type Rank = readonly [number, number, number];

function before(left: Rank, right: Rank): boolean {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index]! < right[index]!;
  }
  return false;
}

/**
 * The company's contact paths among the links of its homepage markdown. A same-site
 * link counts for a kind when its last path segment names it, or when its label does
 * and the link has no query string (the query might be what identifies the page).
 */
export function findContactPaths(homeMarkdown: string, domainInput: string): CompanyContactLinks {
  const domain = companyDomain(domainInput);
  if (!domain || typeof homeMarkdown !== 'string' || !homeMarkdown) return NO_LINKS;
  const base = new URL(`https://${domain}/`);
  const best = new Map<SameSiteKind, { url: string; rank: Rank }>();
  const linkedinPages: string[] = [];
  let x: string | null = null;
  markdownLinks(homeMarkdown).forEach((link, index) => {
    const linkedin = linkedinCompanyPage(link.target);
    if (linkedin && !linkedinPages.includes(linkedin)) linkedinPages.push(linkedin);
    x ??= xCompanyAccount(link.target, domain);
    const page = sameSitePage(link.target, base, domain);
    if (!page) return;
    const label = normalizedLabel(link.label);
    for (const rule of SAME_SITE_RULES) {
      const byPath = rule.path(page.lastTokens);
      if (!byPath && (page.hadQuery || !rule.label.test(label))) continue;
      const rank: Rank = [byPath ? 0 : 1, page.depth, index];
      const current = best.get(rule.kind);
      if (!current || before(rank, current.rank)) best.set(rule.kind, { url: page.url, rank });
    }
  });
  return Object.freeze({
    contactPage: best.get('contact_page')?.url ?? null,
    impressumPage: best.get('impressum_page')?.url ?? null,
    supplierPage: best.get('supplier_page')?.url ?? null,
    linkedinCompanyPage: ownLinkedinPage(linkedinPages, domain),
    xCompanyAccount: x,
  });
}

/**
 * Whether `value` is exactly a link the finder would store for `kind` on this company
 * domain. The persistence step checks every point again with it before writing.
 */
export function isCompanyContactPointValue(kind: string, value: unknown, domainInput: string): boolean {
  const domain = companyDomain(domainInput);
  if (!domain || typeof value !== 'string') return false;
  switch (kind) {
    case 'linkedin_company_page':
      return linkedinCompanyPage(value) === value;
    case 'x_company_account':
      return xCompanyAccount(value, domain) === value;
    case 'contact_page':
    case 'impressum_page':
    case 'contact_form':
    case 'supplier_page': {
      if (!value.startsWith('https://')) return false;
      const page = sameSitePage(value, new URL(`https://${domain}/`), domain);
      return page !== null && !page.hadQuery && page.url === value;
    }
    default:
      return false;
  }
}

const MAX_HTML_CHARS = 3_000_000;
const MAX_FORMS = 20;
const MAX_FORM_CHARS = 200_000;
const COMMENTS = /<!--[\s\S]*?-->/gu;
const NON_CONTENT = /<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gu;
const TAG = /<[^>]*>/gu;
const NOT_A_CONTACT_FORM: readonly RegExp[] = [
  /<input\b[^>]*\btype\s*=\s*["']?(?:password|search)\b/u,
  /\brole\s*=\s*["']?search\b/u,
  /<input\b[^>]*\bname\s*=\s*["']?(?:q|s|search|query|suche)["'\s/>]/u,
];
const NOT_A_CONTACT_ACTION =
  /\baction\s*=\s*["']?[^"'\s>]*(?:cart|warenkorb|basket|checkout|login|logout|signin|anmelden|search|suche)/u;
const SUBMIT_CONTROL = [
  /<button\b(?![^>]*\btype\s*=\s*["']?(?:button|reset)\b)[^>]*>/u,
  /<input\b[^>]*\btype\s*=\s*["']?(?:submit|image)\b/u,
];
const SUBMIT_WORD = /(?<!\p{L})(?:absenden|abschicken|senden|submit|send)(?!\p{L})/u;
const CONSENT = /datenschutz|privacy|data protection|einwillig|einverstanden|zustimm|consent|dsgvo|gdpr/u;
const REQUIRED_MARKUP = /\brequired\b|pflichtfeld|pflichtangabe|mandatory/u;
const REQUIRED_STAR = /[\p{L}\p{N})]\s*\*/u;

/**
 * Whether one form's markup (from `<form` to before `</form`, lower case) is a
 * contact form: not a search, login, newsletter or shop form, and at least two
 * of: a submit control, consent text, required-field markers.
 */
function isContactFormMarkup(block: string): boolean {
  const markup = block.replace(COMMENTS, ' ').replace(NON_CONTENT, ' ');
  const openTag = markup.slice(0, markup.indexOf('>') + 1);
  if (NOT_A_CONTACT_FORM.some((pattern) => pattern.test(markup))) return false;
  if (NOT_A_CONTACT_ACTION.test(openTag)) return false;
  if (!/<textarea\b/u.test(markup) && markup.includes('newsletter')) return false;
  const text = markup.replace(TAG, ' ');
  const submit =
    SUBMIT_CONTROL.some((pattern) => pattern.test(markup)) || SUBMIT_WORD.test(text);
  const consent = CONSENT.test(markup);
  const required =
    REQUIRED_MARKUP.test(markup.replace(/aria-required\s*=\s*["']?false["']?/gu, ' ')) ||
    REQUIRED_STAR.test(text);
  return [submit, consent, required].filter(Boolean).length >= 2;
}

/**
 * Whether rendered HTML carries a contact form. Reads markup only and never fills in or
 * submits a form. This function keeps nothing of the page; the render's durable result
 * keeps the contact page HTML as a PERSONAL_DATA artifact for 24 hours (the Impressum
 * fetch does the same), which DSR erasure covers.
 */
export function hasContactForm(html: string): boolean {
  if (typeof html !== 'string' || !html) return false;
  const lower = html.slice(0, MAX_HTML_CHARS).toLowerCase();
  let from = 0;
  let forms = 0;
  while (forms < MAX_FORMS) {
    const start = lower.indexOf('<form', from);
    if (start < 0) return false;
    from = start + '<form'.length;
    const next = lower.charAt(from);
    if (next && !/[\s/>]/u.test(next)) continue; // <formula>, <form-field> …
    forms += 1;
    const close = lower.indexOf('</form', from);
    const end = Math.min(close < 0 ? lower.length : close, start + MAX_FORM_CHARS);
    if (isContactFormMarkup(lower.slice(start, end))) return true;
    from = Math.max(end, from);
  }
  return false;
}
