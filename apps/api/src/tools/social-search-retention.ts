import { sanitizeSearchProviderUrl } from '../adapters/search-providers';
import { stripHtml } from '../adapters/html-visible-text';
import { durableTitle, isDurableText, isPersonProfileUrl } from './durable-text';

export const SOCIAL_CONTEXT_MAX_CHARS = 240;
export const SOCIAL_MAX_HIGHLIGHTS = 3;
const MAX_RAW_CONTEXT_CHARS = 4096;

const CONTACT_EMAIL =
  /[\p{L}\p{N}._%+'-]{1,64} *(?:@|%40|\[at\]|\(at\)|\{at\}) *[\p{L}\p{N}-]{1,63}(?: *(?:\.|%2e|\[dot\]|\(dot\)|\{dot\}) *[\p{L}\p{N}-]{1,63}){1,8}/giu;
const OBFUSCATED_CONTACT_EMAIL =
  /[\p{L}\p{N}._%+'-]{1,64} +(?:at|ät) +[\p{L}\p{N}-]{1,63}(?: +(?:dot|punkt) +[\p{L}\p{N}-]{1,63}){1,8}/giu;
const CONTACT_PHONE =
  /(?<![\p{L}\p{N}])(?:\+ *|\()?\p{Nd}[\p{Nd} ()./‐‑‒–—-]{5,35}\p{Nd}(?: *(?:ext(?:ension)?\.?|x|#) *\p{Nd}{1,6})?(?!\p{Nd})/giu;
const EMPLOYMENT_YEAR_RANGE = /^\(?(?:19|20)\d{2} *[-–—] *(?:19|20)\d{2}$/u;

function cleanSearchText(raw: string): string {
  return stripHtml(raw.replace(/&commat;/giu, '@'))
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/https?:\/\/[^\s<>"']+/giu, '[redacted]')
    .replace(CONTACT_EMAIL, '[redacted]')
    .replace(OBFUSCATED_CONTACT_EMAIL, '[redacted]')
    .replace(CONTACT_PHONE, (value) =>
      EMPLOYMENT_YEAR_RANGE.test(value) || (value.match(/\p{Nd}/gu)?.length ?? 0) < 7
        ? value
        : '[redacted]')
    .trim();
}

/** Keep professional context while removing contact channels before storage or attribution. */
export function redactSocialSearchText(raw: unknown, maxChars = SOCIAL_CONTEXT_MAX_CHARS): string | undefined {
  if (typeof raw !== 'string' || raw.length > MAX_RAW_CONTEXT_CHARS) return undefined;
  const bounded = durableTitle(cleanSearchText(raw), maxChars)?.trim();
  // Drop a fragment if truncation or another decoding pass changes its meaning at readback.
  return bounded && cleanSearchText(bounded) === bounded ? bounded : undefined;
}

export function redactSocialSearchHighlights(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const highlights = raw.slice(0, SOCIAL_MAX_HIGHLIGHTS)
    .map((entry) => redactSocialSearchText(entry))
    .filter((entry) => entry !== undefined);
  return highlights.length > 0 ? highlights : undefined;
}

/** Keep the profile locator only. Query, fragments and embedded contact paths are outside the contract. */
export function normalizeSocialProfileUrl(raw: unknown): string | null {
  const safe = sanitizeSearchProviderUrl(raw);
  if (!safe || !isDurableText(safe) || !isPersonProfileUrl(safe)) return null;
  const url = new URL(safe);
  if (url.port) return null;
  try {
    const path = decodeURIComponent(url.pathname);
    if (!/^\/(?:in|pub|profile)\/[\p{L}\p{M}\p{N}._~-]+(?:\/[\p{L}\p{M}\p{N}._~-]+)*\/?$/iu.test(path)) return null;
  } catch {
    return null;
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}
