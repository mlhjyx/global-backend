import { isPdfDocumentUrl } from '../../adapters/pdf-url-guard';
import { extractPublicContacts } from '../../adapters/contact-extractor';
import { hasContactForm } from '../website-profile/contact-paths';

export const THIN_VISIBLE_TEXT_THRESHOLD = 200;
const MAX_VISIBLE_TEXT_CHARS = 12_000;
const MAX_ARRAY_ITEMS = 25;

const ROLE_EMAIL_LOCAL_RE =
  /^(?:info|sales|contact|export|import|procurement|purchasing|buyer|buying|commercial|commerciale|vendite|vertrieb|einkauf|anfrage|kontakt|office|hello|b2b|wholesale|distribution|distribuzione|grosshandel|partner|partners|support|service|enquiries|inquiries|inquiry|rfq|tender|orders|order|hello|mail|hello|trade|marketing|admin|general)(?:[._+-][a-z0-9]+)?$/iu;

const CONTACT_PATH_RE =
  /(?:^|\/)(?:contact|contacts|contact-us|contactus|contatti|contatto|contattaci|kontakt|kontaktformular|contacto|contactenos|contactez|contato|iletisim|impressum|imprint|anfrage|rfq|inquiry|quote|preventivo)(?:\/|$|\.)/iu;

const IMPRESSUM_PATH_RE = /(?:^|\/)(?:impressum|imprint|legal-notice|note-legali|mentions-legales)(?:\/|$|\.)/iu;

const CAREERS_PATH_RE =
  /(?:^|\/)(?:careers?|jobs?|karriere|stellenangebote|lavora-con-noi|empleo|recrutement|vacancies|join-us)(?:\/|$|\.)/iu;

const OFFICIAL_SOCIAL_RE =
  /^https?:\/\/(?:www\.)?(?:linkedin\.com\/company\/|x\.com\/|twitter\.com\/|facebook\.com\/|instagram\.com\/|youtube\.com\/(?:@|channel\/|c\/))/iu;

const SHARE_SOCIAL_RE = /sharer|share\?|intent\/|\/share\b/iu;

export interface JsonLdJobPosting {
  readonly title: string;
  readonly location: string | null;
}

export interface JsonLdFacts {
  readonly organizationNames: readonly string[];
  readonly descriptions: readonly string[];
  readonly emails: readonly string[];
  readonly phones: readonly string[];
  readonly socialLinks: readonly string[];
  readonly products: readonly string[];
  readonly jobPostings: readonly JsonLdJobPosting[];
}

export interface HtmlChannelsAndLinks {
  readonly title: string | null;
  readonly metaDescription: string | null;
  readonly roleEmails: readonly string[];
  readonly otherEmails: readonly string[];
  readonly phones: readonly string[];
  readonly socialLinks: readonly string[];
  readonly hasInquiryForm: boolean;
  readonly contactPageUrl: string | null;
  readonly impressumUrl: string | null;
  readonly careersPageUrl: string | null;
}

const NAMED_HTML_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
});

/** Single-pass HTML entity decoding (avoids CodeQL js/double-escaping on &amp;lt; etc.). */
function decodeHtmlEntities(input: string): string {
  return input.replace(/&(?:([a-z]+)|#(\d+));/giu, (match, name?: string, dec?: string) => {
    if (name) {
      return NAMED_HTML_ENTITIES[name.toLowerCase()] ?? match;
    }
    if (dec) {
      const code = Number(dec);
      return Number.isInteger(code) && code >= 32 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    }
    return match;
  });
}

function normalizePhone(raw: string): string {
  return raw.replace(/[^\d+]/gu, '');
}

function uniqueCapped(values: Iterable<string>, cap = MAX_ARRAY_ITEMS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Law 1 (#30): DOM-denoised visible body text (strips script/style/noscript/svg/nav/header/footer/aside).
 * Thin-page Crawl4AI fallback MUST use this length (< 200), never Readability length.
 */
export function extractVisibleBodyText(html: string): string {
  if (!html) return '';
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/iu);
  const source = bodyMatch ? bodyMatch[1]! : html;
  const cleaned = source
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(script|style|noscript|svg|template|nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ');
  return decodeHtmlEntities(cleaned).replace(/\s+/gu, ' ').trim().slice(0, MAX_VISIBLE_TEXT_CHARS);
}

export function isThinHtmlPage(visibleText: string, threshold = THIN_VISIBLE_TEXT_THRESHOLD): boolean {
  return visibleText.trim().length < threshold;
}

export function isPdfBodyContent(text: string): boolean {
  return text.trimStart().startsWith('%PDF-');
}

function collectJsonLdNodes(node: unknown, out: Record<string, unknown>[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectJsonLdNodes(item, out);
    return;
  }
  const record = node as Record<string, unknown>;
  out.push(record);
  if (Array.isArray(record['@graph'])) collectJsonLdNodes(record['@graph'], out);
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

function nodeTypes(record: Record<string, unknown>): string[] {
  return stringList(record['@type']).map((item) => item.toLowerCase());
}

export function extractJsonLdFacts(html: string): JsonLdFacts {
  const organizationNames: string[] = [];
  const descriptions: string[] = [];
  const emails: string[] = [];
  const phones: string[] = [];
  const socialLinks: string[] = [];
  const products: string[] = [];
  const jobPostings: JsonLdJobPosting[] = [];

  const scriptRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    const raw = match[1]?.trim();
    if (!raw || raw.length > 200_000) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const nodes: Record<string, unknown>[] = [];
    collectJsonLdNodes(parsed, nodes);
    for (const node of nodes) {
      const types = nodeTypes(node);
      if (types.some((t) => t.includes('organization') || t.includes('localbusiness') || t.includes('corporation'))) {
        if (typeof node.name === 'string') organizationNames.push(node.name);
        if (typeof node.description === 'string') descriptions.push(node.description);
      }
      if (types.includes('product') && typeof node.name === 'string') {
        products.push(node.name);
      }
      if (types.includes('jobposting') && typeof node.title === 'string') {
        const loc =
          typeof node.jobLocation === 'string'
            ? node.jobLocation
            : typeof (node.jobLocation as Record<string, unknown> | undefined)?.name === 'string'
              ? String((node.jobLocation as Record<string, unknown>).name)
              : null;
        jobPostings.push({ title: node.title.trim(), location: loc });
      }
      for (const email of stringList(node.email)) {
        const cleaned = email.replace(/^mailto:/iu, '').trim().toLowerCase();
        if (cleaned.includes('@')) emails.push(cleaned);
      }
      for (const tel of stringList(node.telephone)) {
        const normalized = normalizePhone(tel);
        if (normalized.replace(/\D/gu, '').length >= 7) phones.push(normalized);
      }
      for (const sameAs of stringList(node.sameAs)) {
        if (OFFICIAL_SOCIAL_RE.test(sameAs) && !SHARE_SOCIAL_RE.test(sameAs)) {
          socialLinks.push(sameAs.replace(/[).,]+$/u, ''));
        }
      }
    }
  }

  return {
    organizationNames: uniqueCapped(organizationNames, 10),
    descriptions: uniqueCapped(descriptions, 5),
    emails: uniqueCapped(emails, 15),
    phones: uniqueCapped(phones, 10),
    socialLinks: uniqueCapped(socialLinks, 10),
    products: uniqueCapped(products, 20),
    jobPostings: jobPostings.slice(0, 10),
  };
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu);
  if (!m) return null;
  const text = decodeHtmlEntities(m[1]!).replace(/\s+/gu, ' ').trim();
  return text ? text.slice(0, 300) : null;
}

function extractMetaDescription(html: string): string | null {
  const m =
    html.match(/<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/iu) ??
    html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*name=["']description["'][^>]*>/iu);
  if (!m) return null;
  const text = decodeHtmlEntities(m[1]!).replace(/\s+/gu, ' ').trim();
  return text ? text.slice(0, 600) : null;
}

function isSameCompanyHost(candidateHost: string, baseDomain: string): boolean {
  const normalizedCandidate = candidateHost.replace(/^www\./iu, '').toLowerCase();
  const normalizedBase = baseDomain.replace(/^www\./iu, '').toLowerCase();
  return normalizedCandidate === normalizedBase;
}

function isRoleEmail(email: string): boolean {
  const local = email.split('@', 1)[0] ?? '';
  return ROLE_EMAIL_LOCAL_RE.test(local);
}

function hasUsableInquiryForm(html: string): boolean {
  if (hasContactForm(html)) return true;
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/giu;
  let m: RegExpExecArray | null;
  while ((m = formRe.exec(html)) !== null) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    if (/(?:role=["']search["']|search-form|login|signin|password)/iu.test(attrs)) continue;
    const hasEmailOrTextarea = /<textarea\b|type=["']email["']|name=["'][^"']*email/iu.test(body);
    if (hasEmailOrTextarea) return true;
  }
  return false;
}

export function extractHtmlChannelsAndLinks(
  html: string,
  pageUrl: string,
  domain: string,
): HtmlChannelsAndLinks {
  const jsonLd = extractJsonLdFacts(html);
  const visibleText = extractVisibleBodyText(html);
  const publicContacts = extractPublicContacts([{ url: pageUrl, text: visibleText }]);

  const allEmails: string[] = [...jsonLd.emails];
  const allPhones: string[] = [...jsonLd.phones];
  const allSocials: string[] = [...jsonLd.socialLinks];
  for (const contact of publicContacts) {
    if (contact.type === 'email') allEmails.push(contact.value);
    else if (contact.type === 'phone') allPhones.push(contact.value);
    else if (contact.type === 'social' && OFFICIAL_SOCIAL_RE.test(contact.value)) allSocials.push(contact.value);
  }

  let contactPageUrl: string | null = null;
  let impressumUrl: string | null = null;
  let careersPageUrl: string | null = null;

  let base: URL | null = null;
  try {
    base = new URL(pageUrl);
  } catch {
    base = null;
  }

  const hrefRe = /href\s*=\s*(?:"([^"]{1,1000})"|'([^']{1,1000})')/giu;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    const rawHref = (m[1] ?? m[2] ?? '').trim();
    if (!rawHref || rawHref.startsWith('#')) continue;
    if (/^mailto:/iu.test(rawHref)) {
      const email = rawHref.replace(/^mailto:/iu, '').split('?', 1)[0]?.trim().toLowerCase() ?? '';
      if (email.includes('@') && !email.includes('%')) allEmails.push(email);
      continue;
    }
    if (/^tel:/iu.test(rawHref)) {
      const phone = normalizePhone(rawHref.replace(/^tel:/iu, ''));
      if (phone.replace(/\D/gu, '').length >= 7) allPhones.push(phone);
      continue;
    }
    if (!base) continue;
    let resolved: URL;
    try {
      resolved = new URL(rawHref, base);
    } catch {
      continue;
    }
    // Strict scheme allowlist (automatically blocks javascript:, data:, vbscript:, etc.).
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
    const cleanUrl = `${resolved.origin}${resolved.pathname}`.replace(/\/+$/u, '') || `${resolved.origin}/`;
    if (OFFICIAL_SOCIAL_RE.test(resolved.href) && !SHARE_SOCIAL_RE.test(resolved.href)) {
      allSocials.push(resolved.href.replace(/[).,]+$/u, ''));
      continue;
    }
    if (!isSameCompanyHost(resolved.hostname, domain)) continue;
    if (isPdfDocumentUrl(resolved.href)) continue;
    const pathname = resolved.pathname;
    if (!impressumUrl && IMPRESSUM_PATH_RE.test(pathname)) {
      impressumUrl = cleanUrl;
    }
    if (!contactPageUrl && CONTACT_PATH_RE.test(pathname) && cleanUrl !== pageUrl.replace(/\/+$/u, '')) {
      contactPageUrl = cleanUrl;
    }
    if (!careersPageUrl && CAREERS_PATH_RE.test(pathname)) {
      careersPageUrl = cleanUrl;
    }
  }

  const dedupedEmails = uniqueCapped(allEmails, 20);
  const roleEmails = dedupedEmails.filter(isRoleEmail);
  const otherEmails = dedupedEmails.filter((email) => !isRoleEmail(email));

  return {
    title: extractTitle(html),
    metaDescription: extractMetaDescription(html),
    roleEmails,
    otherEmails,
    phones: uniqueCapped(allPhones, 15),
    socialLinks: uniqueCapped(allSocials, 15),
    hasInquiryForm: hasUsableInquiryForm(html),
    contactPageUrl: contactPageUrl ?? impressumUrl,
    impressumUrl,
    careersPageUrl,
  };
}
