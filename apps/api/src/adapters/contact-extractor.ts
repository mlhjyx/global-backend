/**
 * Deterministic public-contact extraction (PRD 7.15 Buyer Trust 原料).
 * Regex over crawled markdown — NOT an LLM task on purpose: a matched email/phone
 * verifiably exists on the source page (数据真实性 P-04), no hallucination possible.
 * Every entry carries the page URL it was found on.
 */

export interface PublicContact {
  type: 'email' | 'phone' | 'social';
  value: string;
  sourceUrl: string;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Emails regexes also match image names like "logo@2x.png" — reject asset-ish hits.
const EMAIL_REJECT = /\.(png|jpe?g|gif|svg|webp|css|js)$|^[0-9.]+@/i;

// Phones: only explicit tel: links or clearly international "+" formats — plain
// digit runs create too many false positives (dates, ids) to be trustworthy.
const TEL_LINK_RE = /\(tel:([^)]+)\)/g;
const INTL_PHONE_RE = /\+[0-9][0-9 ()\-./]{6,18}[0-9]/g;

const SOCIAL_HOSTS = [
  'linkedin.com',
  'facebook.com',
  'instagram.com',
  'youtube.com',
  'x.com',
  'twitter.com',
  'tiktok.com',
  'weibo.com',
  'pinterest.com',
  'xing.com',
];
const SOCIAL_RE = new RegExp(
  `https?://(?:www\\.)?(?:${SOCIAL_HOSTS.map((h) => h.replace('.', '\\.')).join('|')})/[A-Za-z0-9_\\-./@%]+`,
  'g',
);

function normalizePhone(raw: string): string {
  return raw.replace(/[^\d+]/g, '');
}

export function extractPublicContacts(pages: { url: string; text: string }[], cap = 30): PublicContact[] {
  const out: PublicContact[] = [];
  const seen = new Set<string>();
  const push = (c: PublicContact) => {
    const key = `${c.type}:${c.value.toLowerCase()}`;
    if (!seen.has(key) && out.length < cap) {
      seen.add(key);
      out.push(c);
    }
  };

  for (const page of pages) {
    for (const m of page.text.match(EMAIL_RE) ?? []) {
      if (!EMAIL_REJECT.test(m)) push({ type: 'email', value: m.toLowerCase(), sourceUrl: page.url });
    }
    let t: RegExpExecArray | null;
    TEL_LINK_RE.lastIndex = 0;
    while ((t = TEL_LINK_RE.exec(page.text)) !== null) {
      const v = normalizePhone(decodeURIComponent(t[1]));
      if (v.replace(/\D/g, '').length >= 7) push({ type: 'phone', value: v, sourceUrl: page.url });
    }
    for (const m of page.text.match(INTL_PHONE_RE) ?? []) {
      const v = normalizePhone(m);
      if (v.replace(/\D/g, '').length >= 8) push({ type: 'phone', value: v, sourceUrl: page.url });
    }
    for (const m of page.text.match(SOCIAL_RE) ?? []) {
      // strip trailing punctuation the regex may swallow
      const v = m.replace(/[).,]+$/, '');
      // share/intent links are not company profiles
      if (/sharer|share\?|intent\//i.test(v)) continue;
      push({ type: 'social', value: v, sourceUrl: page.url });
    }
  }
  return out;
}
